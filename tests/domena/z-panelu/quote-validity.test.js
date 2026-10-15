import { describe, it, expect } from 'vitest';
import { quoteValidity } from '../../../src/domena/z-panelu/quote-validity.js';

describe('quoteValidity', () => {
  it('świeżo wysłana → pełne dni, nie wygasła', () => {
    const v = quoteValidity({ sentAt: '2026-07-12T09:22:00Z', validDays: 30 }, new Date('2026-07-12T15:00:00Z'));
    expect(v.remainingDays).toBe(30);
    expect(v.expired).toBe(false);
    expect(v.expiresOn).toBe('2026-08-11');
  });
  it('po 2 dniach → 28 dni', () => {
    const v = quoteValidity({ sentAt: '2026-07-12T09:22:00Z', validDays: 30 }, new Date('2026-07-14T09:00:00Z'));
    expect(v.remainingDays).toBe(28);
    expect(v.expired).toBe(false);
  });
  it('po terminie → wygasła, remaining 0', () => {
    const v = quoteValidity({ sentAt: '2026-07-12T09:22:00Z', validDays: 30 }, new Date('2026-09-01T09:00:00Z'));
    expect(v.remainingDays).toBe(0);
    expect(v.expired).toBe(true);
  });
  it('brak daty wysyłki → null', () => {
    expect(quoteValidity({ sentAt: null, validDays: 30 })).toBeNull();
  });
  it('domyślne 30 dni gdy validDays niepoprawne', () => {
    const v = quoteValidity({ sentAt: '2026-07-12T09:22:00Z', validDays: 'x' }, new Date('2026-07-12T15:00:00Z'));
    expect(v.remainingDays).toBe(30);
  });
});
