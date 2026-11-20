import { it, expect } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen as rdzen } from '../../../src/moduly/rdzen/modul.ts';
import type { ModulOms } from '../../../src/core/kontrakty.ts';
import { migracjaPowiadomien } from '../../../src/moduly/rdzen/migracje/0024-powiadomienia.ts';
import { wykonajMigracje } from '../../../src/core/baza.ts';

// Rdzeń 0024: migawka powiadomień (lista spraw z historią), przeczytania per konto i ślad ostatniego przebiegu.
// Baza po poprzednim wydaniu nie ma tych tabel — migracja je zakłada puste i nie rusza ignorowań.

const modulRdzen = rdzen as unknown as ModulOms;
type W = Record<string, unknown>;
const T0 = '2026-11-18T10:00:00.000Z';

const przed24 = () =>
  openOmsDb(':memory:', { moduly: [{ ...modulRdzen, migracje: modulRdzen.migracje.filter((m) => m.numer < 24) }] });
const tabela = (db: DatabaseSync, nazwa: string) =>
  (db.prepare(`PRAGMA table_info(${nazwa})`).all() as W[]).map((k) => ({
    name: k.name,
    type: k.type,
    notnull: k.notnull,
    pk: k.pk,
  }));
const indeksy = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'powiadomienia'").all() as W[])
    .map((w) => String(w.name))
    .filter((n) => !n.startsWith('sqlite_'))
    .sort();

it('rdzeń niesie migrację numer 24', () => {
  expect(modulRdzen.migracje).toContain(migracjaPowiadomien);
  expect(migracjaPowiadomien.numer).toBe(24);
});

it('zakłada puste tabele migawki, nie rusza ignorowań; ponowne uruchomienie przechodzi bez błędu', () => {
  const db = przed24();
  try {
    db.prepare('INSERT INTO ostrzezenia_odrzucone (klucz, odrzucone_at, odrzucone_przez) VALUES (?, ?, ?)').run(
      'niski-stan:LAMPA-01',
      T0,
      'magazynier',
    );
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'powiadomienia'").get()).toBeUndefined();

    // Inne nowe migracje mogą przyjść w tej samej paczce — sprawdzamy tylko, że jest wśród nich nasza.
    expect(wykonajMigracje(db, [modulRdzen]).map((m) => m.numer)).toContainEqual(24);

    expect(tabela(db, 'powiadomienia')).toEqual([
      { name: 'klucz', type: 'TEXT', notnull: 0, pk: 1 },
      { name: 'typ', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'tekst', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'title', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'href', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'etykieta_przycisku', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'etykieta_odrzucenia', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'pilne', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'pierwszy_raz_at', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'ostatnio_at', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'rozwiazane_at', type: 'TEXT', notnull: 0, pk: 0 },
    ]);
    expect(indeksy(db)).toEqual(['powiadomienia_rozwiazane', 'powiadomienia_typ']);
    expect(tabela(db, 'powiadomienia_przeczytane')).toEqual([
      { name: 'konto_id', type: 'INTEGER', notnull: 1, pk: 1 },
      { name: 'klucz', type: 'TEXT', notnull: 1, pk: 2 },
      { name: 'przeczytane_at', type: 'TEXT', notnull: 1, pk: 0 },
    ]);
    expect(tabela(db, 'powiadomienia_stan').map((k) => k.name)).toEqual([
      'id',
      'odswiezone_at',
      'czas_ms',
      'blad',
      'blad_at',
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM powiadomienia').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM powiadomienia_stan').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT klucz, odrzucone_at FROM ostrzezenia_odrzucone').all()).toEqual([
      { klucz: 'niski-stan:LAMPA-01', odrzucone_at: T0 },
    ]);

    // Stan przebiegu to jeden wiersz — drugi odbija się od CHECK.
    db.prepare('INSERT INTO powiadomienia_stan (id, odswiezone_at) VALUES (1, ?)').run(T0);
    expect(() => db.prepare('INSERT INTO powiadomienia_stan (id) VALUES (2)').run()).toThrow();

    const po = tabela(db, 'powiadomienia');
    migracjaPowiadomien.wykonaj(db);
    expect(wykonajMigracje(db, [modulRdzen])).toEqual([]);
    expect(tabela(db, 'powiadomienia')).toEqual(po);
    expect(db.prepare('SELECT odswiezone_at FROM powiadomienia_stan').all()).toEqual([{ odswiezone_at: T0 }]);
  } finally {
    db.close();
  }
});

it('świeża baza ma tabele migawki od razu', () => {
  const db = openOmsDb(':memory:', { moduly: [modulRdzen] });
  try {
    for (const t of ['powiadomienia', 'powiadomienia_przeczytane', 'powiadomienia_stan'])
      expect(db.prepare("SELECT 1 AS j FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)).toEqual({ j: 1 });
  } finally {
    db.close();
  }
});
