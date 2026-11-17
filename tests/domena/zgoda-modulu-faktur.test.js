import { it, expect } from 'vitest';
import { zgodaTwojeFaktury, modulDostepny, MODULY_FAKTUR } from '../../src/domena/wybor-programu.js';

it.each([undefined, '', '  '])('brak zgody %j', (wartosc) => {
  expect(zgodaTwojeFaktury({ OMS_TWOJEFAKTURY: wartosc })).toBe(false);
});
it.each(['tak', ' Tak '])('jawna zgoda %j', (wartosc) => {
  expect(zgodaTwojeFaktury({ OMS_TWOJEFAKTURY: wartosc })).toBe(true);
});
it.each(['nie', '1'])('nieprawidłowa zgoda %j blokuje start', (wartosc) => {
  expect(() => zgodaTwojeFaktury({ OMS_TWOJEFAKTURY: wartosc })).toThrow(/OMS_TWOJEFAKTURY/);
});
it('tryb próby nie daje zgody instalacji', () => {
  const tf = MODULY_FAKTUR.find((m) => m.id === 'twojefaktury');
  expect(modulDostepny(tf, { zgoda: false, proba: true })).toBe(false);
  expect(modulDostepny(tf, { zgoda: true })).toBe(true);
});
