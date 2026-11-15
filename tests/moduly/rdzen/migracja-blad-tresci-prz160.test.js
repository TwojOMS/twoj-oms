import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';

// PRZ-160.06b — migracja rdzen/0013: trwały wpis błędu pobrania treści oferty (`tresc_blad`, `tresc_blad_at`).
// Wyłącznie dokładanie: dwie kolumny NULL w `produkty_sklepowe`, dane bez zmian.

const NOWE_KOLUMNY = ['tresc_blad', 'tresc_blad_at'];
const katalogi = [];
afterEach(() => { for (const k of katalogi.splice(0)) rmSync(k, { recursive: true, force: true }); });

function nowyPlik() {
  const k = mkdtempSync(join(tmpdir(), 'oms-prz160-06b-'));
  katalogi.push(k);
  return join(k, 'oms.sqlite');
}

const rdzenDo12 = { ...modulRdzen, migracje: modulRdzen.migracje.filter((m) => m.numer <= 12) };
const rdzenDo13 = { ...modulRdzen, migracje: modulRdzen.migracje.filter((m) => m.numer <= 13) };
const kolumny = (db) => db.prepare('PRAGMA table_info(produkty_sklepowe)').all();
const lustro = (db) => db.prepare('SELECT * FROM produkty_sklepowe ORDER BY id').all();
const bezNowych = (w) => Object.fromEntries(Object.entries(w).filter(([k]) => !NOWE_KOLUMNY.includes(k)));

function staraBaza() {
  const plik = nowyPlik();
  const db = openOmsDb(plik, { moduly: [rdzenDo12] });
  expect(kolumny(db).map((k) => k.name)).not.toContain('tresc_blad');
  const ins = db.prepare(`INSERT INTO produkty_sklepowe (kanal, produkt_id, wariant_id, nazwa, status_publikacji, odczytane_at,
    tresc_pobrana_at, tresc_zmieniona_at) VALUES (?, ?, '', ?, ?, ?, ?, ?)`);
  ins.run('allegro', '17000000001', 'Lampa Półcień 🌙', 'ACTIVE', '2026-11-01T10:00:00.000Z', '2026-11-02T10:00:00.000Z', '2026-10-30T10:00:00.000Z');
  ins.run('allegro', '17000000002', 'Kinkiet Półcień', 'ENDED', '2026-11-01T10:00:00.000Z', null, null);
  const przed = lustro(db);
  db.close();
  return { plik, przed };
}

describe('migracja rdzen/0013 — błąd pobrania treści oferty', () => {
  it('stara baza po 0012: kolumny dochodzą puste, dotychczasowe dane bez zmian', () => {
    const { plik, przed } = staraBaza();
    const db = openOmsDb(plik, { moduly: [rdzenDo13] });
    try {
      const k = Object.fromEntries(kolumny(db).map((x) => [x.name, x]));
      for (const n of NOWE_KOLUMNY) expect(k[n]).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 });
      const po = lustro(db);
      expect(po.map(bezNowych)).toEqual(przed);
      expect(po.map((w) => [w.tresc_blad, w.tresc_blad_at])).toEqual([[null, null], [null, null]]);
      expect(db.prepare("SELECT numer FROM migracje WHERE modul = 'rdzen' AND numer = 13").get()).toEqual({ numer: 13 });
    } finally { db.close(); }
  });

  it('ponowne wykonanie migracji niczego nie zmienia', () => {
    const { plik } = staraBaza();
    const db = openOmsDb(plik, { moduly: [rdzenDo13] });
    try {
      db.prepare("UPDATE produkty_sklepowe SET tresc_blad = 'Zdjęcia pominięte: 1 z 3', tresc_blad_at = '2026-11-13T08:00:00.000Z' WHERE id = 1").run();
      const przed = [lustro(db), kolumny(db)];
      const mig = modulRdzen.migracje.find((m) => m.numer === 13);
      mig.wykonaj(db);
      mig.wykonaj(db);
      expect([lustro(db), kolumny(db)]).toEqual(przed);
    } finally { db.close(); }
  });
});
