import { describe, it, expect } from 'vitest';
import { zakresZZapytania } from '../../src/domena/okresy-raportu.js';

const DZIS = '2026-09-13';

describe('zakresZZapytania', () => {
  it('bez parametrów daje bieżący miesiąc przycięty do dziś', () => {
    const { zakres, blad } = zakresZZapytania({}, DZIS);
    expect(blad).toBeUndefined();
    expect(zakres).toMatchObject({ od: '2026-09-01', do: DZIS, etykieta: 'Ten miesiąc' });
  });

  it('skrót przechodzi przez domenę, z etykietą', () => {
    expect(zakresZZapytania({ skrot: 'poprzedni-miesiac' }, DZIS).zakres)
      .toMatchObject({ od: '2026-08-01', do: '2026-08-31' });
  });

  it('jawny zakres nie ma etykiety', () => {
    expect(zakresZZapytania({ od: '2026-08-01', do: '2026-08-15' }, DZIS).zakres)
      .toEqual({ od: '2026-08-01', do: '2026-08-15', etykieta: null });
  });

  // ⚠️ ZŁA DATA TO BŁĄD, NIE PUSTY RAPORT. Przepuszczona dalej oddaje 200 i zerowy wynik,
  // a zera nikt nie kwestionuje, bo wygląda jak zero.
  it('data kalendarzowo niepoprawna to błąd', () => {
    expect(zakresZZapytania({ od: '2026-02-30', do: '2026-03-01' }, DZIS).blad)
      .toMatch(/Niepoprawna data/);
  });

  it('zły format to błąd', () => {
    expect(zakresZZapytania({ od: '13.09.2026', do: '2026-09-14' }, DZIS).blad)
      .toMatch(/Niepoprawna data/);
  });

  it('odwrócony zakres to błąd', () => {
    expect(zakresZZapytania({ od: '2026-09-10', do: '2026-09-01' }, DZIS).blad)
      .toMatch(/Niepoprawny zakres/);
  });

  it('nieznany skrót to błąd, nie cicha podmiana na domyślny', () => {
    expect(zakresZZapytania({ skrot: 'ten-tydzien' }, DZIS).blad).toBeTruthy();
  });
});
