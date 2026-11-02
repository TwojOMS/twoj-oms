import { describe, it, expect } from 'vitest';
import { krokDemoMs } from '../../scripts/instalacja-wspolne.mjs';

// Granica raportu przy starcie to „wczoraj” (UTC), a raport liczy dzień zamówienia po Warszawie. Demo z zamówieniami
// sprzed 1–3 h, zainstalowane między 00:00 a 02:00 UTC, kładło najstarsze na dzień granicy — RAPORTY odmawiały (400).
const dzienPl = (ms) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(ms);

describe('demo instalatora — zamówienia w dzisiejszym dniu Warszawy', () => {
  for (const chwila of ['2026-10-28T01:39:00Z', '2026-10-27T23:00:00.500Z', '2026-07-01T22:30:00Z', '2026-03-29T01:30:00Z']) {
    it(`noc ${chwila}: trzy zamówienia nie wychodzą przed północ`, () => {
      const teraz = Date.parse(chwila);
      const krok = krokDemoMs(teraz);
      expect(krok).toBeGreaterThan(0);
      expect(dzienPl(teraz - 3 * krok)).toBe(dzienPl(teraz));
    });
  }
  it('w dzień zostaje godzina odstępu', () => {
    expect(krokDemoMs(Date.parse('2026-10-28T11:00:00Z'))).toBe(3600_000);
  });
});
