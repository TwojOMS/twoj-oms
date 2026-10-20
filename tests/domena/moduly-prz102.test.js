import { expect, it } from 'vitest';

it('biała lista wyłączanych ekranów i bezpieczny odczyt uszkodzonego zapisu', async () => {
  const { parsujWylaczoneModuly, MODULY_OPCJONALNE } = await import('../../src/domena/moduly-opcjonalne.js');
  // PRZ-102.22: + Koszty.
  expect(MODULY_OPCJONALNE.map(m => m.klucz)).toEqual(['klienci', 'okresy', 'koszty']);
  expect(parsujWylaczoneModuly('["klienci","okresy","klienci","koszty"]')).toEqual(['klienci', 'okresy', 'koszty']);
  for (const wartosc of [null, '', '{', '{}', '["zamowienia"]', '["klienci",5]']) expect(parsujWylaczoneModuly(wartosc)).toEqual([]);
});
