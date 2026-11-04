import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { OpisKuriera } from '../../src/core/kontrakty.ts';
import { MODULY_KURIEROW } from '../../src/domena/moduly-kurierow.ts';
import { OPISY_PRZEWOZNIKOW } from '../../src/domena/przewoznicy.ts';

const layout = readFileSync(new URL('../../src/core/web/widoki/layout-oms.ejs', import.meta.url), 'utf8');

describe('komplet opisów przewoźników PRZ-135', () => {
  for (const [klucz, opis] of Object.entries(OPISY_PRZEWOZNIKOW)) {
    it(`${klucz}: istniejące logo, klasa plakietki i wzorzec śledzenia`, () => {
      expect(opis.logo).toMatch(/^\/public\/przewoznicy\/[^/]+$/);
      expect(existsSync(fileURLToPath(new URL(`../../src${opis.logo}`, import.meta.url)))).toBe(true);
      expect(layout).toMatch(new RegExp(`\\.plakietka--${klucz}\\s*\\{`));
      expect(opis.sledzenie).toMatch(/\{numer\}$/);
    });
  }

  for (const opis of Object.values(MODULY_KURIEROW) as readonly OpisKuriera[]) {
    it(`${opis.klucz}: kurier ze śledzeniem ma adres lub przewoźnika ze śledzeniem`, () => {
      if (opis.umiejetnosci.sledzenie === 'brak') return;
      expect(typeof opis.sledzenieAdres === 'function' || opis.przewoznicy.some(klucz =>
        Object.hasOwn(OPISY_PRZEWOZNIKOW, klucz)
        && OPISY_PRZEWOZNIKOW[klucz as keyof typeof OPISY_PRZEWOZNIKOW].sledzenie.includes('{numer}'),
      )).toBe(true);
    });
  }
});
