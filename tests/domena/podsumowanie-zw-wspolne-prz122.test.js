// PRZ-122.TFe: przypadki wspólne przeniesione z tests/domena/podsumowanie-zw-prz122.test.js; asercje bez zmian.
// PRZ-122.B07a — „zw” w podsumowaniach: karta/ekran (`podsumowanieWierszami`) i proforma (`podsumowanieVat`).
// Bez flagi `{ zw: true }` — odmowa jak dziś i stare wyniki znak w znak; z flagą — netto = brutto, VAT 0,
// osobny wiersz „zw” na proformie, a suma dokumentu = sumy TwojeFaktury (src/domena/twojefaktury/sumy.js).
// Dane zmyślone.
import { describe, it, expect } from 'vitest';
import { podsumowanieWierszami } from '../../src/domena/podsumowanie-wierszami.js';
import { podsumowanieVat } from '../../src/domena/podsumowanie-vat.js';

// Deterministyczny generator (jak w suma-podglad.test.js) — porażka da się powtórzyć co do przypadku.
function generator(ziarno) {
  let z = ziarno;
  return () => {
    z = (z * 1103515245 + 12345) % 2147483648;
    return z / 2147483648;
  };
}
const LICZBOWE = ['23', '8', '5', '0'];

describe('podsumowanieWierszami — „zw”', () => {
  it('bez flagi „zw” to wyjątek z tym samym zdaniem co dziś', () => {
    expect(() => podsumowanieWierszami([{ bruttoGr: 5700, stawka: 'zw' }]))
      .toThrow('Linia 1: stawka VAT spoza listy („zw”).');
    expect(() => podsumowanieWierszami([{ bruttoGr: 100, stawka: '23' }, { bruttoGr: 5700, stawka: 'zw' }], { zw: false }))
      .toThrow('Linia 2: stawka VAT spoza listy („zw”).');
  });

  it('z flagą: sama linia „zw” — netto = brutto, VAT 0', () => {
    expect(podsumowanieWierszami([{ bruttoGr: 5701, stawka: 'zw' }], { zw: true }))
      .toEqual({ nettoGr: 5701, vatGr: 0, bruttoGr: 5701 });
  });

  it('z flagą: mieszane „zw” + 23 — VAT wyłącznie od linii 23%', () => {
    const linie = [{ bruttoGr: 12300, stawka: '23' }, { bruttoGr: 5700, stawka: 'zw' }, { bruttoGr: 2000, stawka: 23 }];
    expect(podsumowanieWierszami(linie, { zw: true })).toEqual({ nettoGr: 17326, vatGr: 2674, bruttoGr: 20000 });
  });

  it('z flagą: inne stawki spoza listy dalej odmawiają', () => {
    expect(() => podsumowanieWierszami([{ bruttoGr: 100, stawka: 'np' }], { zw: true })).toThrow('stawka VAT spoza listy („np”)');
    expect(() => podsumowanieWierszami([{ bruttoGr: 100, stawka: 'ZW' }], { zw: true })).toThrow('stawka VAT spoza listy („ZW”)');
  });

  it('bez „zw” w liniach flaga nie zmienia wyniku (1000 losowych dokumentów)', () => {
    const los = generator(1105);
    for (let i = 0; i < 1000; i += 1) {
      const linie = Array.from({ length: 1 + Math.floor(los() * 6) }, () => ({
        bruttoGr: 1 + Math.floor(los() * 500000),
        stawka: LICZBOWE[Math.floor(los() * 4)],
      }));
      expect(podsumowanieWierszami(linie, { zw: true })).toEqual(podsumowanieWierszami(linie));
    }
  });
});

describe('podsumowanieVat (proforma) — „zw”', () => {
  it('bez flagi „zw” to odmowa jak dziś', () => {
    expect(() => podsumowanieVat([{ gross_price: 5700, tax_symbol: 'zw' }]))
      .toThrow('Pozycja 1 ma nierozpoznaną stawkę VAT („zw")');
  });

  it('bez flagi wynik dla stawek liczbowych znak w znak (stawka liczbą, kolejność malejąca, wiersz sumy)', () => {
    expect(podsumowanieVat([
      { gross_price: 12300, tax_symbol: '23' }, { gross_price: 1080, tax_symbol: 8 }, { gross_price: 50, tax_symbol: '0' },
    ])).toEqual([
      { stawka: 23, suma: false, nettoGr: 10000, vatGr: 2300, bruttoGr: 12300 },
      { stawka: 8, suma: false, nettoGr: 1000, vatGr: 80, bruttoGr: 1080 },
      { stawka: 0, suma: false, nettoGr: 50, vatGr: 0, bruttoGr: 50 },
      { stawka: null, suma: true, nettoGr: 11050, vatGr: 2380, bruttoGr: 13430 },
    ]);
  });

  it('z flagą: osobny wiersz „zw” na końcu (po 0), VAT 0, netto = brutto; suma = suma wierszy', () => {
    expect(podsumowanieVat([
      { gross_price: 5700, tax_symbol: 'zw' }, { gross_price: 12300, tax_symbol: '23' },
      { gross_price: 300, tax_symbol: ' zw ' }, { gross_price: 50, tax_symbol: '0' },
    ], { zw: true })).toEqual([
      { stawka: 23, suma: false, nettoGr: 10000, vatGr: 2300, bruttoGr: 12300 },
      { stawka: 0, suma: false, nettoGr: 50, vatGr: 0, bruttoGr: 50 },
      { stawka: 'zw', suma: false, nettoGr: 6000, vatGr: 0, bruttoGr: 6000 },
      { stawka: null, suma: true, nettoGr: 16050, vatGr: 2300, bruttoGr: 18350 },
    ]);
  });

  it('z flagą: same „zw”', () => {
    expect(podsumowanieVat([{ gross_price: 99, tax_symbol: 'zw' }], { zw: true })).toEqual([
      { stawka: 'zw', suma: false, nettoGr: 99, vatGr: 0, bruttoGr: 99 },
      { stawka: null, suma: true, nettoGr: 99, vatGr: 0, bruttoGr: 99 },
    ]);
  });

  it('z flagą: „np”, „ZW” i zepsuta kwota przy „zw” dalej odmawiają', () => {
    expect(() => podsumowanieVat([{ gross_price: 100, tax_symbol: 'np' }], { zw: true })).toThrow('nierozpoznaną stawkę VAT („np")');
    expect(() => podsumowanieVat([{ gross_price: 100, tax_symbol: 'ZW' }], { zw: true })).toThrow('nierozpoznaną stawkę VAT („ZW")');
    expect(() => podsumowanieVat([{ gross_price: 1.5, tax_symbol: 'zw' }], { zw: true })).toThrow('kwoty brutto w całych groszach');
  });

  it('bez „zw” w pozycjach flaga nie zmienia wyniku (500 losowych proform)', () => {
    const los = generator(424242);
    for (let i = 0; i < 500; i += 1) {
      const pozycje = Array.from({ length: 1 + Math.floor(los() * 6) }, () => ({
        gross_price: 1 + Math.floor(los() * 500000),
        tax_symbol: LICZBOWE[Math.floor(los() * 4)],
      }));
      expect(podsumowanieVat(pozycje, { zw: true })).toEqual(podsumowanieVat(pozycje));
    }
  });
});
