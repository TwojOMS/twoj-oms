// Liczby przy statusach w bocznym menu znikały na stronach rysowanych w odpowiedzi na POST
// (krok formularza, podgląd, formularz z błędem): wspólny potok liczył je z góry tylko przy GET.
// Teraz liczy je przy każdym renderze pełnej strony z menu — bez względu na metodę i kod odpowiedzi —
// a fragmenty, przekierowania i odpowiedzi JSON indeksu nie odświeżają wcale.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../src/oms/db/zamowienia.js';
import { indeksListy } from '../../src/oms/db/indeks-listy.js';
import { buildOmsServer } from '../pomoc/serwer-testowy-oms.ts';

const naglowek = {
  accept: 'text/html',
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};
const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
const gus = { firmaPoNip: async () => null };

const zmapowane = (nr, status = 'processing') => ({
  zrodlo_id: nr,
  numer: `Z-${nr}`,
  klient: { first_name: 'Ala', last_name: 'Lampowa', email: 'ala@lampowo.test' },
  dostawa: {},
  metoda_wysylki: 'dpd',
  kwota_pobrania: null,
  chce_fakture: 0,
  nip: null,
  kwota_brutto: '89.00',
  status_woo: status,
  oplacone_at: null,
  anulowane: 0,
  utworzone_at: new Date().toISOString(),
  pozycje: [],
});

const formularz = (nad = {}) => ({
  w_nazwa: 'Ala Lampowa',
  w_ulica: 'Świetlna 2',
  w_kod: '00-001',
  w_miasto: 'Lampowo',
  dostawa: 'dpd',
  platnosc: 'przelew',
  koszt_dostawy_brutto: '19,00',
  poz_nazwa: 'Lampa stołowa Półcień',
  poz_ilosc: '1',
  poz_cena_brutto: '189.00',
  poz_sku: '',
  poz_cena_netto: '',
  ...nad,
});

// Liczniki z menu KOMPUTEROWEGO: klucz statusu → tekst licznika.
const liczniki = (html) => {
  const bok = html.slice(
    html.indexOf('<div class="oms-menu-desktop">'),
    html.indexOf('<details class="oms-menu-mobile"'),
  );
  return Object.fromEntries(
    [...bok.matchAll(/<span class="licznik" data-status="([a-z_]+)">([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]),
  );
};

let db;
let app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  for (const n of [1, 2, 3]) zapiszZamowienie(db, 'pro', zmapowane(n), {});
  zapiszZamowienie(db, 'pro', zmapowane(4, 'cancelled'), {});
  app = buildOmsServer({ db, config, poller, gus });
  await app.ready();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  db.close();
});

const wyslij = (method, url, payload) => app.inject({ method, url, headers: naglowek, payload });
const wzor = async () => liczniki((await wyslij('GET', '/?wszystkie=1')).body);

describe('liczby statusów w menu na stronach rysowanych po POST', () => {
  it('lista zamówień ma liczby (punkt odniesienia)', async () => {
    const w = await wzor();
    expect(w.wszystkie).toBe('4');
    expect(Object.keys(w).length).toBeGreaterThan(3);
  });

  it.each([
    ['/zamowienia/nowe/wiersz/dodaj', formularz(), 200],
    ['/klienci/gus', { f_nip: '1234500028', nazwa: '' }, 200],
    ['/magazyn/oferty/podglad', {}, 400],
    ['/zamowienia/masowe/nadaj-podglad', { id: ['1', '2'] }, 200],
  ])('POST %s pokazuje te same liczby co lista', async (url, payload, kod) => {
    const w = await wzor();
    const r = await wyslij('POST', url, payload);
    expect(r.statusCode, r.body.slice(0, 300)).toBe(kod);
    expect(liczniki(r.body)).toEqual(w);
  });

  it('karta zamówienia pokazuje te same liczby co lista', async () => {
    const w = await wzor();
    const r = await wyslij('GET', '/zamowienia/1');
    expect(r.statusCode).toBe(200);
    expect(liczniki(r.body)).toEqual(w);
  });

  it('strona Ustawień pokazuje te same liczby co lista', async () => {
    const w = await wzor();
    const r = await wyslij('GET', '/ustawienia/lacznosc');
    expect(r.statusCode).toBe(200);
    expect(liczniki(r.body)).toEqual(w);
  });
});

describe('odświeżenie indeksu listy na jedno żądanie', () => {
  const szpieg = () => vi.spyOn(indeksListy(db), 'odswiez');

  it('fragment bez układu nie odświeża indeksu', async () => {
    const s = szpieg();
    const r = await wyslij('GET', '/zamowienia/nowe/magazyn/wyniki?fraza=lampa');
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('oms-menu-desktop');
    expect(s).toHaveBeenCalledTimes(0);
  });

  it('POST zakończony przekierowaniem nie odświeża indeksu', async () => {
    const s = szpieg();
    const r = await wyslij('POST', '/zamowienia/nowe', formularz());
    expect(r.statusCode, r.body.slice(0, 300)).toBe(302);
    expect(s).toHaveBeenCalledTimes(0);
  });

  it('pełna strona po POST odświeża indeks dokładnie raz', async () => {
    const s = szpieg();
    const r = await wyslij('POST', '/zamowienia/nowe/wiersz/dodaj', formularz());
    expect(r.statusCode).toBe(200);
    expect(liczniki(r.body).wszystkie).toBe('4');
    expect(s).toHaveBeenCalledTimes(1);
  });
});
