// tests/domain/dates.test.js
import { describe, it, expect } from 'vitest';
import { dayWarsaw, monthRangeWarsaw, monthShift, fmtPL, fmtDayPL, fmtDaySlownie } from '../../../src/domena/z-panelu/dates.js';

describe('dayWarsaw', () => {
  it('konwertuje ISO UTC na dzień w Europe/Warsaw', () => {
    // 23:30 UTC 30 czerwca = 01:30 CEST 1 lipca — dzień MUSI przeskoczyć
    expect(dayWarsaw('2026-06-30T23:30:00.000Z')).toBe('2026-07-01');
    expect(dayWarsaw('2026-07-15T10:00:00.000Z')).toBe('2026-07-15');
  });
  it('zwraca null dla śmieci', () => {
    expect(dayWarsaw('nie-data')).toBe(null);
    expect(dayWarsaw(null)).toBe(null);
  });
});

describe('monthRangeWarsaw', () => {
  it('zwraca pierwszy i ostatni dzień miesiąca', () => {
    expect(monthRangeWarsaw('2026-07')).toEqual({ from: '2026-07-01', to: '2026-07-31' });
    expect(monthRangeWarsaw('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRangeWarsaw('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' }); // przestępny
  });
  it('null dla złego formatu', () => {
    expect(monthRangeWarsaw('2026-13')).toBe(null);
    expect(monthRangeWarsaw('lipiec')).toBe(null);
    expect(monthRangeWarsaw('')).toBe(null);
  });
});

describe('monthShift', () => {
  it('przesuwa miesiąc, także przez granicę roku', () => {
    expect(monthShift('2026-07', -1)).toBe('2026-06');
    expect(monthShift('2026-01', -1)).toBe('2025-12');
    expect(monthShift('2026-12', 1)).toBe('2027-01');
  });
  it('null dla złego formatu', () => expect(monthShift('x', 1)).toBe(null));
});

describe('fmtPL', () => {
  it('format identyczny z dotychczasowym na karcie', () => {
    expect(fmtPL('2026-07-15T10:00:00.000Z')).toBe('2026-07-15 12:00'); // CEST = UTC+2
  });
  it('pusta wartość → pusty string', () => expect(fmtPL(null)).toBe(''));
});

describe('fmtDayPL', () => {
  it('sam dzień, po polsku — z ISO ze strefą', () => {
    expect(fmtDayPL('2026-07-05T09:00:00.000Z')).toBe('05.07.2026');
    // 23:30 UTC = 01:30 następnego dnia w Warszawie — data MUSI przeskoczyć
    expect(fmtDayPL('2026-06-30T23:30:00.000Z')).toBe('01.07.2026');
  });
  it('dzień w formacie YYYY-MM-DD zostaje tym samym dniem', () => {
    // quoteValidity zwraca expiresOn już jako dzień warszawski — nie wolno go przesunąć
    expect(fmtDayPL('2026-08-04')).toBe('04.08.2026');
  });
  it('pusta wartość → pusty string', () => expect(fmtDayPL(null)).toBe(''));
});

describe('fmtDaySlownie', () => {
  it('dzień słownie, tak jak ma stać w mailu do klienta', () => {
    expect(fmtDaySlownie('2026-09-20')).toBe('20 września 2026');
    expect(fmtDaySlownie('2026-01-01')).toBe('1 stycznia 2026');
    expect(fmtDaySlownie('2026-12-31')).toBe('31 grudnia 2026');
  });

  // „05 września" wygląda jak numer katalogowy, a nie jak termin.
  it('dzień bez wiodącego zera', () => {
    expect(fmtDaySlownie('2026-09-05')).toBe('5 września 2026');
  });

  // Ta sama pułapka, co w fmtDayPL: gotowy dzień warszawski nie może przeskoczyć o dobę.
  it('dzień YYYY-MM-DD zostaje tym samym dniem', () => {
    expect(fmtDaySlownie('2026-08-04')).toBe('4 sierpnia 2026');
  });

  it('ISO ze strefą przelicza się na dzień warszawski', () => {
    expect(fmtDaySlownie('2026-06-30T23:30:00.000Z')).toBe('1 lipca 2026');
  });

  it('pusta i niepoprawna wartość → pusty string', () => {
    expect(fmtDaySlownie(null)).toBe('');
    expect(fmtDaySlownie('')).toBe('');
    expect(fmtDaySlownie('kiedyś')).toBe('');
  });

  // ⚠️ Miesiące wpisane wprost, bez Intl — forma nie może zależeć od wersji ICU
  // w kontenerze. Wszystkie dwanaście musi być w dopełniaczu („stycznia", nie „styczeń").
  it('⚠️ wszystkie miesiące w dopełniaczu', () => {
    const oczekiwane = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca',
      'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
    const wynik = oczekiwane.map((_, i) => fmtDaySlownie(`2026-${String(i + 1).padStart(2, '0')}-15`).split(' ')[1]);
    expect(wynik).toEqual(oczekiwane);
  });
});
