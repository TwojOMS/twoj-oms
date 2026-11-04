import { afterEach, beforeEach, expect, it } from 'vitest';
import { terminZamowienia, typZamowienia } from '../../src/domena/termin-wysylki.js';
import { kanalyAllegro, ustawKanalyAllegro } from '../../src/domena/moduly-kanalow.ts';

let poprzednie;
beforeEach(() => {
  poprzednie = kanalyAllegro();
  ustawKanalyAllegro(['rynek_polcien']);
});
afterEach(() => ustawKanalyAllegro(poprzednie));

it.each([
  ['allegro_polcien', 'allegro', 0, true],
  ['rynek_polcien', 'allegro', 0, true],
  ['sklep_polcien', 'krotki', 1, false],
  ['reczne', 'krotki', 1, false],
  ['AlLeGrOpolcien', 'allegro', 0, true],
])('%s — złoty termin i zachowany luźny prefiks', (sklep, typ, limit, cutoffAllegro) => {
  const z = { sklep, oplacone_at: '2026-11-03T09:00:00Z', pozycje: [] };
  expect(typZamowienia(z)).toBe(typ);
  expect(terminZamowienia(z)).toEqual({
    typ, start: '2026-11-03T09:00:00Z', dzienStartu: '2026-11-03', limit, cutoffAllegro, reczny: null,
  });
});
