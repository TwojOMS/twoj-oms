import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zarezerwujNumerWdt } from '../../../src/moduly/faktury/db/wdt-numery.js';
import { createFaktura } from '../../pomoc/faktura-parytetu.js';

// GAŁĄŹ WDT USŁUGI FAKTURY. Fixture i atrapy — wzorem tests/oms/faktura.test.js;
// nabywca unijny = Alfatrend (prawdziwy klient, dane z kartoteki inFaktu id 10000001).
const zmapowaneWdt = (nad = {}) => ({
  zrodlo_id: 2601, numer: 'R/2026/031',
  klient: {
    first_name: 'Peter', last_name: 'Novak', company: 'Alfatrend s.r.o.',
    email: 'peter@alfatrend.sk', address_1: '1. mája 1', postcode: '01001', city: 'Žilina',
  },
  dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null,
  chce_fakture: 1, nip: 'SK1000000001', kwota_brutto: '139.00', koszt_dostawy_brutto: '16.00',
  status_woo: 'processing',
  oplacone_at: null, anulowane: 0, utworzone_at: '2026-08-26T10:00:00',
  pozycje: [{ nazwa: 'Szablon malarski STOP 70x100cm', sku: null, ilosc: 2, cena_brutto: '61.50', vat: null }],
  ...nad,
});

const VIES_WAZNY = {
  wynik: 'wazny', nazwa: 'ALFATREND s.r.o.', adres: '1. mája 1…',
  dataZapytania: '2026-08-26T12:00:00.000Z', numerKonsultacji: 'WAPIAAAAY123456',
};

function zestawWdt(nad = {}, atrapy = {}) {
  const db = openOmsDb(':memory:');
  const infakt = {
    znajdzKlientaPoNip: atrapy.znajdz ?? vi.fn().mockResolvedValue(10000001),
    zalozKlienta: atrapy.zaloz ?? vi.fn().mockResolvedValue(555),
    wystaw: atrapy.wystaw ?? vi.fn().mockResolvedValue({ uuid: 'u1', numer: 'WDT/1/08/2026', ksefStatus: null }),
    oznaczZaplacona: vi.fn().mockResolvedValue({ referencja: 'ref-1' }),
    iluMaNumer: atrapy.iluMaNumer ?? vi.fn().mockResolvedValue(0),
  };
  const vies = 'vies' in atrapy ? atrapy.vies : { sprawdz: vi.fn().mockResolvedValue(VIES_WAZNY) };
  const id = zapiszZamowienie(db, 'pro', zmapowaneWdt(nad), {});
  const faktura = createFaktura({
    db, infakt, vies, teraz: () => '2026-08-26T12:00:00.000Z',
  });
  return { db, infakt, vies, id, faktura };
}

const wiersz = (db, id) => db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id);
const log = (db, id) => db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);

describe('faktura WDT — payload do inFaktu', () => {
  it('niesie osobny numer serii, typ sprzedaży i adnotację z NIP-em PL; pozycje 0%', async () => {
    const { infakt, faktura, id } = zestawWdt();
    await faktura.wystaw(id);
    const p = infakt.wystaw.mock.calls[0][0];
    expect(p.number).toBe('WDT/1/08/2026');
    expect(p.sale_type).toBe('merchandise');
    expect(p.sales_kind).toBe('sprzedaz_podstawowa');
    expect(p.notes).toContain('PL1234563218');
    expect(p.services.every((s) => s.tax_symbol === '0')).toBe(true);
  });

  it('numer serii idzie za DATĄ WYSTAWIENIA, nie za dniem kliknięcia', async () => {
    const { infakt, faktura, id } = zestawWdt();
    await faktura.wystaw(id, { dataWystawienia: '2026-07-31', termin: '14' });
    expect(infakt.wystaw.mock.calls[0][0].number).toBe('WDT/1/07/2026');
  });

  it('faktura KRAJOWA nie dostaje ŻADNEGO z pól WDT — payload bajt w bajt jak dotąd', async () => {
    const { infakt, vies, faktura, id } = zestawWdt({ nip: '1000001201' });
    await faktura.wystaw(id);
    const p = infakt.wystaw.mock.calls[0][0];
    for (const pole of ['number', 'sale_type', 'sales_kind', 'notes']) {
      expect(Object.hasOwn(p, pole)).toBe(false);
    }
    expect(vies.sprawdz).not.toHaveBeenCalled();
    expect(infakt.iluMaNumer).not.toHaveBeenCalled();
  });

  it('zakładany wpis kartoteki dostaje kraj Z PREFIKSU numeru, nie domyślne PL', async () => {
    const znajdz = vi.fn().mockResolvedValue(null);
    const { infakt, faktura, id } = zestawWdt({}, { znajdz });
    await faktura.wystaw(id);
    expect(infakt.zalozKlienta.mock.calls[0][0].country).toBe('SK');
    expect(infakt.zalozKlienta.mock.calls[0][0].nip).toBe('SK1000000001');
  });
});

describe('faktura WDT — VIES', () => {
  it('ważny numer: wystawia i zapisuje do logu dowód (nazwa, numer konsultacji)', async () => {
    const { db, infakt, faktura, id } = zestawWdt();
    await faktura.wystaw(id);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
    const vies = log(db, id).find((w) => w.akcja === 'wdt.vies');
    expect(vies.wynik).toContain('WAŻNY');
    expect(vies.wynik).toContain('ALFATREND');
    expect(vies.wynik).toContain('WAPIAAAAY123456');
  });

  it('NIEWAŻNY numer: odmowa z powodem, nic nie idzie do inFaktu, rezerwacja zwolniona', async () => {
    const vies = { sprawdz: vi.fn().mockResolvedValue({ ...VIES_WAZNY, wynik: 'niewazny' }) };
    const { db, infakt, faktura, id } = zestawWdt({}, { vies });
    await expect(faktura.wystaw(id)).rejects.toThrow(/NIEWAŻNY|nieważny/);
    expect(infakt.wystaw).not.toHaveBeenCalled();
    expect(wiersz(db, id)).toBeUndefined();
    // Licznik serii też wraca: następna próba dostaje numer 1, nie 2.
    expect(zarezerwujNumerWdt(db, { rok: 2026, miesiac: 8 })).toBe(1);
  });

  it('VIES niedostępny: wystawia, ale zapisuje OSTRZEŻENIE do logu', async () => {
    const vies = { sprawdz: vi.fn().mockResolvedValue({ wynik: 'niedostepny', nazwa: null, adres: null, dataZapytania: null, numerKonsultacji: null }) };
    const { db, infakt, faktura, id } = zestawWdt({}, { vies });
    await faktura.wystaw(id);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
    const wpis = log(db, id).find((w) => w.akcja === 'wdt.vies');
    expect(wpis.wynik).toMatch(/NIEDOSTĘPNY/i);
    expect(wpis.wynik).toMatch(/zweryfikuj/i);
  });

  it('panel bez usługi VIES zachowuje się jak przy niedostępnym — wystawia z ostrzeżeniem', async () => {
    const { db, infakt, faktura, id } = zestawWdt({}, { vies: null });
    await faktura.wystaw(id);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
    expect(log(db, id).find((w) => w.akcja === 'wdt.vies').wynik).toMatch(/NIEDOSTĘPNY/i);
  });
});

describe('faktura WDT — numeracja', () => {
  it('numer zajęty już w inFakcie: odmowa PRZED wystawieniem, licznik i rezerwacja zwolnione', async () => {
    const iluMaNumer = vi.fn().mockResolvedValue(1);
    const { db, infakt, faktura, id } = zestawWdt({}, { iluMaNumer });
    await expect(faktura.wystaw(id)).rejects.toThrow(/WDT\/1\/08\/2026/);
    expect(infakt.wystaw).not.toHaveBeenCalled();
    expect(wiersz(db, id)).toBeUndefined();
    expect(zarezerwujNumerWdt(db, { rok: 2026, miesiac: 8 })).toBe(1);
  });

  it('jednoznaczna odmowa inFaktu (4xx) zwalnia numer — kolejna próba dostaje ten sam', async () => {
    const wystaw = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Wadliwy zasób'), { dlaOperatora: true, status: 422 }))
      .mockResolvedValueOnce({ uuid: 'u2', numer: 'WDT/1/08/2026', ksefStatus: null });
    const { infakt, faktura, id } = zestawWdt({}, { wystaw });
    await expect(faktura.wystaw(id)).rejects.toThrow();
    await faktura.wystaw(id);
    expect(infakt.wystaw.mock.calls[1][0].number).toBe('WDT/1/08/2026');
  });

  it('awaria NIEJEDNOZNACZNA zostawia numer zajęty (dziura w serii zamiast ryzyka duplikatu)', async () => {
    const wystaw = vi.fn().mockRejectedValue(new Error('zerwane połączenie'));
    const { db, faktura, id } = zestawWdt({}, { wystaw });
    await expect(faktura.wystaw(id)).rejects.toThrow();
    expect(zarezerwujNumerWdt(db, { rok: 2026, miesiac: 8 })).toBe(2);
    const wpis = log(db, id).find((w) => w.akcja === 'wdt.numeracja');
    expect(wpis.wynik).toMatch(/WDT\/1\/08\/2026/);
    expect(wpis.wynik).toMatch(/dziura|zajęty/i);
  });

  it('inFakt nadał INNY numer niż żądany: głośny wpis w logu i zwolnienie licznika', async () => {
    const wystaw = vi.fn().mockResolvedValue({ uuid: 'u1', numer: '57/08/2026', ksefStatus: null });
    const { db, faktura, id } = zestawWdt({}, { wystaw });
    await faktura.wystaw(id);
    const wpis = log(db, id).find((w) => w.akcja === 'wdt.numeracja');
    expect(wpis.wynik).toContain('57/08/2026');
    expect(wpis.wynik).toContain('WDT/1/08/2026');
    expect(wpis.wynik).toMatch(/nie zadziałała|zamiast/i);
    // Wiersz faktury niesie PRAWDĘ inFaktu, nie nasze zamiary.
    expect(wiersz(db, id).numer).toBe('57/08/2026');
    expect(zarezerwujNumerWdt(db, { rok: 2026, miesiac: 8 })).toBe(1);
  });

  it('drugie zamówienie WDT w tym samym miesiącu dostaje numer 2', async () => {
    const { db, infakt, faktura, id } = zestawWdt({}, {
      wystaw: vi.fn()
        .mockResolvedValueOnce({ uuid: 'u1', numer: 'WDT/1/08/2026', ksefStatus: null })
        .mockResolvedValueOnce({ uuid: 'u2', numer: 'WDT/2/08/2026', ksefStatus: null }),
    });
    await faktura.wystaw(id);
    const id2 = zapiszZamowienie(db, 'pro', zmapowaneWdt({ zrodlo_id: 2602, numer: 'R/2026/032' }), {});
    await faktura.wystaw(id2);
    expect(infakt.wystaw.mock.calls[1][0].number).toBe('WDT/2/08/2026');
  });
});
