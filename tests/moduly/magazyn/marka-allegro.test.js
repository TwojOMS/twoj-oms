// Import marki z parametru „Marka” oferty Allegro: tylko do pustego pola, nigdy przez ręczne.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzKarte, zapiszKarte, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { pobierzTrescOfertAllegro } from '../../../src/moduly/magazyn/services/allegro-tresc-kart.js';
import { markaZParametrow } from '../../../src/domena/slowniki-kart.js';
import {
  ofertyAllegro,
  ofertaAllegroPelna,
  kategoriaAllegroDemo,
  parametryKategoriiAllegroDemo,
} from '../../../scripts/demo-dane-katalog.mjs';

const KANAL = 'allegro';
const AT = '2026-11-13T08:00:00.000Z';
const OFERTY = ofertyAllegro(KANAL).slice(0, 3);
const bazy = [];
const katalogi = [];
afterEach(() => {
  for (const db of bazy.splice(0)) db.close();
  for (const k of katalogi.splice(0)) rmSync(k, { recursive: true, force: true });
});

function baza() {
  const db = openOmsDb(':memory:');
  bazy.push(db);
  const karty = OFERTY.map((o, i) => {
    const karta = utworzKarte(db, { nazwa: `Karta lampy ${i + 1}` }, { at: AT });
    const pid = zapiszProduktSklepowy(db, {
      kanal: KANAL,
      produkt_id: o.id,
      wariant_id: '',
      nazwa: o.name,
      odczytane_at: AT,
    });
    powiazProdukt(db, pid, karta);
    return karta;
  });
  return { db, karty };
}
const klient = () => ({
  pobierzOferte: vi.fn(async (id) => ({ ...ofertaAllegroPelna(KANAL, id), images: [] })),
  pobierzKategorie: vi.fn(async (id) => kategoriaAllegroDemo(id)),
  pobierzParametryKategorii: vi.fn(async (id) => parametryKategoriiAllegroDemo(id)),
});
function przebieg(db) {
  const katalog = mkdtempSync(join(tmpdir(), 'oms-p3b01-'));
  katalogi.push(katalog);
  return pobierzTrescOfertAllegro({
    db,
    allegro: { [KANAL]: klient() },
    kanalyAllegro: [KANAL],
    katalog,
    teraz: () => new Date(AT),
    pobierzZdjecie: vi.fn(async () => {
      throw new Error('bez zdjęć');
    }),
  });
}
const marka = (db, id) => db.prepare('SELECT marka FROM karty_produktow WHERE id = ?').get(id).marka;
const zrodlo = (db, id) =>
  db.prepare("SELECT zrodlo, reczne FROM karty_zrodla_pol WHERE karta_id = ? AND pole = 'marka'").get(id);

it('markaZParametrow bierze pierwszą wartość parametru „Marka” (bez względu na wielkość liter)', () => {
  expect(
    markaZParametrow({
      produkt: [
        { nazwa: 'Kod producenta', wartosci: ['X'] },
        { nazwa: ' marka ', wartosci: ['  Cienie ', 'Inna'] },
      ],
      oferta: [],
    }),
  ).toBe('Cienie');
  expect(markaZParametrow({ produkt: [], oferta: [{ nazwa: 'Marka', wartosci: ['Półcień'] }] })).toBe('Półcień');
  expect(markaZParametrow({ produkt: [{ nazwa: 'Marka', wartosci: ['   '] }] })).toBe(null);
  expect(markaZParametrow(null)).toBe(null);
});

it('pusta marka dostaje wartość z Allegro i trafia do słownika; ręcznej ani wpisanej nie nadpisuje', async () => {
  const { db, karty } = baza();
  zapiszKarte(db, karty[1], { marka: 'Ręczna marka' }, { at: AT });
  db.prepare('UPDATE karty_produktow SET marka = ? WHERE id = ?').run('Zastana marka', karty[2]);
  await przebieg(db);
  expect(marka(db, karty[0])).toBe('Pracownia Półcień');
  expect(zrodlo(db, karty[0])).toEqual({ zrodlo: `allegro:${KANAL}`, reczne: 0 });
  expect(marka(db, karty[1])).toBe('Ręczna marka');
  expect(zrodlo(db, karty[1])).toEqual({ zrodlo: 'reczne', reczne: 1 });
  expect(marka(db, karty[2])).toBe('Zastana marka');
  expect(
    db
      .prepare('SELECT nazwa FROM marki')
      .all()
      .map((r) => r.nazwa),
  ).toEqual(['Pracownia Półcień']);
});

it('ręczne źródło z pustą wartością też chroni pole', async () => {
  const { db, karty } = baza();
  zapiszKarte(db, karty[0], { marka: 'Chwilowa' }, { at: AT });
  db.prepare('UPDATE karty_produktow SET marka = NULL WHERE id = ?').run(karty[0]);
  await przebieg(db);
  expect(marka(db, karty[0])).toBe(null);
});
