import { afterEach, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { zbudujAplikacje, type Aplikacja } from '../../../src/core/aplikacja.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyPiaskownicy } from '../../../deploy/proba/atrapy/index.mjs';
import { createModulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { scopesAllegro } from '../../pomoc/allegro-konfigurator.ts';
import type { ModulOms } from '../../../src/core/kontrakty.ts';
import { zapiszTokeny } from '../../../src/oms/db/tokeny.js';
import { UPRAWNIENIA_OFERT } from '../../../src/domena/uprawnienia-kanalu.js';
import { ustawieniaOfertKonta, zapiszUstawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import { migracjaCennikowDostaw } from '../../../src/moduly/magazyn/migracje/0003-cenniki-dostaw.ts';

// Krok „Oferty” Allegro i ERLI — tabela reguł
// „cennik według rozmiaru” zamiast jednego pola cennikDostaw. Bez sieci: listy Allegro zapisane wprost w bazie,
// transport ERLI rzuca przy każdym wywołaniu. Dane zmyślone („Pracownia Półcień”).

let a: Aplikacja | undefined, db: ReturnType<typeof openOmsDb> | undefined;
afterEach(async () => {
  await a?.app.close();
  db?.close();
  a = undefined;
  db = undefined;
  vi.restoreAllMocks();
});

const ileRazy = (s: string, re: RegExp) => (s.match(re) ?? []).length;
/** Wiersze tabeli jak z formularza: [a, b, c, waga, cennik] — każde pole to lista wartości w kolejności wierszy. */
const tabela = (w: string[][], cennikWiekszych: string) => ({
  regulaA: w.map((x) => x[0]),
  regulaB: w.map((x) => x[1]),
  regulaC: w.map((x) => x[2]),
  regulaWaga: w.map((x) => x[3]),
  regulaCennik: w.map((x) => x[4]),
  cennikWiekszych,
});
const PUSTY = ['', '', '', '', ''];

// ——— Allegro ———
const rootA = '/ustawienia/integracje/allegro';
const SLOWNIKI = {
  pobranoAt: '2026-11-14T11:00:00.000Z',
  cenniki: [
    { id: 'cennik-a', nazwa: 'Pracownia Półcień — paczkomat A' },
    { id: 'cennik-c', nazwa: 'Pracownia Półcień — paczkomat C' },
    { id: 'cennik-gabaryt', nazwa: 'Pracownia Półcień — kurier gabaryt' },
  ],
  zwroty: [{ id: 'zwrot-1', nazwa: 'Zwroty 14 dni' }],
  reklamacje: [{ id: 'reklamacja-1', nazwa: 'Reklamacje' }],
  gwarancje: [],
  producenci: [],
  osoby: [],
};
const poprawneA = {
  czynne: 'wstrzymane',
  narzutProcent: '12,5',
  progPotwierdzeniaProcent: '20',
  stalaIlosc: '3',
  czasWysylkiDni: '2',
  stawkaVat: '23',
  aktywujPoSprawdzeniu: 'nie',
  bezpieczenstwoDomyslne: '',
};
const jwt = (scope: string[], konto: string) =>
  'fixture.' + Buffer.from(JSON.stringify({ user_name: konto, scope })).toString('base64url') + '.fixture';

async function allegro() {
  const calls: string[] = [];
  const http = async (u: string) => {
    calls.push(u);
    if (u.includes('/order/checkout-forms?')) return Response.json({ checkoutForms: [], totalCount: 0 });
    throw Error('Nieoczekiwane API: ' + u);
  };
  const env = {
    OMS_USER: 'serwis',
    OMS_PASS: 'fixture',
    OMS_TRYB: 'proba',
    OMS_KANALY: '[]',
    OMS_SPRZEDAWCA_NIP: '1234563218',
    OMS_RACHUNEK: '34109010140000000000000000',
    OMS_PROFORMY_KATALOG: path.join(os.tmpdir(), 'cenniki-krok-prz160e3d02', 'proformy'),
    OMS_ETYKIETY_KATALOG: path.join(os.tmpdir(), 'cenniki-krok-prz160e3d02', 'etykiety'),
  };
  const def = ['legacy', 'allegro_polcien'].map((klucz) => ({
    klucz,
    typ: 'allegro' as const,
    prefiks: klucz.toUpperCase(),
    raport: klucz.toUpperCase(),
  }));
  const m = createModulKanaly(def, false, {
    fetchImpl: (u, _i) => http(String(u)),
    autoryzacjaAtrapy: {
      http,
      softwareStatementId: '',
      redirectUri: 'http://localhost' + rootA + '/oauth/powrot',
      userAgent: 'Fixture/1 (+https://example.invalid)',
    },
  });
  const kanal = {
    ...m,
    konfiguracja: () => ({
      ...m.konfiguracja(env),
      kanaly: Object.fromEntries(
        def.map((d) => [
          d.klucz,
          {
            clientId: 'app-public',
            clientSecret: 'SECRET-BAIT',
            userAgent: 'Fixture/1 (+https://example.invalid)',
            api: 'https://api.allegro.pl',
            auth: 'https://allegro.pl/auth/oauth',
            od: '2024-11-01T00:00:00Z',
          },
        ]),
      ),
    }),
  };
  db = openOmsDb();
  const bazowe = scopesAllegro.filter((s) => s !== 'allegro:api:profile:read');
  for (const d of def)
    zapiszTokeny(db, d.klucz, {
      accessToken: jwt([...bazowe, ...UPRAWNIENIA_OFERT], d.klucz === 'legacy' ? '123' : '456'),
      refreshToken: 'REFRESH-OLD',
      wygasaAt: '2099-01-01T00:00:00Z',
      refreshWygasaAt: '2099-02-01T00:00:00Z',
    });
  a = await zbudujAplikacje({
    db,
    moduly: modulyPiaskownicy(env).map((x) => (x.nazwa === 'kanaly' ? kanal : x)) as ModulOms[],
    env,
    teraz: () => new Date('2026-11-14T12:00:00Z'),
    log: () => {},
  });
  zalozKonto(db, { login: 'admin', imie: 'Administrator', haslo: 'fixture', rola: 'administrator', admin: true });
  // Listy „Pobierz z Allegro” tylko dla konta legacy; allegro_polcien list nie ma.
  zapiszUstawieniaOfertKonta(
    db,
    'legacy',
    { slowniki: SLOWNIKI },
    { aktor: 'admin', teraz: '2026-11-14T11:00:00.000Z' },
  );
  const cookie = 'sesja_oms_proba=' + podpisz('admin', wczytajSekret(db), Date.now());
  async function req(method: 'GET' | 'POST', sciezka: string, payload?: Record<string, unknown>) {
    const r = await a!.app.inject({
      method,
      url: sciezka,
      headers: {
        accept: 'text/html',
        cookie,
        ...(method === 'POST' ? { origin: 'http://localhost' } : {}),
        ...(payload ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      payload: payload
        ? new URLSearchParams(
            Object.entries(payload).flatMap(([k, v]) =>
              Array.isArray(v) ? v.map((x) => [k, String(x)]) : [[k, String(v)]],
            ),
          ).toString()
        : undefined,
    });
    expect(r.body).not.toMatch(/SECRET-BAIT|REFRESH-OLD|fixture\./);
    return r;
  }
  return { req, calls, ustawienia: (k: string) => ustawieniaOfertKonta(db!, k) };
}

const REGULY_A = [
  { doMm: [80, 380, 640], doG: 25000, cennik: 'cennik-a' },
  { doMm: [410, 380, 645], doG: 2500, cennik: 'cennik-c' },
  { cennik: 'cennik-gabaryt' },
];
const FORMULARZ_A = tabela(
  [['8', '38', '64', '25', 'cennik-a'], ['41', '38', '64,5', '2,5', 'cennik-c'], PUSTY, PUSTY],
  'cennik-gabaryt',
);

it('Allegro: krok bez reguł — dwa puste wiersze, wymagany cennik „dla większych” z listy konta, podpowiedź InPost, bez pola cennikDostaw', async () => {
  const f = await allegro();
  const r = await f.req('GET', rootA + '/legacy/oferty');
  expect(r.statusCode).toBe(200);
  expect(r.body).not.toMatch(/name="cennikDostaw"/);
  expect(ileRazy(r.body, /name="regulaCennik"/g)).toBe(2);
  for (const pole of ['regulaA', 'regulaB', 'regulaC', 'regulaWaga'])
    expect(ileRazy(r.body, new RegExp(`name="${pole}"[^>]*value=""`, 'g')), pole).toBe(2);
  expect(r.body).toMatch(/<select[^>]*name="cennikWiekszych"[^>]*required/);
  expect(r.body).toMatch(/<option value="cennik-gabaryt">Pracownia Półcień — kurier gabaryt<\/option>/);
  expect(r.body).toMatch(/<p[^>]*class="ust-pomoc"[^>]*>[^<]*A 8×38×64, B 19×38×64, C 41×38×64 cm, do 25 kg/);
  // Każde pole tabeli ma własną etykietę <label for>.
  for (const id of [
    'allegro-oferty-cenniki-0-a',
    'allegro-oferty-cenniki-1-waga',
    'allegro-oferty-cenniki-1-cennik',
    'allegro-oferty-cenniki-wieksze',
  ])
    expect(r.body).toContain(`<label for="${id}"`);
  expect(f.calls).toEqual([]);
});

it('Allegro: zapis i odczyt — cm z przecinkiem → mm, kg → g, kolejność wierszy od góry; dawne pole cennik_dostaw nietknięte', async () => {
  const f = await allegro();
  const r = await f.req('POST', rootA + '/legacy/oferty', { ...poprawneA, ...FORMULARZ_A });
  expect(r.statusCode).toBe(303);
  const u = f.ustawienia('legacy');
  expect(u.cenniki).toEqual(REGULY_A);
  expect(u.cennikDostaw).toBeNull();
  expect(u).toMatchObject({ stalaIlosc: 3, aktorLogin: 'admin' });
  const e = await f.req('GET', rootA + '/legacy/oferty?wynik=zapisano');
  // Dwa zapisane wiersze w kolejności zapisu, potem dwa puste.
  expect(ileRazy(e.body, /name="regulaCennik"/g)).toBe(4);
  expect(e.body).toMatch(
    /name="regulaA"[^>]*value="8"[\s\S]*name="regulaA"[^>]*value="41"[\s\S]*name="regulaA"[^>]*value=""[\s\S]*name="regulaA"[^>]*value=""/,
  );
  expect(e.body).toMatch(/id="allegro-oferty-cenniki-1-c"[^>]*value="64,5"/);
  expect(e.body).toMatch(/id="allegro-oferty-cenniki-1-waga"[^>]*value="2,5"/);
  expect(e.body).toMatch(/id="allegro-oferty-cenniki-0-waga"[^>]*value="25"/);
  expect(e.body).toMatch(/id="allegro-oferty-cenniki-0-cennik"[\s\S]*?<option value="cennik-a" selected>/);
  expect(e.body).toMatch(/id="allegro-oferty-cenniki-1-cennik"[\s\S]*?<option value="cennik-c" selected>/);
  expect(e.body).toMatch(/id="allegro-oferty-cenniki-wieksze"[\s\S]*?<option value="cennik-gabaryt" selected>/);
});

it('Allegro: wiersz bez wagi → 400 z błędem przy tym wierszu, wpisane wartości wracają, nic nie zapisane', async () => {
  const f = await allegro();
  const przed = f.ustawienia('legacy');
  const r = await f.req('POST', rootA + '/legacy/oferty', {
    ...poprawneA,
    ...tabela([['8', '38', '64', '25', 'cennik-a'], ['41', '38', '64', '', 'cennik-c'], PUSTY], 'cennik-gabaryt'),
  });
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('Podaj trzy wymiary w cm i wagę w kg');
  expect(r.body).toMatch(/<input[^>]*id="allegro-oferty-cenniki-1-waga"[^>]*aria-invalid="true"/);
  expect(r.body).not.toMatch(/<input[^>]*id="allegro-oferty-cenniki-0-waga"[^>]*aria-invalid/);
  expect(r.body).toMatch(/id="allegro-oferty-cenniki-1-a"[^>]*value="41"/);
  expect(f.ustawienia('legacy')).toEqual(przed);
});

it('Allegro: wiersze rozmiaru bez cennika „dla większych” → 400 przy tym polu, nic nie zapisane', async () => {
  const f = await allegro();
  const przed = f.ustawienia('legacy');
  const r = await f.req('POST', rootA + '/legacy/oferty', {
    ...poprawneA,
    ...tabela([['8', '38', '64', '25', 'cennik-a'], PUSTY, PUSTY], ''),
  });
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('Podaj cennik dla większych');
  expect(r.body).toMatch(/<select[^>]*name="cennikWiekszych"[^>]*aria-invalid="true"/);
  expect(f.ustawienia('legacy')).toEqual(przed);
});

it('Allegro: cennik spoza listy „Pobierz z Allegro” (w wierszu, „dla większych”, konto bez list) → odmowa, nic nie zapisane', async () => {
  const f = await allegro();
  const przed = f.ustawienia('legacy');
  const wWierszu = await f.req('POST', rootA + '/legacy/oferty', {
    ...poprawneA,
    ...tabela([['8', '38', '64', '25', 'cennik-obcy'], PUSTY, PUSTY], 'cennik-gabaryt'),
  });
  expect(wWierszu.statusCode).toBe(400);
  expect(wWierszu.body).toContain('Wybierz z listy pobranej z Allegro (cennik dostaw)');
  expect(wWierszu.body).toMatch(/<select[^>]*id="allegro-oferty-cenniki-0-cennik"[^>]*aria-invalid="true"/);
  const wieksze = await f.req('POST', rootA + '/legacy/oferty', {
    ...poprawneA,
    ...tabela([PUSTY, PUSTY], 'cennik-obcy'),
  });
  expect(wieksze.statusCode).toBe(400);
  expect(wieksze.body).toMatch(/<select[^>]*name="cennikWiekszych"[^>]*aria-invalid="true"/);
  expect(f.ustawienia('legacy')).toEqual(przed);
  const bezList = await f.req('POST', rootA + '/allegro_polcien/oferty', {
    ...poprawneA,
    ...tabela([PUSTY, PUSTY], 'cennik-a'),
  });
  expect(bezList.statusCode).toBe(400);
  expect(f.ustawienia('allegro_polcien').zapisane).toBe(false);
});

it('Allegro: konto po migracji magazyn/0003 pokazuje jedną regułę „wszystko” — sam cennik „dla większych”, puste wiersze; ponowny zapis jej nie zmienia', async () => {
  const f = await allegro();
  // Stan sprzed E3d.02: jedno pole cennik_dostaw, lista reguł pusta; migracja przepisuje je do jednej reguły.
  db!
    .prepare(
      "UPDATE oferty_ustawienia_kont SET cennik_dostaw = 'cennik-gabaryt', cenniki_json = NULL WHERE klucz = 'legacy'",
    )
    .run();
  migracjaCennikowDostaw.wykonaj(db!);
  expect(f.ustawienia('legacy').cenniki).toEqual([{ cennik: 'cennik-gabaryt' }]);
  const r = await f.req('GET', rootA + '/legacy/oferty');
  expect(r.body).toMatch(/id="allegro-oferty-cenniki-wieksze"[\s\S]*?<option value="cennik-gabaryt" selected>/);
  expect(ileRazy(r.body, /name="regulaCennik"/g)).toBe(2);
  expect(r.body).not.toMatch(/name="regula(A|B|C|Waga)"[^>]*value="[^"]/);
  expect(r.body).not.toMatch(/name="cennikDostaw"/);
  expect(
    (await f.req('POST', rootA + '/legacy/oferty', { ...poprawneA, ...tabela([PUSTY, PUSTY], 'cennik-gabaryt') }))
      .statusCode,
  ).toBe(303);
  expect(f.ustawienia('legacy').cenniki).toEqual([{ cennik: 'cennik-gabaryt' }]);
  expect(f.ustawienia('legacy').cennikDostaw).toBe('cennik-gabaryt'); // zapis reguł nie rusza kolumny cennik_dostaw
});

it('Allegro: pusta tabela i puste „dla większych” → 400 „Ustaw cennik dla większych”, reguły konta nietknięte', async () => {
  const f = await allegro();
  expect((await f.req('POST', rootA + '/legacy/oferty', { ...poprawneA, ...FORMULARZ_A })).statusCode).toBe(303);
  const r = await f.req('POST', rootA + '/legacy/oferty', {
    ...poprawneA,
    stalaIlosc: '9',
    ...tabela([PUSTY, PUSTY], ''),
  });
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('Ustaw cennik dla większych');
  expect(f.ustawienia('legacy')).toMatchObject({ cenniki: REGULY_A, stalaIlosc: 3 });
});

it('Allegro: formularz z regułami nie wysyła cennikDostaw; zbłąkane cennikDostaw ani stary formularz bez tabeli nie nadpisują reguł (alias D4)', async () => {
  const f = await allegro();
  expect((await f.req('POST', rootA + '/legacy/oferty', { ...poprawneA, ...FORMULARZ_A })).statusCode).toBe(303);
  const r = await f.req('GET', rootA + '/legacy/oferty');
  expect(r.body).not.toMatch(/name="cennikDostaw"/);
  expect(
    (await f.req('POST', rootA + '/legacy/oferty', { ...poprawneA, ...FORMULARZ_A, cennikDostaw: 'cennik-a' }))
      .statusCode,
  ).toBe(303);
  expect(f.ustawienia('legacy')).toMatchObject({ cenniki: REGULY_A, cennikDostaw: null });
  // Stary formularz (bez tabeli) przy koncie z regułami: strona otwarta przed zmianą — 409, nic nie zapisane.
  const stary = await f.req('POST', rootA + '/legacy/oferty', {
    ...poprawneA,
    stalaIlosc: '5',
    cennikDostaw: 'cennik-a',
  });
  expect(stary.statusCode).toBe(409);
  expect(stary.body).toContain('Strona była otwarta przed zmianą — odśwież');
  expect(f.ustawienia('legacy')).toMatchObject({ cenniki: REGULY_A, cennikDostaw: null, stalaIlosc: 3 });
});

// ——— ERLI ———
const rootE = '/ustawienia/integracje/erli';
const poprawneE = {
  narzutProcent: '12,5',
  progPotwierdzeniaProcent: '20',
  stalaIlosc: '7',
  czasWysylkiDni: '2',
  stawkaVat: '23',
};

async function erli() {
  db = openOmsDb();
  const env = {
    OMS_TRYB: 'proba',
    OMS_KANALY: '[]',
    OMS_USER: 'serwis',
    OMS_PASS: 'fixture',
    OMS_PROFORMY_KATALOG: path.join(os.tmpdir(), 'cenniki-krok-prz160e3d02-erli', 'proformy'),
    OMS_ETYKIETY_KATALOG: path.join(os.tmpdir(), 'cenniki-krok-prz160e3d02-erli', 'etykiety'),
  };
  const transport = vi.fn(async () => {
    throw new Error('Ten krok nie może wywołać ERLI');
  });
  const kanaly = createModulKanaly([], false, { fetchImpl: transport });
  a = await zbudujAplikacje({
    db,
    moduly: modulyPiaskownicy(env).map((m) => (m.nazwa === 'kanaly' ? kanaly : m)) as ModulOms[],
    env,
    log: () => {},
  });
  zalozKonto(db, { login: 'operator', imie: 'Operator', haslo: 'fixture', rola: 'administrator', admin: true });
  const cookie = 'sesja_oms_proba=' + podpisz('operator', wczytajSekret(db), Date.now());
  const s = a.usluga<any>('kanaly', 'sklepyErli');
  const wynik = await s.operacja(
    'nowe',
    'dane',
    {
      nazwa: 'Pracownia Półcień',
      adresApi: 'https://sandbox.erli.dev/svc/shop-api',
      kluczApi: 'atrapa-polcien',
      wersja: 0,
    },
    { id: 0, login: 'operator' },
  );
  const klucz = wynik.klucz;
  db.prepare("UPDATE kanaly_sprzedazy SET autoryzacja='polaczone' WHERE klucz=?").run(klucz);
  const req = (method: 'GET' | 'POST', payload?: Record<string, unknown>) =>
    a!.app.inject({
      method,
      url: rootE + '/' + klucz + (method === 'POST' ? '/oferty' : ''),
      payload: payload ? { wersja: s.pobierz(klucz).wersja, ...payload } : undefined,
      headers: { cookie, origin: 'http://localhost', accept: 'text/html' },
    });
  return { klucz, req, transport, ustawienia: () => ustawieniaOfertKonta(db!, klucz) };
}

it('ERLI: krok „Oferty” ma tabelę reguł z cennikiem jako tekstem dowolnym, wymagane „dla większych”, podpowiedź InPost, bez pola cennikDostaw', async () => {
  const f = await erli();
  const r = await f.req('GET');
  expect(r.statusCode).toBe(200);
  expect(r.body).not.toMatch(/name="cennikDostaw"/);
  expect(ileRazy(r.body, /<input[^>]*name="regulaCennik"/g)).toBe(2);
  expect(r.body).toMatch(/<input[^>]*name="cennikWiekszych"[^>]*required/);
  expect(r.body).toMatch(/<p[^>]*class="ust-pomoc"[^>]*>[^<]*A 8×38×64, B 19×38×64, C 41×38×64 cm, do 25 kg/);
  expect(f.transport).not.toHaveBeenCalled();
});

it('ERLI: zapis i odczyt reguł (cm z przecinkiem → mm, kg → g, cennik jako wpisany tekst)', async () => {
  const f = await erli();
  const r = await f.req('POST', {
    ...poprawneE,
    ...tabela(
      [
        ['8', '38', '64', '25', 'Pracownia Półcień — paczkomat A'],
        ['41,5', '38', '64', '2,5', 'paczkomat-c'],
        PUSTY,
        PUSTY,
      ],
      'kurier-gabaryt',
    ),
  });
  expect(r.statusCode).toBe(303);
  expect(f.ustawienia()).toMatchObject({
    stalaIlosc: 7,
    cennikDostaw: null,
    cenniki: [
      { doMm: [80, 380, 640], doG: 25000, cennik: 'Pracownia Półcień — paczkomat A' },
      { doMm: [415, 380, 640], doG: 2500, cennik: 'paczkomat-c' },
      { cennik: 'kurier-gabaryt' },
    ],
  });
  const e = await f.req('GET');
  expect(e.body).toMatch(/id="erli-oferty-cenniki-1-a"[^>]*value="41,5"/);
  expect(e.body).toMatch(/id="erli-oferty-cenniki-1-waga"[^>]*value="2,5"/);
  expect(e.body).toMatch(/name="cennikWiekszych"[^>]*value="kurier-gabaryt"/);
  expect(ileRazy(e.body, /name="regulaCennik"/g)).toBe(4);
  expect(f.transport).not.toHaveBeenCalled();
});

it('ERLI: wiersz bez wagi albo brak „dla większych” → 400 przy polu, nic nie zapisane', async () => {
  const f = await erli();
  const bezWagi = await f.req('POST', {
    ...poprawneE,
    ...tabela(
      [
        ['8', '38', '64', '25', 'paczkomat-a'],
        ['41', '38', '64', '', 'paczkomat-c'],
      ],
      'kurier-gabaryt',
    ),
  });
  expect(bezWagi.statusCode).toBe(400);
  expect(bezWagi.body).toMatch(/<input[^>]*id="erli-oferty-cenniki-1-waga"[^>]*aria-invalid="true"/);
  expect(bezWagi.body).toMatch(/id="erli-oferty-cenniki-1-a"[^>]*value="41"/);
  expect(f.ustawienia().zapisane).toBe(false);
  const bezWiekszych = await f.req('POST', { ...poprawneE, ...tabela([['8', '38', '64', '25', 'paczkomat-a']], '') });
  expect(bezWiekszych.statusCode).toBe(400);
  expect(bezWiekszych.body).toMatch(/<input[^>]*name="cennikWiekszych"[^>]*aria-invalid="true"/);
  expect(f.ustawienia().zapisane).toBe(false);
});

it('ERLI: pusta tabela i puste „dla większych” → 400; stary formularz z cennikDostaw bez tabeli → 409, reguły nietknięte (alias D4)', async () => {
  const f = await erli();
  // Konto bez reguł: formularz bez tabeli zapisuje pozostałe pola i niczego nie odmawia.
  expect((await f.req('POST', { ...poprawneE, stalaIlosc: '4' })).statusCode).toBe(303);
  expect(f.ustawienia()).toMatchObject({ cenniki: [], stalaIlosc: 4 });
  expect(
    (
      await f.req('POST', {
        ...poprawneE,
        ...tabela([['8', '38', '64', '25', 'paczkomat-a'], PUSTY], 'kurier-gabaryt'),
      })
    ).statusCode,
  ).toBe(303);
  const REGULY_E = [{ doMm: [80, 380, 640], doG: 25000, cennik: 'paczkomat-a' }, { cennik: 'kurier-gabaryt' }];
  expect(
    (
      await f.req('POST', {
        ...poprawneE,
        ...tabela([['8', '38', '64', '25', 'paczkomat-a'], PUSTY], 'kurier-gabaryt'),
        cennikDostaw: 'paczkomat-x',
      })
    ).statusCode,
  ).toBe(303);
  expect(f.ustawienia()).toMatchObject({ cenniki: REGULY_E, cennikDostaw: null });
  const pusta = await f.req('POST', { ...poprawneE, stalaIlosc: '9', ...tabela([PUSTY, PUSTY], '') });
  expect(pusta.statusCode).toBe(400);
  expect(pusta.body).toContain('Ustaw cennik dla większych');
  const stary = await f.req('POST', { ...poprawneE, stalaIlosc: '5', cennikDostaw: 'paczkomat-x' });
  expect(stary.statusCode).toBe(409);
  expect(stary.body).toContain('Strona była otwarta przed zmianą — odśwież');
  expect(f.ustawienia()).toMatchObject({ cenniki: REGULY_E, cennikDostaw: null, stalaIlosc: 7 });
  expect(f.transport).not.toHaveBeenCalled();
});
