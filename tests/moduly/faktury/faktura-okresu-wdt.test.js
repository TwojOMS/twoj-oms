import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapewnijOkres } from '../../../src/oms/db/okresy.js';
import { zarezerwujNumerWdt } from '../../../src/moduly/faktury/db/wdt-numery.js';
import { createFakturaOkresu, pozycjeOkresu } from '../../pomoc/faktura-okresu-parytetu.js';
import { STAN } from '../../../src/domena/okres-rozliczeniowy.js';

// GAŁĄŹ WDT FAKTURY OKRESU — fixture wzorem tests/oms/faktura-okresu-wystaw.test.js.
// Klient okresu = Alfatrend (rozliczenie zbiorcze uzgodnione — wiki „WDT — faktury
// wewnątrzwspólnotowe"); stawka dokumentu liczy się z NIP-u KLIENTA okresu, raz.
function bazaZOkresem() {
  const db = openOmsDb();
  const okres = zapewnijOkres(db, { klientKlucz: 'alfatrend', rok: 2026, miesiac: 7 });
  db.prepare(
    'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, okres_rozliczeniowy_id, utworzone_at)'
    + " VALUES ('reczne', 202600001, 'R/2026/001', '96.48', ?, '2026-07-10T10:00:00.000Z')",
  ).run(okres.id);
  const zamId = db.prepare('SELECT id FROM zamowienia WHERE numer = ?').get('R/2026/001').id;
  db.prepare(
    'INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, brutto_linii, zrodlo)'
    + " VALUES (?, 'Lampa stołowa Kałamarz 30x45cm', 2, '40.24', '80.48', 'reczna'),"
    + " (?, 'Kurier DPD', 1, '16.00', '16.00', 'reczna')",
  ).run(zamId, zamId);
  return { db, okres, zamId };
}

const VIES_WAZNY = {
  wynik: 'wazny', nazwa: 'ALFATREND s.r.o.', adres: null,
  dataZapytania: '2026-08-26T12:00:00.000Z', numerKonsultacji: 'WAPIAAAAY123456',
};

const infaktUdany = (nad = {}) => ({
  znajdzKlientaPoNip: vi.fn().mockResolvedValue(10000001),
  zalozKlienta: vi.fn(),
  wystaw: vi.fn().mockResolvedValue({ uuid: 'u-1', numer: 'WDT/1/08/2026', ksefStatus: null }),
  iluMaNumer: vi.fn().mockResolvedValue(0),
  ...nad,
});

const usluga = (db, infakt, vies = { sprawdz: vi.fn().mockResolvedValue(VIES_WAZNY) }) => createFakturaOkresu({
  db, infakt, vies, teraz: () => '2026-08-26T12:00:00.000Z',
});

const KLIENT_WDT = { nip: 'SK1000000001', nazwa: 'Alfatrend s.r.o.' };
const log = (db, id) => db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);

describe('pozycjeOkresu — stawka dokumentu', () => {
  const zamowienia = [{
    pozycje: [{ nazwa: 'STOP', ilosc: 2, cena_brutto: '40.24', brutto_linii: '80.48' }],
    koszt_dostawy_brutto: '0.00',
  }];

  it('bez opcji liczy jak dotąd — 23%', () => {
    expect(pozycjeOkresu(zamowienia)[0].tax_symbol).toBe('23');
  });

  it('ze stawką dokumentu 0 każda pozycja jedzie 0%', () => {
    expect(pozycjeOkresu(zamowienia, { stawka: '0' })[0].tax_symbol).toBe('0');
  });
});

describe('faktura okresu WDT', () => {
  it('payload niesie numer serii, typ sprzedaży, adnotację PL i pozycje 0%', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany();
    const wynik = await usluga(db, infakt).wystaw(okres.id, KLIENT_WDT);
    expect(wynik.stan).toBe(STAN.ZAFAKTUROWANY);
    const p = infakt.wystaw.mock.calls[0][0];
    expect(p.number).toBe('WDT/1/08/2026');
    expect(p.sale_type).toBe('merchandise');
    expect(p.notes).toContain('PL1234563218');
    expect(p.services.every((s) => s.tax_symbol === '0')).toBe(true);
  });

  it('klient krajowy: payload bez ŻADNEGO pola WDT — bajt w bajt jak dotąd', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany();
    const vies = { sprawdz: vi.fn() };
    await usluga(db, infakt, vies).wystaw(okres.id, { nip: '1000001017' });
    const p = infakt.wystaw.mock.calls[0][0];
    for (const pole of ['number', 'sale_type', 'sales_kind', 'notes']) {
      expect(Object.hasOwn(p, pole)).toBe(false);
    }
    expect(p.services.every((s) => s.tax_symbol === '23')).toBe(true);
    expect(vies.sprawdz).not.toHaveBeenCalled();
    expect(infakt.iluMaNumer).not.toHaveBeenCalled();
  });

  it('VIES nieważny: odmowa PRZED zamknięciem okresu — po wyjaśnieniu wystawia się bez śladów', async () => {
    const { db, okres, zamId } = bazaZOkresem();
    const infakt = infaktUdany();
    const zepsuty = { sprawdz: vi.fn().mockResolvedValue({ ...VIES_WAZNY, wynik: 'niewazny' }) };
    await expect(usluga(db, infakt, zepsuty).wystaw(okres.id, KLIENT_WDT)).rejects.toThrow(/NIEWAŻNY/);
    expect(infakt.wystaw).not.toHaveBeenCalled();
    // Nic się nie zablokowało: ta sama usługa z dobrym VIES wystawia od ręki.
    await usluga(db, infakt).wystaw(okres.id, KLIENT_WDT);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
    // Dowód weryfikacji trafia do logu zamówień okresu.
    expect(log(db, zamId).some((w) => w.akcja === 'wdt.vies' && /WAŻNY/.test(w.wynik))).toBe(true);
  });

  it('jednoznaczna odmowa inFaktu zwalnia numer serii — ponowienie dostaje ten sam', async () => {
    const { db, okres } = bazaZOkresem();
    const infakt = infaktUdany({
      wystaw: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('Wadliwy zasób'), { dlaOperatora: true, status: 422 }))
        .mockResolvedValueOnce({ uuid: 'u-2', numer: 'WDT/1/08/2026', ksefStatus: null }),
    });
    const u = usluga(db, infakt);
    await expect(u.wystaw(okres.id, KLIENT_WDT)).rejects.toThrow();
    await u.wystaw(okres.id, KLIENT_WDT);
    expect(infakt.wystaw.mock.calls[1][0].number).toBe('WDT/1/08/2026');
  });

  it('inFakt nadał inny numer: głośny wpis w logu zamówień i zwolniony licznik', async () => {
    const { db, okres, zamId } = bazaZOkresem();
    const infakt = infaktUdany({
      wystaw: vi.fn().mockResolvedValue({ uuid: 'u-3', numer: '58/08/2026', ksefStatus: null }),
    });
    await usluga(db, infakt).wystaw(okres.id, KLIENT_WDT);
    const wpis = log(db, zamId).find((w) => w.akcja === 'wdt.numeracja');
    expect(wpis.wynik).toContain('58/08/2026');
    expect(wpis.wynik).toContain('WDT/1/08/2026');
    expect(zarezerwujNumerWdt(db, { rok: 2026, miesiac: 8 })).toBe(1);
  });
});
