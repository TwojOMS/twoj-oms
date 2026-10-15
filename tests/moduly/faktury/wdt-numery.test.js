import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zarezerwujNumerWdt, cofnijRezerwacjeWdt } from '../../../src/moduly/faktury/db/wdt-numery.js';

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

describe('zarezerwujNumerWdt', () => {
  it('pierwsza rezerwacja miesiąca dostaje 1, kolejne rosną o 1', () => {
    expect(zarezerwujNumerWdt(db, { rok: 2026, miesiac: 8 })).toBe(1);
    expect(zarezerwujNumerWdt(db, { rok: 2026, miesiac: 8 })).toBe(2);
    expect(zarezerwujNumerWdt(db, { rok: 2026, miesiac: 8 })).toBe(3);
  });

  it('licznik jest MIESIĘCZNY — inny miesiąc i inny rok liczą od 1', () => {
    zarezerwujNumerWdt(db, { rok: 2026, miesiac: 8 });
    expect(zarezerwujNumerWdt(db, { rok: 2026, miesiac: 9 })).toBe(1);
    expect(zarezerwujNumerWdt(db, { rok: 2027, miesiac: 8 })).toBe(1);
  });
});

describe('cofnijRezerwacjeWdt', () => {
  it('cofa OSTATNI numer — następna rezerwacja dostaje ten sam', () => {
    zarezerwujNumerWdt(db, { rok: 2026, miesiac: 8 });
    const n = zarezerwujNumerWdt(db, { rok: 2026, miesiac: 8 });
    expect(cofnijRezerwacjeWdt(db, { rok: 2026, miesiac: 8, kolejny: n })).toBe(true);
    expect(zarezerwujNumerWdt(db, { rok: 2026, miesiac: 8 })).toBe(n);
  });

  // Dziura w serii jest tańsza niż duplikat: gdy po naszej rezerwacji ktoś zdążył wziąć
  // następny numer, cofnięcie NASZEGO zrobiłoby z cudzego duplikat przy kolejnym UPSERT.
  it('NIE cofa numeru, który nie jest już ostatni — i mówi o tym wynikiem', () => {
    const pierwszy = zarezerwujNumerWdt(db, { rok: 2026, miesiac: 8 });
    zarezerwujNumerWdt(db, { rok: 2026, miesiac: 8 });
    expect(cofnijRezerwacjeWdt(db, { rok: 2026, miesiac: 8, kolejny: pierwszy })).toBe(false);
    expect(zarezerwujNumerWdt(db, { rok: 2026, miesiac: 8 })).toBe(3);
  });

  it('cofnięcie w miesiącu bez rezerwacji nic nie robi', () => {
    expect(cofnijRezerwacjeWdt(db, { rok: 2026, miesiac: 1, kolejny: 1 })).toBe(false);
  });
});
