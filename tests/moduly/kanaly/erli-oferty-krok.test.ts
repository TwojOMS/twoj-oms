import { afterEach, expect, it, vi } from 'vitest';
import { zbudujAplikacje, type Aplikacja } from '../../../src/core/aplikacja.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyPiaskownicy } from '../../../deploy/proba/atrapy/index.mjs';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { ustawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import { przelaczStany } from '../../../src/oms/db/stany-magazynowe.js';
import type { ModulOms } from '../../../src/core/kontrakty.ts';
import { createModulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import os from 'node:os';
import path from 'node:path';
let a: Aplikacja, db: ReturnType<typeof openOmsDb>;
afterEach(async () => {
  await a?.app.close();
  db?.close();
});
const root = '/ustawienia/integracje/erli';
const poprawne = {
  narzutProcent: '12,5',
  progPotwierdzeniaProcent: '20',
  stalaIlosc: '7',
  czasWysylkiDni: '2',
  // Dawne pole reguł: zapis kroku je pomija, cenniki konta zostają bez zmian.
  cennikWiekszych: 'demo-cennik',
  stawkaVat: '23',
};
async function setup(admin = true) {
  db = openOmsDb();
  const env = {
    OMS_TRYB: 'proba',
    OMS_KANALY: '[]',
    OMS_USER: 'serwis',
    OMS_PASS: 'fixture',
    OMS_PROFORMY_KATALOG: path.join(os.tmpdir(), 'erli-oferty-krok-prz160e2', 'proformy'),
    OMS_ETYKIETY_KATALOG: path.join(os.tmpdir(), 'erli-oferty-krok-prz160e2', 'etykiety'),
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
  zalozKonto(db, { login: 'operator', imie: 'Operator', haslo: 'fixture', rola: 'administrator', admin });
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
  const req = (method: 'GET' | 'POST', payload?: Record<string, unknown>) =>
    a.app.inject({
      method,
      url: root + '/' + klucz + (method === 'POST' ? '/oferty' : ''),
      payload: payload ? { wersja: s.pobierz(klucz).wersja, ...payload } : undefined,
      headers: { cookie, origin: 'http://localhost', accept: 'text/html' },
    });
  return { klucz, req, s, transport };
}
it('renderuje Oferty po nadawaniu, ilość pusta i opcjonalna, domyślnie wstrzymane i próg 20%', async () => {
  const f = await setup();
  db.prepare("UPDATE kanaly_sprzedazy SET autoryzacja='polaczone' WHERE klucz=?").run(f.klucz);
  const r = await f.req('GET');
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('id="erli-oferty"');
  const pole = r.body.match(/<input[^>]*name="stalaIlosc"[^>]*>/)?.[0];
  expect(pole).toMatch(/value=""[^>]*min="1" max="1000000" step="1"/);
  expect(pole).not.toMatch(/\brequired\b/);
  expect(r.body).toMatch(/name="progPotwierdzeniaProcent"[^>]*value="20"/);
  expect(r.body).toMatch(/value="wstrzymane"[^>]*checked/);
  expect(r.body).toContain('sprawdź w panelu ERLI, czy klucz ma zakres product');
  expect(ustawieniaOfertKonta(db, f.klucz).czynne).toBe(false);
  expect(f.transport).not.toHaveBeenCalled();
});
it.each([
  [
    false,
    'Stała liczba sztuk',
    'Tyle sztuk OMS wpisze w każdej ofercie ERLI. Po sprzedaży przywraca tę liczbę, więc oferta się nie wyprzedaje. Przy towarze robionym na zamówienie wpisz zapas, np. 50 — to też najwięcej, ile klient kupi w jednym zamówieniu. Możesz zostawić puste i uzupełnić przy wystawianiu oferty.',
  ],
  [
    true,
    'Stała liczba sztuk (gdy stany magazynowe są wyłączone)',
    'Używana tylko wtedy, gdy stany magazynowe są wyłączone. Przy włączonych OMS wysyła stan karty pomniejszony o bufor.',
  ],
])('wiąże pomoc ze stałą liczbą sztuk (stany magazynowe kiedykolwiek włączone: %s)', async (stany, etykieta, pomoc) => {
  const f = await setup();
  db.prepare("UPDATE kanaly_sprzedazy SET autoryzacja='polaczone' WHERE klucz=?").run(f.klucz);
  if (stany) przelaczStany(db, { wlacz: true, at: '2026-11-18T08:00:00Z' });
  const r = await f.req('GET');
  expect(r.body).toMatch(
    /<input[^>]*name="stalaIlosc"[^>]*aria-describedby="erli-oferty-stalaIlosc-pomoc"><br><span id="erli-oferty-stalaIlosc-pomoc" class="ust-pomoc">/,
  );
  expect(r.body).toContain(`<label for="erli-oferty-stalaIlosc">${etykieta}</label>`);
  expect(r.body).toContain(`id="erli-oferty-stalaIlosc-pomoc" class="ust-pomoc">${pomoc}</span>`);
});
it('wiąże pomoc i komunikat błędu z nieprawidłową stałą liczbą sztuk', async () => {
  const f = await setup();
  const r = await f.req('POST', { ...poprawne, stalaIlosc: '0' });
  expect(r.body).toMatch(
    /name="stalaIlosc"[^>]*aria-describedby="erli-oferty-stalaIlosc-pomoc erli-oferty-stalaIlosc-blad"/,
  );
});
it.each([false, true])(
  'pokazuje czas wysyłki ofert w dniach roboczych jako opcjonalny (historia stanów: %s)',
  async (stany) => {
    const f = await setup();
    db.prepare("UPDATE kanaly_sprzedazy SET autoryzacja='polaczone' WHERE klucz=?").run(f.klucz);
    if (stany) przelaczStany(db, { wlacz: true, at: '2026-11-18T08:00:00Z' });
    const r = await f.req('GET');
    const pole = r.body.match(/<input[^>]*name="czasWysylkiDni"[^>]*>/)?.[0];
    expect(pole).toMatch(/min="0" max="365" step="1" aria-describedby="erli-oferty-czasWysylkiDni-pomoc"/);
    expect(pole).not.toMatch(/\brequired\b/);
    expect(r.body).toContain('<label for="erli-oferty-czasWysylkiDni">Czas wysyłki w dniach roboczych</label>');
    expect(r.body).toContain(
      'id="erli-oferty-czasWysylkiDni-pomoc" class="ust-pomoc">Obietnica dla kupującego: w ciągu tylu dni roboczych od zakupu wyślesz paczkę. OMS wpisuje ją w każdą ofertę ERLI i od niej liczy termin wysyłki zamówienia. Przy towarze robionym na zamówienie wpisz realny czas produkcji z zapasem. Możesz zostawić puste i uzupełnić przy wystawianiu oferty.</span>',
    );
  },
);
it('wyjaśnia, kiedy używany jest domyślny czas wysyłki z danych sklepu', async () => {
  const f = await setup();
  const r = await f.req('GET');
  expect(r.body).toMatch(/name="domyslnyCzasWysylki"[^>]*aria-describedby="erli-czas-pomoc"/);
  expect(r.body).toContain(
    'id="erli-czas-pomoc">Nie trafia do ofert — czas w ofertach ustawiasz w kroku „Oferty”. Ten służy tylko zamówieniom z ofert założonych ręcznie w ERLI bez czasu wysyłki: OMS policzy z niego termin. Puste pole zostawia wtedy termin nieustalony.</span>',
  );
});
it('zapisuje pusty czas wysyłki ofert jako NULL', async () => {
  const f = await setup();
  expect((await f.req('POST', poprawne)).statusCode).toBe(303);
  expect((await f.req('POST', { ...poprawne, czasWysylkiDni: '' })).statusCode).toBe(303);
  expect(ustawieniaOfertKonta(db, f.klucz).czasWysylkiDni).toBeNull();
});
it('zapisuje 12,5 jako 1250 bp i wszystkie pola bez wywołania ERLI', async () => {
  const f = await setup();
  const r = await f.req('POST', { ...poprawne, czynne: 'czynne' });
  expect(r.statusCode).toBe(303);
  expect(ustawieniaOfertKonta(db, f.klucz)).toMatchObject({
    narzutBp: 1250,
    progPotwierdzeniaBp: 2000,
    stalaIlosc: 7,
    czasWysylkiDni: 2,
    cenniki: [],
    stawkaVat: '23',
    czynne: true,
    aktorLogin: 'operator',
  });
  expect((await f.req('POST', poprawne)).statusCode).toBe(303);
  expect(ustawieniaOfertKonta(db, f.klucz).czynne).toBe(false);
  expect(f.transport).not.toHaveBeenCalled();
});
it('zapisuje pustą ilość jako NULL razem z pozostałymi ustawieniami', async () => {
  const f = await setup();
  expect((await f.req('POST', poprawne)).statusCode).toBe(303);
  const r = await f.req('POST', { ...poprawne, stalaIlosc: '' });
  expect(r.statusCode).toBe(303);
  expect(ustawieniaOfertKonta(db, f.klucz)).toMatchObject({
    zapisane: true,
    stalaIlosc: null,
    narzutBp: 1250,
    progPotwierdzeniaBp: 2000,
    czasWysylkiDni: 2,
    cenniki: [],
    stawkaVat: '23',
  });
});
it('zapisuje krok „Oferty” z pustymi polami i przywraca domyślny narzut oraz próg', async () => {
  const f = await setup();
  db.prepare("UPDATE kanaly_sprzedazy SET autoryzacja='polaczone' WHERE klucz=?").run(f.klucz);
  expect((await f.req('POST', { ...poprawne, progPotwierdzeniaProcent: '35' })).statusCode).toBe(303);
  const r = await f.req('POST', {
    narzutProcent: '',
    progPotwierdzeniaProcent: ' ',
    stalaIlosc: '',
    czasWysylkiDni: '',
    cennikWiekszych: '',
    stawkaVat: '',
  });
  expect(r.statusCode).toBe(303);
  expect(ustawieniaOfertKonta(db, f.klucz)).toMatchObject({
    zapisane: true,
    narzutBp: 0,
    progPotwierdzeniaBp: 2000,
    stalaIlosc: null,
    czasWysylkiDni: null,
    cenniki: [],
    stawkaVat: null,
  });
  expect((await f.req('GET')).statusCode).toBe(200);
  expect(f.transport).not.toHaveBeenCalled();
});
it('brak pola narzutu w ciele to nie puste pole — odmowa zamiast cichego 0%', async () => {
  const f = await setup();
  const { narzutProcent: _, ...bezNarzutu } = poprawne;
  expect((await f.req('POST', bezNarzutu)).statusCode).toBe(400);
  expect(ustawieniaOfertKonta(db, f.klucz).zapisane).toBe(false);
});
it.each([
  ['narzutProcent', '12,555'],
  ['narzutProcent', '-1'],
  ['progPotwierdzeniaProcent', '0'],
  ['stalaIlosc', '0'],
  ['czasWysylkiDni', '366'],
  ['stawkaVat', '99'],
])('walidacja E2.01 odrzuca %s=%s bez częściowego zapisu', async (pole, wartosc) => {
  const f = await setup();
  const r = await f.req('POST', { ...poprawne, [pole]: wartosc });
  expect(r.statusCode).toBe(400);
  expect(r.body).toMatch(new RegExp('name="' + pole + '"[^>]*aria-invalid="true"'));
  expect(ustawieniaOfertKonta(db, f.klucz).zapisane).toBe(false);
});
it('nie-admin dostaje 403 bez zapisu', async () => {
  const f = await setup(false);
  expect((await f.req('POST', poprawne)).statusCode).toBe(403);
  expect(ustawieniaOfertKonta(db, f.klucz).zapisane).toBe(false);
});
it.each(['narzutProcent', 'progPotwierdzeniaProcent', 'stalaIlosc', 'czasWysylkiDni'])(
  'odrzuca zapis wykładniczy i szesnastkowy w %s',
  async (pole) => {
    const f = await setup();
    for (const wartosc of ['1e2', '0x10']) {
      const r = await f.req('POST', { ...poprawne, [pole]: wartosc });
      expect(r.statusCode).toBe(400);
      expect(r.body).toMatch(new RegExp('name="' + pole + '"[^>]*aria-invalid="true"'));
      expect(ustawieniaOfertKonta(db, f.klucz).zapisane).toBe(false);
    }
  },
);
it('ilość ponad 1000000 dostaje komunikat zakresu, bez sugestii pustego pola', async () => {
  const f = await setup();
  const r = await f.req('POST', { ...poprawne, stalaIlosc: '1000001' });
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('Stała ilość musi być liczbą całkowitą od 1 do 1000000');
  expect(r.body).not.toContain('albo pusta');
  expect(ustawieniaOfertKonta(db, f.klucz).zapisane).toBe(false);
});
it('zerowa ilość odsyła do „Zdejmij” (D55), bez sugestii pustego pola', async () => {
  const f = await setup();
  const r = await f.req('POST', { ...poprawne, stalaIlosc: '0' });
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('0 sztuk = zdejmij ofertę przyciskiem „Zdejmij”');
  expect(r.body).not.toContain('albo pusta');
  expect(ustawieniaOfertKonta(db, f.klucz).zapisane).toBe(false);
});
it('po zapisie ekran pokazuje zapisane ustawienia, a nie domyślne', async () => {
  const f = await setup();
  db.prepare("UPDATE kanaly_sprzedazy SET autoryzacja='polaczone' WHERE klucz=?").run(f.klucz);
  expect((await f.req('POST', { ...poprawne, czynne: 'czynne' })).statusCode).toBe(303);
  const r = await f.req('GET');
  expect(r.statusCode).toBe(200);
  expect(r.body).toMatch(/name="narzutProcent"[^>]*value="12[,.]5"/);
  expect(r.body).toMatch(/name="stalaIlosc"[^>]*value="7"/);
  expect(r.body).not.toMatch(/name="cennikWiekszych"/);
  expect(r.body).not.toMatch(/name="cennikDostaw"/);
  expect(r.body).toMatch(/value="czynne"[^>]*checked/);
  expect(r.body).not.toMatch(/value="wstrzymane"[^>]*checked/);
});
