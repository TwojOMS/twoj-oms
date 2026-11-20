// Gość demo otwiera Magazyn i widzi pierwsze karty z Allegro, a nie samo sklep i ERLI. Oferty Allegro
// muszą więc obejmować także karty katalogu (wypełniacze), które stoją na początku listy po nazwie.
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { kartyZKanalami, kanalyDostepnosciKart } from '../../src/oms/db/magazyn.js';
import { utworzBazeDemo } from '../../scripts/demo-dane.mjs';
import { ofertyAllegro, ofertaAllegroPelna, zdjeciaKarty } from '../../scripts/demo-dane-katalog.mjs';

let db, katalog;
afterEach(() => {
  db?.close();
  db = null;
  if (katalog) fs.rmSync(katalog, { recursive: true, force: true });
  katalog = null;
});

// Lustro Allegro powstaje przy synchronizacji, więc potrzebna jest baza z pełnego generatora.
async function bazaDemo() {
  katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-demo-allegro-gora-'));
  const baza = path.join(katalog, 'oms.sqlite');
  await utworzBazeDemo({ baza, dzis: '2026-11-11' });
  db = openOmsDb(baza);
  return db;
}

it('co najmniej 6 z pierwszych 20 kart listy Magazynu ma dostępne Allegro', async () => {
  const karty = kartyZKanalami(await bazaDemo(), { sort: 'nazwa', kier: 'asc', kolumny: 'lista' }).slice(0, 20);
  // Allegro liczy się tylko ze statusem ACTIVE, jak plakietka na liście.
  const wiersze = kanalyDostepnosciKart(
    db,
    karty.map((k) => k.id),
    { kanalyZeStatusem: ['allegro'] },
  );
  const zAllegro = karty.filter((k) => wiersze.some((w) => w.karta_id === k.id && w.kanal === 'allegro'));
  expect(zAllegro.length).toBeGreaterThanOrEqual(6);
});

it('numery dotychczasowych ofert Allegro się nie zmieniają, nowe dopisują się na końcu', () => {
  const oferty = ofertyAllegro('allegro');
  expect(oferty.slice(0, 25).every((o) => !o.external.id.startsWith('LMP-KAT-'))).toBe(true);
  expect(oferty[0].id).toBe('17001000001');
  expect(oferty.length).toBe(25 + 60);
});

it('pełna oferta i zdjęcia działają dla karty katalogu', () => {
  const nowa = ofertyAllegro('allegro').find((o) => o.external.id.startsWith('LMP-KAT-'));
  const pelna = ofertaAllegroPelna('allegro', nowa.id);
  expect(pelna.external.id).toBe(nowa.external.id);
  expect(pelna.images).toEqual(zdjeciaKarty(nowa.external.id));
  expect(pelna.images.length).toBeGreaterThan(0);
});
