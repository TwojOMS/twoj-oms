// tests/core/baza.test.ts
import { describe, it, expect } from 'vitest';
import type { DatabaseSync as BazaSqlite } from 'node:sqlite';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { otworzBaze, wykonajMigracje, schematBazy } from '../../src/core/baza.ts';
import { migracjaBaseline } from '../../src/moduly/rdzen/migracje/baseline.ts';
import type { ModulOms } from '../../src/core/kontrakty.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const BASELINE = readFileSync(new URL('../../src/moduly/rdzen/migracje/0001-baseline.sql', import.meta.url), 'utf8');
const rdzen = (dodatkowe: ModulOms['migracje'] = []): ModulOms => ({
  nazwa: 'rdzen', wersja: '1.0.0', wymaga: [], konfiguracja: () => ({}),
  migracje: [migracjaBaseline, ...dodatkowe], uprawnienia: [], menu: [], zbuduj: () => ({}),
});

describe('strażnik migracji addytywnych', () => {
  const uruchom = (sql: string, modul = 'proba', plik = '0002-proba.sql') => {
    const roboczy = tmpdir();
    mkdirSync(roboczy, { recursive: true });
    const katalog = mkdtempSync(join(roboczy, 'straznik-'));
    const migracje = join(katalog, 'src/moduly', modul, 'migracje');
    mkdirSync(migracje, { recursive: true });
    writeFileSync(join(migracje, plik), sql);
    return spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/straznik-migracji.mjs', import.meta.url))], { cwd: katalog, encoding: 'utf8' });
  };

  it.each([
    ['DROP TABLE', 'DROP\nTABLE t;'],
    ['DROP COLUMN', 'ALTER TABLE t DROP\nCOLUMN x;'],
    ['RENAME', 'ALTER TABLE t\nRENAME TO x;'],
    ['NOT NULL bez DEFAULT', 'ALTER TABLE t\n ADD COLUMN x TEXT\n NOT NULL;'],
    ['DROP bez COLUMN', 'ALTER TABLE t DROP x;'],
    ['ADD bez COLUMN', 'ALTER TABLE t ADD x TEXT NOT NULL;'],
    ['BEGIN', 'BEGIN;'],
    ['COMMIT', 'COMMIT;'],
    ['ROLLBACK', 'ROLLBACK;'],
    ['END', 'END;'],
    ['writable_schema', 'PRAGMA main.writable_schema = ON;'],
    ['cytowana pragma', 'PRAGMA "writable_schema" = ON;'],
    ['pragma w nawiasach', 'PRAGMA [writable_schema] = ON;'],
    ['pragma jako literał', "PRAGMA 'writable_schema' = ON;"],
    ['DROP INDEX', 'DROP INDEX ix;'],
    ['DROP VIEW', 'DROP VIEW v;'],
    ['DROP TRIGGER', 'DROP TRIGGER tr;'],
    ['CASE przed DROP bez COLUMN', 'UPDATE t SET a = CASE WHEN 1 THEN 2 END; ALTER TABLE t DROP x; ALTER TABLE t ADD x TEXT;'],
  ])('odmawia dla %s rozłożonego na wiele linii', (_nazwa, sql) => {
    const wynik = uruchom(sql);
    expect(wynik.status).toBe(1);
    expect(wynik.stdout).toMatch(/0002-proba\.sql:\d+:/);
  });

  it.each([
    "ALTER TABLE t ADD COLUMN x TEXT DEFAULT 'a' NOT NULL;",
    "ALTER TABLE t ADD COLUMN x TEXT NOT NULL DEFAULT 'a';",
    "-- DROP TABLE t;\nALTER TABLE t ADD COLUMN x TEXT DEFAULT 'DROP TABLE; NOT NULL';",
  ])('przepuszcza addytywną migrację: %s', (sql) => {
    expect(uruchom(sql).status).toBe(0);
  });

  it('nie zwalnia migracji 0001 obcego modułu z zakazu usuwania tabel', () => {
    expect(uruchom('DROP TABLE t;', 'proba', '0001-nowy.sql').status).toBe(1);
  });

  it('wyłącza wyłącznie baseline rdzenia z kontroli instrukcji', () => {
    expect(uruchom('CREATE TABLE t (x TEXT NOT NULL);', 'rdzen', '0001-baseline.sql').status).toBe(0);
  });
});
const staraBazaProdukcyjna = (): BazaSqlite => {
  const db = otworzBaze(':memory:');
  db.exec(BASELINE);
  db.exec("INSERT INTO konta (login, imie, hash_hasla, rola, utworzone_at) VALUES ('ewa', 'Ewa', 'x', 'sprzedaz', '2026-09-01')");
  return db;
};

describe('migracje', () => {
  it('CASE poza wyzwalaczem nie ukrywa DROP/ADD kolejnej instrukcji', () => {
    const db = otworzBaze(':memory:');
    try {
      wykonajMigracje(db, [rdzen()]);
      db.exec("CREATE TABLE chroniona (id INTEGER, wartosc TEXT); INSERT INTO chroniona VALUES (1, 'zachowaj')");
      const m = rdzen([{ numer: 2, nazwa: 'CASE i DROP', wykonaj: (d) => {
        d.exec('UPDATE chroniona SET id = CASE WHEN 1 THEN 2 END; ALTER TABLE chroniona DROP wartosc; ALTER TABLE chroniona ADD wartosc TEXT;');
      } }]);
      expect(() => wykonajMigracje(db, [m])).toThrow('nieaddytywna');
      expect(db.prepare('SELECT id, wartosc FROM chroniona').get()).toEqual({ id: 1, wartosc: 'zachowaj' });
    } finally { db.close(); }
  });

  it('blokuje wyzwalacz na tabeli migracje przed zapisaniem znacznika', () => {
    const db = otworzBaze(':memory:');
    try {
      wykonajMigracje(db, [rdzen()]);
      db.exec('CREATE TABLE chroniona (id INTEGER); INSERT INTO chroniona VALUES (1)');
      const m = rdzen([{ numer: 2, nazwa: 'wyzwalacz znacznika', wykonaj: (d) => {
        d.exec('CREATE TRIGGER zly AFTER INSERT ON migracje BEGIN DELETE FROM chroniona; END');
      } }]);
      expect(() => wykonajMigracje(db, [m])).toThrow('nieaddytywna');
      expect(db.prepare('SELECT count(*) AS n FROM chroniona').get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'zly'").get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT count(*) AS n FROM migracje WHERE numer = 2').get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it.each(['main.migracje', 'main.chroniona'])('blokuje wyzwalacz TEMP na istniejącej tabeli %s', (tabela) => {
    const db = otworzBaze(':memory:');
    try {
      wykonajMigracje(db, [rdzen()]);
      db.exec('CREATE TABLE chroniona (id INTEGER); INSERT INTO chroniona VALUES (1)');
      const m = rdzen([{ numer: 2, nazwa: 'wyzwalacz TEMP', wykonaj: (d) => {
        d.exec(`CREATE TEMP TRIGGER zly AFTER INSERT ON ${tabela} BEGIN DELETE FROM chroniona; END`);
      } }]);
      expect(() => wykonajMigracje(db, [m])).toThrow('nieaddytywna');
      expect(db.prepare('SELECT id FROM chroniona').all()).toEqual([{ id: 1 }]);
      expect(db.prepare("SELECT count(*) AS n FROM sqlite_temp_master WHERE name = 'zly'").get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT count(*) AS n FROM migracje WHERE numer = 2').get()).toEqual({ n: 0 });
      db.exec('INSERT INTO chroniona VALUES (2)');
      expect(db.prepare('SELECT id FROM chroniona ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }]);
    } finally { db.close(); }
  });

  it('rozróżnia wyzwalacze main i TEMP o tej samej nazwie i treści', () => {
    const db = otworzBaze(':memory:');
    try {
      wykonajMigracje(db, [rdzen()]);
      db.exec('CREATE TABLE chroniona (id INTEGER); INSERT INTO chroniona VALUES (1)');
      db.exec('CREATE TRIGGER wspolny AFTER INSERT ON main.chroniona BEGIN SELECT 1; END');
      const m = rdzen([{ numer: 2, nazwa: 'ta sama nazwa wyzwalacza', wykonaj: (d) => {
        d.exec('CREATE TEMP TRIGGER wspolny AFTER INSERT ON main.chroniona BEGIN SELECT 1; END');
      } }]);
      expect(() => wykonajMigracje(db, [m])).toThrow('nieaddytywna');
      expect(db.prepare('SELECT id FROM chroniona').all()).toEqual([{ id: 1 }]);
      expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = 'wspolny'").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM sqlite_temp_master WHERE type = 'trigger' AND name = 'wspolny'").get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT count(*) AS n FROM migracje WHERE numer = 2').get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it.each(['"writable_schema"', '[writable_schema]', "'writable_schema'"])('blokuje cytowaną nazwę pragmy %s', (nazwa) => {
    const db = otworzBaze(':memory:');
    try {
      wykonajMigracje(db, [rdzen()]);
      const m = rdzen([{ numer: 2, nazwa: 'cytowana pragma', wykonaj: (d) => d.exec(`PRAGMA ${nazwa} = ON`) }]);
      expect(() => wykonajMigracje(db, [m])).toThrow('nieaddytywna');
      expect(db.prepare('PRAGMA writable_schema').get()).toEqual({ writable_schema: 0 });
    } finally { db.close(); }
  });

  it('zachowuje przyczynę po automatycznym rollbacku SQLite', () => {
    const db = otworzBaze(':memory:');
    try {
      wykonajMigracje(db, [rdzen()]);
      db.exec('CREATE TABLE chroniona (id INTEGER UNIQUE); INSERT INTO chroniona VALUES (1)');
      const m = rdzen([{ numer: 2, nazwa: 'automatyczny rollback', wykonaj: (d) => {
        d.exec('CREATE TABLE chwilowa (x); INSERT OR ROLLBACK INTO chroniona VALUES (1)');
      } }]);
      expect(() => wykonajMigracje(db, [m])).toThrow('UNIQUE constraint failed');
      expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'chwilowa'").get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT count(*) AS n FROM migracje WHERE numer = 2').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT count(*) AS n FROM chroniona').get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });

  it.each(['exec', 'prepare'] as const)('chroni wartości przed DROP/ADD bez COLUMN przez %s', (metoda) => {
    const db = otworzBaze(':memory:');
    try {
      wykonajMigracje(db, [rdzen()]);
      db.exec("CREATE TABLE chroniona (id INTEGER PRIMARY KEY, wartosc TEXT); INSERT INTO chroniona VALUES (1, 'zachowaj')");
      const m = rdzen([{ numer: 2, nazwa: 'odtworzenie kolumny', wykonaj: (d) => {
        if (metoda === 'exec') d.exec('ALTER TABLE chroniona DROP wartosc');
        else d.prepare('ALTER TABLE chroniona DROP wartosc').run();
        d.exec('ALTER TABLE chroniona ADD wartosc TEXT');
      } }]);
      expect(() => wykonajMigracje(db, [m])).toThrow('nieaddytywna');
      expect(db.prepare('SELECT wartosc FROM chroniona').get()).toEqual({ wartosc: 'zachowaj' });
    } finally { db.close(); }
  });

  it.each(['COMMIT', 'END', 'ROLLBACK', 'BEGIN', 'PRAGMA writable_schema = ON'])('migracja nie może sterować transakcją ani schematem przez %s', (sql) => {
    const db = otworzBaze(':memory:');
    try {
      wykonajMigracje(db, [rdzen()]);
      const m = rdzen([{ numer: 2, nazwa: 'transakcja', wykonaj: (d) => {
        d.exec('CREATE TABLE tymczasowa (x INTEGER)');
        d.exec(sql);
        throw new Error('bum');
      } }]);
      expect(() => wykonajMigracje(db, [m])).toThrow('nieaddytywna');
      expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'tymczasowa'").get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT count(*) AS n FROM migracje WHERE numer = 2').get()).toEqual({ n: 0 });
      expect(db.prepare('PRAGMA writable_schema').get()).toEqual({ writable_schema: 0 });
    } finally { db.close(); }
  });

  it.each([
    'CREATE UNIQUE INDEX nowy ON chroniona (wartosc)',
    'CREATE TRIGGER nowy AFTER INSERT ON chroniona BEGIN UPDATE chroniona SET wartosc = 1; END',
    'ALTER TABLE chroniona ADD x INTEGER DEFAULT 0 CHECK (x > 0)',
    'ALTER TABLE chroniona ADD rodzic INTEGER REFERENCES rodzice(id)',
  ])('odmawia nowego ograniczenia lub wyzwalacza istniejącej tabeli: %s', (sql) => {
    const db = otworzBaze(':memory:');
    try {
      wykonajMigracje(db, [rdzen()]);
      db.exec('CREATE TABLE chroniona (wartosc INTEGER)');
      db.exec('CREATE TABLE rodzice (id INTEGER PRIMARY KEY)');
      const przed = schematBazy(db);
      const m = rdzen([{ numer: 2, nazwa: 'ograniczenie', wykonaj: (d) => d.exec(sql) }]);
      expect(() => wykonajMigracje(db, [m])).toThrow('nieaddytywna');
      expect(schematBazy(db)).toEqual(przed);
      expect(db.prepare('SELECT count(*) AS n FROM migracje WHERE numer = 2').get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it.each([false, true])('przywraca metody po migracji, także po błędzie=%s', (blad) => {
    const db = otworzBaze(':memory:');
    try {
      wykonajMigracje(db, [rdzen()]);
      const exec = db.exec;
      const prepare = db.prepare;
      const m = rdzen([{ numer: 2, nazwa: 'przywracanie metod', wykonaj: () => { if (blad) throw new Error('bum'); } }]);
      if (blad) expect(() => wykonajMigracje(db, [m])).toThrow('bum');
      else wykonajMigracje(db, [m]);
      expect(db.exec).toBe(exec);
      expect(db.prepare).toBe(prepare);
      db.exec('CREATE TABLE chwilowa (x); DROP TABLE chwilowa');
      db.exec('CREATE TABLE chwilowa (x)');
      db.prepare('DROP TABLE chwilowa').run();
    } finally { db.close(); }
  });

  it.each(['exec', 'prepare'] as const)('blokuje DROP przed wykonaniem przez %s, nawet gdy funkcja odtworzyłaby ten sam schemat', (metoda) => {
    const db = otworzBaze(':memory:');
    try {
      wykonajMigracje(db, [rdzen()]);
      db.exec('CREATE TABLE chroniona (id INTEGER PRIMARY KEY); INSERT INTO chroniona VALUES (1)');
      const m = rdzen([{ numer: 2, nazwa: 'odtworzenie', wykonaj: (d) => {
        if (metoda === 'exec') d.exec('DROP TABLE chroniona');
        else d.prepare('DROP TABLE chroniona').run();
        d.exec('CREATE TABLE chroniona (id INTEGER PRIMARY KEY)');
      } }]);
      expect(() => wykonajMigracje(db, [m])).toThrow('nieaddytywna');
      expect(db.prepare('SELECT count(*) AS n FROM chroniona').get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });

  it.each([
    ['FK', 'CREATE TABLE t (x INTEGER REFERENCES p(id))', 'CREATE TABLE t (x INTEGER)'],
    ['CHECK', 'CREATE TABLE t (x INTEGER CHECK (x > 0))', 'CREATE TABLE t (x INTEGER CHECK (x >= 0))'],
    ['UNIQUE', 'CREATE TABLE t (x INTEGER UNIQUE)', 'CREATE TABLE t (x INTEGER)'],
    ['DESC', 'CREATE TABLE t (x INTEGER); CREATE INDEX ix ON t (x DESC)', 'CREATE TABLE t (x INTEGER); CREATE INDEX ix ON t (x ASC)'],
    ['WHERE', 'CREATE TABLE t (x INTEGER); CREATE INDEX ix ON t (x) WHERE x > 0', 'CREATE TABLE t (x INTEGER); CREATE INDEX ix ON t (x) WHERE x >= 0'],
    ['trigger', 'CREATE TABLE t (x INTEGER); CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET x = 1; END', 'CREATE TABLE t (x INTEGER); CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET x = 2; END'],
    ['COLLATE', 'CREATE TABLE t (x TEXT COLLATE NOCASE)', 'CREATE TABLE t (x TEXT COLLATE BINARY)'],
    ['WITHOUT ROWID', 'CREATE TABLE t (x INTEGER NOT NULL PRIMARY KEY) WITHOUT ROWID', 'CREATE TABLE t (x INTEGER NOT NULL PRIMARY KEY)'],
    ['STRICT', 'CREATE TABLE t (x INTEGER) STRICT', 'CREATE TABLE t (x INTEGER)'],
    ['AUTOINCREMENT', 'CREATE TABLE t (x INTEGER PRIMARY KEY AUTOINCREMENT)', 'CREATE TABLE t (x INTEGER PRIMARY KEY)'],
    ['wyrażenie indeksu', 'CREATE TABLE t (x TEXT); CREATE INDEX ix ON t (lower(x))', 'CREATE TABLE t (x TEXT); CREATE INDEX ix ON t (upper(x))'],
    ['kolumna generowana', 'CREATE TABLE t (x INTEGER, y INTEGER AS (x + 1))', 'CREATE TABLE t (x INTEGER, y INTEGER AS (x + 2))'],
  ])('odcisk wykrywa różnicę %s', (_nazwa, sqlA, sqlB) => {
    const a = new DatabaseSync(':memory:');
    const b = new DatabaseSync(':memory:');
    try {
      a.exec('CREATE TABLE p (id INTEGER PRIMARY KEY)');
      b.exec('CREATE TABLE p (id INTEGER PRIMARY KEY)');
      a.exec(sqlA);
      b.exec(sqlB);
      expect(schematBazy(a)).not.toEqual(schematBazy(b));
    } finally { a.close(); b.close(); }
  });

  it('odcisk ignoruje kolejność FK i kolumn oraz formatowanie i cytowanie wyrażenia CHECK', () => {
    const a = new DatabaseSync(':memory:');
    const b = new DatabaseSync(':memory:');
    try {
      a.exec('CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE t (x INTEGER REFERENCES p(id), y INTEGER REFERENCES p(id), CHECK (x > 0))');
      b.exec('CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE t (y INTEGER REFERENCES p(id), x INTEGER REFERENCES p(id), CHECK ("x">0))');
      expect(schematBazy(a)).toEqual(schematBazy(b));
    } finally { a.close(); b.close(); }
  });

  it.each([
    'DROP TABLE chroniona',
    'ALTER TABLE chroniona RENAME TO inna',
    'ALTER TABLE chroniona ADD COLUMN x TEXT NOT NULL',
  ])('cofa nieaddytywną migrację funkcyjną: %s', (sql) => {
    const db = otworzBaze(':memory:');
    wykonajMigracje(db, [rdzen()]);
    db.exec('CREATE TABLE chroniona (id INTEGER PRIMARY KEY)');
    const przed = schematBazy(db);
    const m = rdzen([{ numer: 2, nazwa: 'nieaddytywna', wykonaj: (d) => d.exec(sql) }]);
    expect(() => wykonajMigracje(db, [m])).toThrow('nieaddytywna');
    expect(schematBazy(db)).toEqual(przed);
    expect(db.prepare('SELECT count(*) AS n FROM migracje WHERE numer = 2').get()).toEqual({ n: 0 });
    db.close();
  });

  it.each(['', 'TEMP '])('przepuszcza funkcję dodającą kolumnę z DEFAULT oraz nową tabelę z wyzwalaczem %s', (rodzaj) => {
    const db = otworzBaze(':memory:');
    wykonajMigracje(db, [rdzen()]);
    db.exec('CREATE TABLE chroniona (id INTEGER PRIMARY KEY)');
    const m = rdzen([{ numer: 2, nazwa: 'addytywna', wykonaj: (d) => {
      d.exec("ALTER TABLE chroniona ADD COLUMN x TEXT DEFAULT 'a' NOT NULL");
      d.exec('CREATE TABLE nowa (y TEXT NOT NULL UNIQUE CHECK (length(y) > 0))');
      d.exec(`CREATE ${rodzaj}TRIGGER nowy AFTER INSERT ON nowa BEGIN UPDATE nowa SET y = CASE WHEN y = 'a' THEN 'b' ELSE y END; END`);
    } }]);
    expect(wykonajMigracje(db, [m])).toHaveLength(1);
    expect(db.prepare('SELECT count(*) AS n FROM migracje WHERE numer = 2').get()).toEqual({ n: 1 });
    db.exec("INSERT INTO nowa VALUES ('a')");
    expect(db.prepare('SELECT y FROM nowa').get()).toEqual({ y: 'b' });
    db.close();
  });

  it('pusta baza: baseline tworzy schemat i zapisuje się w tabeli migracje', () => {
    const db = otworzBaze(':memory:');
    const wynik = wykonajMigracje(db, [rdzen()]);
    expect(wynik).toEqual([{ modul: 'rdzen', numer: 1, nazwa: migracjaBaseline.nazwa, tryb: 'wykonana' }]);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'zamowienia'").get()).toEqual({ n: 1 });
  });

  // Review Focus 1: baza starego OMS-u NIE jest pusta i NIE dostaje tabel drugi raz.
  it('istniejąca baza starego OMS-u: baseline tylko się oznacza, dane zostają', () => {
    const db = staraBazaProdukcyjna();
    expect(wykonajMigracje(db, [rdzen()])[0].tryb).toBe('oznaczona');
    expect(db.prepare('SELECT login FROM konta').all()).toEqual([{ login: 'ewa' }]);
    expect(db.prepare('SELECT modul, numer FROM migracje').all()).toEqual([{ modul: 'rdzen', numer: 1 }]);
  });

  it('istniejąca baza z INNYM schematem: odmowa z nazwą różnicy, bez zmian w bazie', () => {
    const db = staraBazaProdukcyjna();
    db.exec('ALTER TABLE zamowienia ADD COLUMN obca_kolumna TEXT');
    expect(() => wykonajMigracje(db, [rdzen()])).toThrow('obca_kolumna');
    expect(db.prepare('SELECT count(*) AS n FROM migracje').get()).toEqual({ n: 0 });
  });

  it('odmawia baseline, gdy jedyną różnicą jest dodatkowy FK świeżej bazy starego kodu', () => {
    const db = otworzBaze(':memory:');
    try {
      db.exec(BASELINE.replace('zamowienie_zrodlowe_id INTEGER', 'zamowienie_zrodlowe_id INTEGER REFERENCES zamowienia(id)'));
      expect(() => wykonajMigracje(db, [rdzen()])).toThrow('FK');
      expect(db.prepare('SELECT count(*) AS n FROM migracje').get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it('migracja wykonuje się raz — drugi start niczego nie powtarza', () => {
    const db = otworzBaze(':memory:');
    let ile = 0;
    const m = rdzen([{ numer: 2, nazwa: 'licznik', wykonaj: () => { ile++; } }]);
    wykonajMigracje(db, [m]);
    wykonajMigracje(db, [m]);
    expect(ile).toBe(1);
  });

  it('nieudana migracja cofa swoje zmiany i nie zapisuje się jako wykonana', () => {
    const db = otworzBaze(':memory:');
    const zla = rdzen([{ numer: 2, nazwa: 'zla', wykonaj: (d) => { d.exec('CREATE TABLE tymczasowa (a)'); throw new Error('bum'); } }]);
    expect(() => wykonajMigracje(db, [zla])).toThrow('Migracja rdzen/2 „zla" nie powiodła się: bum');
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'tymczasowa'").get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM migracje WHERE numer = 2').get()).toEqual({ n: 0 });
  });

  it('odcisk schematu nie zależy od tekstu CREATE, tylko od struktury', () => {
    const a = new DatabaseSync(':memory:');
    const b = new DatabaseSync(':memory:');
    a.exec('CREATE TABLE t (x INTEGER NOT NULL, y TEXT)');
    b.exec('CREATE TABLE t (x INTEGER NOT NULL)');
    b.exec('ALTER TABLE t ADD COLUMN y TEXT');
    expect(schematBazy(a)).toEqual(schematBazy(b));
  });
});
