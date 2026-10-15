// PRZ-051 — warstwa odczytu listy: granica zmiennych SQLite, N+1, kolejność, chudy odczyt.
import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { listaZamowien, pobierzZamowienie, zamowieniaPoId } from '../../src/oms/db/zamowienia.js';
import { zwrotyDlaZamowien } from '../../src/oms/db/zwroty.js';
import { wstawGole, wstawMieszane } from './pomoc.js';

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

// Licznik kompilacji SQL na czas jednego wywołania — N+1 widać jako liczbę `prepare`
// rosnącą razem z liczbą zamówień.
function policzPrepare(fn) {
  const oryginal = db.prepare;
  const sql = [];
  db.prepare = function (tekst) { sql.push(tekst); return oryginal.call(this, tekst); };
  try { return { wynik: fn(), sql }; } finally { db.prepare = oryginal; }
}

describe('PRZ-051 odczyt listy', () => {
  it('listaZamowien przy 32 767 + 1 zamówieniach nie wpada w limit zmiennych SQLite', () => {
    wstawGole(db, 32768);
    const lista = listaZamowien(db);
    expect(lista).toHaveLength(32768);
    expect(lista[0].pozycje).toEqual([]);
    expect(lista[0].przesylki).toEqual([]);
  }, 60000);

  it('liczba zapytań nie rośnie z liczbą zamówień (bez N+1): stała liczba na porcję 500', () => {
    const ids = wstawMieszane(db, { powtorzen: 60 }).map((w) => w.id);
    expect(ids.length).toBeGreaterThan(1000);
    const zapytan = (n) => policzPrepare(() => zamowieniaPoId(db, ids.slice(0, n))).sql.length;
    // 6 zapytań na porcję (zamówienia, pozycje, wpłaty, przesyłki, faktura, zwroty), niezależnie
    // od tego, ile w porcji zamówień i ile każde ma dzieci.
    for (const n of [1, 40, 499, 500, 501, 1000, ids.length]) expect(zapytan(n), String(n)).toBe(6 * Math.ceil(n / 500));
  });

  it('równe daty: kolejność stabilna, nowszy identyfikator pierwszy', () => {
    const ids = wstawGole(db, 5);
    expect(listaZamowien(db).map((z) => z.id)).toEqual([...ids].reverse());
  });

  it('każdy wiersz listy = odczyt karty (te same fakty, po nadpisaniach), zwroty jako nagłówki', () => {
    const wstawione = wstawMieszane(db, { powtorzen: 2 });
    const lista = new Map(listaZamowien(db).map((z) => [z.id, z]));
    const zwroty = zwrotyDlaZamowien(db, wstawione.map((w) => w.id));
    for (const { id } of wstawione) {
      const { zwroty: _k, ...karta } = pobierzZamowienie(db, id);
      const { zwroty: zl, ...wiersz } = lista.get(id);
      expect(wiersz).toEqual(karta);
      expect(zl).toEqual(zwroty.get(id) ?? []);
    }
  });

  it('zamowieniaPoId: tylko wskazane, w kolejności listy, także ponad limit zmiennych', () => {
    const ids = wstawGole(db, 32800, { utworzone: (i) => `2026-10-01T10:${String(i % 60).padStart(2, '0')}:00` });
    // ids[5] → minuta 6, ids[32799] → minuta 20 (32800 % 60), ids[0] → minuta 1: porządek listy
    // to najpierw późniejsza minuta.
    const wynik = zamowieniaPoId(db, [ids[5], ids[32799], ids[0], 999999]);
    expect(wynik.map((z) => z.id)).toEqual([ids[32799], ids[5], ids[0]]);
    expect(zamowieniaPoId(db, ids).length).toBe(32800);
  }, 60000);

  it('chudy odczyt listy nie czyta surowe_json, pełny czyta', () => {
    const [id] = wstawGole(db, 1);
    db.prepare("UPDATE zamowienia SET surowe_json = '{\"x\":1}' WHERE id = ?").run(id);
    const chudy = policzPrepare(() => zamowieniaPoId(db, [id], { bezSurowych: true }));
    expect(chudy.wynik[0]).not.toHaveProperty('surowe_json');
    expect(chudy.sql.join('\n')).not.toMatch(/SELECT \*\s+FROM zamowienia/i);
    expect(zamowieniaPoId(db, [id])[0].surowe_json).toBe('{"x":1}');
  });
});
