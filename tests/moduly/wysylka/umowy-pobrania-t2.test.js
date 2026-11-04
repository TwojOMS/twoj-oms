// PRZ-135.T2.01 — odczyt i zapis ustawienia „umowa na pobranie” (tabela `ustawienia`, bez migracji).
import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { umowyPobraniaFirmy, zapiszUmowePobrania } from '../../../src/moduly/wysylka/db/umowy-pobrania.js';

const wiersz = (db, k = 'inpost') => db.prepare('SELECT * FROM ustawienia WHERE klucz = ?').get(`wysylka.umowa_pobrania.${k}`);
const wstaw = (db, k, w) => db.prepare('INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)')
  .run(`wysylka.umowa_pobrania.${k}`, w, '2026-11-03T10:00:00.000Z');

function zBaza(fn) {
  const db = openOmsDb(':memory:');
  try { fn(db); } finally { db.close(); }
}

describe('umowyPobraniaFirmy — odczyt', () => {
  it('brak wiersza = wyłączone', () => zBaza((db) => {
    expect(wiersz(db)).toBeUndefined();
    expect(umowyPobraniaFirmy(db)).toEqual([]);
  }));

  it('„nie” = wyłączone, „tak” = [inpost]; zapis to upsert, odczyt bez pamięci podręcznej', () => zBaza((db) => {
    zapiszUmowePobrania(db, 'inpost', false);
    expect(wiersz(db).wartosc).toBe('nie');
    expect(umowyPobraniaFirmy(db)).toEqual([]);
    zapiszUmowePobrania(db, 'inpost', true);
    expect(wiersz(db).wartosc).toBe('tak');
    expect(wiersz(db).zmienione_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(umowyPobraniaFirmy(db)).toEqual(['inpost']);
    zapiszUmowePobrania(db, 'inpost', false);
    expect(umowyPobraniaFirmy(db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ustawienia WHERE klucz LIKE 'wysylka.umowa_pobrania.%'").get().n).toBe(1);
  }));

  it('zapis włącza tylko przy true — napisy z formularza („tak”, „nie”, „0”, „on”) nie włączają', () => zBaza((db) => {
    for (const w of ['tak', 'nie', '0', 'false', 'off', 'on', 1]) {
      zapiszUmowePobrania(db, 'inpost', w);
      expect(wiersz(db).wartosc).toBe('nie');
      expect(umowyPobraniaFirmy(db)).toEqual([]);
    }
  }));

  it('tylko dosłowne „tak” włącza', () => zBaza((db) => {
    for (const w of ['TAK', '1', 'true', ' tak', '']) {
      db.prepare('DELETE FROM ustawienia').run();
      wstaw(db, 'inpost', w);
      expect(umowyPobraniaFirmy(db)).toEqual([]);
    }
  }));

  it('wpis „tak” dla kuriera z „umowa” albo „brak” wpisany z ręki nie awansuje nikogo', () => zBaza((db) => {
    for (const k of ['dpd', 'allegro', 'allegro_wza', 'nieznany']) wstaw(db, k, 'tak');
    expect(umowyPobraniaFirmy(db)).toEqual([]);
    wstaw(db, 'inpost', 'tak');
    expect(umowyPobraniaFirmy(db)).toEqual(['inpost']);
  }));

  it('brak bazy albo błąd odczytu = []', () => {
    expect(umowyPobraniaFirmy(undefined)).toEqual([]);
    expect(umowyPobraniaFirmy(null)).toEqual([]);
    expect(umowyPobraniaFirmy({ prepare() { throw new Error('baza zamknięta'); } })).toEqual([]);
  });
});

describe('zapiszUmowePobrania — tylko kurier z „adapter”', () => {
  it.each(['dpd', 'allegro', 'allegro_wza', 'nieznany', '', '__proto__'])('klucz „%s” odrzucony, nic nie zapisane', (k) => zBaza((db) => {
    expect(() => zapiszUmowePobrania(db, k, true)).toThrow(/umow/i);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ustawienia WHERE klucz LIKE 'wysylka.umowa_pobrania.%'").get().n).toBe(0);
  }));
});
