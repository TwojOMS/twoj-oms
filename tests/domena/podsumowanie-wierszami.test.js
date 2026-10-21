import { describe, it, expect } from 'vitest';
import { podsumowanieWierszami } from '../../src/domena/podsumowanie-wierszami.js';
import { podsumowanieVat } from '../../src/domena/podsumowanie-vat.js';

// PRZ-105: podsumowanie netto / VAT / brutto pod pozycjami MA DAĆ TE SAME LICZBY CO FAKTURA.
// Zmierzone 21.10.2026 na 400 fakturach inFaktu (968 linii): netto linii = round(brutto × 100 / (100 + stawka)),
// netto dokumentu = suma netto linii (270/270 faktur wielopozycyjnych), VAT = brutto − netto.
describe('podsumowanieWierszami', () => {
  it('liczy netto WIERSZAMI, nie od sumy stawki: 2 × 0,50 zł przy 23% → 0,82 netto, 0,18 VAT', () => {
    const linie = [{ bruttoGr: 50, stawka: '23' }, { bruttoGr: 50, stawka: '23' }];
    expect(podsumowanieWierszami(linie)).toEqual({ nettoGr: 82, vatGr: 18, bruttoGr: 100 });
    // Reguła proformy (od sumy na stawkę) daje tu 81 — dokładnie ten grosz różnicy, którego ekran mieć nie może.
    const suma = podsumowanieVat(linie.map((l) => ({ gross_price: l.bruttoGr, tax_symbol: l.stawka }))).at(-1);
    expect(suma.nettoGr).toBe(81);
  });

  it('dwie stawki: 100,00 zł / 23% + 108,00 zł / 8% → 181,30 netto, 26,70 VAT', () => {
    expect(podsumowanieWierszami([{ bruttoGr: 10000, stawka: '23' }, { bruttoGr: 10800, stawka: 8 }]))
      .toEqual({ nettoGr: 18130, vatGr: 2670, bruttoGr: 20800 });
  });

  it('0% (WDT albo krajowe) → netto = brutto, VAT 0', () => {
    expect(podsumowanieWierszami([{ bruttoGr: 3750, stawka: '0' }])).toEqual({ nettoGr: 3750, vatGr: 0, bruttoGr: 3750 });
  });

  it('pusta lista → same zera', () => {
    expect(podsumowanieWierszami([])).toEqual({ nettoGr: 0, vatGr: 0, bruttoGr: 0 });
  });

  it('VAT jest odejmowaniem — kolumny zawsze sumują się do brutto', () => {
    for (let gr = 1; gr <= 5000; gr += 7) {
      const w = podsumowanieWierszami([{ bruttoGr: gr, stawka: '23' }, { bruttoGr: gr + 3, stawka: '5' }]);
      expect(w.nettoGr + w.vatGr).toBe(w.bruttoGr);
    }
  });

  it('kwota nie w całych groszach albo stawka spoza listy → wyjątek, nie cicha liczba', () => {
    expect(() => podsumowanieWierszami([{ bruttoGr: 10.5, stawka: '23' }])).toThrow();
    expect(() => podsumowanieWierszami([{ bruttoGr: 100, stawka: 'zw' }])).toThrow();
  });
});
