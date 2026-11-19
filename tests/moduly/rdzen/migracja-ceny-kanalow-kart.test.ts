import { it, expect } from 'vitest';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen as rdzen } from '../../../src/moduly/rdzen/modul.ts';
import type { ModulOms } from '../../../src/core/kontrakty.ts';
import { migracjaCenKanalowKart } from '../../../src/moduly/rdzen/migracje/0019-ceny-kanalow-kart.ts';
import { wykonajMigracje } from '../../../src/core/baza.ts';

// Rdzeń 0019: ręczna cena karty w danym kanale (klucz konta). Brak wiersza = cena z karty z narzutem konta.
// Dane zmyślone: „Pracownia Półcień”, konto `polcien`, lampy LMP-*.

// Moduł rdzenia ma własny typ konfiguracji; baza przyjmuje moduły bez niego (jak domyślna lista w db.ts).
const modulRdzen = rdzen as unknown as ModulOms;
type W = Record<string, unknown>;
const T0 = '2026-11-18T10:00:00.000Z';

const bez19 = () =>
  openOmsDb(':memory:', { moduly: [{ ...modulRdzen, migracje: modulRdzen.migracje.filter((m) => m.numer !== 19) }] });
const wiersze = (db: DatabaseSync, sql: string, ...a: SQLInputValue[]) => db.prepare(sql).all(...a) as W[];
const tabela = (db: DatabaseSync, nazwa: string) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(nazwa) as W | undefined)?.name ??
  null;
const karta = (db: DatabaseSync, sku: string) =>
  Number(
    db
      .prepare('INSERT INTO karty_produktow (sku, nazwa, utworzony_at, zmieniony_at) VALUES (?, ?, ?, ?)')
      .run(sku, `Lampa Półcień ${sku}`, T0, T0).lastInsertRowid,
  );
const wpis = (db: DatabaseSync, kartaId: number, nad: { kanal?: string; cena?: SQLInputValue } = {}) =>
  db
    .prepare('INSERT INTO ceny_kanalow_kart (karta_id, kanal, cena_gr, kto, zmieniono_at) VALUES (?, ?, ?, ?, ?)')
    .run(kartaId, nad.kanal ?? 'polcien', nad.cena === undefined ? 10500 : nad.cena, 'administrator', T0);
const ile = (db: DatabaseSync) => Number((db.prepare('SELECT COUNT(*) AS n FROM ceny_kanalow_kart').get() as W).n);

it('rdzeń niesie migrację numer 19', () => {
  expect(modulRdzen.migracje).toContain(migracjaCenKanalowKart);
  expect(migracjaCenKanalowKart.numer).toBe(19);
});

it('dokłada tabelę ręcznych cen kanałów raz; powtórka niczego nie psuje', () => {
  const db = bez19();
  try {
    expect(tabela(db, 'ceny_kanalow_kart')).toBe(null);
    expect(wykonajMigracje(db, [modulRdzen]).map((m) => m.numer)).toEqual([19]);
    expect(tabela(db, 'ceny_kanalow_kart')).toBe('ceny_kanalow_kart');
    expect(wiersze(db, 'PRAGMA table_info(ceny_kanalow_kart)').map((k) => k.name)).toEqual([
      'karta_id',
      'kanal',
      'cena_gr',
      'kto',
      'zmieniono_at',
    ]);
    const unikalne = wiersze(db, 'PRAGMA index_list(ceny_kanalow_kart)')
      .filter((i) => i.unique === 1)
      .map((i) => wiersze(db, `PRAGMA index_info(${JSON.stringify(i.name)})`).map((k) => k.name));
    expect(unikalne).toContainEqual(['karta_id', 'kanal']);
    const fk = wiersze(db, 'PRAGMA foreign_key_list(ceny_kanalow_kart)');
    expect(fk.map((f) => [f.table, f.from, f.to, f.on_delete])).toEqual([
      ['karty_produktow', 'karta_id', 'id', 'CASCADE'],
    ]);

    const id = karta(db, 'LMP-1');
    wpis(db, id);
    // Druga i trzecia próba na bazie, która już ma tabelę z danymi — bez błędu i bez utraty wiersza.
    migracjaCenKanalowKart.wykonaj(db);
    migracjaCenKanalowKart.wykonaj(db);
    expect(wykonajMigracje(db, [modulRdzen])).toEqual([]);
    expect(ile(db)).toBe(1);
  } finally {
    db.close();
  }
});

it('baza odmawia ceny zerowej, ujemnej, ułamkowej, pustej, drugiej ceny tego samego konta i nieznanej karty', () => {
  const db = openOmsDb(':memory:');
  try {
    const id = karta(db, 'LMP-2');
    expect(() => wpis(db, id, { cena: 0 })).toThrow(/CHECK/);
    expect(() => wpis(db, id, { cena: -100 })).toThrow(/CHECK/);
    expect(() => wpis(db, id, { cena: 10.5 })).toThrow(/CHECK/);
    expect(() => wpis(db, id, { cena: '105,00' })).toThrow(/CHECK/);
    expect(() => wpis(db, id, { cena: null })).toThrow(/NOT NULL/);
    expect(() => wpis(db, 999999)).toThrow(/FOREIGN KEY/);
    expect(ile(db)).toBe(0);

    wpis(db, id, { cena: 1 });
    expect(() => wpis(db, id, { cena: 10500 })).toThrow(/UNIQUE/);
    wpis(db, id, { kanal: 'allegro_polcien', cena: 10900 });
    expect(ile(db)).toBe(2);
  } finally {
    db.close();
  }
});

it('skasowana karta zabiera swoje ręczne ceny, cudzych nie rusza', () => {
  const db = openOmsDb(':memory:');
  try {
    const a = karta(db, 'LMP-3');
    const b = karta(db, 'LMP-4');
    wpis(db, a);
    wpis(db, a, { kanal: 'allegro_polcien' });
    wpis(db, b);
    db.prepare('DELETE FROM karty_produktow WHERE id = ?').run(a);
    expect(wiersze(db, 'SELECT karta_id, kanal FROM ceny_kanalow_kart').map((w) => ({ ...w }))).toEqual([
      { karta_id: b, kanal: 'polcien' },
    ]);
  } finally {
    db.close();
  }
});
