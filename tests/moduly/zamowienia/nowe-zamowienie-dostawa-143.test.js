import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszUstawienia } from '../../../src/oms/db/ustawienia.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { DOSTAWY } from '../../../src/domena/nowe-zamowienie.js';
import { METODA_DOMYSLNA } from '../../../src/domena/moduly-kurierow.ts';

// PRZ-143.03: formularz nowego zamówienia nie zakłada na sztywno DPD (domyślna dostawa
// pochodzi z kontekstu, `dostawaDomyslna`), a podpowiedź brakującej etykiety na karcie
// wskazuje panel kuriera TEJ przesyłki. Dane zmyślone („Pracownia Półcień").

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

// Metoda domyślna rejestru ustawiona na paczkomat — kontekst ma ją przenieść do widoku
// (przy zahardkodowanym 'dpd' w widoku zaznaczone zostałoby DPD).
vi.mock('../../../src/domena/moduly-kurierow.ts', async (oryginal) => ({
  ...(await oryginal()),
  METODA_DOMYSLNA: 'inpost_paczkomat',
}));

let db, app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, poller });
  await app.ready();
});

const get = (url) => app.inject({ method: 'GET', url, headers: naglowek });
const opcja = (body, klucz) => body.match(new RegExp(`<option value="${klucz}"[^>]*>`))?.[0] ?? '';

describe('domyślna dostawa w formularzu nowego zamówienia', () => {
  it('GET /zamowienia/nowe zaznacza METODA_DOMYSLNA', async () => {
    const r = await get('/zamowienia/nowe');
    expect(r.statusCode).toBe(200);
    expect(Object.keys(DOSTAWY)).toContain(METODA_DOMYSLNA);
    expect(opcja(r.body, METODA_DOMYSLNA)).toContain(' selected');
    for (const k of Object.keys(DOSTAWY).filter((x) => x !== METODA_DOMYSLNA)) {
      expect(opcja(r.body, k)).not.toContain(' selected');
    }
  });

  it('zaznaczony paczkomat ma też swój koszt, nie koszt DPD', async () => {
    zapiszUstawienia(db, { 'dostawa.dpd': '1900', 'dostawa.inpost_paczkomat': '1300' });
    const r = await get('/zamowienia/nowe');
    expect(opcja(r.body, 'inpost_paczkomat')).toContain(' selected');
    expect(opcja(r.body, 'dpd')).not.toContain(' selected');
    expect(r.body.match(/name="koszt_dostawy_brutto" value="([^"]*)"/)?.[1]).toMatch(/^13/);
  });
});

describe('podpowiedź brakującej etykiety na karcie zamówienia', () => {
  const zam = (id) => ({
    zrodlo_id: `pc-${id}`, numer: `PC-${id}`,
    klient: { email: 'ola@polcien.example' },
    dostawa: { first_name: 'Ola', last_name: 'Półcień', company: 'Pracownia Półcień', address_1: 'Cienista 3', postcode: '00-950', city: 'Warszawa', country: 'PL' },
    metoda_wysylki: 'inpost_paczkomat', punkt_odbioru: 'WAW01M', kwota_pobrania: null, chce_fakture: 0, nip: null,
    kwota_brutto: '149.00', status_woo: 'processing', oplacone_at: '2026-10-20T10:00:00', anulowane: 0,
    utworzone_at: '2026-10-20T09:58:00', pozycje: [],
  });
  const przesylka = (zamId, kurier) => db.prepare(
    `INSERT INTO przesylki (zamowienie_id, kurier, kolejnosc, status, numer_listu, etykieta_sciezka, utworzona_at) VALUES (?, ?, 1, 'nadana', 'LIST123', NULL, '2026-10-20')`,
  ).run(zamId, kurier);

  it.each([
    ['inpost', 'Etykieta niezapisana — pobierz ją z panelu InPost.'],
    ['dpd', 'Etykieta niezapisana — pobierz ją z panelu DPD.'],
    ['nieznany_kurier', 'Etykieta niezapisana — pobierz ją z panelu kuriera.'],
  ])('kurier %s', async (kurier, zdanie) => {
    const id = zapiszZamowienie(db, 'polcien', zam(kurier), {});
    przesylka(id, kurier);
    const r = await get(`/zamowienia/${id}`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(zdanie);
  });
});
