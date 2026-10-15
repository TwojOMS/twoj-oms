import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';

/* ============================================================================
   DANE DOSTAWY DLA STRONY AKCEPTACJI PROJEKTU (zgłoszenie właściciela 20.08.2026).

   Klient po zaakceptowaniu projektu ma zobaczyć, DOKĄD to jedzie i na co dostanie
   dokument — zanim paczka pojedzie pod zły adres. Panel tych danych nie ma: przy torze
   automatycznym adres został w sklepie. Stąd ta trasa.
============================================================================ */

const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
const naglowki = {
  authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'),
  origin: 'http://localhost', host: 'localhost',
};

// Zamówienie ze SKLEPU — czyli takie, jakie ma karta na torze automatycznym: bez `karta_id`.
const ZE_SKLEPU = {
  zrodlo_id: 28060, numer: '28060', kwota_brutto: '343.00', kwota_pobrania: null,
  metoda_wysylki: 'dpd', chce_fakture: 1, nip: '1000001129', status_woo: 'processing',
  oplacone_at: '2026-08-19T10:00:00', anulowane: 0, utworzone_at: '2026-08-19T09:55:00',
  pozycje: [],
  dostawa: {
    first_name: 'Anna', last_name: 'Kowalska', company: 'Pracownia Wnętrz sp. z o.o.',
    address_1: 'Długa 45/2', postcode: '30-001', city: 'Kraków', country: 'PL',
  },
  klient: {
    first_name: 'Anna', last_name: 'Kowalska', company: 'Pracownia Wnętrz sp. z o.o.',
    email: 'anna@pracownia.pl', phone: '500900008',
    address_1: 'Długa 45/2', postcode: '30-001', city: 'Kraków',
  },
};

let db; let app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config });
  await app.ready();
});

const zaloz = (nadpisz = {}) => zapiszZamowienie(db, 'pro', { ...ZE_SKLEPU, ...nadpisz }, {});
const pobierz = (id) => app.inject({ method: 'GET', url: `/api/zamowienia/${id}/dostawa`, headers: naglowki });

describe('GET /api/zamowienia/:id/dostawa', () => {
  it('oddaje adres, metodę wysyłki i dane faktury', async () => {
    const res = await pobierz(zaloz());
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.adres).toMatchObject({ ulica: 'Długa 45/2', kod: '30-001', miasto: 'Kraków', telefon: '500900008' });
    expect(d.adres.nazwa).toContain('Anna');
    expect(d.metoda).toMatch(/DPD/i);
    expect(d.dokument).toBe('faktura');
    expect(d.faktura).toMatchObject({ nip: '1000001129' });
    expect(d.faktura.firma).toContain('Pracownia');
  });

  it('bez chęci na fakturę → paragon i żadnych danych nabywcy', async () => {
    const d = (await pobierz(zaloz({ chce_fakture: 0, klient_nip: null }))).json();
    expect(d.dokument).toBe('paragon');
    expect(d.faktura).toBeNull();
  });

  /* ⚠️⚠️ SEDNO TEJ TRASY. Tor automatyczny (klient płaci w sklepie) NIE MA `karta_id` —
     zamówienie zaciąga poller OMS-u, a panel wie o nim tylko tyle, że `card.omsId` wskazuje
     ten wiersz. Gdyby ta trasa szukała po karcie, jak sąsiednia, oddawałaby 404 dokładnie
     tym zamówieniom, których ta funkcja dotyczy najbardziej. */
  it('⚠️ działa dla zamówienia BEZ karta_id (tor automatyczny)', async () => {
    const id = zaloz();
    expect(db.prepare('SELECT karta_id FROM zamowienia WHERE id = ?').get(id).karta_id).toBeFalsy();
    expect((await pobierz(id)).statusCode).toBe(200);
  });

  /* ⚠️ RĘCZNA POPRAWKA OPERATORA WYGRYWA — bo to ona jedzie kurierem. Pokazanie klientowi
     surowego adresu ze sklepu znaczyłoby „potwierdź dane, których i tak nie użyjemy". */
  it('⚠️ poprawiony ręcznie adres i metoda biją wartości ze sklepu', async () => {
    const id = zaloz();
    db.prepare('UPDATE zamowienia SET dostawa_reczna_json = ?, wysylka_reczna_json = ? WHERE id = ?')
      .run(JSON.stringify({ ulica: 'Krótka 1', miasto: 'Pęki', kod: '00-650' }), JSON.stringify({ metoda: 'inpost_paczkomat' }), id);
    const d = (await pobierz(id)).json();
    expect(d.adres.ulica).toBe('Krótka 1');
    expect(d.adres.miasto).toBe('Pęki');
    expect(d.metoda).toMatch(/InPost|Paczkomat/i);
  });

  /* ⚠️ ZNALEZIONE NA PRODUKCJI 20.08.2026: zamówienie sprzed mapowania metod ma metodę
     `nieznana`, a `etykietaWysylki` robi z niej „Nieznana metoda". Wewnątrz OMS-u to sensowne
     („do wyjaśnienia przez operatora"), ale na stronie klienta brzmi jak awaria u nas —
     więc wtedy nie mówimy nic, a strona pomija tę linię. */
  it('⚠️ metoda „nieznana" nie jedzie do klienta jako „Nieznana metoda"', async () => {
    const d = (await pobierz(zaloz({ metoda_wysylki: 'nieznana' }))).json();
    expect(d.metoda).toBeNull();
  });

  it('paczkomat: oddaje kod punktu odbioru', async () => {
    const id = zaloz({ metoda_wysylki: 'inpost_paczkomat', punkt_odbioru: 'KTY01M' });
    const d = (await pobierz(id)).json();
    expect(d.punkt).toBe('KTY01M');
  });

  it('nieznane zamówienie → 404, a nie puste dane', async () => {
    expect((await pobierz(999999)).statusCode).toBe(404);
    expect((await pobierz('abc')).statusCode).toBe(404);
  });

  it('bez logowania nie oddaje niczego', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/zamowienia/${zaloz()}/dostawa`, headers: { host: 'localhost' } });
    expect(res.statusCode).toBe(401);
  });
});
