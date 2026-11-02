import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { zapewnijOkres } from '../../../src/oms/db/okresy.js';
import { dodajWplateReczna, dodajWplateOkresu } from '../../../src/oms/db/platnosci.js';
import { wplatyPowiazane, dopiszWplatePowiazana } from '../../../src/moduly/faktury/db/wplaty-dokumentu.js';

let db;
let okres;
beforeEach(() => {
  db = openOmsDb(':memory:', { moduly: [modulRdzen] });
  for (const id of [1, 2]) {
    db.prepare(`INSERT INTO zamowienia (id, sklep, zrodlo_id, numer, kwota_brutto, utworzone_at)
      VALUES (?, 'test', ?, ?, '134.00', '2026-10-01')`).run(id, id, `TEST/${id}`);
    db.prepare(`INSERT INTO faktury (zamowienie_id, program, dokument_id, utworzona_at)
      VALUES (?, 'twojefaktury', ?, '2026-10-01')`).run(id, `tf-${id}`);
  }
  okres = zapewnijOkres(db, { klientKlucz: 'test', rok: 2026, miesiac: 10 });
  db.prepare("UPDATE okresy_rozliczeniowe SET program = 'twojefaktury', dokument_id = 'tf-okres' WHERE id = ?").run(okres.id);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

it('T1 — dostawca przelicza 134.00 na 13400 i zachowuje źródło wpłaty', () => {
  dodajWplateReczna(db, 1, { kwota: '134.00', data: '2026-10-29', metoda: 'karta', uwaga: 'test' });
  db.prepare("UPDATE platnosci SET zrodlo = 'sklep', utworzona_at = '2026-10-29T12:00:00.000Z'").run();
  expect(wplatyPowiazane(db).get('tf-1')).toEqual({ rodzaj: 'zamowienie', id: 1, blad: null,
    wplaty: [{ data: '2026-10-29', kwotaGr: 13400, zrodlo: 'sklep', metoda: 'karta', uwaga: 'test', utworzona_at: '2026-10-29T12:00:00.000Z' }] });
  expect(wplatyPowiazane(db).get('tf-2').wplaty).toEqual([]);
  expect(wplatyPowiazane(db).has('niepowiazana')).toBe(false);
});

it('T6 — dostawca okresu: dwie wpłaty 50.00 dają po 5000 groszy', () => {
  for (let i = 0; i < 2; i++) dodajWplateOkresu(db, okres.id, { kwota: '50.00', data: '2026-10-29' });
  db.prepare("UPDATE platnosci_okresu SET utworzona_at = '2026-10-29T12:00:00.000Z'").run();
  const wynik = wplatyPowiazane(db, ['tf-okres']).get('tf-okres');
  expect(wynik).toMatchObject({ rodzaj: 'okres', id: okres.id, blad: null });
  expect(wynik.wplaty.map(w => w.kwotaGr)).toEqual([5000, 5000]);
  expect(wynik.wplaty.map(w => w.utworzona_at)).toEqual(['2026-10-29T12:00:00.000Z', '2026-10-29T12:00:00.000Z']);
});

it('T7 — abc zatruwa tylko swój dokument, także po poprawnej wpłacie', () => {
  dodajWplateReczna(db, 1, { kwota: '1.00', data: '2026-10-01' });
  dodajWplateReczna(db, 1, { kwota: 'abc', data: '2026-10-02' });
  dodajWplateReczna(db, 1, { kwota: '5.00', data: '2026-10-03' });
  dodajWplateReczna(db, 2, { kwota: '134.00', data: '2026-10-01' });
  const mapa = wplatyPowiazane(db);
  expect(mapa.get('tf-1').blad).toEqual(expect.any(String));
  expect(mapa.get('tf-1').blad.length).toBeGreaterThan(0);
  expect(mapa.get('tf-1').wplaty).toEqual([]);
  expect(mapa.get('tf-2')).toMatchObject({ blad: null, wplaty: [{ kwotaGr: 13400 }] });
});

it('dwa zapytania dla wielu dokumentów, filtr id i porządek daty z rezerwą na czas zapisu oraz id', () => {
  for (const [kwota, data] of [['1.00', '2026-10-03'], ['2.00', '2026-10-01'], ['3.00', '2026-10-01'], ['4.00', null]]) {
    dodajWplateReczna(db, 1, { kwota, data });
    dodajWplateOkresu(db, okres.id, { kwota, data });
  }
  for (const tabela of ['platnosci', 'platnosci_okresu']) {
    db.prepare(`UPDATE ${tabela} SET utworzona_at = '2026-10-02' WHERE data IS NULL`).run();
  }
  const przygotuj = vi.spyOn(db, 'prepare');
  const mapa = wplatyPowiazane(db, ['tf-1', 'tf-okres']);
  expect(przygotuj).toHaveBeenCalledTimes(2);
  expect([...mapa.keys()].sort()).toEqual(['tf-1', 'tf-okres']);
  for (const wynik of mapa.values()) expect(wynik.wplaty.map(w => w.kwotaGr)).toEqual([200, 300, 400, 100]);
  expect(wplatyPowiazane(db, []).size).toBe(0);
});

it('dopisanie trafia do istniejących rejestrów zamówienia i okresu jako tekst złotych', () => {
  for (const dokumentId of ['tf-1', 'tf-okres']) {
    dopiszWplatePowiazana(db, dokumentId, { kwotaGr: 12345, data: '2026-10-29', uwaga: 'wpisana na fakturze TEST' });
  }
  for (const tabela of ['platnosci', 'platnosci_okresu']) {
    expect(db.prepare(`SELECT kwota, data, uwaga, zrodlo FROM ${tabela}`).get()).toEqual({
      kwota: '123.45', data: '2026-10-29', uwaga: 'wpisana na fakturze TEST', zrodlo: 'reczna',
    });
  }
  expect(() => dopiszWplatePowiazana(db, 'brak', { kwotaGr: 100, data: '2026-10-29' })).toThrow(/powiązan/);
});

// Recenzja P36a: luki obrony przed P36b.
it('wiersz inFaktu z tym samym dokument_id nie trafia do mapy', () => {
  db.prepare("UPDATE faktury SET program = 'infakt' WHERE zamowienie_id = 2").run();
  expect(wplatyPowiazane(db).has('tf-2')).toBe(false);
});

it('dokument przy dwóch zamówieniach albo przy zamówieniu i okresie: błąd, bez wpłat', () => {
  dodajWplateReczna(db, 1, { kwota: '134.00', data: '2026-10-01' });
  dodajWplateReczna(db, 2, { kwota: '134.00', data: '2026-10-01' });
  dodajWplateOkresu(db, okres.id, { kwota: '50.00', data: '2026-10-01' });
  db.prepare("UPDATE faktury SET dokument_id = 'tf-1' WHERE zamowienie_id = 2").run();
  db.prepare("UPDATE okresy_rozliczeniowe SET dokument_id = 'tf-1' WHERE id = ?").run(okres.id);
  expect(wplatyPowiazane(db).get('tf-1')).toMatchObject({ blad: expect.stringMatching(/więcej niż jednym/), wplaty: [] });
  db.prepare("UPDATE faktury SET dokument_id = 'tf-2' WHERE zamowienie_id = 2").run();
  expect(wplatyPowiazane(db).get('tf-1')).toMatchObject({ blad: expect.stringMatching(/więcej niż jednym/), wplaty: [] });
  expect(() => dopiszWplatePowiazana(db, 'tf-1', { kwotaGr: 100, data: '2026-10-29' })).toThrow(/więcej niż jednym/);
});

it.each([12.5, NaN, 0, -100, '100'])('dopisanie odmawia kwoty %s groszy bez zapisu', (kwotaGr) => {
  expect(() => dopiszWplatePowiazana(db, 'tf-1', { kwotaGr, data: '2026-10-29' })).toThrow(/groszy/);
  expect(db.prepare('SELECT COUNT(*) AS n FROM platnosci').get().n).toBe(0);
});
