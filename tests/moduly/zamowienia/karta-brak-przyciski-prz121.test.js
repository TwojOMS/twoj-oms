// PRZ-121.07 — przy jawnym „Brak” karta zamówienia nie pokazuje „Pobierz PDF” ani „Drukuj” FAKTURY
// (trasy i tak odmawiają zdaniem). Numer faktury zostaje, przycisk PDF proformy zostaje (proformy „Brak” nie wyłącza).
// Bez wyboru (z kluczem i bez) — przyciski faktury są jak dziś.
// Pełna aplikacja (zbudujOms), prawdziwe trasy, zero sieci.
import { afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszWyborProgramu } from '../../../src/oms/db/wybor-programu.js';

const KLUCZ = 'zmyslony-klucz-karty-prz121-0000000007';
const katalogi = [];
const aplikacje = [];
afterAll(async () => {
  vi.unstubAllGlobals();
  for (const a of aplikacje.splice(0)) { await a.app.close(); a.db.close(); }
  for (const p of katalogi.splice(0)) rmSync(p, { recursive: true, force: true });
});

const headers = { authorization: 'Basic ' + Buffer.from('operator:fixture').toString('base64'), origin: 'http://localhost' };

const zamowienie = (nr) => ({ zrodlo_id: nr, numer: `PZ-${nr}`, klient: { first_name: 'Anna', last_name: 'Półcień', company: 'Pracownia Półcień',
  address_1: 'Lampowa 1', postcode: '00-950', city: 'Warszawa', email: 'biuro@polcien.invalid' },
dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: '5250000009',
kwota_brutto: '258.00', koszt_dostawy_brutto: '0.00', anulowane: 0, status_woo: 'processing', oplacone_at: null,
utworzone_at: '2026-10-01T10:00:00Z', sklep: 'reczne',
pozycje: [{ nazwa: 'Lampa wisząca Półcień', sku: 'LAMPA-W1', ilosc: 2, cena_brutto: '129.00', vat: null }] });

async function karta({ klucz = false, plik = null, zapis = null }) {
  const katalog = mkdtempSync(join(tmpdir(), 'karta-przyciski-prz121-')); katalogi.push(katalog);
  const sciezka = join(katalog, 'oms.db');
  const przed = openOmsDb(sciezka);
  if (zapis) zapiszWyborProgramu(przed, zapis);
  przed.close();
  const fetchPuste = vi.fn(async () => { throw new Error('Sieć zabroniona'); });
  vi.stubGlobal('fetch', fetchPuste);
  const env = { OMS_DB_PATH: sciezka, OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog,
    OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_USER: 'operator', OMS_PASS: 'fixture',
    ...(klucz ? { INFAKT_API_KEY: KLUCZ } : {}), ...(plik ? { OMS_PROGRAM_FAKTUROWY: plik } : {}) };
  const a = await zbudujOms({ env, teraz: () => new Date('2026-10-27T10:00:00Z') }); aplikacje.push(a);
  const id = zapiszZamowienie(a.db, 'reczne', zamowienie(5107), {});
  a.db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, program, dokument_id, numer, utworzona_at) VALUES (?,?,?,?,?,?)')
    .run(id, 'dok-przyciski-prz121', 'infakt', 'dok-przyciski-prz121', 'FV/9/10/2026', '2026-10-02T10:00:00Z');
  const proforma = a.db.prepare('INSERT INTO proformy (zamowienie_id, numer, rok, miesiac, kolejny, kwota_brutto, utworzona_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, 'PRO/3/10/2026', 2026, 10, 3, '258.00', '2026-10-01T11:00:00Z').lastInsertRowid;
  const r = await a.app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers });
  expect(r.statusCode).toBe(200);
  return { html: r.body, id, proforma, fetchPuste };
}

describe.each([
  ['plik', { klucz: true, plik: 'brak' }],
  ['ustawienia', { klucz: true, zapis: 'brak' }],
])('PRZ-121.07 jawny „brak” (%s): bez przycisków faktury', (_n, ustawienie) => {
  it('numer faktury widoczny, brak „Pobierz PDF” i „Drukuj” faktury, PDF proformy jest', async () => {
    const { html, id, proforma, fetchPuste } = await karta(ustawienie);
    expect(fetchPuste).not.toHaveBeenCalled();
    expect(html).toContain('FV/9/10/2026');
    expect(html).not.toContain(`href="/zamowienia/${id}/faktura/pdf"`);
    expect(html).not.toContain(`action="/zamowienia/${id}/faktura/drukuj"`);
    expect(html).toContain(`href="/proformy/${proforma}/pdf"`);
  });
});

describe.each([
  ['bez wyboru, z kluczem', { klucz: true }],
  ['bez wyboru i bez klucza', { klucz: false }],
])('PRZ-121.07 %s: przyciski faktury jak dziś', (_n, ustawienie) => {
  it('„Pobierz PDF” i „Drukuj” faktury są', async () => {
    const { html, id, proforma } = await karta(ustawienie);
    expect(html).toContain('FV/9/10/2026');
    expect(html).toContain(`href="/zamowienia/${id}/faktura/pdf"`);
    expect(html).toContain(`action="/zamowienia/${id}/faktura/drukuj"`);
    expect(html).toContain(`href="/proformy/${proforma}/pdf"`);
  });
});
