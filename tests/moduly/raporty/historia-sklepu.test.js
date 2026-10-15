import { describe, it, expect } from 'vitest';
import { wierszHistorii, KONTA_SKLEPOW } from '../../pomoc/import-sklep-parytet.js';

const zam = (nad = {}) => ({
  id: 28225, number: '28225', status: 'completed',
  date_created: '2014-06-13T19:29:24', date_created_gmt: '2014-06-13T17:29:24',
  date_paid_gmt: '2014-06-13T17:31:00', currency: 'PLN', total: '246.00',
  billing: { email: 'k@klient.pl', first_name: 'Anna', last_name: 'Nowak', company: '' },
  line_items: [{
    name: 'Szablon kwiaty', sku: 'SZ-1', product_id: 501, variation_id: 0,
    quantity: 2, total: '160.00', total_tax: '36.80',
  }],
  shipping_lines: [{ method_title: 'Kurier DPD', total: '40.00', total_tax: '9.20' }],
  ...nad,
});

describe('wiersz historii ze sklepu', () => {
  it('NIE PRZENOSI ANI JEDNEJ DANEJ OSOBOWEJ', () => {
    const w = wierszHistorii('szkicownia', zam());
    expect(w.klientEmail).toBeNull();
    expect(w.klientNazwa).toBeNull();
    // Bariera na przyszlosc: gdyby ktos dolozyl pole, test ma je zlapac.
    expect(JSON.stringify(w)).not.toMatch(/klient\.pl|Anna|Nowak/);
  });

  it('klucz ma prefiks sklepu, a konto wskazuje kanal SZKICOWNIA_PL', () => {
    const w = wierszHistorii('szkicownia', zam());
    expect(w.apiloId).toBe('woo:szkicownia:28225');
    expect(w.zrodlo).toBe('woo:szkicownia');
    expect(w.platformAccountId).toBe(KONTA_SKLEPOW.get('szkicownia'));
    expect(w.platformAccountId).toBe(9);
  });

  it('brutto pozycji to total + total_tax — `total` w Woo jest NETTO linii', () => {
    const w = wierszHistorii('szkicownia', zam());
    const produkt = w.pozycje.find((p) => p.typ === 1);
    expect(produkt.bruttoLinii).toBe('196.80');
    expect(produkt.ilosc).toBe(2);
  });

  it('WYSYLKA JEST POZYCJA TYPU 2 — inaczej konkurowalaby z szablonami w rankingu', () => {
    const w = wierszHistorii('szkicownia', zam());
    const wysylka = w.pozycje.find((p) => p.nazwa === 'Kurier DPD');
    expect(wysylka.typ).toBe(2);
    expect(wysylka.bruttoLinii).toBe('49.20');
  });

  it('DZIEN LICZY SIE Z CZASU GMT, NIE Z LOKALNEGO — inaczej noc wpada w zla dobe', () => {
    const nocLatem = zam({ date_created: '2014-06-14T00:30:00', date_created_gmt: '2014-06-13T22:30:00' });
    expect(wierszHistorii('szkicownia', nocLatem).dzien).toBe('2014-06-14');
    const nocZima = zam({ date_created: '2014-01-14T00:30:00', date_created_gmt: '2014-01-13T23:30:00' });
    expect(wierszHistorii('szkicownia', nocZima).dzien).toBe('2014-01-14');
  });

  it('utworzone_at niesie strefe — bez `Z` reszta panelu przeczyta to jako czas warszawski', () => {
    expect(wierszHistorii('szkicownia', zam()).utworzoneAt).toBe('2014-06-13T17:29:24Z');
  });

  it('oplacone rozpoznajemy po date_paid_gmt', () => {
    expect(wierszHistorii('szkicownia', zam()).paymentStatus).toBe(2);
    expect(wierszHistorii('szkicownia', zam({ date_paid_gmt: null })).paymentStatus).toBeNull();
  });

  it('ZASLEPKA PANELU OFERT ZOSTAJE ROZPOZNAWALNA — original_code jak w erze Apilo', () => {
    const zZaslepka = zam({
      line_items: [{
        name: 'Pozycja indywidualna', sku: 'psm-zam-placeholder', product_id: 28040,
        variation_id: 0, quantity: 1, total: '100.00', total_tax: '23.00',
      }],
    });
    expect(wierszHistorii('szkicownia', zZaslepka).pozycje[0].originalCode).toBe('28040|0');
  });

  it('status Apilo zostaje pusty, surowy status sklepu jest zapisany', () => {
    const w = wierszHistorii('szkicownia', zam());
    expect(w.status).toBeNull();
    expect(w.statusZrodla).toBe('completed');
  });

  it('nieznany sklep PRZERYWA — kanal bez konta nie ma jak sie policzyc', () => {
    expect(() => wierszHistorii('drugamarka', zam())).toThrow(/drugamarka/);
  });
});
