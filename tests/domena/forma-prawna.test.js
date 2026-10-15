import { describe, it, expect } from 'vitest';
import { skrocFormePrawna } from '../../src/domena/forma-prawna.js';

// PRZ-078: nazwa nabywcy z inFaktu bywa pełną formą prawną wielkimi literami, a jej najdłuższe
// słowo („ODPOWIEDZIALNOŚCIĄ") nie łamie się — kolumna „Nabywca" rozpychała tabelę faktur.
describe('skrocFormePrawna', () => {
  it('skraca spółkę z o.o. wielkimi literami', () => {
    expect(skrocFormePrawna('PRZYKŁAD SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ')).toBe('PRZYKŁAD sp. z o.o.');
  });

  it('skraca bez względu na wielkość liter i nadmiarowe spacje', () => {
    expect(skrocFormePrawna('Przykład  Spółka z ograniczoną  odpowiedzialnością')).toBe('Przykład sp. z o.o.');
  });

  it('skraca pozostałe formy spółek', () => {
    expect(skrocFormePrawna('ALFA SPÓŁKA AKCYJNA')).toBe('ALFA S.A.');
    expect(skrocFormePrawna('Beta Spółka Komandytowa')).toBe('Beta sp.k.');
    expect(skrocFormePrawna('Gamma spółka jawna')).toBe('Gamma sp.j.');
    expect(skrocFormePrawna('Delta Spółka Cywilna')).toBe('Delta s.c.');
  });

  it('nie rusza nazwy bez formy prawnej ani osoby prywatnej', () => {
    expect(skrocFormePrawna('Jan Kowalski')).toBe('Jan Kowalski');
    expect(skrocFormePrawna('PHU Zenon Przykładowy')).toBe('PHU Zenon Przykładowy');
  });

  it('pusta i brakująca nazwa zostają puste', () => {
    expect(skrocFormePrawna('')).toBe('');
    expect(skrocFormePrawna(null)).toBe('');
    expect(skrocFormePrawna(undefined)).toBe('');
  });
});
