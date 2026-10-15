import { expect, it } from 'vitest';
import { probaPrzesylkiWymagana } from '../../../src/moduly/wysylka/services/status-kuriera.js';

const teraz = Date.parse('2026-09-22T12:00:00Z');
const p = { kurier: 'allegro_wza', przejeta_at: null,
  utworzona_at: '2026-09-22T08:00:00Z', status_kuriera_pobrany_at: '2026-09-22T11:49:00Z' };

it('nieprzejęte WzA pyta po 10 minutach, zwykła paczka dopiero po godzinie', () => {
  expect(probaPrzesylkiWymagana(p, teraz)).toBe(true);
  expect(probaPrzesylkiWymagana({ ...p, kurier: 'dpd' }, teraz)).toBe(false);
  expect(probaPrzesylkiWymagana({ ...p, przejeta_at: '2026-09-22T11:00:00Z' }, teraz)).toBe(false);
});

it('stare nieprzejęte WzA pyta najwyżej raz na dobę', () => {
  const stare = { ...p, utworzona_at: '2026-09-01T08:00:00Z',
    status_kuriera_pobrany_at: '2026-09-22T00:00:00Z' };
  expect(probaPrzesylkiWymagana(stare, teraz)).toBe(false);
  expect(probaPrzesylkiWymagana({ ...stare, status_kuriera_pobrany_at: '2026-09-21T11:59:00Z' }, teraz)).toBe(true);
});
