import { describe, it, expect, vi } from 'vitest';
import { utworzHamulecLogowania } from '../../../src/core/bezpieczenstwo/hamulec.js';

const T = 1_770_000_000_000;
describe('trzy liczniki logowania', () => {
  it('kara pary nie dotyka innego loginu, normalizuje login i zapisuje blokadę raz', () => {
    const h = utworzHamulecLogowania();
    for (let i = 0; i < 5; i++) h.odnotujBlad('192.0.2.1', ' Admin ', T);
    expect(h.sprawdzPare('192.0.2.1', 'admin', T).wolno).toBe(false);
    expect(h.sprawdzPare('192.0.2.1', 'inny', T).wolno).toBe(true);
    expect(h.zapiszBlokadeRaz('192.0.2.1', 'admin', T)).toBe(true);
    expect(h.zapiszBlokadeRaz('192.0.2.1', 'admin', T)).toBe(false);
    h.wyczysc('192.0.2.1', 'admin');
    expect(h.sprawdzPare('192.0.2.1', 'admin', T).wolno).toBe(true);
  });
  it('40 różnych loginów uruchamia szerszy limit adresu, ale nie twardą blokadę nowej pary', () => {
    const h = utworzHamulecLogowania();
    for (let i = 0; i < 39; i++) expect(h.odnotujBlad('192.0.2.1', `login-${i}`, T).wolno).toBe(true);
    expect(h.odnotujBlad('192.0.2.1', 'ostatni', T)).toEqual({ wolno: false, zostaloMs: 900_000 });
    expect(h.sprawdzPare('192.0.2.1', 'nowy', T).wolno).toBe(true);
    expect(h.sprawdz('192.0.2.2', 'nowy', T).wolno).toBe(true);
  });
  it('okno 40 błędów adresu kończy się po 15 minutach od pierwszego błędu', () => {
    const h = utworzHamulecLogowania();
    for (let i = 0; i < 38; i++) h.odnotujBlad('192.0.2.1', `login-${i}`, T);
    h.odnotujBlad('192.0.2.1', 'przed-koncem', T + 800_000);
    expect(h.odnotujBlad('192.0.2.1', 'nowe-okno', T + 900_000).wolno).toBe(true);
  });
  it('konto po 30 adresach dostaje 2 s kary, niezależnie od istnienia konta', async () => {
    const czekaj = vi.fn(async () => {});
    const h = utworzHamulecLogowania({ czekaj });
    for (let i = 0; i < 30; i++) h.odnotujBlad(`192.0.2.${i}`, 'konto', T);
    const stan = h.sprawdz('198.51.100.1', ' KONTO ', T);
    expect(stan).toEqual({ wolno: false, zostaloMs: 2_000 });
    expect(h.sprawdzPare('198.51.100.1', 'konto', T).wolno).toBe(true);
    await h.opoznij('198.51.100.1', 'konto', T);
    expect(czekaj).toHaveBeenCalledWith(2_000);
    expect(h.sprawdz('198.51.100.1', 'konto', T + 2_000).wolno).toBe(true);
  });
  it('liczniki wygasają po 15 minutach bezczynności i mają ograniczenie pamięci', () => {
    const h = utworzHamulecLogowania({ maksKluczy: 3 });
    for (let i = 0; i < 20; i++) h.odnotujBlad(`192.0.2.${i}`, `login-${i}`, T);
    expect(h.rozmiary()).toEqual([3, 3, 3]);
    for (let i = 0; i < 4; i++) h.odnotujBlad('198.51.100.1', 'konto', T);
    expect(h.odnotujBlad('198.51.100.1', 'konto', T + 900_000).wolno).toBe(true);
  });
});
