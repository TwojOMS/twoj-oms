// tests/quote/quote-total-of.test.js
import { describe, it, expect } from 'vitest';
import { quoteTotalOf } from '../../../src/domena/z-panelu/quote-text.js';

describe('quoteTotalOf', () => {
  it('liczy sumę kompletnej wyceny tą samą arytmetyką co mail', () => {
    const q = { items: [{ qty: 3, price: 150 }], shipping: 19 };
    expect(quoteTotalOf(q)).toEqual({ itemsBrutto: 450, totalBrutto: 469, totalNetto: 381.3 });
  });
  it('null dla braku wyceny / pustych pozycji', () => {
    expect(quoteTotalOf(null)).toBe(null);
    expect(quoteTotalOf({ items: [] })).toBe(null);
  });
  it('null gdy pozycja niekompletna — JSON zamienia NaN w null, a Number(null)=0 to pułapka', () => {
    expect(quoteTotalOf({ items: [{ qty: 2, price: null }], shipping: 0 })).toBe(null);
    expect(quoteTotalOf({ items: [{ qty: '', price: 10 }], shipping: 0 })).toBe(null);
    expect(quoteTotalOf({ items: [{ qty: 1, price: 10 }], shipping: '' })).toBe(null);
  });
  it('cena 0 podana wprost (gratis) NADAL się liczy', () => {
    expect(quoteTotalOf({ items: [{ qty: 1, price: 0 }], shipping: 0 }).totalBrutto).toBe(0);
  });
  it('brak shipping = 0', () => {
    expect(quoteTotalOf({ items: [{ qty: 1, price: 100 }] }).totalBrutto).toBe(100);
  });
});
