import { afterEach, expect, it } from 'vitest';
import { zbudujAplikacje, type Aplikacja } from '../../../src/core/aplikacja.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyPiaskownicy } from '../../../deploy/proba/atrapy/index.mjs';
import { createModulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import type { ModulOms } from '../../../src/core/kontrakty.ts';
import { ustawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import { przelaczStany } from '../../../src/oms/db/stany-magazynowe.js';
import { MODUL_WOO } from '../../../src/domena/modul-woo.ts';

// Narzut i próg potwierdzenia zmiany ceny w ustawieniach sklepu Woo. Sklep atrapa „Pracownia Półcień”, bez sieci.

let a: Aplikacja | undefined, db: ReturnType<typeof openOmsDb> | undefined;
afterEach(async () => {
  await a?.app.close();
  db?.close();
  a = undefined;
  db = undefined;
});
const env = {
  OMS_USER: 'serwis',
  OMS_PASS: 'fixture',
  OMS_TRYB: 'proba',
  OMS_KANALY: '[]',
  OMS_SPRZEDAWCA_NIP: '1234563218',
  OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: '/tmp/woo-narzut-proformy',
  OMS_ETYKIETY_KATALOG: '/tmp/woo-narzut-etykiety',
};
const PODPOWIEDZ_NARZUTU = 'Cena w sklepie = cena z karty + narzut. Ręczną cenę ustawisz na karcie.';
const BLAD_NARZUTU = 'Narzut (%) musi być liczbą od 0 do 1000 z najwyżej dwoma miejscami po przecinku';
const BLAD_PROGU =
  'Próg potwierdzenia ceny (%) musi być liczbą od 0.01 do 1000 z najwyżej dwoma miejscami po przecinku';

async function woo() {
  const root = MODUL_WOO.konfigurator.sciezka;
  const m = createModulKanaly([], false, {
    fetchImpl: async (u) => {
      const url = String(u);
      if (url.includes('/shipping/zones/'))
        return Response.json([{ instance_id: 1, title: 'Kurier Półcień', method_id: 'flat_rate', enabled: true }]);
      if (url.includes('/shipping/zones')) return Response.json([{ id: 1, name: 'Polska' }]);
      if (url.includes('/payment_gateways'))
        return Response.json([{ id: 'cod', title: 'Za pobraniem', enabled: true }]);
      return Response.json([]);
    },
  });
  const config = createModulKanaly([]).konfiguracja(env);
  db = openOmsDb();
  a = await zbudujAplikacje({
    db,
    moduly: modulyPiaskownicy(env).map((x) =>
      x.nazwa === 'kanaly' ? { ...m, konfiguracja: () => config } : x,
    ) as ModulOms[],
    env,
    teraz: () => new Date('2026-11-14T12:00:00Z'),
    log: () => {},
  });
  zalozKonto(db, { login: 'admin', imie: 'Administrator', haslo: 'fixture', rola: 'administrator', admin: true });
  zalozKonto(db, {
    login: 'operator',
    imie: 'Operator',
    haslo: 'fixture',
    rola: 'sprzedaz',
    ekrany: ['ustawienia'],
  } as any);
  const cookie = (login: string) => 'sesja_oms_proba=' + podpisz(login, wczytajSekret(db!), Date.now());
  const c = { admin: cookie('admin'), operator: cookie('operator') };
  const req = (
    method: 'GET' | 'POST',
    url: string,
    payload?: Record<string, unknown>,
    o: { cookie?: string; origin?: string | null } = {},
  ) =>
    a!.app.inject({
      method,
      url,
      payload: payload
        ? new URLSearchParams(Object.entries(payload).map(([k, v]) => [k, String(v)])).toString()
        : undefined,
      headers: {
        cookie: o.cookie ?? c.admin,
        ...(payload ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(o.origin === null ? {} : { origin: o.origin ?? 'http://localhost' }),
      },
    });
  async function sklep(aktywny = true, nazwa = 'Pracownia Półcień') {
    const p = await req('POST', root + '/szkice', {
      nazwa,
      adres: 'https://' + (aktywny ? 'sklep' : 'szkic') + '.polcien.example',
    });
    const formularzId = p.body.match(/name="formularzId" value="([^"]+)"/)?.[1];
    const w = await req('POST', root + '/nowy/klucze', {
      formularzId,
      wersja: 0,
      ck: 'ck_test_polcien',
      cs: 'cs_test_polcien',
    });
    expect(w.statusCode).toBe(303);
    const klucz = decodeURIComponent(String(w.headers.location).slice(root.length + 1));
    if (aktywny) db!.prepare("UPDATE kanaly_sprzedazy SET autoryzacja='polaczone' WHERE klucz=?").run(klucz);
    return klucz;
  }
  const adres = (k: string) => root + '/' + encodeURIComponent(k);
  const wersja = (k: string) => (db!.prepare('SELECT wersja FROM kanaly_sprzedazy WHERE klucz=?').get(k) as any).wersja;
  const ceny = (k: string, p: Record<string, unknown>, o?: { cookie?: string; origin?: string | null }) =>
    req('POST', adres(k) + '/ceny', { wersja: wersja(k), ...p }, o);
  const stany = (k: string, p: Record<string, unknown>) =>
    req('POST', adres(k) + '/stany', { wersja: wersja(k), ...p });
  return { req, sklep, adres, ceny, stany, c, wersja };
}

it('pola narzutu i progu widać zawsze — bez stanów magazynowych, także w szkicu sklepu; domyślnie 0% i 50%', async () => {
  const f = await woo();
  for (const aktywny of [true, false]) {
    const k = await f.sklep(aktywny, aktywny ? 'Pracownia Półcień' : 'Półcień — szkic');
    const r = await f.req('GET', f.adres(k));
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<form method="post" action="' + f.adres(k) + '/ceny"');
    expect(r.body).toMatch(
      /<input id="woo-ceny-narzutProcent" type="text" name="narzutProcent" inputmode="decimal" value="0"/,
    );
    expect(r.body).toMatch(
      /<input id="woo-ceny-progPotwierdzeniaProcent" type="text" name="progPotwierdzeniaProcent" inputmode="decimal" value="50"/,
    );
    expect(r.body).toContain('Próg potwierdzenia zmiany ceny %');
    expect(r.body).toContain(PODPOWIEDZ_NARZUTU);
  }
});

it('„12,5” → narzut 1250 bp, „50” → próg 5000 bp; zapis bez zmiany wersji sklepu i bez ruszania progów stanów', async () => {
  const f = await woo();
  przelaczStany(db!, { wlacz: true, at: '2026-11-10T08:00:00Z' });
  const k = await f.sklep();
  expect((await f.stany(k, { czynne: 'czynne', buforSzt: '2', progSkokuSzt: '7' })).statusCode).toBe(303);
  const v = f.wersja(k);
  const z = await f.ceny(k, { narzutProcent: '12,5', progPotwierdzeniaProcent: '50' });
  expect(z.statusCode).toBe(303);
  expect(ustawieniaOfertKonta(db!, k)).toMatchObject({
    narzutBp: 1250,
    progPotwierdzeniaBp: 5000,
    czynne: true,
    buforSzt: 2,
    progSkokuSzt: 7,
    aktorLogin: 'admin',
  });
  expect(f.wersja(k)).toBe(v);
  const r = await f.req('GET', f.adres(k));
  expect(r.body).toMatch(/name="narzutProcent" inputmode="decimal" value="12,5"/);
  expect(r.body).toMatch(/name="progPotwierdzeniaProcent" inputmode="decimal" value="50"/);
});

it('puste pole progu → 5000 bp, puste pole narzutu → 0', async () => {
  const f = await woo();
  const k = await f.sklep();
  expect((await f.ceny(k, { narzutProcent: '8', progPotwierdzeniaProcent: '30' })).statusCode).toBe(303);
  expect((await f.ceny(k, { narzutProcent: '', progPotwierdzeniaProcent: ' ' })).statusCode).toBe(303);
  expect(ustawieniaOfertKonta(db!, k)).toMatchObject({ narzutBp: 0, progPotwierdzeniaBp: 5000 });
});

it('zapis samego narzutu nie zmienia progu, zapis samego progu nie zmienia narzutu', async () => {
  const f = await woo();
  const k = await f.sklep();
  expect((await f.ceny(k, { narzutProcent: '10', progPotwierdzeniaProcent: '30' })).statusCode).toBe(303);
  expect((await f.ceny(k, { narzutProcent: '15' })).statusCode).toBe(303);
  expect(ustawieniaOfertKonta(db!, k)).toMatchObject({ narzutBp: 1500, progPotwierdzeniaBp: 3000 });
  expect((await f.ceny(k, { progPotwierdzeniaProcent: '25,5' })).statusCode).toBe(303);
  expect(ustawieniaOfertKonta(db!, k)).toMatchObject({ narzutBp: 1500, progPotwierdzeniaBp: 2550 });
});

it('pierwszy zapis stanów zakłada konto z progiem ceny Woo 50%, nie 20%', async () => {
  const f = await woo();
  przelaczStany(db!, { wlacz: true, at: '2026-11-10T08:00:00Z' });
  const k = await f.sklep();
  expect((await f.stany(k, { czynne: 'wstrzymane', buforSzt: '0', progSkokuSzt: '5' })).statusCode).toBe(303);
  expect(ustawieniaOfertKonta(db!, k)).toMatchObject({ zapisane: true, narzutBp: 0, progPotwierdzeniaBp: 5000 });
});

it('granice: narzut 0 i 1000% przechodzą, 1000,01% nie; próg 1000% przechodzi, 0% nie', async () => {
  const f = await woo();
  const k = await f.sklep();
  expect((await f.ceny(k, { narzutProcent: '0', progPotwierdzeniaProcent: '1000' })).statusCode).toBe(303);
  expect(ustawieniaOfertKonta(db!, k)).toMatchObject({ narzutBp: 0, progPotwierdzeniaBp: 100000 });
  expect((await f.ceny(k, { narzutProcent: '1000', progPotwierdzeniaProcent: '0,01' })).statusCode).toBe(303);
  expect(ustawieniaOfertKonta(db!, k)).toMatchObject({ narzutBp: 100000, progPotwierdzeniaBp: 1 });
  const za = await f.ceny(k, { narzutProcent: '1000,01', progPotwierdzeniaProcent: '50' });
  expect(za.statusCode).toBe(400);
  expect(za.body).toContain(BLAD_NARZUTU);
  const zero = await f.ceny(k, { narzutProcent: '5', progPotwierdzeniaProcent: '0' });
  expect(zero.statusCode).toBe(400);
  expect(zero.body).toContain(BLAD_PROGU);
  expect(zero.body).toMatch(/id="woo-ceny-progPotwierdzeniaProcent"[^>]* aria-invalid="true"/);
  expect(ustawieniaOfertKonta(db!, k)).toMatchObject({ narzutBp: 100000, progPotwierdzeniaBp: 1 });
});

it('„abc” → odmowa z napisem przy polu, wpisana wartość zostaje, nic nie zapisane', async () => {
  const f = await woo();
  const k = await f.sklep();
  const z = await f.ceny(k, { narzutProcent: 'abc', progPotwierdzeniaProcent: '40' });
  expect(z.statusCode).toBe(400);
  expect(z.body).toContain(BLAD_NARZUTU);
  expect(z.body).toMatch(/id="woo-ceny-narzutProcent"[^>]* value="abc"[^>]* aria-invalid="true"/);
  expect(ustawieniaOfertKonta(db!, k).zapisane).toBe(false);
});

it('zapis bez Origin → 403, operator bez roli administratora → 403; nic nie zapisane', async () => {
  const f = await woo();
  const k = await f.sklep();
  expect((await f.ceny(k, { narzutProcent: '5' }, { origin: null })).statusCode).toBe(403);
  expect((await f.ceny(k, { narzutProcent: '5' }, { cookie: f.c.operator })).statusCode).toBe(403);
  expect(ustawieniaOfertKonta(db!, k).zapisane).toBe(false);
});
