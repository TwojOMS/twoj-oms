// PRZ-153.E5.3c — EAN na karcie produktu: 8 albo 13 cyfr z cyfrą kontrolną GTIN.
import { describe, it, expect } from 'vitest';
import { poprawnyEan } from '../../src/domena/ean.js';

describe('poprawnyEan', () => {
  it('przyjmuje EAN-13 i EAN-8 z dobrą cyfrą kontrolną', () => {
    expect(poprawnyEan('5901234123457')).toBe(true);
    expect(poprawnyEan('4006381333931')).toBe(true);
    expect(poprawnyEan('96385074')).toBe(true);
    expect(poprawnyEan('73513537')).toBe(true);
    // Cyfra kontrolna 0 (suma podzielna przez 10).
    expect(poprawnyEan('0000000000000')).toBe(true);
  });

  it('odrzuca złą cyfrę kontrolną', () => {
    expect(poprawnyEan('5901234123458')).toBe(false);
    expect(poprawnyEan('4006381333932')).toBe(false);
    expect(poprawnyEan('96385075')).toBe(false);
  });

  it('odrzuca inne długości, litery, spacje w środku i nie-napisy', () => {
    expect(poprawnyEan('590123412345')).toBe(false);
    expect(poprawnyEan('59012341234570')).toBe(false);
    expect(poprawnyEan('036000291452')).toBe(false); // UPC-A (12) — nie na tej karcie
    expect(poprawnyEan('59012341234 7')).toBe(false);
    expect(poprawnyEan('590123412345X')).toBe(false);
    expect(poprawnyEan('')).toBe(false);
    expect(poprawnyEan(null)).toBe(false);
    expect(poprawnyEan(5901234123457)).toBe(false);
  });
});
