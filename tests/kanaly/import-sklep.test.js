import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { createImportSklepu } from '../pomoc/import-sklep-parytet.js';
import { zapiszHistorie, historiaWOknie, wczytajKursorImportu } from '../../src/oms/db/historia-sprzedazy.js';

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

const zam = (id, dzien, nad = {}) => ({
  id, number: String(id), status: 'completed',
  date_created: `${dzien}T12:00:00`, date_created_gmt: `${dzien}T10:00:00`,
  date_paid_gmt: `${dzien}T10:01:00`, currency: 'PLN', total: '100.00',
  billing: { email: 'k@klient.pl', first_name: 'A', last_name: 'B', company: '' },
  line_items: [{ name: 'Szablon', sku: 'S1', product_id: 5, variation_id: 0, quantity: 1, total: '81.30', total_tax: '18.70' }],
  shipping_lines: [],
  ...nad,
});

const klientZ = (strony) => ({
  async pobierzZamowieniaZakresu({ page = 1 }) {
    return { zamowienia: strony[page - 1] ?? [], stron: strony.length, razem: strony.flat().length };
  },
});

// Wiersz z ERY APILO — konto 9 to sklep szkicownia.pl.
const apilowy = (id, dzien) => zapiszHistorie(db, {
  apiloId: id, platformAccountId: 9, numer: id, dzien, utworzoneAt: `${dzien}T10:00:00Z`,
  brutto: '50.00', waluta: 'PLN', status: 15, paymentStatus: 2, tagi: [], faktura: 0, pozycje: [],
});

// ⚠️ KAZDY PRZEBIEG POTRZEBUJE ERY APILO — sufit mierzy sie z niej, wiec baza bez niej
// ma import ODMOWIC. Warunki brzegowe („pusta era") maja wlasny test nizej.
beforeEach(() => { apilowy('MA241000001', '2024-10-07'); });

describe('import historii sklepu', () => {
  it('wciaga zamowienia ze wszystkich stron', async () => {
    const imp = createImportSklepu({ db, sklep: 'szkicownia', klient: klientZ([[zam(1, '2016-03-01')], [zam(2, '2016-03-02')]]) });
    const w = await imp.przebieg({ od: '2014-01-01', doDnia: '2024-10-06' });
    expect(w.pobranych).toBe(2);
    expect(historiaWOknie(db, '2016-01-01', '2016-12-31')).toHaveLength(2);
  });

  it('⚠️ SUFIT MIERZY SIE Z BAZY: import nie tknie dnia, o ktorym wie juz era Apilo', async () => {
    const imp = createImportSklepu({ db, sklep: 'szkicownia', klient: klientZ([[zam(1, '2024-10-07')]]) });
    await expect(imp.przebieg({ od: '2014-01-01', doDnia: '2024-10-07' }))
      .rejects.toThrow(/2024-10-07/);
    // W oknie zostaje WYLACZNIE wiersz z Apilo — sklepowy nie wszedl.
    expect(historiaWOknie(db, '2024-10-01', '2024-10-31')).toHaveLength(1);
  });

  it('sufit o jeden dzien nizej przechodzi', async () => {
    const imp = createImportSklepu({ db, sklep: 'szkicownia', klient: klientZ([[zam(1, '2024-10-06')]]) });
    const w = await imp.przebieg({ od: '2014-01-01', doDnia: '2024-10-06' });
    expect(w.pobranych).toBe(1);
  });

  it('⚠️ PUSTA ERA APILO ODMAWIA IMPORTU — „nic nie ma" to nie to samo, co „wszystko wolno"', async () => {
    const czysta = openOmsDb(':memory:');
    const imp = createImportSklepu({ db: czysta, sklep: 'szkicownia', klient: klientZ([[zam(1, '2016-03-01')]]) });
    await expect(imp.przebieg({ od: '2014-01-01', doDnia: '2024-10-06' }))
      .rejects.toThrow(/Era Apilo jest pusta/);
  });

  it('ZAMOWIENIE SPOZA OKNA (zapas doby w filtrze GMT) NIE ZAPISUJE SIE', async () => {
    const imp = createImportSklepu({ db, sklep: 'szkicownia', klient: klientZ([[zam(1, '2016-03-01'), zam(2, '2024-12-31')]]) });
    const w = await imp.przebieg({ od: '2014-01-01', doDnia: '2024-10-06' });
    expect(w.pobranych).toBe(1);
    expect(w.pominietych).toBe(1);
  });

  it('zamowienia testowe NIE WCHODZA i maja wlasny licznik', async () => {
    const imp = createImportSklepu({
      db, sklep: 'szkicownia',
      klient: klientZ([[zam(1, '2016-03-01'), zam(2, '2016-03-02', { billing: { email: 'wlasciciel@example.com' } })]]),
    });
    const w = await imp.przebieg({ od: '2014-01-01', doDnia: '2024-10-06' });
    expect(w.pobranych).toBe(1);
    expect(w.testowych).toBe(1);
  });

  it('KLIENT WDT ZATRZYMUJE PRZEBIEG i zostawia to, co juz zapisane', async () => {
    const imp = createImportSklepu({
      db, sklep: 'szkicownia',
      klient: klientZ([[zam(1, '2016-03-01'), zam(2, '2016-03-02', { billing: { email: 'info@alfatrend.sk' } }), zam(3, '2016-03-03')]]),
    });
    const w = await imp.przebieg({ od: '2014-01-01', doDnia: '2024-10-06' });
    expect(w.zatrzymany).toBe(true);
    expect(w.powod).toMatch(/WDT/);
    expect(w.pobranych).toBe(1);
    expect(historiaWOknie(db, '2016-01-01', '2016-12-31')).toHaveLength(1);
  });

  it('DWA PRZEBIEGI DAJA TEN SAM WYNIK', async () => {
    const strony = [[zam(1, '2016-03-01')]];
    await createImportSklepu({ db, sklep: 'szkicownia', klient: klientZ(strony) }).przebieg({ od: '2014-01-01', doDnia: '2024-10-06' });
    await createImportSklepu({ db, sklep: 'szkicownia', klient: klientZ(strony) }).przebieg({ od: '2014-01-01', doDnia: '2024-10-06' });
    expect(historiaWOknie(db, '2016-01-01', '2016-12-31')).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) c FROM sprzedaz_historyczna_pozycje').get().c).toBe(1);
  });

  it('⚠️ NIE RUSZA KURSORA IMPORTU Z APILO', async () => {
    await createImportSklepu({ db, sklep: 'szkicownia', klient: klientZ([[zam(1, '2016-03-01')]]) })
      .przebieg({ od: '2014-01-01', doDnia: '2024-10-06' });
    expect(wczytajKursorImportu(db)).toEqual({ ostatniDzien: null, ostatniId: null });
  });

  it('KURSOR Z INNEGO OKNA NIE JEST WZNOWIENIEM — przebieg startuje od strony 1', async () => {
    const strony = [[zam(1, '2016-03-01')], [zam(2, '2016-03-02')]];
    await createImportSklepu({ db, sklep: 'szkicownia', klient: klientZ(strony) }).przebieg({ od: '2014-01-01', doDnia: '2024-10-06' });
    // Inne okno = inny zbior. Gdyby kursor przeszedl, strona 1 zostalaby pominieta.
    const w = await createImportSklepu({ db, sklep: 'szkicownia', klient: klientZ(strony) })
      .przebieg({ od: '2015-01-01', doDnia: '2024-10-06' });
    expect(w.pobranych).toBe(2);
  });

  it('SONDA NICZEGO NIE ZAPISUJE, ale mierzy statusy, lata i waluty', async () => {
    const imp = createImportSklepu({
      db, sklep: 'szkicownia',
      klient: klientZ([[zam(1, '2016-03-01'), zam(2, '2017-04-01', { status: 'cancelled' }), zam(3, '2018-05-01', { currency: 'EUR' })]]),
    });
    const w = await imp.przebieg({ od: '2014-01-01', doDnia: '2024-10-06', sonda: true });
    // Liczymy WYLACZNIE wiersze sklepowe — wiersz z Apilo zasiał `beforeEach`.
    expect(db.prepare("SELECT COUNT(*) c FROM sprzedaz_historyczna WHERE zrodlo LIKE 'woo:%'").get().c).toBe(0);
    expect(w.statusy).toEqual({ completed: 2, cancelled: 1 });
    expect(w.lata).toEqual({ 2016: 1, 2017: 1, 2018: 1 });
    expect(w.waluty).toEqual({ PLN: 2, EUR: 1 });
  });
});
