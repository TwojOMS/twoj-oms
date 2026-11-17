import { it, expect } from 'vitest';
import { opisOdrzuceniaKorekty } from '../../src/domena/korekta-status.js';

it('opisuje dwa polskie pola i nieznane pole bez surowego JSON-u', () => {
  expect(opisOdrzuceniaKorekty({ nazwaProgramu: 'inFakt', bledy: [
    { pole: 'klient', komunikaty: ['Proszę wybrać klienta.'] },
    { pole: 'powód korekty', komunikaty: ['Proszę podać powód korekty.'] },
  ] })).toBe('inFakt nie wystawił korekty: klient — Proszę wybrać klienta.; powód korekty — Proszę podać powód korekty. Popraw i wystaw ponownie.');
  expect(opisOdrzuceniaKorekty({ nazwaProgramu: 'Program', bledy: [{ pole: 'nowe_pole', komunikaty: ['A', 'B'] }] })).toContain('nowe_pole — A, B');
});

it('ogranicza cały opis do 500 znaków i zachowuje wskazówkę', () => {
  const opis = opisOdrzuceniaKorekty({ nazwaProgramu: 'Program', bledy: [{ pole: 'dokument', komunikaty: ['x'.repeat(800)] }] });
  expect(opis).toHaveLength(500);
  expect(opis.endsWith(' Popraw i wystaw ponownie.')).toBe(true);
});

it('opisuje odmowę bez szczegółów', () => {
  expect(opisOdrzuceniaKorekty({ nazwaProgramu: 'Program', bledy: [] })).toBe('Program nie wystawił korekty. Popraw i wystaw ponownie.');
});
