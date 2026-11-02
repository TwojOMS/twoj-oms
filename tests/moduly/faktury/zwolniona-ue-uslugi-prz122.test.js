// PRZ-122.B07d — usługi faktur: firma zwolniona z VAT (art. 113, TwojeFaktury) + nabywca z numerem VAT UE = NIE WDT.
// Faktura „zw” z serii zwykłej: bez VIES, bez serii WDT, bez pól WDT w ładunku; w logu zamówienia „to nie jest WDT”.
// Kontrolne: firma niezwolniona albo program zewnętrzny (inFakt) — WDT jak dziś.
// Program: atrapa (tests/pomoc/program-testowy.js) z opisem programu wbudowanego (lista stawek z „zw”).
// Dane zmyślone („Pracownia Półcień”, DE123456789).
import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapewnijOkres } from '../../../src/oms/db/okresy.js';
import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';
import { createFakturaOkresu } from '../../../src/moduly/faktury/services/faktura-okresu.js';
import { zapiszStawkeDomyslna } from '../../../src/moduly/faktury/db/stawka-vat.js';
import { zapiszZwolnienie, sprzedawcaZwolniony, PODSTAWA_ART_113 } from '../../../src/moduly/faktury/db/zwolnienie-vat.js';
import { programInfakt } from '../../../src/integracje/programy/infakt.ts';
import { programTestowy } from '../../pomoc/program-testowy.js';

const NIP_PRACOWNI = '5250000009';   // zmyślony
const NIP_UE = 'DE123456789';        // zmyślony numer VAT-UE
const NIP_SPRZEDAWCY = '1234563218'; // zmyślony
const TERAZ = () => '2026-10-15T10:00:00.000Z';
const POLA_WDT = ['sale_type', 'sales_kind', 'number', 'notes'];

/** Atrapa programu wbudowanego (opis z „zw”, jak TwojeFaktury): `wystaw` zapisuje ładunek. */
function programWbudowany(o = {}) {
  const p = programTestowy(o);
  return { ...p, opis: Object.freeze({ ...p.opis, wbudowany: true }) };
}

const zamowienie = (nad = {}) => ({
  zrodlo_id: 4107, numer: 'R/2026/107',
  klient: {
    first_name: 'Hans', last_name: 'Muster', company: 'Leuchten Test GmbH', email: 'einkauf@leuchten.invalid',
    address_1: 'Lampenweg 7', postcode: '10115', city: 'Berlin',
  },
  dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null,
  chce_fakture: 1, nip: NIP_UE, kwota_brutto: '139.00', koszt_dostawy_brutto: '16.00',
  status_woo: 'processing',
  oplacone_at: '2026-10-14T13:00:00', anulowane: 0, utworzone_at: '2026-10-14T13:00:00',
  pozycje: [{ nazwa: 'Lampa stołowa Kałamarz', sku: 'LMP-KAL-01', ilosc: 2, cena_brutto: '61.50', vat: null }],
  ...nad,
});

const VIES_RZUCA = () => ({ sprawdz: vi.fn(async () => { throw new Error('VIES nie powinien być wołany'); }) });
const VIES_WAZNY = () => ({ sprawdz: vi.fn().mockResolvedValue({
  wynik: 'wazny', nazwa: 'LEUCHTEN TEST GMBH', dataZapytania: '2026-10-15T10:00:00.000Z', numerKonsultacji: 'WAPI-T-7',
}) });

function zwolnij(db) {
  zapiszZwolnienie(db, { zwolniona: true, podstawa: PODSTAWA_ART_113, rodzaj: 'ustawa' });
  zapiszStawkeDomyslna(db, 'zw', { zw: true });
}

function zestaw({ nad = {}, program = programWbudowany(), vies = VIES_RZUCA(), zwolniona = true } = {}) {
  const db = openOmsDb(':memory:');
  if (zwolniona) zwolnij(db);
  const id = zapiszZamowienie(db, 'pro', zamowienie(nad), {});
  const faktura = createFaktura({ db, program, vies, nipSprzedawcy: NIP_SPRZEDAWCY, teraz: TERAZ });
  return { db, id, program, vies, faktura };
}

function bazaZOkresem({ zwolniona = true } = {}) {
  const db = openOmsDb();
  if (zwolniona) zwolnij(db);
  const okres = zapewnijOkres(db, { klientKlucz: 'leuchten', rok: 2026, miesiac: 9 });
  db.prepare(
    'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, okres_rozliczeniowy_id, utworzone_at)'
    + " VALUES ('reczne', 202600107, 'R/2026/107', '104.00', ?, '2026-09-10T10:00:00.000Z')",
  ).run(okres.id);
  const zamId = db.prepare('SELECT id FROM zamowienia WHERE numer = ?').get('R/2026/107').id;
  db.prepare(
    'INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, brutto_linii, zrodlo)'
    + " VALUES (?, 'Lampa wisząca Półksiężyc', 1, '100.00', '100.00', 'reczna'),"
    + " (?, 'Obsługa zamówienia', 1, '4.00', '4.00', 'reczna')",
  ).run(zamId, zamId);
  return { db, okres, zamId };
}

const wpisy = (db, id) => db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);
const licznikWdt = (db) => db.prepare('SELECT rok, miesiac, kolejny FROM wdt_numery').all();
const ladunek = (program) => program.wystaw.mock.calls[0][0];

describe('sprzedawcaZwolniony — jedno źródło prawdy', () => {
  it('program wbudowany + zapisane zwolnienie → true', () => {
    const db = openOmsDb(':memory:');
    zwolnij(db);
    expect(sprzedawcaZwolniony(db, programWbudowany().opis)).toBe(true);
  });

  it('program wbudowany bez wpisu → false; wpis „niezwolniona” z podstawą → false', () => {
    const db = openOmsDb(':memory:');
    expect(sprzedawcaZwolniony(db, programWbudowany().opis)).toBe(false);
    zapiszZwolnienie(db, { zwolniona: false, podstawa: 'art. 43 ust. 1 pkt 18 ustawy o VAT', rodzaj: 'ustawa' });
    expect(sprzedawcaZwolniony(db, programWbudowany().opis)).toBe(false);
  });

  it('opis inFaktu (i brak programu) + zapisane zwolnienie → false', () => {
    const db = openOmsDb(':memory:');
    zwolnij(db);
    expect(sprzedawcaZwolniony(db, programInfakt({ wystaw: async () => ({}) }).opis)).toBe(false);
    expect(sprzedawcaZwolniony(db, programTestowy().opis)).toBe(false);
    expect(sprzedawcaZwolniony(db, undefined)).toBe(false);
  });
});

describe('faktura zamówienia — firma zwolniona, nabywca DE123456789', () => {
  it('ładunek bez pól WDT, wszystkie stawki „zw”, bez VIES i bez serii WDT, w logu „to nie jest WDT”', async () => {
    const { db, id, program, vies, faktura } = zestaw();
    await faktura.wystaw(id);
    const p = ladunek(program);
    for (const pole of POLA_WDT) expect(Object.hasOwn(p, pole)).toBe(false);
    expect(p.services.map((s) => s.tax_symbol)).toEqual(['zw', 'zw']);
    expect(vies.sprawdz).not.toHaveBeenCalled();
    expect(program.iluMaNumer).not.toHaveBeenCalled();
    expect(licznikWdt(db)).toEqual([]);
    const log = wpisy(db, id).map((w) => w.wynik).join('\n');
    expect(log).toContain('Sprzedawca zwolniony z VAT — to nie jest WDT');
    expect(log).toContain('faktura „zw”');
  });

  it('nie wymaga NIP-u sprzedawcy do adnotacji WDT (to nie WDT)', async () => {
    const db = openOmsDb(':memory:');
    zwolnij(db);
    const id = zapiszZamowienie(db, 'pro', zamowienie(), {});
    const program = programWbudowany();
    await createFaktura({ db, program, vies: VIES_RZUCA(), nipSprzedawcy: () => '', teraz: TERAZ }).wystaw(id);
    expect(program.wystaw).toHaveBeenCalledTimes(1);
  });
});

describe('faktura okresu — firma zwolniona, klient okresu DE123456789', () => {
  it('ładunek bez pól WDT, stawki „zw”, bez VIES i bez serii WDT, w logu zamówień „to nie jest WDT”', async () => {
    const { db, okres, zamId } = bazaZOkresem();
    const program = programWbudowany();
    const vies = VIES_RZUCA();
    await createFakturaOkresu({ db, program, vies, nipSprzedawcy: NIP_SPRZEDAWCY, teraz: TERAZ })
      .wystaw(okres.id, { nip: NIP_UE });
    const p = ladunek(program);
    for (const pole of POLA_WDT) expect(Object.hasOwn(p, pole)).toBe(false);
    expect(p.services.map((s) => s.tax_symbol)).toEqual(['zw', 'zw']);
    expect(vies.sprawdz).not.toHaveBeenCalled();
    expect(program.iluMaNumer).not.toHaveBeenCalled();
    expect(licznikWdt(db)).toEqual([]);
    expect(wpisy(db, zamId).map((w) => w.wynik).join('\n')).toContain('Sprzedawca zwolniony z VAT — to nie jest WDT');
  });
});

describe('kontrolne — WDT jak dziś', () => {
  const programWdt = (fabryka) => fabryka({ metody: { wystaw: async () => ({ uuid: 'dok-w1', numer: 'WDT/1/10/2026', ksefStatus: null }) } });

  it('firma NIEzwolniona + program wbudowany + numer UE → VIES, seria WDT, 0%, pola WDT (zaślepka bez wdtWSeriiFaktur)', async () => {
    const program = programWdt(programWbudowany);
    const { db, id, vies, faktura } = zestaw({ program, vies: VIES_WAZNY(), zwolniona: false });
    await faktura.wystaw(id);
    const p = ladunek(program);
    expect(p.number).toBe('WDT/1/10/2026');
    expect(p.sale_type).toBe('merchandise');
    expect(p.services.every((s) => s.tax_symbol === '0')).toBe(true);
    expect(vies.sprawdz).toHaveBeenCalledTimes(1);
    expect(licznikWdt(db)).toEqual([{ rok: 2026, miesiac: 10, kolejny: 1 }]);
    expect(wpisy(db, id).map((w) => w.wynik).join('\n')).not.toContain('to nie jest WDT');
  });

  it('program zewnętrzny (bez „zw”, jak inFakt) + zapisane zwolnienie → WDT jak dziś', async () => {
    const program = programWdt(programTestowy);
    const { db, id, vies, faktura } = zestaw({ program, vies: VIES_WAZNY() });
    await faktura.wystaw(id);
    const p = ladunek(program);
    expect(p.number).toBe('WDT/1/10/2026');
    expect(p.services.every((s) => s.tax_symbol === '0')).toBe(true);
    expect(vies.sprawdz).toHaveBeenCalledTimes(1);
    expect(licznikWdt(db)).toEqual([{ rok: 2026, miesiac: 10, kolejny: 1 }]);
  });

  it('okres: firma NIEzwolniona + numer UE → VIES, seria WDT, 0%', async () => {
    const { db, okres } = bazaZOkresem({ zwolniona: false });
    const program = programWdt(programWbudowany);
    const vies = VIES_WAZNY();
    await createFakturaOkresu({ db, program, vies, nipSprzedawcy: NIP_SPRZEDAWCY, teraz: TERAZ })
      .wystaw(okres.id, { nip: NIP_UE });
    const p = ladunek(program);
    expect(p.number).toBe('WDT/1/10/2026');
    expect(p.services.every((s) => s.tax_symbol === '0')).toBe(true);
    expect(vies.sprawdz).toHaveBeenCalledTimes(1);
  });
});
