import { afterEach, describe, it, expect } from 'vitest';
import { otworzBaze, wykonajMigracje } from '../../src/core/baza.ts';
import { migracjaBaseline } from '../../src/moduly/rdzen/migracje/baseline.ts';
import { rozdajNoweUprawnienia, oznaczKluczeZamrozenia } from '../../src/core/uprawnienia.ts';
import type { ModulOms } from '../../src/core/kontrakty.ts';

const teraz = () => new Date('2026-10-01T10:00:00Z');
const bazy: ReturnType<typeof otworzBaze>[] = [];
afterEach(() => { for (const db of bazy.splice(0)) db.close(); });
const modul = (klucz: string, role: string[]): ModulOms => ({
  nazwa: klucz, wersja: '1.0.0', wymaga: [], konfiguracja: () => ({}), migracje: [],
  uprawnienia: [{ klucz, etykieta: klucz, role }], menu: [], zbuduj: () => ({}),
});
const baza = () => {
  const db = otworzBaze(':memory:'); bazy.push(db);
  wykonajMigracje(db, [{ ...modul('rdzen', []), uprawnienia: [], migracje: [migracjaBaseline] }]);
  db.exec(`INSERT INTO konta (id, login, imie, hash_hasla, rola, utworzone_at) VALUES
    (1, 'ola', 'Ola', 'x', 'sprzedaz', '2026-09-01'), (2, 'jan', 'Jan', 'x', 'produkcja', '2026-09-01')`);
  return db;
};
const ptaszki = (db: ReturnType<typeof otworzBaze>) => db.prepare('SELECT konto_id, ekran FROM uprawnienia ORDER BY konto_id, ekran').all();

describe('rozdajNoweUprawnienia', () => {
  it('przyznaje nowy klucz kontom według ról raz, zachowuje ręczne odebranie', () => {
    const db = baza();
    expect(rozdajNoweUprawnienia(db, [modul('nowy', ['sprzedaz'])], teraz)).toEqual(['nowy']);
    expect(ptaszki(db)).toEqual([{ konto_id: 1, ekran: 'nowy' }]);
    expect(db.prepare('SELECT * FROM uprawnienia_rozdane').all()).toEqual([{ klucz: 'nowy', rozdane_at: '2026-10-01T10:00:00.000Z' }]);
    db.exec("DELETE FROM uprawnienia WHERE ekran = 'nowy'");
    expect(rozdajNoweUprawnienia(db, [modul('nowy', ['sprzedaz', 'produkcja'])], teraz)).toEqual([]);
    expect(ptaszki(db)).toEqual([]);
  });
  it('klucz zamrożenia nie jest przyznawany ponownie', () => {
    const db = baza();
    oznaczKluczeZamrozenia(db, ['zamowienia'], teraz);
    expect(rozdajNoweUprawnienia(db, [modul('zamowienia', ['sprzedaz', 'produkcja'])], teraz)).toEqual([]);
    expect(ptaszki(db)).toEqual([]);
  });
  it('błąd zapisu wycofuje ptaszki i oznaczenie klucza', () => {
    const db = baza();
    oznaczKluczeZamrozenia(db, [], teraz);
    db.exec("CREATE TRIGGER blokada BEFORE INSERT ON uprawnienia_rozdane BEGIN SELECT RAISE(ABORT, 'blokada'); END");
    expect(() => rozdajNoweUprawnienia(db, [modul('nowy', ['sprzedaz'])], teraz)).toThrow('blokada');
    expect(ptaszki(db)).toEqual([]);
    expect(db.prepare('SELECT * FROM uprawnienia_rozdane').all()).toEqual([]);
    expect(db.isTransaction).toBe(false);
  });
});
