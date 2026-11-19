import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import { migracjaCenStatusowKanalow } from '../../../src/moduly/magazyn/migracje/0005-ceny-statusy-kanalow.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { ofertaPoId, zmienOferte } from '../../../src/oms/db/oferty-kanalow.ts';

// Magazyn 0005: flagi „cena z OMS” i „status z OMS” w rejestrze ofert oraz dziennik zmian w kanałach.
// Wyłącznie dokładanie; domyślne 0 = żadna istniejąca oferta nie dostaje ceny ani statusu z OMS.
// Dane zmyślone: „Pracownia Półcień”, konto `polcien`, lampy LMP-*.

type W = Record<string, unknown>;
type Moduly = ReturnType<typeof modulyDla>;
const T0 = '2026-11-18T10:00:00.000Z';
const TERAZ = () => new Date(T0);

const katalogi: string[] = [];
const bazy: DatabaseSync[] = [];
afterEach(() => {
  for (const db of bazy.splice(0)) if (db.isOpen) db.close();
  for (const k of katalogi.splice(0)) rmSync(k, { recursive: true, force: true });
});

function nowyPlik() {
  const k = mkdtempSync(join(tmpdir(), 'oms-ceny-statusy-'));
  katalogi.push(k);
  return join(k, 'oms.sqlite');
}
const bez5 = (moduly: Moduly): Moduly =>
  moduly.map((m) => (m.nazwa === 'magazyn' ? { ...m, migracje: m.migracje.filter((x) => x.numer !== 5) } : m));
const wiersz = (db: DatabaseSync, sql: string, ...a: SQLInputValue[]) => db.prepare(sql).get(...a) as W;
const wiersze = (db: DatabaseSync, sql: string, ...a: SQLInputValue[]) =>
  (db.prepare(sql).all(...a) as W[]).map((w) => ({ ...w }));
const kolumna = (db: DatabaseSync, t: string, k: string) =>
  wiersze(db, `PRAGMA table_info(${t})`).find((x) => x.name === k);

function staraBazaZOfertami(plik: string) {
  const db = openOmsDb(plik, { moduly: bez5(modulyDla(ENV_DEMO)), teraz: TERAZ });
  const karta = db.prepare(
    'INSERT INTO karty_produktow (id, sku, nazwa, utworzony_at, zmieniony_at) VALUES (?, ?, ?, ?, ?)',
  );
  karta.run(601, 'LMP-601', 'Lampa Półcień 40', T0, T0);
  karta.run(602, 'LMP-602', 'Lampa Półcień 60', T0, T0);
  const oferta = db.prepare(`INSERT INTO oferty_kanalow (karta_id, kanal, id_zewnetrzne, pochodzenie, tryb, stan,
    ilosc_z_oms, utworzono_at, zmieniono_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  oferta.run(601, 'allegro_polcien', '7700000001', 'przejeta', 'obserwowana', 'aktywna', 1, T0, T0);
  oferta.run(602, 'allegro_polcien', '7700000002', 'oms', 'zarzadzana', 'aktywna', 0, T0, T0);
  db.close();
}

describe('migracja magazyn/0005 — ceny i statusy z OMS, dziennik zmian w kanałach', () => {
  it('moduł magazynu niesie migrację numer 5', () => {
    expect(modulMagazyn.migracje).toContain(migracjaCenStatusowKanalow);
    expect(migracjaCenStatusowKanalow.numer).toBe(5);
  });

  it('stara baza z ofertami: nowe kolumny z domyślnym 0, wiersze bez zmian, dziennik i indeks, wpis migracji', () => {
    const plik = nowyPlik();
    staraBazaZOfertami(plik);
    let db = openOmsDb(plik, { moduly: bez5(modulyDla(ENV_DEMO)), teraz: TERAZ });
    expect(kolumna(db, 'oferty_kanalow', 'cena_z_oms')).toBeUndefined();
    expect(wiersz(db, "SELECT name FROM sqlite_master WHERE name = 'zmiany_w_kanalach'")).toBeUndefined();
    const przed = wiersze(db, 'SELECT * FROM oferty_kanalow ORDER BY id');
    db.close();

    db = openOmsDb(plik, { moduly: modulyDla(ENV_DEMO), teraz: TERAZ });
    bazy.push(db);
    for (const k of ['cena_z_oms', 'status_z_oms']) {
      expect(kolumna(db, 'oferty_kanalow', k)).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
    }
    const po = wiersze(db, 'SELECT * FROM oferty_kanalow ORDER BY id');
    expect(po.map(({ cena_z_oms: _c, status_z_oms: _s, ...reszta }) => reszta)).toEqual(przed);
    expect(po.map((w) => [w.cena_z_oms, w.status_z_oms])).toEqual([
      [0, 0],
      [0, 0],
    ]);
    for (const w of po) {
      expect(ofertaPoId(db, Number(w.id))).toMatchObject({ cenaZOms: false, statusZOms: false });
    }
    expect(ofertaPoId(db, Number(po[0].id))?.iloscZOms).toBe(true);

    expect(wiersze(db, 'PRAGMA table_info(zmiany_w_kanalach)').map((k) => k.name)).toEqual([
      'id',
      'kanal',
      'karta_id',
      'cel',
      'pole',
      'stara',
      'nowa',
      'kto',
      'at',
      'wynik',
      'blad',
    ]);
    expect(wiersz(db, 'SELECT count(*) AS n FROM zmiany_w_kanalach').n).toBe(0);
    expect(wiersze(db, 'PRAGMA index_info(zmiany_w_kanalach_karta)').map((k) => k.name)).toEqual(['karta_id', 'at']);
    // Wpis przeżywa usunięcie karty — dziennik nie ma klucza obcego.
    expect(wiersze(db, 'PRAGMA foreign_key_list(zmiany_w_kanalach)')).toEqual([]);
    expect(wiersze(db, "SELECT numer FROM migracje WHERE modul = 'magazyn' AND numer = 5")).toEqual([{ numer: 5 }]);
  });

  it('migracja dwa razy na bazie, która już ją ma = bez błędu i bez utraty danych', () => {
    const plik = nowyPlik();
    staraBazaZOfertami(plik);
    let db = openOmsDb(plik, { moduly: modulyDla(ENV_DEMO), teraz: TERAZ });
    db.prepare(
      `INSERT INTO zmiany_w_kanalach (kanal, karta_id, cel, pole, stara, nowa, kto, at, wynik)
       VALUES ('polcien', 601, 'produkt:123', 'cena', '10000', '11000', 'administrator', ?, 'ok')`,
    ).run(T0);
    db.prepare('UPDATE oferty_kanalow SET cena_z_oms = 1 WHERE karta_id = 601').run();
    migracjaCenStatusowKanalow.wykonaj(db);
    migracjaCenStatusowKanalow.wykonaj(db);
    db.close();
    db = openOmsDb(plik, { moduly: modulyDla(ENV_DEMO), teraz: TERAZ });
    bazy.push(db);
    expect(wiersz(db, 'SELECT count(*) AS n FROM zmiany_w_kanalach').n).toBe(1);
    expect(wiersze(db, 'SELECT karta_id, cena_z_oms, status_z_oms FROM oferty_kanalow ORDER BY id')).toEqual([
      { karta_id: 601, cena_z_oms: 1, status_z_oms: 0 },
      { karta_id: 602, cena_z_oms: 0, status_z_oms: 0 },
    ]);
  });

  it('dziennik odmawia nieznanego pola i wyniku, wpis bez karty i z usuniętą kartą przechodzi', () => {
    const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO), teraz: TERAZ });
    bazy.push(db);
    const wpis = (pole: string, wynik: string, kartaId: number | null = 601) =>
      db
        .prepare(
          `INSERT INTO zmiany_w_kanalach (kanal, karta_id, cel, pole, stara, nowa, kto, at, wynik)
           VALUES ('polcien', ?, 'produkt:123', ?, 'publish', 'draft', 'administrator', ?, ?)`,
        )
        .run(kartaId, pole, T0, wynik);
    expect(() => wpis('tresc', 'ok')).toThrow(/CHECK/);
    expect(() => wpis('cena', 'zrobione')).toThrow(/CHECK/);
    for (const pole of ['cena', 'status', 'steruj_cena']) wpis(pole, 'ok', 999999);
    for (const wynik of ['blad', 'w_toku']) wpis('status', wynik, null);
    expect(wiersz(db, 'SELECT count(*) AS n FROM zmiany_w_kanalach').n).toBe(5);
  });

  it('rejestr ofert: cenaZOms i statusZOms zapisują się jak iloscZOms, tylko jako true/false', () => {
    const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO), teraz: TERAZ });
    bazy.push(db);
    db.prepare('INSERT INTO karty_produktow (id, sku, nazwa, utworzony_at, zmieniony_at) VALUES (?, ?, ?, ?, ?)').run(
      701,
      'LMP-701',
      'Lampa Półcień 40',
      T0,
      T0,
    );
    const id = Number(
      db
        .prepare(
          `INSERT INTO oferty_kanalow (karta_id, kanal, id_zewnetrzne, pochodzenie, tryb, stan, utworzono_at,
           zmieniono_at) VALUES (701, 'allegro_polcien', '7700000701', 'przejeta', 'obserwowana', 'aktywna', ?, ?)`,
        )
        .run(T0, T0).lastInsertRowid,
    );
    expect(zmienOferte(db, id, { cenaZOms: true })).toMatchObject({ cenaZOms: true, statusZOms: false });
    expect(zmienOferte(db, id, { statusZOms: true })).toMatchObject({ cenaZOms: true, statusZOms: true });
    expect(wiersz(db, 'SELECT cena_z_oms, status_z_oms FROM oferty_kanalow WHERE id = ?', id)).toEqual({
      cena_z_oms: 1,
      status_z_oms: 1,
    });
    expect(zmienOferte(db, id, { cenaZOms: false })).toMatchObject({ cenaZOms: false, statusZOms: true });
    expect(() => zmienOferte(db, id, { cenaZOms: 1 })).toThrow(/cenaZOms/);
    expect(() => zmienOferte(db, id, { statusZOms: 'tak' })).toThrow(/statusZOms/);
    expect(wiersz(db, 'SELECT cena_z_oms, status_z_oms FROM oferty_kanalow WHERE id = ?', id)).toEqual({
      cena_z_oms: 0,
      status_z_oms: 1,
    });
  });
});
