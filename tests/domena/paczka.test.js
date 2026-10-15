import { describe, it, expect } from 'vitest';
import { parsujPaczke, parsujPaczkeInpost, GABARYTY_PACZKOMATU } from '../../src/domena/paczka.js';

const OK = { waga: '1', dlugosc: '110', szerokosc: '75', wysokosc: '1' };

describe('parsujPaczke', () => {
  it('poprawne wartości → zwraca cztery liczby', () => {
    expect(parsujPaczke(OK)).toEqual({ paczka: { waga: 1, dlugosc: 110, szerokosc: 75, wysokosc: 1 } });
  });

  // Przecinek dziesiętny jest tym, co człowiek naprawdę wpisze w polskim polu liczbowym.
  it('przecinek dziesiętny w wadze („1,5") jest traktowany jak kropka', () => {
    const wynik = parsujPaczke({ ...OK, waga: '1,5' });
    expect(wynik.blad).toBeUndefined();
    expect(wynik.paczka.waga).toBe(1.5);
  });

  it('przecinek dziesiętny działa też w wymiarach', () => {
    const wynik = parsujPaczke({ ...OK, dlugosc: '110,5' });
    expect(wynik.paczka.dlugosc).toBe(110.5);
  });

  it('wartość nieliczbowa → odmowa z czytelnym komunikatem, nie cichy fallback', () => {
    const wynik = parsujPaczke({ ...OK, waga: 'dużo' });
    expect(wynik.paczka).toBeUndefined();
    expect(wynik.blad).toMatch(/waga/i);
    expect(wynik.blad).toMatch(/większą od zera/i);
  });

  it('wartość ujemna → odmowa, nie ciche podstawienie wartości domyślnej', () => {
    const wynik = parsujPaczke({ ...OK, dlugosc: '-5' });
    expect(wynik.paczka).toBeUndefined();
    expect(wynik.blad).toMatch(/długość/i);
  });

  it('wartość zero → odmowa (musi być WIĘKSZA od zera)', () => {
    const wynik = parsujPaczke({ ...OK, wysokosc: '0' });
    expect(wynik.blad).toMatch(/wysokość/i);
  });

  it('pole puste/brakujące → odmowa, nie domyślna wartość', () => {
    const wynik = parsujPaczke({ ...OK, szerokosc: '' });
    expect(wynik.blad).toMatch(/szerokość/i);
  });

  it('pole zupełnie nieobecne w danych → odmowa', () => {
    const { szerokosc, ...bezSzerokosci } = OK;
    const wynik = parsujPaczke(bezSzerokosci);
    expect(wynik.blad).toMatch(/szerokość/i);
  });

  it('kilka złych pól naraz → komunikat wymienia wszystkie', () => {
    const wynik = parsujPaczke({ waga: '-1', dlugosc: 'x', szerokosc: '0', wysokosc: '1' });
    expect(wynik.blad).toMatch(/waga/);
    expect(wynik.blad).toMatch(/długość/);
    expect(wynik.blad).toMatch(/szerokość/);
    expect(wynik.blad).not.toMatch(/wysokość/);
  });

  it('białe znaki dookoła wartości są przycinane', () => {
    const wynik = parsujPaczke({ ...OK, waga: '  1  ' });
    expect(wynik.paczka.waga).toBe(1);
  });

  it('brak jakichkolwiek danych (undefined) → odmowa, nie wyjątek', () => {
    expect(() => parsujPaczke(undefined)).not.toThrow();
    expect(parsujPaczke(undefined).blad).toBeDefined();
  });
});

// Zadanie 7: paczkomat InPost NIE MA wymiarow, tylko wage i gabaryt (A/B/C) — osobna
// funkcja od parsujPaczke, zeby sciezka DPD wyzej zostala dotkniecie DOKLADNIE taka,
// jaka jest dzisiaj.
describe('parsujPaczkeInpost', () => {
  it('poprawna waga i gabaryt → zwraca { waga, gabaryt }', () => {
    expect(parsujPaczkeInpost({ waga: '1.2', gabaryt: 'A' })).toEqual({ paczka: { waga: 1.2, gabaryt: 'A' } });
  });

  it('akceptuje wszystkie trzy gabaryty ze słownika', () => {
    for (const litera of Object.keys(GABARYTY_PACZKOMATU)) {
      expect(parsujPaczkeInpost({ waga: '1', gabaryt: litera }).paczka.gabaryt).toBe(litera);
    }
  });

  it('mała litera gabarytu jest akceptowana (normalizacja do wielkiej)', () => {
    expect(parsujPaczkeInpost({ waga: '1', gabaryt: 'b' }).paczka.gabaryt).toBe('B');
  });

  it('przecinek dziesiętny w wadze jest traktowany jak kropka', () => {
    expect(parsujPaczkeInpost({ waga: '1,5', gabaryt: 'A' }).paczka.waga).toBe(1.5);
  });

  it('waga nieliczbowa → odmowa, nie ciche podstawienie', () => {
    const wynik = parsujPaczkeInpost({ waga: 'dużo', gabaryt: 'A' });
    expect(wynik.paczka).toBeUndefined();
    expect(wynik.blad).toMatch(/waga/i);
  });

  it('waga zero albo ujemna → odmowa', () => {
    expect(parsujPaczkeInpost({ waga: '0', gabaryt: 'A' }).blad).toMatch(/waga/i);
    expect(parsujPaczkeInpost({ waga: '-1', gabaryt: 'A' }).blad).toMatch(/waga/i);
  });

  // ⚠️ MUTACJA (a) z briefu Zadania 7: cicha domyślna litera zamiast odmowy musi
  // zaczerwienić ten test — nieznany gabaryt jest błędem operatora, nie zgadywaniem.
  it('brak gabarytu → odmowa, NIGDY cicha domyślna litera', () => {
    const wynik = parsujPaczkeInpost({ waga: '1' });
    expect(wynik.paczka).toBeUndefined();
    expect(wynik.blad).toMatch(/gabaryt/i);
  });

  it('nieznana litera gabarytu (np. „D") → odmowa z czytelnym komunikatem', () => {
    const wynik = parsujPaczkeInpost({ waga: '1', gabaryt: 'D' });
    expect(wynik.blad).toMatch(/gabaryt/i);
    expect(wynik.blad).toContain('D');
  });

  it('brak jakichkolwiek danych (undefined) → odmowa, nie wyjątek', () => {
    expect(() => parsujPaczkeInpost(undefined)).not.toThrow();
    expect(parsujPaczkeInpost(undefined).blad).toBeDefined();
  });

  it('GABARYTY_PACZKOMATU niesie dokładnie litery A, B, C razem z wymiarami', () => {
    expect(Object.keys(GABARYTY_PACZKOMATU)).toEqual(['A', 'B', 'C']);
    expect(GABARYTY_PACZKOMATU.A).toMatch(/8.*38.*64/);
    expect(GABARYTY_PACZKOMATU.B).toMatch(/19.*38.*64/);
    expect(GABARYTY_PACZKOMATU.C).toMatch(/41.*38.*64/);
  });
});
