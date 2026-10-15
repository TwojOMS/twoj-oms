import { describe, it, expect } from 'vitest';
import { ostrzezenia } from '../../src/domena/ostrzezenia-raportu.js';

// Kazdy kanal historyczny (w tym GDD, tag 9 — patrz kanaly-raportowe.js) potrzebuje wlasnej
// granicy: sprzedazWOkresie/granicaDla PRZERYWA na kanale bez wpisu w granice_historii, wiec
// w prawdziwych danych (import 2309 zamowien juz przeszedl) granica dla GDD musi istniec.
const granice = [
  { kanal: 'SZKICOWNIA_PL', do_dnia: '2026-07-02', zrodlo: 'pomiar', uwaga: null },
  { kanal: 'GDD', do_dnia: '2026-07-02', zrodlo: 'pomiar', uwaga: null },
];
const w = (extra = {}) => ({
  zrodlo: 'historia', zrodloDanych: 'apilo', id: 'A', dzien: '2026-06-10', kanal: 'SZKICOWNIA_PL',
  bruttoGrosze: 10000, nettoGrosze: 8130, faktura: false, oplacone: true,
  email: 'a@b.pl', tagi: [3], pozycje: [], ...extra,
});

const kody = (wiersze, zakres = { od: '2026-06-01', do: '2026-06-30' }) =>
  ostrzezenia(wiersze, { ...zakres, granice }).map((o) => o.kod);

describe('pas ostrzezen', () => {
  it('MILCZY, gdy nie ma o czym mowic', () => {
    expect(kody([w()])).toEqual([]);
  });

  it('mowi, gdy okres przecina granice historii', () => {
    expect(kody([w()], { od: '2026-06-01', do: '2026-07-31' })).toContain('granica');
  });

  it('liczy zamowienia BEZ ZADNEGO TAGU, ale tylko w erze historycznej', () => {
    expect(kody([w({ tagi: [] })])).toContain('bez-tagu');
    // ⚠️ Wiersz z OMS-u nie ma tagow z definicji — alarm o nim bylby wyciem przy dobrych danych.
    expect(kody([w({ zrodlo: 'oms', tagi: [] })])).not.toContain('bez-tagu');
  });

  it('⚠️ HISTORIA ZE SKLEPU NIE JEST „BEZ TAGU" — Woo tagow Apilo nie zna i nigdy nie znalo', () => {
    // Import ze sklepu wnosi ~8 500 takich wierszy. Bez tego warunku pas krzyczalby o nich
    // przy KAZDYM raporcie siegajacym przed pazdziernik 2024.
    expect(kody([w({ zrodloDanych: 'woo:szkicownia', tagi: [] })])).not.toContain('bez-tagu');
    // ...a wiersz z Apilo obok niego nadal sie liczy.
    expect(kody([w({ zrodloDanych: 'woo:szkicownia', tagi: [] }), w({ tagi: [] })])).toContain('bez-tagu');
  });

  it('liczy zamowienia BEZ POTWIERDZONEJ PLATNOSCI', () => {
    // bruttoGrosze:12300 / nettoGrosze:10000 to spojna para (12300 / 1.23 = 10000 dokladnie) —
    // ostrzezenie liczy NETTO z wiersza, wiec oba pola musza sie zgadzac, inaczej test sprawdza
    // przypadek, ktory nie moze wystapic w prawdziwych danych.
    const o = ostrzezenia([w({ oplacone: false, bruttoGrosze: 12300, nettoGrosze: 10000 })],
      { od: '2026-06-01', do: '2026-06-30', granice });
    const wpis = o.find((x) => x.kod === 'bez-platnosci');
    expect(wpis.tresc).toMatch(/1 zamówienie/);
    expect(wpis.tresc).toMatch(/100,00/);
  });

  it('mowi, ze kanal GDD nie istnieje po granicy, gdy okres obejmuje obie epoki', () => {
    expect(kody([w()], { od: '2026-06-01', do: '2026-08-01', kanalGddWHistorii: true })).toContain('gdd');
  });

  // PRZ-073: kanal GDD jest algorytmiczny i ma granice w KAZDEJ instancji (generator demo zaklada
  // ja wszystkim kanalom raportu), ale istnieje tylko tam, gdzie klasyfikacja ma tag GDD.
  // Bez tego warunku demo i klient bez takiego kanalu czytaliby o „kanale GDD" w kazdym raporcie.
  it('⚠️ MILCZY o GDD, gdy instancja nie ma tego kanalu w historii, choc granica istnieje', () => {
    expect(kody([w()], { od: '2026-06-01', do: '2026-08-01', kanalGddWHistorii: false })).not.toContain('gdd');
    expect(kody([w()], { od: '2026-06-01', do: '2026-08-01' })).not.toContain('gdd');
  });

  it('tresc ostrzezenia bierze nazwe kanalu z granicy, nie z kodu', () => {
    const o = ostrzezenia([w()], { od: '2026-06-01', do: '2026-08-01', granice, kanalGddWHistorii: true });
    expect(o.find((x) => x.kod === 'gdd').tresc).toMatch(/^Po granicy historii kanał GDD nie istnieje/);
  });
});
