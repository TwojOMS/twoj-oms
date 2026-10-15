import { describe, it, expect } from 'vitest';
import { fmtDataCzas, fmtDataCzasKrotko } from '../../src/domena/format-daty.js';

// Zadanie „strona główna", punkt C: jeden format daty w całym module OMS, z rozróżnieniem
// dwóch skal czasu — patrz komentarz w src/oms/domain/format-daty.js i przewodnik OMS 4.7/6.

describe('fmtDataCzas — wartość Z OZNACZENIEM STREFY (nasz znacznik, UTC)', () => {
  it('"Z" latem przelicza na czas polski (+2 h)', () => {
    expect(fmtDataCzas('2026-07-30T20:38:51.710Z')).toBe('2026-07-30 22:38:51');
  });

  it('"Z" zimą przelicza na czas polski (+1 h) — dowód, że to prawdziwa strefa, nie stałe +2', () => {
    expect(fmtDataCzas('2026-01-15T20:00:00Z')).toBe('2026-01-15 21:00:00');
  });

  it('przesunięcie po północy zmienia też DZIEŃ (rollover), nie tylko godzinę', () => {
    expect(fmtDataCzas('2026-07-30T23:10:00Z')).toBe('2026-07-31 01:10:00');
  });

  it('jawne przesunięcie (+00:00, równoważne Z) też jest przeliczane', () => {
    expect(fmtDataCzas('2026-07-30T20:38:51+00:00')).toBe('2026-07-30 22:38:51');
  });
});

describe('fmtDataCzas — wartość BEZ oznaczenia strefy (data ze sklepu, już lokalna)', () => {
  it('przeformatowuje BEZ przesunięcia — sama zamiana T na spację', () => {
    expect(fmtDataCzas('2026-07-30T18:40:20')).toBe('2026-07-30 18:40:20');
  });

  it('przyjmuje też spację zamiast T', () => {
    expect(fmtDataCzas('2026-07-30 18:40:20')).toBe('2026-07-30 18:40:20');
  });

  it('sama data bez czasu (np. ręcznie wpisana data wpłaty) dostaje północ', () => {
    expect(fmtDataCzas('2026-08-01')).toBe('2026-08-01 00:00:00');
  });
});

describe('fmtDataCzas — wartości puste i nieparsowalne', () => {
  it.each([null, undefined, ''])('%s → pusty string', (v) => {
    expect(fmtDataCzas(v)).toBe('');
  });

  it('śmieciowy tekst → pusty string, NIGDY "Invalid Date"', () => {
    expect(fmtDataCzas('nie-data')).toBe('');
    expect(fmtDataCzas('nie-data')).not.toMatch(/Invalid Date/);
  });

  it('śmieć Z OZNACZENIEM STREFY (trafia w gałąź przeliczającą) → pusty string, NIGDY "Invalid Date"', () => {
    expect(fmtDataCzas('nie-data+02:00')).toBe('');
    expect(fmtDataCzas('nie-data+02:00')).not.toMatch(/Invalid Date/);
  });

  it('data z niemożliwym miesiącem/godziną (bez strefy) → pusty string, nie "Invalid Date"', () => {
    expect(fmtDataCzas('2026-13-40T25:99:99')).toBe('');
  });
});

describe('fmtDataCzasKrotko — format krótki, bez sekund', () => {
  it('"Z" przelicza na czas polski i obcina sekundy', () => {
    expect(fmtDataCzasKrotko('2026-07-30T20:38:51.710Z')).toBe('2026-07-30 22:38');
  });

  it('bez strefy tylko przeformatowuje i obcina sekundy', () => {
    expect(fmtDataCzasKrotko('2026-07-30T18:40:20')).toBe('2026-07-30 18:40');
  });

  it('pusta wartość → pusty string', () => {
    expect(fmtDataCzasKrotko('')).toBe('');
  });
});
