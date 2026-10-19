// PRZ-101.05: plakietka przewoźnika także na KARCIE zamówienia (wiersz „Metoda wysyłki”), tym samym rozpoznaniem
// co kolumna „Dostawa” listy (domena/przewoznik-przesylki.js → przewoznikWiersza). Test sprawdza WYRENDEROWANY
// HTML karty i porównuje klasę z tą z listy, więc złapie i brak plakietki, i osobną kopię reguł w szablonie.
import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

const zam = (id, nad = {}) => ({
  zrodlo_id: id, numer: String(id), klient: { first_name: 'Jan', last_name: 'Kowalski', email: 'j@k.pl' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '100.00',
  koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-10-17T13:19:52',
  pozycje: [{ nazwa: 'STOP', sku: 'S-1', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00', vat: null }],
  ...nad,
});

let db, app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: { auth: { user: 'adam', pass: 'x' } }, poller });
  await app.ready();
});

const karta = async (id) => {
  const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
  expect(r.statusCode, r.body).toBe(200);
  return r.body;
};
// Wiersz „Metoda wysyłki” z metryczki karty: od etykiety do końca jej <div>.
const metoda = (html) => {
  const od = html.indexOf('<span>Metoda wysyłki</span>');
  expect(od, 'brak wiersza „Metoda wysyłki”').toBeGreaterThan(-1);
  return html.slice(od, html.indexOf('<div><span>Status</span>', od));
};

describe('plakietka przewoźnika na karcie zamówienia', () => {
  it('InPost i DPD: klasa marki, pełna nazwa metody (z dopiskiem „(pobranie)”) zostaje w tekście', async () => {
    const dpd = zapiszZamowienie(db, 'pro', zam(8101, { metoda_wysylki: 'dpd', pobranie: 1, kwota_pobrania: '100.00' }), {});
    const inpost = zapiszZamowienie(db, 'pro', zam(8102, { metoda_wysylki: 'inpost_paczkomat' }), {});
    expect(metoda(await karta(dpd))).toMatch(/plakietka plakietka--dpd"[\s\S]*Kurier DPD \(pobranie\)/);
    expect(metoda(await karta(inpost))).toMatch(/plakietka plakietka--inpost"[\s\S]*InPost Paczkomat/);
  });
  it('odbiór osobisty i punkt Allegro (przewoźnik nieustalony) — bez plakietki, jak na liście', async () => {
    const odbior = zapiszZamowienie(db, 'pro', zam(8111, { metoda_wysylki: 'odbior_osobisty' }), {});
    const punkt = zapiszZamowienie(db, 'pro', zam(8112, { metoda_wysylki: 'allegro_punkt' }), {});
    expect(metoda(await karta(odbior))).not.toContain('plakietka');
    expect(metoda(await karta(punkt))).not.toContain('plakietka');
  });
  it('ta sama klasa co w kolumnie „Dostawa” listy dla tego samego zamówienia', async () => {
    const id = zapiszZamowienie(db, 'pro', zam(8121, { metoda_wysylki: 'allegro_kurier' }), {});
    const l = await app.inject({ method: 'GET', url: '/', headers: naglowek });
    const w = l.body.slice(l.body.indexOf('<td class="komorka-dostawa">'), l.body.indexOf('<td class="komorka-kwota'));
    const naLiscie = /plakietka--([a-z-]+)"/.exec(w)?.[1];
    expect(naLiscie).toBe('allegro-one');
    expect(metoda(await karta(id))).toContain(`plakietka plakietka--${naLiscie}"`);
  });
});
