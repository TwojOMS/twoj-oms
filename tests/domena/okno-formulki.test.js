// tests/oms/okno-formulki.test.js
import { describe, it, expect } from 'vitest';
import { czyWOknie } from '../../src/domena/okno-formulki.js';

const WSZYSTKIE_DNI = [0, 1, 2, 3, 4, 5, 6];
// 2026-08-28 to piatek. Godziny podane w UTC, a okno liczy sie w Warszawie (UTC+2 latem).
const utc = (iso) => new Date(iso);

describe('okno godzin formulki', () => {
  it('okno 18-8 lapie 23:00 czasu warszawskiego', () => {
    expect(czyWOknie(utc('2026-08-28T21:00:00Z'), { odGodziny: 18, doGodziny: 8, dni: WSZYSTKIE_DNI }))
      .toBe(true); // 23:00 Warszawa
  });

  it('okno 18-8 lapie 00:30 czasu warszawskiego — PRZECHODZI PRZEZ POLNOC', () => {
    expect(czyWOknie(utc('2026-08-28T22:30:00Z'), { odGodziny: 18, doGodziny: 8, dni: WSZYSTKIE_DNI }))
      .toBe(true); // 00:30 Warszawa, juz sobota
  });

  it('okno 18-8 NIE lapie 12:00 czasu warszawskiego', () => {
    expect(czyWOknie(utc('2026-08-28T10:00:00Z'), { odGodziny: 18, doGodziny: 8, dni: WSZYSTKIE_DNI }))
      .toBe(false); // 12:00 Warszawa
  });

  it('godzina konca jest WYLACZONA — 8:00 juz nie jest w oknie 18-8', () => {
    expect(czyWOknie(utc('2026-08-28T06:00:00Z'), { odGodziny: 18, doGodziny: 8, dni: WSZYSTKIE_DNI }))
      .toBe(false); // 08:00 Warszawa
  });

  it('7:59 jeszcze jest w oknie 18-8', () => {
    expect(czyWOknie(utc('2026-08-28T05:59:00Z'), { odGodziny: 18, doGodziny: 8, dni: WSZYSTKIE_DNI }))
      .toBe(true); // 07:59 Warszawa
  });

  it('dzien liczy sie dla CHWILI, nie dla poczatku okna', () => {
    // 00:30 w Warszawie to juz SOBOTA (6). Okno tylko na dni robocze (1-5) ma to odrzucic,
    // mimo ze okno zaczelo sie w piatek wieczorem.
    expect(czyWOknie(utc('2026-08-28T22:30:00Z'), { odGodziny: 18, doGodziny: 8, dni: [1, 2, 3, 4, 5] }))
      .toBe(false);
  });

  it('okno bez przejscia przez polnoc dziala normalnie', () => {
    expect(czyWOknie(utc('2026-08-28T12:00:00Z'), { odGodziny: 9, doGodziny: 17, dni: WSZYSTKIE_DNI }))
      .toBe(true); // 14:00 Warszawa
    expect(czyWOknie(utc('2026-08-28T16:00:00Z'), { odGodziny: 9, doGodziny: 17, dni: WSZYSTKIE_DNI }))
      .toBe(false); // 18:00 Warszawa
  });

  it('okno calodobowe (od === do) lapie kazda godzine', () => {
    expect(czyWOknie(utc('2026-08-28T03:00:00Z'), { odGodziny: 0, doGodziny: 0, dni: WSZYSTKIE_DNI }))
      .toBe(true);
  });

  it('pusta lista dni nie lapie niczego', () => {
    expect(czyWOknie(utc('2026-08-28T21:00:00Z'), { odGodziny: 18, doGodziny: 8, dni: [] }))
      .toBe(false);
  });

  it('zima strefa jest inna — 23:00 UTC w styczniu to 00:00 Warszawy', () => {
    // 2026-01-15 to czwartek; 23:00Z = 00:00 piatku w Warszawie (UTC+1).
    expect(czyWOknie(utc('2026-01-15T23:00:00Z'), { odGodziny: 18, doGodziny: 8, dni: [5] }))
      .toBe(true); // piatek
    expect(czyWOknie(utc('2026-01-15T23:00:00Z'), { odGodziny: 18, doGodziny: 8, dni: [4] }))
      .toBe(false); // czwartek juz sie skonczyl w Warszawie
  });
});
