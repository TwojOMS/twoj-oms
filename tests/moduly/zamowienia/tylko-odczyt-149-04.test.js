// PRZ-149.04 (C8): sklep podłączony kluczem „Odczyt”. Odesłanie statusu NIE woła sklepu — zamiast błędu
// z przyciskiem „Wyślij ponownie” (który i tak by nie pomógł) jest jawny komunikat i wpis w logu.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createSyncSklep } from '../../../src/moduly/zamowienia/services/sync-sklep.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { TYLKO_ODCZYT } from '../../../src/domena/woo-uprawnienia.js';

const zmapowane = (id) => ({
  zrodlo_id: id, numer: String(id), klient: { first_name: 'Anna', last_name: 'Półcień', email: 'anna@polcien.example' },
  dostawa: { first_name: 'Anna', last_name: 'Półcień', address_1: 'Cicha 1', postcode: '00-950', city: 'Warszawa', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '120.00',
  koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-11-03T09:00:00', pozycje: [],
});

describe('PRZ-149.04: odesłanie statusu przy sklepie „Odczyt”', () => {
  let db;
  beforeEach(() => { db = openOmsDb(':memory:'); });
  const wyslane = (id) => {
    const wewn = zapiszZamowienie(db, 'pro', zmapowane(id), {});
    db.prepare("UPDATE zamowienia SET wyslane_at = '2026-11-03T10:00:00' WHERE id = ?").run(wewn);
    return wewn;
  };

  it('nie woła ustawStatus, oddaje komunikat zamiast błędu i nie zostawia śladu do ponowień', async () => {
    const id = wyslane(5101);
    const woo = { tylkoOdczyt: true, ustawStatus: vi.fn().mockResolvedValue({}) };
    const sync = createSyncSklep({ db, klienci: { pro: woo } });
    const wynik = await sync.odeslijStatus(id);
    expect(woo.ustawStatus).not.toHaveBeenCalled();
    expect(wynik).toEqual({ wyslany: null, powod: TYLKO_ODCZYT });
    expect(pobierzZamowienie(db, id).sync_woo_blad).toBeNull();
    const logi = db.prepare('SELECT wynik FROM log WHERE zamowienie_id = ?').all(id).map((w) => w.wynik);
    expect(logi).toEqual([`POMINIĘTO: ${TYLKO_ODCZYT}`]);
    expect(sync.tylkoOdczyt('pro')).toBe(true);
  });

  it('ślad po odmowie klucza tylko do odczytu znika po przełączeniu sklepu na „Odczyt”', async () => {
    const id = wyslane(5102);
    const odmowa = { ustawStatus: vi.fn().mockRejectedValue(new Error('Klucz ma tylko odczyt')) };
    await createSyncSklep({ db, klienci: { pro: odmowa } }).odeslijStatus(id);
    expect(pobierzZamowienie(db, id).sync_woo_blad).toContain('Klucz ma tylko odczyt');
    const wynik = await createSyncSklep({ db, klienci: { pro: { tylkoOdczyt: true, ustawStatus: vi.fn() } } }).odeslijStatus(id);
    expect(wynik).toEqual({ wyslany: null, powod: TYLKO_ODCZYT });
    expect(pobierzZamowienie(db, id).sync_woo_blad).toBeNull();
  });

  it('sklep „Zapis/odczyt” i sklep bez klienta nie są „tylko do odczytu”', () => {
    const klienci = { pro: { ustawStatus: vi.fn() }, zly: null };
    Object.defineProperty(klienci, 'rzuca', { get() { throw new Error('nie połączony'); }, enumerable: true });
    const sync = createSyncSklep({ db, klienci });
    expect(sync.tylkoOdczyt('pro')).toBe(false);
    expect(sync.tylkoOdczyt('zly')).toBe(false);
    expect(sync.tylkoOdczyt('rzuca')).toBe(false);
    expect(sync.tylkoOdczyt('brak')).toBe(false);
  });
});

describe('PRZ-149.04: karta zamówienia sklepu „Odczyt”', () => {
  const config = { auth: { user: 'adam', pass: 'x' } };
  const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') };
  const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
  const karta = async (woo) => {
    const db = openOmsDb(':memory:');
    const app = buildOmsServer({ db, config, poller, syncSklep: createSyncSklep({ db, klienci: { pro: woo } }) });
    await app.ready();
    const id = zapiszZamowienie(db, 'pro', zmapowane(5201), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    await app.close();
    return r;
  };

  it('pokazuje komunikat przy sklepie „Odczyt”', async () => {
    const r = await karta({ tylkoOdczyt: true, ustawStatus: vi.fn() });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`<p class="pasek-uwaga" id="sklep-tylko-odczyt">${TYLKO_ODCZYT}</p>`);
  });

  it('nie pokazuje go przy sklepie „Zapis/odczyt”', async () => {
    const r = await karta({ ustawStatus: vi.fn() });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('sklep-tylko-odczyt');
  });
});
