// Próg niskiego stanu z pola formularza: puste = bez progu (NULL), liczba całkowita od zera w górę, reszta to odmowa.
import { describe, it, expect } from 'vitest';
import { parsujProg } from '../../src/domena/prog-stanu.js';

describe('parsujProg', () => {
  it('puste pole (także same spacje) to brak progu, nie zero', () => {
    expect(parsujProg('')).toBe(null);
    expect(parsujProg('   ')).toBe(null);
  });

  it('liczba całkowita od zera w górę, spacje wokół nie przeszkadzają', () => {
    expect(parsujProg('0')).toBe(0);
    expect(parsujProg('2')).toBe(2);
    expect(parsujProg(' 15 ')).toBe(15);
    expect(parsujProg('007')).toBe(7);
  });

  it.each(['-1', '1.5', '1,5', 'abc', '2 szt.', '1e3', '+2', '0x10', '99999999999999999999'])(
    '„%s” → odmowa z komunikatem',
    (tekst) => {
      const w = parsujProg(tekst);
      expect(w).toEqual({ blad: expect.stringContaining('liczba całkowita') });
    },
  );

  it('pole niebędące napisem (brak albo powtórzone) to odmowa, nie kasowanie progu', () => {
    expect(parsujProg(undefined)).toHaveProperty('blad');
    expect(parsujProg(null)).toHaveProperty('blad');
    expect(parsujProg(['2', '3'])).toHaveProperty('blad');
    expect(parsujProg(2)).toHaveProperty('blad');
  });
});
