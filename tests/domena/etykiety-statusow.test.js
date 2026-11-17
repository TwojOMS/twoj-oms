import { it, expect } from 'vitest';
import { powodOdmowyStatusu } from '../../src/domena/status-reczny.js';

it('komunikat odmowy również używa własnej nazwy statusu systemowego', () => {
  const powod = powodOdmowyStatusu({ ma_zwrot: true, etykiety_statusow: { zwrot: 'Reklamacja' } }, 'nowe');
  expect(powod).toContain('status „Reklamacja"');
  expect(powod).not.toContain('status „Zwrot"');
});

it('czysta reguła bez konfiguracji zachowuje dotychczasowy komunikat', () => {
  expect(powodOdmowyStatusu({ ma_zwrot: true }, 'nowe')).toContain('status „Zwrot"');
});
