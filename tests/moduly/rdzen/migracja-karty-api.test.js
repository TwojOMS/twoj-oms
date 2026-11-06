import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { migracjaKartApi } from '../../../src/moduly/rdzen/migracje/0011-karty-api.ts';

// PRZ-153.E5.1 — migracja rdzen/0011: pola karty dla API (cena, VAT, EAN, wycofanie) i tabela idempotencji.
// Wyłącznie dokładanie; stare karty dostają `wycofana = 0`, reszta ich danych zostaje bez zmian.

const KORZEN = fileURLToPath(new URL('../../../', import.meta.url));
const NOWE_KOLUMNY = ['cena_gr', 'stawka_vat', 'ean', 'wycofana'];
const katalogi = [];
afterEach(() => { for (const k of katalogi.splice(0)) rmSync(k, { recursive: true, force: true }); });

function nowyPlik() {
  const k = mkdtempSync(join(tmpdir(), 'oms-prz153-e51-'));
  katalogi.push(k);
  return join(k, 'oms.sqlite');
}

// Rdzeń w stanie sprzed tej zmiany: te same migracje, bez numeru 11.
const rdzenBez11 = { ...modulRdzen, migracje: modulRdzen.migracje.filter((m) => m.numer !== 11) };
const kolumny = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all();
const karty = (db) => db.prepare('SELECT * FROM karty_produktow ORDER BY id').all();

function staraBaza() {
  const plik = nowyPlik();
  const db = openOmsDb(plik, { moduly: [rdzenBez11] });
  expect(kolumny(db, 'karty_produktow').map((k) => k.name)).not.toContain('cena_gr');
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'api_idempotencja'").get()).toBeUndefined();
  const ins = db.prepare(`INSERT INTO karty_produktow (sku, nazwa, szerokosc_mm, wysokosc_mm, kategoria_glowna, opis,
    utworzony_at, zmieniony_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run('LAMPA-01', 'Lampa Półcień 🌙', 300, 450, 'oświetlenie', 'Opis z polskimi znakami: żółć', '2026-10-01T10:00:00.000Z', '2026-10-02T10:00:00.000Z');
  ins.run(null, 'Karta bez SKU', null, null, null, null, '2026-10-03T10:00:00.000Z', '2026-10-03T10:00:00.000Z');
  const przed = karty(db);
  db.close();
  return { plik, przed };
}

describe('migracja rdzen/0011 — pola karty i idempotencja API', () => {
  it('stara baza: kolumny dochodzą, stare karty mają wycofana = 0 i puste nowe pola, dotychczasowe dane bez zmian', () => {
    const { plik, przed } = staraBaza();
    const db = openOmsDb(plik);
    try {
      const k = Object.fromEntries(kolumny(db, 'karty_produktow').map((x) => [x.name, x]));
      expect(k.cena_gr).toMatchObject({ type: 'INTEGER', notnull: 0, dflt_value: null });
      expect(k.stawka_vat).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
      expect(k.ean).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
      expect(k.wycofana).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
      const po = karty(db);
      expect(po.map((w) => Object.fromEntries(Object.entries(w).filter(([n]) => !NOWE_KOLUMNY.includes(n))))).toEqual(przed);
      expect(po.map((w) => [w.cena_gr, w.stawka_vat, w.ean, w.wycofana])).toEqual([[null, null, null, 0], [null, null, null, 0]]);
      expect(db.prepare("SELECT numer FROM migracje WHERE modul = 'rdzen' AND numer = 11").get()).toEqual({ numer: 11 });
    } finally { db.close(); }
  });

  it('tabela api_idempotencja: kolumny jak w planie, klucz główny (klucz_id, klucz_zadania), bez indeksu', () => {
    const db = openOmsDb(':memory:');
    try {
      expect(kolumny(db, 'api_idempotencja').map((k) => [k.name, k.type, k.notnull, k.pk])).toEqual([
        ['klucz_id', 'INTEGER', 1, 1], ['klucz_zadania', 'TEXT', 1, 2], ['trasa', 'TEXT', 1, 0],
        ['status', 'INTEGER', 1, 0], ['cialo', 'TEXT', 1, 0], ['at', 'TEXT', 1, 0],
      ]);
      const indeksy = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'api_idempotencja' AND sql IS NOT NULL").all();
      expect(indeksy).toEqual([]);
      const ins = db.prepare('INSERT INTO api_idempotencja (klucz_id, klucz_zadania, trasa, status, cialo, at) VALUES (?, ?, ?, ?, ?, ?)');
      ins.run(1, 'k-1', 'POST /x', 201, '{}', '2026-11-06T10:00:00.000Z');
      ins.run(2, 'k-1', 'POST /x', 201, '{}', '2026-11-06T10:00:00.000Z');
      expect(() => ins.run(1, 'k-1', 'POST /y', 200, '{}', '2026-11-06T10:00:00.000Z')).toThrow(/UNIQUE|PRIMARY/);
    } finally { db.close(); }
  });

  it('ponowne wykonanie migracji niczego nie psuje ani nie zmienia', () => {
    const { plik } = staraBaza();
    const db = openOmsDb(plik);
    try {
      db.prepare('UPDATE karty_produktow SET cena_gr = 12999, ean = ?, wycofana = 1 WHERE id = 1').run('5901234123457');
      db.prepare("INSERT INTO api_idempotencja VALUES (1, 'k', 'POST /x', 201, '{}', '2026-11-06T10:00:00.000Z')").run();
      const przed = karty(db);
      migracjaKartApi.wykonaj(db);
      migracjaKartApi.wykonaj(db);
      expect(karty(db)).toEqual(przed);
      expect(db.prepare('SELECT COUNT(*) AS n FROM api_idempotencja').get().n).toBe(1);
    } finally { db.close(); }
  });

  it('strażnik migracji przepuszcza repozytorium (kod 0)', () => {
    const wyjscie = execFileSync(process.execPath, ['scripts/straznik-migracji.mjs'], { cwd: KORZEN, encoding: 'utf8' });
    expect(wyjscie).toBe('');
  });
});
