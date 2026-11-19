import { it, expect } from 'vitest';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen as rdzen } from '../../../src/moduly/rdzen/modul.ts';
import type { ModulOms } from '../../../src/core/kontrakty.ts';
import { migracjaProguNiskiegoStanu } from '../../../src/moduly/rdzen/migracje/0021-prog-niskiego-stanu.ts';
import { wykonajMigracje } from '../../../src/core/baza.ts';
import { utworzKarte, zapiszKarte } from '../../../src/oms/db/magazyn.js';

// Rdzeń 0021: próg niskiego stanu karty. NULL = karta bez progu (stare karty), 0 dozwolone („ostrzegaj przy zerze
// i poniżej”), ujemne i ułamki odrzuca zapis karty. Dane zmyślone: „Pracownia Półcień”, lampy LMP-*.

// Moduł rdzenia ma własny typ konfiguracji; baza przyjmuje moduły bez niego (jak domyślna lista w db.ts).
const modulRdzen = rdzen as unknown as ModulOms;
type W = Record<string, unknown>;
const T0 = '2026-11-18T10:00:00.000Z';

const bez21 = () =>
  openOmsDb(':memory:', { moduly: [{ ...modulRdzen, migracje: modulRdzen.migracje.filter((m) => m.numer !== 21) }] });
const kolumny = (db: DatabaseSync) =>
  (db.prepare('PRAGMA table_info(karty_produktow)').all() as W[]).map((k) => String(k.name));
const karta = (db: DatabaseSync, sku: string) =>
  Number(
    db
      .prepare('INSERT INTO karty_produktow (sku, nazwa, utworzony_at, zmieniony_at) VALUES (?, ?, ?, ?)')
      .run(sku, `Lampa Półcień ${sku}`, T0, T0).lastInsertRowid,
  );
const ustaw = (db: DatabaseSync, id: number, prog: SQLInputValue) =>
  db.prepare('UPDATE karty_produktow SET prog_niskiego_stanu = ? WHERE id = ?').run(prog, id);
const prog = (db: DatabaseSync, id: number) =>
  (db.prepare('SELECT prog_niskiego_stanu AS p FROM karty_produktow WHERE id = ?').get(id) as W).p;

it('rdzeń niesie migrację numer 21', () => {
  expect(modulRdzen.migracje).toContain(migracjaProguNiskiegoStanu);
  expect(migracjaProguNiskiegoStanu.numer).toBe(21);
});

it('dokłada kolumnę raz; stare karty zostają bez progu, powtórka niczego nie psuje', () => {
  const db = bez21();
  try {
    expect(kolumny(db)).not.toContain('prog_niskiego_stanu');
    const stara = karta(db, 'LMP-1');

    // Inne nowe migracje mogą przyjść w tej samej paczce — sprawdzamy tylko, że jest wśród nich nasza.
    expect(wykonajMigracje(db, [modulRdzen]).map((m) => m.numer)).toContainEqual(21);
    const kolumna = (db.prepare('PRAGMA table_info(karty_produktow)').all() as W[]).find(
      (k) => k.name === 'prog_niskiego_stanu',
    );
    expect(kolumna).toMatchObject({ type: 'INTEGER', notnull: 0, dflt_value: null });
    expect(prog(db, stara)).toBe(null);

    ustaw(db, stara, 2);
    migracjaProguNiskiegoStanu.wykonaj(db);
    migracjaProguNiskiegoStanu.wykonaj(db);
    expect(wykonajMigracje(db, [modulRdzen])).toEqual([]);
    expect(kolumny(db).filter((k) => k === 'prog_niskiego_stanu')).toHaveLength(1);
    expect(prog(db, stara)).toBe(2);
  } finally {
    db.close();
  }
});

// Strażnik migracji nie pozwala na CHECK w istniejącej tabeli, więc wartość pilnuje droga zapisu kart.
it('zapis karty przyjmuje brak progu, zero i liczbę całkowitą; odmawia ujemnej, ułamka i napisu', () => {
  const db = openOmsDb(':memory:');
  try {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień LMP-2' });
    expect(() => zapiszKarte(db, id, { prog_niskiego_stanu: -1 })).toThrow(/próg niskiego stanu/);
    expect(() => zapiszKarte(db, id, { prog_niskiego_stanu: 1.5 })).toThrow(/próg niskiego stanu/);
    expect(() => zapiszKarte(db, id, { prog_niskiego_stanu: 'dwa' })).toThrow(/próg niskiego stanu/);
    expect(() => zapiszKarte(db, id, { prog_niskiego_stanu: '2' })).toThrow(/próg niskiego stanu/);
    expect(() => utworzKarte(db, { nazwa: 'Lampa Półcień LMP-3', prog_niskiego_stanu: -3 })).toThrow(
      /próg niskiego stanu/,
    );
    expect(prog(db, id)).toBe(null);

    zapiszKarte(db, id, { prog_niskiego_stanu: 0 });
    expect(prog(db, id)).toBe(0);
    zapiszKarte(db, id, { prog_niskiego_stanu: 25 });
    expect(prog(db, id)).toBe(25);
    zapiszKarte(db, id, { prog_niskiego_stanu: null });
    expect(prog(db, id)).toBe(null);
    expect(prog(db, utworzKarte(db, { nazwa: 'Lampa Półcień LMP-4', prog_niskiego_stanu: 3 }))).toBe(3);
  } finally {
    db.close();
  }
});
