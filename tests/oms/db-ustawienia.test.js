import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { wczytajUstawienia, zapiszUstawienia, ustawieniaZmienioneAt } from '../../src/oms/db/ustawienia.js';

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

describe('tabela ustawień', () => {
  it('świeża baza nie ma żadnego ustawienia', () => {
    expect(wczytajUstawienia(db)).toEqual({});
    expect(ustawieniaZmienioneAt(db)).toBeNull();
  });

  it('zapisuje i oddaje wartości jako zwykły obiekt klucz → tekst', () => {
    zapiszUstawienia(db, { 'paczka.waga': '2', 'dostawa.dpd': '1900' }, '2026-08-17T10:00:00.000Z');

    expect(wczytajUstawienia(db)).toEqual({ 'paczka.waga': '2', 'dostawa.dpd': '1900' });
  });

  // ⚠️ NADPISANIE, NIE DRUGI WIERSZ. Dwa wiersze o tym samym kluczu znaczyłyby, że wartość
  // zależy od kolejności odczytu — czyli panel wysyłałby raz jedne, raz drugie wymiary.
  it('ten sam klucz zapisany drugi raz NADPISUJE, a nie dokłada wiersza', () => {
    zapiszUstawienia(db, { 'paczka.waga': '2' }, '2026-08-17T10:00:00.000Z');
    zapiszUstawienia(db, { 'paczka.waga': '3' }, '2026-08-17T11:00:00.000Z');

    expect(wczytajUstawienia(db)).toEqual({ 'paczka.waga': '3' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM ustawienia').get().n).toBe(1);
    expect(ustawieniaZmienioneAt(db)).toBe('2026-08-17T11:00:00.000Z');
  });

  // ⚠️ WSZYSTKO ALBO NIC. Połowa zapisanych wymiarów to paczka, której nikt świadomie
  // nie ustawił — a wymiary jadą do DPD i są rozliczane.
  it('awaria w środku zapisu nie zostawia połowy wartości', () => {
    zapiszUstawienia(db, { 'paczka.waga': '2' }, '2026-08-17T10:00:00.000Z');

    // `null` przechodzi przez String(), ale kolumna jest NOT NULL — wymuszamy odmowę
    // wprost na poziomie SQLite, żeby sprawdzić rollback, a nie walidację wyżej.
    expect(() => zapiszUstawienia(db, { 'paczka.dlugosc': '110', 'paczka.waga': null })).toThrow();
    expect(wczytajUstawienia(db)).toEqual({ 'paczka.waga': '2' });
  });

  it('oddaje najświeższy znacznik zmiany', () => {
    zapiszUstawienia(db, { 'dostawa.dpd': '1900' }, '2026-08-16T09:00:00.000Z');
    zapiszUstawienia(db, { 'dostawa.odbior_osobisty': '0' }, '2026-08-17T09:00:00.000Z');

    expect(ustawieniaZmienioneAt(db)).toBe('2026-08-17T09:00:00.000Z');
  });
});
