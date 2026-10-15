import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { opisKlienta } from '../../../src/domena/klient-staly.js';

// KARTA I TRASY WDT — harness jak w tests/oms/web-zamowienie.test.js. Konfiguracja niesie
// nadawcę (adres sprzedawcy dla dokumentu wywozu) i NIP z config.proforma.
const config = {
  auth: { user: 'adam', pass: 'x' },
  nadawca: {
    nazwa: 'Lumina Marek Zywiecki', ulica: '1 Maja 5', kod: '00-650', miasto: 'Pęki', kraj: 'PL',
  },
  proforma: { nip: '1234563218' },
};
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: '2026-07-29T12:00:00', ostatni_blad: null }) };

const zmapowane = (id, nad = {}) => ({
  zrodlo_id: id, numer: String(id),
  klient: {
    first_name: 'Peter', last_name: 'Novak', company: 'Alfatrend s.r.o.',
    email: 't@alfatrend.sk', address_1: '1. mája 1', postcode: '01001', city: 'Žilina',
  },
  dostawa: { city: 'Lipnica Wielka' }, metoda_wysylki: 'dpd', kwota_pobrania: null,
  chce_fakture: 1, nip: 'SK1000000001', kwota_brutto: '96.48',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-08-26T10:00:00',
  pozycje: [{ nazwa: 'Szablon malarski STOP 70x100cm', sku: null, ilosc: 2, cena_brutto: '40.24', vat: null }],
  ...nad,
});

let db;
let app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, poller });
  await app.ready();
});

describe('karta zamówienia WDT', () => {
  it('niesie pas WDT i przycisk potwierdzenia wywozu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(2601), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('WDT ze stawką 0%');
    expect(r.body).toContain('SK1000000001');
    expect(r.body).toContain(`/zamowienia/${id}/potwierdzenie-wywozu.pdf`);
  });

  // Formularz „Dodaj pozycję" (jedyny nosiciel data-vat) renderuje się w trybie edycji
  // pozycji — tam podpowiedź netto MUSI liczyć stawką DOKUMENTU: przy WDT netto = brutto.
  it('edycja pozycji zamówienia WDT niesie data-vat="0"', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(2601), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}?edytuj=pozycje`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('data-vat="0"');
  });

  it('karta krajowa NIE ma pasa WDT ani przycisku, a data-vat zostaje 23', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(2602, { nip: '1000001201' }), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}?edytuj=pozycje`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('WDT ze stawką 0%');
    expect(r.body).not.toContain('potwierdzenie-wywozu.pdf');
    expect(r.body).toContain('data-vat="23"');
  });
});

describe('GET /zamowienia/:id/potwierdzenie-wywozu.pdf', () => {
  it('dla zamówienia WDT oddaje PDF z nazwą pliku po numerze zamówienia', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(2603), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/potwierdzenie-wywozu.pdf`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('potwierdzenie-wywozu-2603.pdf');
    expect(r.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('dla zamówienia krajowego odmawia z powodem (400), nie surowym błędem', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(2604, { nip: '1000001201' }), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/potwierdzenie-wywozu.pdf`, headers: naglowek });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/WDT|VAT-UE/);
  });

  it('nieistniejące zamówienie: 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/zamowienia/999999/potwierdzenie-wywozu.pdf', headers: naglowek });
    expect(r.statusCode).toBe(404);
  });
});

// CENY Z MAGAZYNU DLA KLIENTA WDT (zgłoszenie właściciela 26.08 wieczór): wstawka ma od
// razu robić rabat → ÷1,23, a nie zostawiać operatorowi dzielenia 19 pozycji z ręki.
// STOP 70x100: cennik 108,90 → rabat 50% → 54,45 → ÷1,23 → 44,27 (wektor z faktury Apilo).
describe('ceny z magazynu przy WDT', () => {
  const produkt = (nad = {}) => ({
    kanal: 'pro', produkt_id: '28040', wariant_id: '', nazwa: 'Szablon malarski STOP',
    sku_sklepu: 'PRO-STOP-001', cena_gr: 10890, rozmiar_tekst: '70x100cm', kategorie: [], zdjecia: [],
    adres: 'https://pro.szkicownia.pl/produkt/stop', odczytane_at: '2026-08-26T08:00:00', ...nad,
  });

  it('karta zamówienia WDT: pozycja z magazynu wchodzi po rabacie i ÷1,23', async () => {
    zapiszProduktSklepowy(db, produkt());
    const id = zapiszZamowienie(db, 'reczne', zmapowane(2605, { zrodlo_id: 202600031 }), {});
    db.prepare('UPDATE zamowienia SET rabat_procent = 50 WHERE id = ?').run(id);
    const odp = await app.inject({
      method: 'POST',
      url: `/zamowienia/${id}/pozycje/z-magazynu`,
      headers: naglowek,
      payload: { kanal: 'pro', produkt_id: '28040', wariant_id: '', ilosc: '2', fraza: 'stop' },
    });
    expect(odp.statusCode).toBe(302);
    const p = pobierzZamowienie(db, id).pozycje.at(-1);
    expect(p.cena_brutto).toBe('44.27');
    expect(p.brutto_linii).toBe('88.54');
    // Migawka źródła zostaje sklepowa — widać, skąd wzięła się cena.
    expect(p.cena_katalogowa).toBe('108.90');
  });

  it('karta zamówienia KRAJOWEGO: ta sama wstawka bez ÷1,23 — jak dotąd', async () => {
    zapiszProduktSklepowy(db, produkt());
    const id = zapiszZamowienie(db, 'reczne', zmapowane(2606, { zrodlo_id: 202600032, nip: '1000001201' }), {});
    db.prepare('UPDATE zamowienia SET rabat_procent = 50 WHERE id = ?').run(id);
    await app.inject({
      method: 'POST',
      url: `/zamowienia/${id}/pozycje/z-magazynu`,
      headers: naglowek,
      payload: { kanal: 'pro', produkt_id: '28040', wariant_id: '', ilosc: '2', fraza: 'stop' },
    });
    expect(pobierzZamowienie(db, id).pozycje.at(-1).cena_brutto).toBe('54.45');
  });

  // Formularz NOWEGO zamówienia: WDT rozpoznaje się po f_nip (wypełnia je „Wstaw dane
  // klienta"), bo zamówienia jeszcze nie ma.
  it('nowe zamówienie z f_nip UE: cena wstawiona do formularza jest po ÷1,23', async () => {
    zapiszProduktSklepowy(db, produkt());
    const odp = await app.inject({
      method: 'POST',
      url: '/zamowienia/nowe/magazyn/dodaj',
      headers: naglowek,
      payload: {
        f_nip: 'SK1000000001', rabat_procent: '50', cennik: 'pro',
        wybrany: '0', mag_kanal: 'pro', mag_produkt_id: '28040', mag_wariant_id: '', mag_ilosc: '2',
      },
    });
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toContain('value="44.27"');
    expect(odp.body).not.toContain('value="54.45"');
  });

  it('nowe zamówienie bez NIP-u UE: cena z samym rabatem — jak dotąd', async () => {
    zapiszProduktSklepowy(db, produkt());
    const odp = await app.inject({
      method: 'POST',
      url: '/zamowienia/nowe/magazyn/dodaj',
      headers: naglowek,
      payload: {
        f_nip: '1000001201', rabat_procent: '50', cennik: 'pro',
        wybrany: '0', mag_kanal: 'pro', mag_produkt_id: '28040', mag_wariant_id: '', mag_ilosc: '2',
      },
    });
    expect(odp.body).toContain('value="54.45"');
  });
});

describe('opisKlienta — stały klient z numerem VAT-UE', () => {
  it('dopisuje ostrzeżenie o WDT i kwotach netto', () => {
    const opis = opisKlienta({ nazwa: 'Alfatrend s.r.o.', nip: 'SK1000000001', aktywny: 1 });
    expect(opis).toContain('WDT 0%');
    expect(opis).toContain('NETTO');
  });

  it('klient krajowy bez dopisku', () => {
    expect(opisKlienta({ nazwa: 'ACME', nip: '1000001201', aktywny: 1 })).not.toContain('WDT');
  });
});
