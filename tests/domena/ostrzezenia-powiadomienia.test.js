import { it, expect } from 'vitest';
import * as ostrzezenia from '../../src/domena/ostrzezenia.js';

it('osobisty filtr usuwa tylko wybrane typy, bez zmiany wierszy wejściowych', () => {
  const wiersze = [{ typ: 'faktura-ksef', klucz: 'k' }, { typ: 'przesylka', klucz: 'p' }];
  expect(ostrzezenia.zlozOstrzezenia({ wiersze, ukryteTypy: ['faktura-ksef'] })).toEqual([wiersze[1]]);
  expect(ostrzezenia.zlozOstrzezenia({ wiersze })).toHaveLength(2);
  expect(wiersze).toHaveLength(2);
});

it('każdy typ ma dokładnie jeden opis i to samo źródło kolejności', async () => {
  const powiadomienia = await import('../../src/domena/powiadomienia.js');
  expect(powiadomienia.RODZAJE_OSTRZEZEN.map(r => r.typ)).toEqual(ostrzezenia.KOLEJNOSC);
  expect(new Set(ostrzezenia.KOLEJNOSC).size).toBe(7);
  for (const r of powiadomienia.RODZAJE_OSTRZEZEN) {
    expect(r.nazwa.length).toBeGreaterThan(5);
    expect(r.opis.length).toBeGreaterThan(20);
  }
});

it('walidacja przyjmuje tylko tablicę znanych typów i usuwa duplikaty', async () => {
  const powiadomienia = await import('../../src/domena/powiadomienia.js');
  expect(powiadomienia.sprawdzUkryteTypy(['przesylka', 'przesylka'])).toEqual(['przesylka']);
  for (const zle of [['obcy'], 'przesylka', null, [1], {}]) {
    expect(() => powiadomienia.sprawdzUkryteTypy(zle)).toThrow();
  }
});
