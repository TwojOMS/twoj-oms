import { expect, it } from 'vitest';
import { liczbaPolska, cenaPolska, zlotowki } from '../../src/domena/kwoty.js';

it('formatuje liczby przez polskie Intl, również zero i tysiące', () => {
  expect(liczbaPolska(1.9)).toBe('1,9');
  expect(liczbaPolska(0)).toBe('0');
  expect(liczbaPolska(12345.67)).toBe('12\u00a0345,67');
  expect(cenaPolska('289.00')).toBe('289,00 zł');
  expect(cenaPolska('0.00')).toBe('0,00 zł');
  expect(cenaPolska('12345.67')).toBe('12\u00a0345,67 zł');
  // Maile do klienta zostają przy dotychczasowym formacie (bez odstępu tysięcy).
  expect(zlotowki('12345.67')).toBe('12345,67 zł');
});

it.each(['', null])('zlotowki zachowuje znak braku kwoty dla %s', wartosc => {
  expect(zlotowki(wartosc)).toBe('—');
});
it.each(['abc', NaN])('zlotowki nie pokazuje niepoprawnej liczby %s', wartosc => {
  expect(zlotowki(wartosc)).toBe('');
});
it('zlotowki przyjmuje przecinek dziesiętny jak przed PRZ-160.09', () => {
  expect(zlotowki('12,50')).toBe('12,50 zł');
  expect(zlotowki('12.50')).toBe('12,50 zł');
});
