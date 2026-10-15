import { describe, it, expect } from 'vitest';
import { zlozZestawienieKosztow } from '../../src/domena/paczka-dla-biura.js';

// Wiersze tak, jak oddaje je `kosztyOtrzymaneWMiesiacu`: kwoty jako NAPISY, `zrodlo` 'ksef'
// albo 'reczne', `dzien_otrzymania` policzony przez SQL.
const k = (n = {}) => ({
  ksef_number: 'K-1', numer_dokumentu: 'FV/1', sprzedawca_nip: '1', sprzedawca_nazwa: 'OVH',
  data_wystawienia: '2026-08-04', dzien_otrzymania: '2026-08-04', netto: '100.00', vat: '23.00',
  brutto: '123.00', waluta: 'PLN', rodzaj: 'Vat', zrodlo: 'ksef', ...n,
});
const r = (n = {}) => k({
  ksef_number: 'RECZNY-1', numer_dokumentu: 'INV-1', sprzedawca_nazwa: 'Meta', sprzedawca_nip: '',
  netto: '50.00', vat: '0.00', brutto: '50.00', rodzaj: 'Reczny', zrodlo: 'reczne',
  data_wystawienia: '2026-08-10', dzien_otrzymania: '2026-08-10', ...n,
});

describe('zlozZestawienieKosztow — dwie osobne części', () => {
  it('faktury z KSeF i dopisane ręcznie trafiają do OSOBNYCH list, każda z własnym lp.', () => {
    const z = zlozZestawienieKosztow({
      miesiac: '2026-08',
      koszty: [
        k({ ksef_number: 'K-2', numer_dokumentu: 'FV/2', dzien_otrzymania: '2026-08-06' }),
        r({ ksef_number: 'RECZNY-1', numer_dokumentu: 'INV-1' }),
        k({ ksef_number: 'K-1', numer_dokumentu: 'FV/1' }),
        r({ ksef_number: 'RECZNY-2', numer_dokumentu: 'INV-2', dzien_otrzymania: '2026-08-12' }),
      ],
    });
    expect(z.ksef.map((w) => [w.lp, w.numer])).toEqual([[1, 'FV/1'], [2, 'FV/2']]);
    expect(z.reczne.map((w) => [w.lp, w.numer])).toEqual([[1, 'INV-1'], [2, 'INV-2']]);
    expect(z.ksef.every((w) => w.zrodlo === 'ksef')).toBe(true);
    expect(z.reczne.every((w) => w.zrodlo === 'reczne')).toBe(true);
  });

  it('sumy: osobno KSeF, osobno ręczne i łącznie — w groszach, per waluta', () => {
    const z = zlozZestawienieKosztow({
      miesiac: '2026-08',
      koszty: [
        k(),
        k({ ksef_number: 'K-2', numer_dokumentu: 'FV/2', netto: '200.00', vat: '46.00', brutto: '246.00' }),
        k({ ksef_number: 'K-EUR', numer_dokumentu: 'FV/E', waluta: 'EUR', netto: '10.00', vat: '0.00', brutto: '10.00' }),
        r(),
        r({ ksef_number: 'RECZNY-2', numer_dokumentu: 'INV-2', netto: '30.00', vat: '0.00', brutto: '30.00' }),
      ],
    });
    expect(z.sumy.ksef.PLN).toEqual({ nettoGr: 30000, vatGr: 6900, bruttoGr: 36900 });
    expect(z.sumy.ksef.EUR).toEqual({ nettoGr: 1000, vatGr: 0, bruttoGr: 1000 });
    expect(z.sumy.reczne.PLN).toEqual({ nettoGr: 8000, vatGr: 0, bruttoGr: 8000 });
    expect(z.sumy.reczne.EUR).toBeUndefined();
    expect(z.sumy.razem.PLN).toEqual({ nettoGr: 38000, vatGr: 6900, bruttoGr: 44900 });
    expect(z.sumy.razem.EUR).toEqual({ nettoGr: 1000, vatGr: 0, bruttoGr: 1000 });
  });

  it('brak faktur ręcznych to pusta lista, a nie brak klucza; sumy ręczne puste', () => {
    const z = zlozZestawienieKosztow({ miesiac: '2026-08', koszty: [k()] });
    expect(z.reczne).toEqual([]);
    expect(z.sumy.reczne).toEqual({});
    expect(z.ksef).toHaveLength(1);
  });

  it('wiersz ręczny NIE powtarza „dołącz oryginał” — część ręczna mówi to raz, pod nagłówkiem', () => {
    const z = zlozZestawienieKosztow({ miesiac: '2026-08', koszty: [r(), r({ ksef_number: 'RECZNY-2', numer_dokumentu: 'INV-2' })] });
    expect(z.reczne.flatMap((w) => w.uwagi)).toEqual([]);
    expect(z.opisRecznych).toMatch(/dołącz/);
  });

  it('wiersz z KSeF zachowuje swoje uwagi (wystawiona/otrzymana na granicy miesiąca)', () => {
    const z = zlozZestawienieKosztow({
      miesiac: '2026-08', koszty: [k({ data_wystawienia: '2026-07-31', dzien_otrzymania: '2026-08-02' })],
    });
    expect(z.ksef[0].uwagi).toEqual(['wystawiona 31.07.2026, otrzymana 02.08.2026']);
  });

  it('kwarantanna zostaje ostrzeżeniem nad zestawieniem', () => {
    const z = zlozZestawienieKosztow({ miesiac: '2026-08', koszty: [k()], kwarantanna: 2 });
    expect(z.ostrzezenia.join(' ')).toMatch(/2 dokumenty kosztowe leżą w kwarantannie/);
    // To zestawienie, nie paczka — zdanie ma mówić o dokumencie, który księgowa trzyma w ręce.
    expect(z.ostrzezenia.join(' ')).toContain('NIE ma ich w tym zestawieniu');
    expect(z.ostrzezenia.join(' ')).not.toContain('paczce');
  });

  it('nie zmienia listy wejściowej i trzyma miesiąc', () => {
    const wejscie = [r(), k()];
    const kopia = JSON.stringify(wejscie);
    const z = zlozZestawienieKosztow({ miesiac: '2026-08', koszty: wejscie });
    expect(JSON.stringify(wejscie)).toBe(kopia);
    expect(z.miesiac).toBe('2026-08');
  });
});
