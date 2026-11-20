// Nazwa wiersza wariantu Woo w podglądzie cen: rodzic + opis wariantu, bez podwajania.
import { describe, expect, it } from 'vitest';
import { nazwaWariantuWoo } from '../../src/domena/nazwa-wariantu-woo.js';

describe('nazwa wariantu Woo', () => {
  it('skleja nazwę rodzica z samym opisem atrybutów wariantu', () => {
    expect(nazwaWariantuWoo('Szablon Lampa', '70 x 100 cm', 'Szablon Lampa z lustra')).toBe(
      'Szablon Lampa — 70 x 100 cm',
    );
  });

  it('nie podwaja nazwy, gdy sklep składa tytuł wariantu z nazwy rodzica', () => {
    expect(nazwaWariantuWoo('Szablon Lampa', 'Szablon Lampa - 70 x 100 cm', 'Szablon Lampa')).toBe(
      'Szablon Lampa - 70 x 100 cm',
    );
  });

  it('bierze nazwę rodzica z lustra, gdy odczyt rodzica nie przyszedł', () => {
    expect(nazwaWariantuWoo(undefined, '70 x 100 cm', 'Szablon Lampa')).toBe('Szablon Lampa — 70 x 100 cm');
  });

  it('zostawia samą nazwę rodzica, gdy wariant nie ma nazwy', () => {
    expect(nazwaWariantuWoo('Szablon Lampa', '', 'Szablon Lampa z lustra')).toBe('Szablon Lampa');
    expect(nazwaWariantuWoo(undefined, undefined, 'Szablon Lampa')).toBe('Szablon Lampa');
  });
});
