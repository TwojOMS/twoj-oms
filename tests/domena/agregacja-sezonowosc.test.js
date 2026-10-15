import { describe, it, expect } from 'vitest';
import { wgMiesiecy, dokumenty, klienci } from '../../src/domena/agregacja-sprzedazy.js';

const w = (dzien, brutto, extra = {}) => ({
  zrodlo: 'oms', id: 1, dzien, kanal: 'SZKICOWNIA_PL', bruttoGrosze: brutto,
  nettoGrosze: Math.round(brutto / 1.23), faktura: false, oplacone: true,
  email: 'a@b.pl', tagi: [], pozycje: [], ...extra,
});

describe('sezonowosc', () => {
  it('MIESIAC BEZ SPRZEDAZY MA WIERSZ Z ZEREM, a nie znika z wykresu', () => {
    const wynik = wgMiesiecy([w('2026-01-05', 10000), w('2026-03-05', 20000)],
      ['2026-01', '2026-02', '2026-03']);
    expect(wynik.map((m) => m.miesiac)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(wynik[1]).toMatchObject({ bruttoGrosze: 0, zamowien: 0 });
  });

  it('sumuje w obrebie miesiaca', () => {
    const wynik = wgMiesiecy([w('2026-01-05', 10000), w('2026-01-20', 5000)], ['2026-01']);
    expect(wynik[0]).toMatchObject({ bruttoGrosze: 15000, zamowien: 2 });
  });
});

describe('faktura vs paragon', () => {
  it('dzieli po liczbie i po wartosci', () => {
    const wynik = dokumenty([
      w('2026-01-05', 10000, { faktura: true }),
      w('2026-01-06', 30000, { faktura: false }),
    ]);
    expect(wynik.faktura).toMatchObject({ zamowien: 1, bruttoGrosze: 10000 });
    expect(wynik.paragon).toMatchObject({ zamowien: 1, bruttoGrosze: 30000 });
  });
});

describe('nowi vs powracajacy', () => {
  it('klient znany sprzed okresu liczy sie jako POWRACAJACY', () => {
    const wynik = klienci([w('2026-07-01', 100, { email: 'stary@k.pl' })], new Set(['stary@k.pl']));
    expect(wynik).toMatchObject({ nowych: 0, powracajacych: 1 });
  });

  it('DRUGIE zamowienie tego samego klienta W OKRESIE nie liczy go dwa razy', () => {
    const wynik = klienci([
      w('2026-07-01', 100, { email: 'nowy@k.pl' }),
      w('2026-07-05', 100, { email: 'nowy@k.pl' }),
    ], new Set());
    expect(wynik).toMatchObject({ nowych: 1, powracajacych: 0 });
  });

  it('zamowienie bez maila ma wlasny licznik, a nie udaje nowego klienta', () => {
    expect(klienci([w('2026-07-01', 100, { email: null })], new Set()))
      .toMatchObject({ nowych: 0, powracajacych: 0, bezMaila: 1 });
  });

  it('porownanie maili jest NIEWRAZLIWE na wielkosc liter', () => {
    expect(klienci([w('2026-07-01', 100, { email: 'Stary@K.pl' })], new Set(['stary@k.pl'])))
      .toMatchObject({ powracajacych: 1 });
  });
});
