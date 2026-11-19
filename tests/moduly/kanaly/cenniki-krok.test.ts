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
import { dodajCennikOms, ustawPowiazanieCennika } from '../../../src/oms/db/cenniki-oms.ts';

// Krok „Oferty” Allegro i ERLI — cenniki dostaw ustawia się w Magazyn → Cenniki; krok pokazuje tylko podsumowanie
// powiązań konta i nie czyta dawnych pól reguł. Bez sieci: listy Allegro zapisane wprost w bazie, transport ERLI
// rzuca przy każdym wywołaniu. Dane zmyślone („Pracownia Półcień”).

let a: Aplikacja | undefined, db: ReturnType<typeof openOmsDb> | undefined;
afterEach(async () => {
  await a?.app.close();
  db?.close();
  a = undefined;
  db = undefined;
  vi.restoreAllMocks();
});

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
  const def = ['legacy', 'allegro_lampy'].map((klucz) => ({
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
  // Listy „Pobierz z Allegro” tylko dla konta legacy; allegro_lampy list nie ma.
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

// ——— ERLI ———
const rootE = '/ustawienia/integracje/erli';
const poprawneE = {
  narzutProcent: '12,5',
  progPotwierdzeniaProcent: '20',
  stalaIlosc: '7',
  czasWysylkiDni: '2',
  stawkaVat: '23',
};

async function erli(cennikiDostaw?: string[]) {
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
  if (cennikiDostaw)
    db.prepare(
      "UPDATE konfiguracja_integracji SET ustawienia_json = json_set(ustawienia_json, '$.cennikiDostaw', json(?)) WHERE integracja = ?",
    ).run(JSON.stringify(cennikiDostaw), 'erli:' + klucz);
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

const powiazania = () =>
  db!.prepare('SELECT cennik_id, konto, cennik_kanalu FROM cenniki_dostaw_powiazania ORDER BY cennik_id, konto').all();
const ODNOSNIK = /<a href="\/magazyn\/cenniki">Ustaw w Magazyn → Cenniki<\/a>/;
const POLA_REGUL = /name="(regula|cennikWiekszych|cennikDostaw)/;
// Pola dawnej tabeli reguł, które może jeszcze wysłać strona otwarta przed zmianą.
const DAWNE_POLA = {
  regulaA: ['8', ''],
  regulaB: ['38', ''],
  regulaC: ['64', ''],
  regulaWaga: ['25', ''],
  regulaCennik: ['cennik-c', ''],
  'regula-0-cennik': 'cennik-c',
  cennikWiekszych: 'cennik-a',
  cennikDostaw: 'cennik-a',
};

it('Allegro: krok „Oferty” zamiast tabeli reguł pokazuje podsumowanie cenników OMS konta i odnośnik do Magazynu', async () => {
  const f = await allegro();
  const pusty = await f.req('GET', rootA + '/allegro_lampy/oferty');
  expect(pusty.statusCode).toBe(200);
  expect(pusty.body).toContain('Konto nie ma powiązanego cennika dostaw.');
  expect(pusty.body).toMatch(ODNOSNIK);
  expect(pusty.body).not.toMatch(POLA_REGUL);
  zapiszUstawieniaOfertKonta(db!, 'legacy', {
    cenniki: [{ doMm: [640, 380, 80], doG: 25000, cennik: 'cennik-a' }, { cennik: 'cennik-gabaryt' }],
  });
  zapiszUstawieniaOfertKonta(db!, 'allegro_lampy', { cenniki: [{ cennik: 'lampy-kurier' }] });
  const r = await f.req('GET', rootA + '/legacy/oferty');
  expect(r.body).toContain(
    'Cennik dostaw: 2 cenniki OMS mają powiązanie z tym kontem (domyślny: „Domyślny” → Pracownia Półcień — kurier gabaryt).',
  );
  expect(r.body).toMatch(ODNOSNIK);
  expect(r.body).not.toMatch(POLA_REGUL);
  // Konto bez list „Pobierz z Allegro” pokazuje identyfikator cennika kanału.
  expect((await f.req('GET', rootA + '/allegro_lampy/oferty')).body).toContain(
    'Cennik dostaw: 1 cennik OMS ma powiązanie z tym kontem (domyślny: „Domyślny” → lampy-kurier).',
  );
  expect(f.calls.filter((u) => !u.includes('/order/checkout-forms?'))).toEqual([]);
});

it('Allegro: zapis kroku z dawnymi polami reguł zapisuje resztę i nie rusza żadnego powiązania cennika', async () => {
  const f = await allegro();
  zapiszUstawieniaOfertKonta(db!, 'legacy', {
    cenniki: [{ doMm: [640, 380, 80], doG: 25000, cennik: 'cennik-a' }, { cennik: 'cennik-gabaryt' }],
  });
  const przed = powiazania();
  expect(przed).toHaveLength(2);
  const r = await f.req('POST', rootA + '/legacy/oferty', { ...poprawneA, ...DAWNE_POLA });
  expect(r.statusCode).toBe(303);
  expect(powiazania()).toEqual(przed);
  expect(f.ustawienia('legacy')).toMatchObject({ stalaIlosc: 3, czasWysylkiDni: 2 });
  // Konto bez powiązań: dawne pola też niczego nie zakładają.
  expect((await f.req('POST', rootA + '/allegro_lampy/oferty', { ...poprawneA, ...DAWNE_POLA })).statusCode).toBe(303);
  expect(powiazania()).toEqual(przed);
});

it('ERLI: krok „Oferty” pokazuje podsumowanie cenników OMS konta, bez pól reguł i bez napisów o kroku 3', async () => {
  const f = await erli(['Lampy — paczkomat', 'Lampy — kurier']);
  const pusty = await f.req('GET');
  expect(pusty.statusCode).toBe(200);
  expect(pusty.body).toContain('Konto nie ma powiązanego cennika dostaw.');
  expect(pusty.body).toMatch(ODNOSNIK);
  expect(pusty.body).not.toMatch(POLA_REGUL);
  expect(pusty.body).not.toMatch(/pobierz metody ponownie|Listę cenników OMS pobiera/i);
  // Powiązany sam cennik rozmiaru — domyślny nie ma powiązania z tym kontem.
  const mala = dodajCennikOms(db!, { nazwa: 'Mała paczka', doMm: [640, 380, 80], doG: 25000 });
  ustawPowiazanieCennika(db!, { cennikId: mala, konto: f.klucz, cennikKanalu: 'Lampy — paczkomat' });
  expect((await f.req('GET')).body).toContain(
    'Cennik dostaw: 1 cennik OMS ma powiązanie z tym kontem (cennik domyślny nie ma powiązania z tym kontem).',
  );
  zapiszUstawieniaOfertKonta(db!, f.klucz, {
    cenniki: [{ doMm: [640, 380, 80], doG: 25000, cennik: 'Lampy — paczkomat' }, { cennik: 'Lampy — kurier' }],
  });
  const r = await f.req('GET');
  expect(r.body).toContain(
    'Cennik dostaw: 2 cenniki OMS mają powiązanie z tym kontem (domyślny: „Domyślny” → Lampy — kurier).',
  );
  expect(f.transport).not.toHaveBeenCalled();
});

it('ERLI: zapis kroku z dawnymi polami reguł zapisuje resztę i nie rusza żadnego powiązania cennika', async () => {
  const f = await erli(['Lampy — paczkomat', 'Lampy — kurier']);
  zapiszUstawieniaOfertKonta(db!, f.klucz, {
    cenniki: [{ doMm: [640, 380, 80], doG: 25000, cennik: 'Lampy — paczkomat' }, { cennik: 'Lampy — kurier' }],
  });
  const przed = powiazania();
  expect(przed).toHaveLength(2);
  const r = await f.req('POST', { ...poprawneE, ...DAWNE_POLA, cennikWiekszych: 'Lampy — paczkomat' });
  expect(r.statusCode).toBe(303);
  expect(powiazania()).toEqual(przed);
  expect(f.ustawienia()).toMatchObject({ stalaIlosc: 7, czasWysylkiDni: 2 });
  expect(f.transport).not.toHaveBeenCalled();
});
