import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajZwrot, zwrot } from '../../../src/oms/db/zwroty.js';
import { createKorekta } from '../../../src/moduly/zwroty/services/korekta.js';
import { createInfaktClient } from '../../../src/oms/infakt/client.js';
import { polaWdtInfakt } from '../../../src/domena/wdt.js';
import { modulZwroty } from '../../../src/moduly/zwroty/modul.ts';
import { zapiszZwolnienie, PODSTAWA_ART_113 } from '../../../src/moduly/faktury/db/zwolnienie-vat.js';
import { programTestowy } from '../../pomoc/program-testowy.js';

let db; let id; let zwrotId;
const faktura = (stawka = '0') => ({ uuid: 'polcien-fv', number: 'FV 8/11/2026',
  invoice_date: '2026-11-02', client_id: 14808,
  services: [{ name: 'Lampa Półcień', quantity: 2, gross_price: 25800, tax_symbol: stawka }] });
const atrapa = (stawka) => ({ pobierzFakture: vi.fn().mockResolvedValue(faktura(stawka)),
  wystawKorekte: vi.fn().mockResolvedValue({ referencja: 'REF-WDT', uuid: null, numer: null }) });
beforeEach(() => {
  db = openOmsDb(':memory:');
  id = zapiszZamowienie(db, 'reczne', { zrodlo_id: 14808, numer: '14808',
    klient: { company: 'Pracownia Półcień', email: 'biuro@example.test' }, dostawa: {},
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: 'DE123456789',
    kwota_brutto: '258.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
    utworzone_at: '2026-11-01T12:00:00', pozycje: [{ zrodlo_id: 81, nazwa: 'Lampa Półcień',
      sku: 'LAMPA-P8', ilosc: 2, cena_brutto: '129.00', brutto_linii: '258.00', vat: null }] }, {});
  db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
    .run(id, 'polcien-fv', 'FV 8/11/2026', '2026-11-02T12:00:00Z');
  zwrotId = dodajZwrot(db, id, { data: '2026-11-03', kwota: '129.00',
    pozycje: [{ klucz_pozycji: 's81', nazwa: 'Lampa Półcień', ilosc: 1, kwota: '129.00' }] }).id;
});
afterEach(() => db.close());

describe('PRZ-148.08 korekta faktury WDT', () => {
  it('moduł pobiera bieżący NIP z config faktur przy wystawieniu', async () => {
    const infakt = atrapa();
    let nip = '';
    const nipBdoFirmy = vi.fn(() => ({ nip }));
    const ctx = { db, usluga: (modul, usluga) => {
      expect(modul).toBe('faktury');
      return usluga === 'infakt' ? infakt : { nipBdoFirmy };
    } };
    const { uslugi } = modulZwroty.zbuduj(ctx);
    expect(nipBdoFirmy).not.toHaveBeenCalled();
    nip = '1234563218';
    await uslugi.korekta.wystaw(id, zwrotId);
    expect(nipBdoFirmy).toHaveBeenCalledTimes(1);
    expect(infakt.wystawKorekte.mock.calls[0][0].notes)
      .toBe(`${polaWdtInfakt('DE123456789', { nipSprzedawcy: nip }).notes} Zwrot towaru`);
  });
  it('wysyła rodzaj sprzedaży i adnotację; czyta NIP dopiero przy wystawieniu', async () => {
    const infakt = atrapa();
    let nip = '';
    const nipSprzedawcy = vi.fn(() => nip);
    const usluga = createKorekta({ db, infakt, nipSprzedawcy });
    expect(nipSprzedawcy).not.toHaveBeenCalled();
    nip = '1234563218';
    await usluga.wystaw(id, zwrotId);
    expect(nipSprzedawcy).toHaveBeenCalledTimes(1);
    const payload = infakt.wystawKorekte.mock.calls[0][0];
    expect(payload).toMatchObject({ sale_type: 'merchandise', sales_kind: 'sprzedaz_podstawowa',
      notes: `${polaWdtInfakt('DE123456789', { nipSprzedawcy: nip }).notes} Zwrot towaru` });
    expect(Object.keys(payload).slice(-3)).toEqual(['services', 'sale_type', 'sales_kind']);
  });

  it.each(['23', 'zw'])('UE ze stawką %s: odmowa przed rezerwacją', async (stawka) => {
    const infakt = atrapa(stawka);
    await expect(createKorekta({ db, infakt, nipSprzedawcy: '1234563218' }).wystaw(id, zwrotId))
      .rejects.toMatchObject({ dlaOperatora: true, message: expect.stringContaining('nie wygląda na WDT') });
    expect(infakt.wystawKorekte).not.toHaveBeenCalled();
    expect(zwrot(db, id, zwrotId).korekta_zlecona_at).toBeNull();
  });

  it('bez NIP-u sprzedawcy: odmowa z miejscem konfiguracji przed rezerwacją', async () => {
    const infakt = atrapa();
    const blad = await createKorekta({ db, infakt }).wystaw(id, zwrotId).catch((e) => e);
    expect(blad).toMatchObject({ dlaOperatora: true });
    expect(blad.message).toContain('Ustawienia → Firma');
    expect(blad.message).toContain('Korekta NIE została zlecona.');
    expect(infakt.wystawKorekte).not.toHaveBeenCalled();
    expect(zwrot(db, id, zwrotId).korekta_zlecona_at).toBeNull();
  });

  it.each(['23', '0'])('krajowa ze stawką %s: identyczny ładunek i kolejność kluczy', async (stawka) => {
    db.prepare('UPDATE zamowienia SET nip = ? WHERE id = ?').run('1234563218', id);
    const infakt = atrapa(stawka);
    const nipSprzedawcy = vi.fn();
    await createKorekta({ db, infakt, nipSprzedawcy }).wystaw(id, zwrotId);
    const oczekiwany = { client_id: 14808, corrected_invoice_number: 'FV 8/11/2026',
      corrected_invoice_date: '2026-11-02', corrected_invoice_uuid: 'polcien-fv',
      correction_reason: 'zwrot towaru', notes: 'Zwrot towaru', services: [
        { name: 'Lampa Półcień', quantity: 2, gross_price: 25800, tax_symbol: stawka, group: 1, correction: false },
        { name: 'Lampa Półcień', quantity: 1, gross_price: 12900, tax_symbol: stawka, group: 1, correction: true },
      ] };
    expect(infakt.wystawKorekte.mock.calls[0][0]).toEqual(oczekiwany);
    expect(JSON.stringify(infakt.wystawKorekte.mock.calls[0][0])).toBe(JSON.stringify(oczekiwany));
    expect(nipSprzedawcy).not.toHaveBeenCalled();
  });

  it('firma zwolniona (TwojeFaktury, stawka zw), nabywca z numerem UE: korekta krajowa bez odmowy', async () => {
    zapiszZwolnienie(db, { zwolniona: true, podstawa: PODSTAWA_ART_113, rodzaj: 'ustawa' });
    db.prepare("UPDATE faktury SET program = 'twojefaktury' WHERE zamowienie_id = ?").run(id);
    const { pobierzFakture, wystawKorekte } = atrapa('zw');
    const p = programTestowy({ id: 'twojefaktury', metody: { pobierzFakture, wystawKorekte } });
    const program = { ...p, opis: Object.freeze({ ...p.opis, wbudowany: true }) };
    const nipSprzedawcy = vi.fn();
    await createKorekta({ db, program, nipSprzedawcy }).wystaw(id, zwrotId);
    const payload = wystawKorekte.mock.calls[0][0];
    expect(payload.notes).toBe('Zwrot towaru');
    expect(payload).not.toHaveProperty('sale_type');
    expect(nipSprzedawcy).not.toHaveBeenCalled();
  });

  it('doczytaj zapisuje polski opis odrzucenia sale_type i zwalnia rezerwację', async () => {
    db.prepare('UPDATE zwroty SET korekta_zlecona_at = ?, korekta_referencja = ? WHERE id = ?')
      .run('2026-11-04T10:00:00Z', 'REF-WDT', zwrotId);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({
      processing_code: 422, invoice_errors: { sale_type: ['Proszę określić rodzaj sprzedaży.'] },
    }) }));
    await createKorekta({ db, infakt: createInfaktClient({ apiKey: 'fikcyjny', fetchImpl }) }).doczytaj(id, zwrotId);
    expect(zwrot(db, id, zwrotId).korekta_blad).toContain('rodzaj sprzedaży — Proszę określić rodzaj sprzedaży.');
    expect(zwrot(db, id, zwrotId).korekta_zlecona_at).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
