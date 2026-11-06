import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nowyPanel, BASIC } from '../../pomoc/konta-prz068.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { zalozKluczApi } from '../../../src/core/bezpieczenstwo/klucze-api.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';

let app, db, odczyt, sprzedaz, druk, id;
const bearer = klucz => ({ authorization: `Bearer ${klucz}` });
beforeAll(async () => {
  ({ app, db } = nowyPanel());
  await app.ready();
  const kontoId = zalozKonto(db, { login: 'tester-api', imie: 'Tester', haslo: 'h', admin: true, rola: 'administrator' });
  const klucz = zakresy => bearer(zalozKluczApi(db, {
    nazwa: 'Pracownia Półcień', zakresy, kontoId, teraz: new Date().toISOString(),
  }).klucz);
  odczyt = klucz(['zamowienia:odczyt']);
  sprzedaz = klucz(['sprzedaz:odczyt']);
  druk = klucz(['druk']);
  id = zapiszZamowienie(db, 'sklep-testowy', {
    zrodlo_id: 701, numer: '701', kwota_brutto: '123.00', kwota_pobrania: null,
    utworzone_at: '2026-11-01T10:00:00.000Z', metoda_wysylki: 'dpd',
    pozycje: [], chce_fakture: 0, nip: null, status_woo: 'processing', oplacone_at: null, anulowane: 0,
    dostawa: { first_name: 'Ala', last_name: 'Testowa', company: 'Pracownia Półcień',
      address_1: 'Testowa 7', postcode: '00-001', city: 'Testowo', country: 'PL' },
    klient: { email: 'ala@example.test', first_name: 'Ala', last_name: 'Testowa' },
  }, {});
  db.prepare('UPDATE zamowienia SET karta_id = ?, wyslane_at = ? WHERE id = ?')
    .run('karta-testowa', '2026-11-02T12:00:00.000Z', id);
  // Ten sam numer w innym sklepie nie może zmienić wyniku wyszukiwania.
  zapiszZamowienie(db, 'drugi-sklep', {
    zrodlo_id: 702, numer: '701', kwota_brutto: '99.00', kwota_pobrania: null, pozycje: [],
    klient: {}, dostawa: {}, metoda_wysylki: 'dpd', chce_fakture: 0, nip: null,
    status_woo: 'processing', oplacone_at: null, anulowane: 0,
    utworzone_at: '2026-11-01T11:00:00.000Z',
  }, {});
});
afterAll(async () => { await app?.close(); db?.close(); });

const trasy = [
  ['z karty', () => '/zamowienia-z-karty/karta-testowa', () => '/zamowienia/z-karty/karta-testowa', 'zamowienia:odczyt'],
  ['po numerze', () => '/zamowienia/po-numerze/701?sklep=sklep-testowy', null, 'zamowienia:odczyt'],
  ['dostawa', () => `/zamowienia/${id}/dostawa`, null, 'zamowienia:odczyt'],
  ['stan wysyłki', () => `/zamowienia/${id}/stan-wysylki`, null, 'zamowienia:odczyt'],
  ['sprzedaż', () => '/sprzedaz?od=2026-11-01&do=2026-11-03', null, 'sprzedaz:odczyt'],
];
async function porownaj(stara, nowa, status, headers = odczyt) {
  const a = await app.inject({ url: `/api${stara}`, headers: BASIC });
  const b = await app.inject({ url: `/api/v1${nowa ?? stara}`, headers });
  expect(a.statusCode).toBe(status);
  expect(b.statusCode).toBe(a.statusCode);
  expect(b.json()).toEqual(a.json());
  return b.json();
}

describe('Przeniesione odczyty: Basic /api i klucz /api/v1', () => {
  for (const [nazwa, stara, nowa, zakres] of trasy) {
    it(`${nazwa}: identyczny status i pełne ciało`, async () => {
      const wynik = await porownaj(stara(), nowa?.(), 200, zakres === 'sprzedaz:odczyt' ? sprzedaz : odczyt);
      if (nazwa === 'sprzedaż') expect(wynik.zamowienia).toHaveLength(2);
      else expect(wynik.id).toBe(id);
    });
    it(`${nazwa}: inny zakres daje 403 brak_zakresu`, async () => {
      for (const headers of [druk, zakres === 'sprzedaz:odczyt' ? odczyt : sprzedaz]) {
        const r = await app.inject({ url: `/api/v1${nowa ? nowa() : stara()}`, headers });
        expect(r.statusCode).toBe(403);
        expect(r.json()).toEqual({ kod: 'brak_zakresu', powod: `Klucz nie ma zakresu ${zakres}.` });
      }
    });
    it(`${nazwa}: brak klucza i Basic dają 401`, async () => {
      for (const headers of [{}, BASIC]) {
        const r = await app.inject({ url: `/api/v1${nowa ? nowa() : stara()}`, headers });
        expect(r.statusCode).toBe(401);
        expect(r.json().kod).toBe('klucz');
      }
    });
  }
  it.each([
    ['/zamowienia-z-karty/brak', '/zamowienia/z-karty/brak', 404],
    ['/zamowienia/999999/dostawa', null, 404],
    ['/zamowienia/abc/dostawa', null, 404],
    ['/zamowienia/999999/stan-wysylki', null, 404],
    ['/zamowienia/abc/stan-wysylki', null, 404],
    ['/zamowienia/po-numerze/999?sklep=sklep-testowy', null, 404],
    ['/zamowienia/po-numerze/701?sklep=nieistniejacy', null, 404],
    ['/zamowienia/po-numerze/701', null, 400],
    ['/zamowienia/po-numerze/701?sklep=%20', null, 400],
  ])('%s: zachowuje błędy starej trasy', async (stara, nowa, status) => {
    await porownaj(stara, nowa, status);
  });
  it.each([
    '', '?od=2026-11-01', '?od=2026-02-30&do=2026-11-03', '?od=2026-11-03&do=2026-11-01',
  ])('sprzedaż %s: zachowuje 400 i treść błędu', async query => {
    await porownaj(`/sprzedaz${query}`, null, 400, sprzedaz);
  });
});
