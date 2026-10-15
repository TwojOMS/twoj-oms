import { describe, it, expect } from 'vitest';
import { czyPaczkomat, PACZKOMAT_WARTOSCI } from '../../src/domena/paczkomat.js';

describe('czyPaczkomat — pole ustawiane recznie', () => {
  it('oddaje to, co ustawil czlowiek', () => {
    expect(czyPaczkomat({ paczkomat: 'tak' })).toBe('tak');
    expect(czyPaczkomat({ paczkomat: 'nie' })).toBe('nie');
  });

  // ⚠️ NIEUSTAWIONE to TRZECI STAN, nie „nie". „Jeszcze nie zdecydowalem" i „nie miesci sie"
  // to rozne odpowiedzi: pierwsza znaczy „do oznaczenia", druga „pakuj do DPD".
  it('brak wartosci oddaje null, nie „nie”', () => {
    expect(czyPaczkomat({ paczkomat: null })).toBe(null);
    expect(czyPaczkomat({ paczkomat: undefined })).toBe(null);
    expect(czyPaczkomat({ paczkomat: '' })).toBe(null);
    expect(czyPaczkomat({})).toBe(null);
    expect(czyPaczkomat(null)).toBe(null);
  });

  // ⚠️ Wartosc spoza bialej listy NIE MA prawa przejsc do widoku. Kolumna trzyma TEXT,
  // wiec do bazy da sie wpisac cokolwiek — bramka jest tutaj, w jednym miejscu.
  it('wartosc spoza bialej listy traktujemy jak nieustawiona', () => {
    expect(czyPaczkomat({ paczkomat: 'moze' })).toBe(null);
    expect(czyPaczkomat({ paczkomat: 'TAK' })).toBe(null);
    expect(czyPaczkomat({ paczkomat: 'auto' })).toBe(null);
    expect(czyPaczkomat({ paczkomat: 1 })).toBe(null);
  });

  // ⚠️ ROZMIAR NIE MA NA TO WPLYWU — to jest cala tresc decyzji z 2026-08-06.
  // Mutacja przywracajaca wyliczanie z wymiarow ma czerwienic.
  it('rozmiar wzoru NIE wplywa na odpowiedz', () => {
    expect(czyPaczkomat({ paczkomat: null, szerokosc_mm: 300, wysokosc_mm: 400 })).toBe(null);
    expect(czyPaczkomat({ paczkomat: 'tak', szerokosc_mm: 7000, wysokosc_mm: 9000 })).toBe('tak');
    expect(czyPaczkomat({ paczkomat: 'nie', szerokosc_mm: 10, wysokosc_mm: 10 })).toBe('nie');
  });

  it('biala lista jest jedna i zawiera dokladnie dwie wartosci', () => {
    expect([...PACZKOMAT_WARTOSCI].sort()).toEqual(['nie', 'tak']);
  });
});
