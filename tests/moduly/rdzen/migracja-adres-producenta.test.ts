import { it, expect } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen as rdzen } from '../../../src/moduly/rdzen/modul.ts';
import type { ModulOms } from '../../../src/core/kontrakty.ts';
import { migracjaAdresuProducenta } from '../../../src/moduly/rdzen/migracje/0023-adres-producenta.ts';
import { wykonajMigracje } from '../../../src/core/baza.ts';

// Rdzeń 0023: adres producenta w polach (ulica, kod, miejscowość, kraj) obok dawnej kolumny `adres`. Baza po
// wydaniu z 0020 ma producentów z adresem w jednym polu — te wiersze mają przetrwać bez zmian. Dane zmyślone.

// Moduł rdzenia ma własny typ konfiguracji; baza przyjmuje moduły bez niego (jak domyślna lista w db.ts).
const modulRdzen = rdzen as unknown as ModulOms;
type W = Record<string, unknown>;
const T0 = '2026-11-18T10:00:00.000Z';
const NOWE = ['ulica', 'kod_pocztowy', 'miasto', 'kraj'];

const przed23 = () =>
  openOmsDb(':memory:', { moduly: [{ ...modulRdzen, migracje: modulRdzen.migracje.filter((m) => m.numer < 23) }] });
const kolumny = (db: DatabaseSync) =>
  (db.prepare('PRAGMA table_info(producenci)').all() as W[]).map((k) => ({
    name: k.name,
    type: k.type,
    notnull: k.notnull,
  }));
const wszyscy = (db: DatabaseSync) =>
  (db.prepare('SELECT * FROM producenci ORDER BY id').all() as W[]).map((w) => ({ ...w }));

it('rdzeń niesie migrację numer 23', () => {
  expect(modulRdzen.migracje).toContain(migracjaAdresuProducenta);
  expect(migracjaAdresuProducenta.numer).toBe(23);
});

it('stary producent (adres jedną linią, domyślny) zostaje bez zmian, nowe kolumny są puste; powtórka niczego nie zmienia', () => {
  const db = przed23();
  try {
    expect(kolumny(db).map((k) => k.name)).not.toContain('ulica');
    db.prepare(
      `INSERT INTO producenci (nazwa, adres, email, www, domyslny, utworzono_at, zmieniono_at)
       VALUES (?, ?, ?, NULL, 1, ?, ?)`,
    ).run('Pracownia Półcień', 'ul. Zmyślona 19, 00-950 Przykładowo', 'kontakt@polcien.invalid', T0, T0);
    const przed = wszyscy(db);

    // Inne nowe migracje mogą przyjść w tej samej paczce — sprawdzamy tylko, że jest wśród nich nasza.
    expect(wykonajMigracje(db, [modulRdzen]).map((m) => m.numer)).toContainEqual(23);

    // Nowe kolumny dopuszczają NULL (stare wiersze), a `adres` zostaje NOT NULL — składa go domena.
    const po = kolumny(db);
    expect(po.filter((k) => NOWE.includes(String(k.name)))).toEqual(
      NOWE.map((name) => ({ name, type: 'TEXT', notnull: 0 })),
    );
    expect(po.find((k) => k.name === 'adres')?.notnull).toBe(1);
    expect(wszyscy(db)).toEqual([{ ...przed[0], ulica: null, kod_pocztowy: null, miasto: null, kraj: null }]);

    migracjaAdresuProducenta.wykonaj(db);
    expect(wykonajMigracje(db, [modulRdzen])).toEqual([]);
    expect(kolumny(db)).toEqual(po);
    expect(wszyscy(db)).toEqual([{ ...przed[0], ulica: null, kod_pocztowy: null, miasto: null, kraj: null }]);
  } finally {
    db.close();
  }
});

it('świeża baza ma kolumny adresu w polach od razu', () => {
  const db = openOmsDb(':memory:', { moduly: [modulRdzen] });
  try {
    expect(kolumny(db).map((k) => k.name)).toEqual(expect.arrayContaining(['adres', ...NOWE]));
  } finally {
    db.close();
  }
});
