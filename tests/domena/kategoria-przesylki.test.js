import { describe, expect, it } from 'vitest';
import * as etapy from '../../src/domena/etap-przesylki.js';

// Każdy przypadek zabija inną pomyłkę: numer bez dowodu etykiety nie jest „utworzony”,
// a plik etykiety nie utrzymuje tej kategorii po pierwszym skanie.
const kategoria = (p, etap) => etapy.kategoriaPrzesylki?.(p, etap);

describe('kategoriaPrzesylki', () => {
  it('jawna rejestracja u przewoźnika oznacza utworzoną, również bez lokalnego PDF', () => {
    expect(kategoria({ numer_listu: 'X' }, 'nadana')).toBe('utworzone');
  });

  it('brak zdarzenia wymaga dowodu etykiety PDF, ZPL albo potwierdzenia człowieka', () => {
    expect(kategoria({ numer_listu: 'X', etykieta_sciezka: '/e.pdf' }, null)).toBe('utworzone');
    expect(kategoria({ numer_listu: 'X', etykieta_zpl_sciezka: '/e.zpl' }, null)).toBe('utworzone');
    expect(kategoria({ numer_listu: 'X', etykieta_reczna: 1 }, null)).toBe('utworzone');
    expect(kategoria({ numer_listu: 'X' }, null)).toBe('w_drodze');
    expect(kategoria({ numer_listu: 'X', etykieta_sciezka: '  ' }, null)).toBe('w_drodze');
  });

  it('pierwszy ruch wyprowadza paczkę z utworzonych pomimo zachowanej etykiety', () => {
    const p = { numer_listu: 'X', etykieta_sciezka: '/e.pdf' };
    expect(kategoria(p, 'w_drodze')).toBe('w_drodze');
    expect(kategoria(p, 'w_doreczeniu')).toBe('w_drodze');
  });

  it('trwały skan przejęcia wyprowadza paczkę z utworzonych mimo późniejszego PENDING', () => {
    const p = { numer_listu: 'X', etykieta_sciezka: '/e.pdf', przejeta_at: '2026-09-22T09:00:00Z' };
    expect(kategoria(p, 'nadana')).toBe('w_drodze');
    expect(kategoria(p, null)).toBe('w_drodze');
  });

  it('doręczenie i zwrot są końcowe nawet przy nadal zapisanej etykiecie', () => {
    const p = { numer_listu: 'X', etykieta_sciezka: '/e.pdf' };
    expect(kategoria(p, 'doreczona')).toBe('doreczone');
    expect(kategoria(p, 'zwrot')).toBe('doreczone');
  });
});
