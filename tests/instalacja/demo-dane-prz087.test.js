// PRZ-087 — zamówienia „w toku” w demo według listy właściciela (16.10). Liczymy tym samym indeksem, z którego boczne menu
// i lista biorą liczniki (src/oms/db/indeks-listy.js), na prawdziwym zegarze — tak, jak zobaczy to gość.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { utworzBazeDemo, ENV_DEMO } from '../../scripts/demo-dane.mjs';
import { indeksListy } from '../../src/oms/db/indeks-listy.js';
import { przewoznikPrzesylki } from '../../src/domena/przewoznik-przesylki.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const DZIS = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
const dzienPl = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
const WCZORAJ = dzienPl(Date.parse(`${DZIS}T12:00:00Z`) - 86400000);

let katalog, db, liczniki;
const wStatusie = (status) => db.prepare(`SELECT z.id, z.utworzone_at, z.metoda_wysylki, z.metoda_wysylki_nazwa, z.metoda_platnosci, z.sklep,
    l.po_terminie_od FROM lista_stan l JOIN zamowienia z ON z.id = l.zamowienie_id WHERE l.status = ?`).all(status);
const przewoznik = (z) => przewoznikPrzesylki({ nazwaUslugi: z.metoda_wysylki_nazwa, metoda: z.metoda_wysylki })?.klucz
  ?? (z.metoda_wysylki === 'odbior_osobisty' ? 'odbior' : null);

beforeAll(async () => {
  katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-demo-prz087-'));
  const env = { ...ENV_DEMO, OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog };
  await utworzBazeDemo({ baza: path.join(katalog, 'oms.sqlite'), dzis: DZIS, env });
  db = new DatabaseSync(path.join(katalog, 'oms.sqlite'));
  const teraz = Date.now();
  const indeks = indeksListy(db);
  await indeks.odswiez(teraz);
  liczniki = indeks.liczniki(teraz);
}, 180_000);
afterAll(() => { db?.close(); fs.rmSync(katalog, { recursive: true, force: true }); });

describe('demo PRZ-087: NOWE', () => {
  it('dokładnie 12, wszystkie z dziś', () => {
    const nowe = wStatusie('nowe');
    expect(liczniki.statusy.nowe).toBe(12);
    expect(nowe.map((z) => dzienPl(z.utworzone_at)).filter((d) => d !== DZIS)).toEqual([]);
  });

  it('dostawa: DPD, Paczkomat, Allegro One, DHL i odbiór osobisty', () => {
    const przewoznicy = new Set(wStatusie('nowe').map(przewoznik));
    for (const p of ['dpd', 'inpost', 'allegro-one', 'dhl', 'odbior']) expect(przewoznicy, p).toContain(p);
  });
});

describe('demo PRZ-087: INDYWIDUALNE', () => {
  it('są, a każda pozycja niesie w nazwie personalizację', () => {
    const ids = wStatusie('indywidualne').map((z) => z.id);
    expect(ids.length).toBeGreaterThanOrEqual(5);
    const nazwy = db.prepare(`SELECT nazwa FROM pozycje WHERE zamowienie_id IN (${ids.join(',')})`).all().map((p) => p.nazwa);
    expect(nazwy.filter((n) => !/GRAWER|NADRUK|KOLOR NA ZAMÓWIENIE/.test(n))).toEqual([]);
    expect(nazwy.some((n) => n.includes('GRAWER'))).toBe(true);
  });
});

describe('demo PRZ-087: W REALIZACJI', () => {
  it('co najmniej 20, większość z wczoraj', () => {
    const lista = wStatusie('w_realizacji');
    expect(lista.length).toBeGreaterThanOrEqual(20);
    const zWczoraj = lista.filter((z) => dzienPl(z.utworzone_at) === WCZORAJ).length;
    expect(zWczoraj).toBeGreaterThan(lista.length / 2);
  });

  it('dokładnie dwa po terminie wysyłki — i w całym demo nie ma innych', () => {
    const teraz = Date.now();
    const po = wStatusie('w_realizacji').filter((z) => z.po_terminie_od != null && z.po_terminie_od <= teraz);
    expect(po.length).toBe(2);
    expect(liczniki.po_terminie).toBe(2);
  });

  it('różne metody dostawy i płatności', () => {
    const lista = wStatusie('w_realizacji');
    expect(new Set(lista.map(przewoznik)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(lista.map((z) => z.metoda_platnosci)).size).toBeGreaterThanOrEqual(5);
  });
});

describe('demo PRZ-087: ciągłość sprzedaży', () => {
  it('każdy z ostatnich 7 dni ma zamówienia', () => {
    const dni = new Set(db.prepare('SELECT utworzone_at FROM zamowienia').all().map((z) => dzienPl(z.utworzone_at)));
    for (let d = 0; d < 7; d++) {
      const dzien = dzienPl(Date.parse(`${DZIS}T12:00:00Z`) - d * 86400000);
      expect(dni, dzien).toContain(dzien);
    }
  });
});
