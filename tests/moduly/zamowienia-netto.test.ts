import {describe,it,expect} from 'vitest';
import {nettoZamowieniaGrosze} from '../../src/domena/netto-zamowienia.js';
describe('Jawna konfiguracja WDT specyfikacji',()=>{
 it('wybiera zero VAT wyłącznie dla jawnego klienta, bez nazw firmy w produkcji',()=>{
  expect(nettoZamowieniaGrosze(12300,'kupujacy@example.org',new Set())).toBe(10000);
  expect(nettoZamowieniaGrosze(12300,'KUPUJACY@example.org',new Set(['kupujacy@example.org']))).toBe(12300);
 });
});
