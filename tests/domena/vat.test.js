import { describe, it, expect } from 'vitest';
import { STAWKA_VAT, nettoZBruttoDoPokazania } from '../../src/domena/vat.js';

describe('STAWKA_VAT', () => {
  it('jest tą samą stawką, którą wysyła faktura', () => {
    expect(STAWKA_VAT).toBe('23');
  });
});

describe('nettoZBruttoDoPokazania', () => {
  it('liczy netto ze stawki VAT — 61,50 brutto to 50,00 netto', () => {
    expect(nettoZBruttoDoPokazania('61.50')).toBe('50.00');
  });

  it('zaokrągla do pełnych groszy, na liczbach całkowitych', () => {
    // 100,00 / 1,23 = 81,300813... zł → 81,30 zł
    expect(nettoZBruttoDoPokazania('100.00')).toBe('81.30');
  });

  it('zero brutto → zero netto, nie null', () => {
    expect(nettoZBruttoDoPokazania('0.00')).toBe('0.00');
  });

  // Ta funkcja jedzie na karcie zamówienia, która NIE MA PRAWA wywalić się na uszkodzonej
  // wartości — brak danych ma wyglądać jak brak danych, a nie jak awaria panelu.
  it('brak / nieliczbowa wartość → null, nigdy wyjątek', () => {
    expect(nettoZBruttoDoPokazania(null)).toBeNull();
    expect(nettoZBruttoDoPokazania('')).toBeNull();
    expect(nettoZBruttoDoPokazania('zła')).toBeNull();
  });
});
