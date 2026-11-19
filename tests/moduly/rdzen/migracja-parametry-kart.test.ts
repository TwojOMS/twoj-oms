import { it, expect } from 'vitest';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen as rdzen } from '../../../src/moduly/rdzen/modul.ts';
import type { ModulOms } from '../../../src/core/kontrakty.ts';
import { migracjaParametrowKart } from '../../../src/moduly/rdzen/migracje/0022-parametry-kart.ts';
import { wykonajMigracje } from '../../../src/core/baza.ts';

// Rdzeń 0022: parametry własne kart (definicje firmy + wartości kart) i przeniesienie dawnego pola stałego
// „paczkomat” do parametru typu lista. Dane zmyślone: „Pracownia Półcień”, lampy LMP-*.

// Moduł rdzenia ma własny typ konfiguracji; baza przyjmuje moduły bez niego (jak domyślna lista w db.ts).
const modulRdzen = rdzen as unknown as ModulOms;
type W = Record<string, unknown>;
const T0 = '2026-11-18T10:00:00.000Z';

const przed22 = () =>
  openOmsDb(':memory:', { moduly: [{ ...modulRdzen, migracje: modulRdzen.migracje.filter((m) => m.numer < 22) }] });
const wiersze = (db: DatabaseSync, sql: string, ...a: SQLInputValue[]) => db.prepare(sql).all(...a) as W[];
const tabela = (db: DatabaseSync, nazwa: string) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(nazwa) as W | undefined)?.name ??
  null;
const karta = (db: DatabaseSync, sku: string, paczkomat: string | null = null) =>
  Number(
    db
      .prepare('INSERT INTO karty_produktow (sku, nazwa, paczkomat, utworzony_at, zmieniony_at) VALUES (?, ?, ?, ?, ?)')
      .run(sku, `Lampa Półcień ${sku}`, paczkomat, T0, T0).lastInsertRowid,
  );
const ile = (db: DatabaseSync, sql: string, ...a: SQLInputValue[]) => Number((db.prepare(sql).get(...a) as W).n);
const migruj = (db: DatabaseSync) => wykonajMigracje(db, [modulRdzen]).map((m) => m.numer);

it('rdzeń niesie migrację numer 22', () => {
  expect(modulRdzen.migracje).toContain(migracjaParametrowKart);
  expect(migracjaParametrowKart.numer).toBe(22);
});

it('dokłada tabele definicji i wartości z ograniczeniami i indeksami ze specyfikacji', () => {
  const db = przed22();
  try {
    expect(tabela(db, 'parametry_kart')).toBe(null);
    expect(tabela(db, 'karty_parametry')).toBe(null);
    // Inne nowe migracje mogą przyjść w tej samej paczce — sprawdzamy tylko, że jest wśród nich nasza.
    expect(migruj(db)).toContainEqual(22);

    expect(wiersze(db, 'PRAGMA table_info(parametry_kart)').map((k) => k.name)).toEqual([
      'id',
      'nazwa',
      'typ',
      'jednostka',
      'wartosci_json',
      'wymagany',
      'kolejnosc',
      'utworzono_at',
      'zmieniono_at',
    ]);
    expect(wiersze(db, 'PRAGMA table_info(karty_parametry)').map((k) => k.name)).toEqual([
      'karta_id',
      'parametr_id',
      'wartosc',
      'zmieniono_at',
      'kto',
    ]);
    const fk = wiersze(db, 'PRAGMA foreign_key_list(karty_parametry)');
    expect(fk.map((f) => [f.table, f.from, f.to, f.on_delete]).sort()).toEqual([
      ['karty_produktow', 'karta_id', 'id', 'CASCADE'],
      ['parametry_kart', 'parametr_id', 'id', 'CASCADE'],
    ]);
    const indeksy = wiersze(db, "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL");
    expect(indeksy.find((i) => i.name === 'parametry_kart_nazwa')?.sql).toMatch(/UNIQUE INDEX.*lower\(trim\(nazwa\)\)/);
    expect(indeksy.find((i) => i.name === 'karty_parametry_parametr')?.sql).toMatch(/\(parametr_id, wartosc\)/);

    // CHECK-i są drugą zaporą za domeną: zły typ, pusta nazwa, pusta wartość i nazwa różniąca się tylko
    // wielkością liter nie wejdą nawet zapisem z pominięciem formularza.
    const def = db.prepare(
      `INSERT INTO parametry_kart (nazwa, typ, jednostka, wartosci_json, wymagany, kolejnosc, utworzono_at, zmieniono_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    expect(() => def.run('Kolor', 'data', null, null, 0, T0, T0)).toThrow(/CHECK/);
    expect(() => def.run('   ', 'tekst', null, null, 0, T0, T0)).toThrow(/CHECK/);
    expect(() => def.run('Moc', 'liczba', 'kilowatogodziny', null, 0, T0, T0)).toThrow(/CHECK/);
    expect(() => def.run('Kolor', 'lista', null, '[nie json', 0, T0, T0)).toThrow(/CHECK/);
    expect(() => def.run('Moc', 'liczba', 'W', null, 2, T0, T0)).toThrow(/CHECK/);
    const kolor = Number(def.run('Kolor', 'lista', null, '["czarny","biały"]', 0, T0, T0).lastInsertRowid);
    expect(() => def.run(' kolor ', 'tekst', null, null, 0, T0, T0)).toThrow(/UNIQUE/);
    const id = karta(db, 'LMP-1');
    const wartosc = db.prepare(
      'INSERT INTO karty_parametry (karta_id, parametr_id, wartosc, zmieniono_at, kto) VALUES (?, ?, ?, ?, ?)',
    );
    expect(() => wartosc.run(id, kolor, '', T0, null)).toThrow(/CHECK/);
    expect(() => wartosc.run(id, kolor, 'x'.repeat(201), T0, null)).toThrow(/CHECK/);
    expect(() => wartosc.run(id + 100, kolor, 'czarny', T0, null)).toThrow(/FOREIGN KEY/);
    wartosc.run(id, kolor, 'czarny', T0, 'administrator');
    expect(() => wartosc.run(id, kolor, 'biały', T0, null)).toThrow(/UNIQUE|PRIMARY/);
  } finally {
    db.close();
  }
});

it('przenosi paczkomat 1:1 przy rozkładzie 4 tak / 9 nie / 965 bez oznaczenia', () => {
  const db = przed22();
  try {
    const oczekiwane = new Map<number, string>();
    for (let i = 1; i <= 978; i++) {
      const p = i <= 4 ? 'tak' : i <= 13 ? 'nie' : null;
      // Przeplatamy, żeby przeniesienie nie zależało od kolejności kart.
      const id = karta(db, `LMP-${String((i * 7919) % 100000).padStart(5, '0')}`, p);
      if (p) oczekiwane.set(id, p);
    }

    expect(migruj(db)).toContainEqual(22);

    const parametry = wiersze(db, 'SELECT * FROM parametry_kart');
    expect(parametry).toHaveLength(1);
    const [p] = parametry;
    expect(p).toMatchObject({ nazwa: 'Paczkomat', typ: 'lista', jednostka: null, wymagany: 1, kolejnosc: 1 });
    expect(JSON.parse(String(p.wartosci_json))).toEqual(['tak', 'nie']);
    expect(String(p.utworzono_at)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(p.zmieniono_at).toBe(p.utworzono_at);

    const przeniesione = wiersze(db, 'SELECT karta_id, parametr_id, wartosc, kto FROM karty_parametry');
    expect(przeniesione).toHaveLength(13);
    expect(new Map(przeniesione.map((w) => [Number(w.karta_id), w.wartosc]))).toEqual(oczekiwane);
    expect(new Set(przeniesione.map((w) => w.parametr_id))).toEqual(new Set([p.id]));
    expect(new Set(przeniesione.map((w) => w.kto))).toEqual(new Set(['migracja']));
    expect(ile(db, "SELECT COUNT(*) AS n FROM karty_parametry WHERE wartosc = 'tak'")).toBe(4);
    expect(ile(db, "SELECT COUNT(*) AS n FROM karty_parametry WHERE wartosc = 'nie'")).toBe(9);
    // Karta bez oznaczenia zostaje BEZ wiersza (brak wartości to brak wiersza, nigdy pusty napis) — dzięki
    // temu wymagany parametr liczy te same 965 kart do braków co dawne „bez paczkomatu”.
    expect(
      ile(
        db,
        'SELECT COUNT(*) AS n FROM karty_produktow k WHERE NOT EXISTS (SELECT 1 FROM karty_parametry kp WHERE kp.karta_id = k.id)',
      ),
    ).toBe(965);
    // Kolumna zostaje w bazie z danymi — nie kasujemy niczego.
    expect(ile(db, "SELECT COUNT(*) AS n FROM karty_produktow WHERE paczkomat IN ('tak', 'nie')")).toBe(13);

    // Druga i trzecia próba niczego nie zmieniają — także gdy firma zdążyła już zmienić wartość karty.
    const [pierwsza] = oczekiwane.keys();
    db.prepare("UPDATE karty_parametry SET wartosc = 'nie', kto = 'administrator' WHERE karta_id = ?").run(pierwsza);
    const przed = wiersze(db, 'SELECT * FROM karty_parametry ORDER BY karta_id');
    migracjaParametrowKart.wykonaj(db);
    migracjaParametrowKart.wykonaj(db);
    expect(wykonajMigracje(db, [modulRdzen])).toEqual([]);
    expect(wiersze(db, 'SELECT * FROM parametry_kart')).toEqual(parametry);
    expect(wiersze(db, 'SELECT * FROM karty_parametry ORDER BY karta_id')).toEqual(przed);
  } finally {
    db.close();
  }
});

it('baza bez oznaczonych paczkomatów nie dostaje parametru', () => {
  const db = przed22();
  try {
    karta(db, 'LMP-1');
    karta(db, 'LMP-2');
    expect(migruj(db)).toContainEqual(22);
    expect(ile(db, 'SELECT COUNT(*) AS n FROM parametry_kart')).toBe(0);
    expect(ile(db, 'SELECT COUNT(*) AS n FROM karty_parametry')).toBe(0);
    migracjaParametrowKart.wykonaj(db);
    expect(ile(db, 'SELECT COUNT(*) AS n FROM parametry_kart')).toBe(0);
  } finally {
    db.close();
  }
});

it('świeża baza bez kart nie dostaje parametru', () => {
  const db = openOmsDb(':memory:');
  try {
    expect(tabela(db, 'parametry_kart')).toBe('parametry_kart');
    expect(ile(db, 'SELECT COUNT(*) AS n FROM parametry_kart')).toBe(0);
  } finally {
    db.close();
  }
});

it('usunięcie karty kasuje jej wartości parametrów', () => {
  const db = przed22();
  try {
    const id = karta(db, 'LMP-1', 'tak');
    karta(db, 'LMP-2', 'nie');
    migruj(db);
    expect(ile(db, 'SELECT COUNT(*) AS n FROM karty_parametry')).toBe(2);
    db.prepare('DELETE FROM karty_produktow WHERE id = ?').run(id);
    expect(ile(db, 'SELECT COUNT(*) AS n FROM karty_parametry')).toBe(1);
  } finally {
    db.close();
  }
});
