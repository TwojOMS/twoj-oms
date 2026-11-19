// Demo pokazuje cenniki dostaw OMS: listę po rozmiarze, domyślną i jedną „tylko na karcie” wybraną na dwóch
// kartach, każdą powiązaną z cennikiem atrapy Allegro i ERLI.
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { utworzBazeDemo } from '../../scripts/demo-dane.mjs';
import { cennikiOms } from '../../src/oms/db/cenniki-oms.ts';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const katalogi = [];
afterAll(() => {
  for (const p of katalogi.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

describe('demo: cenniki dostaw OMS', () => {
  it('trzy listy z powiązaniami Allegro i ERLI, lista „tylko na karcie” na dwóch kartach', async () => {
    const k = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-demo-cenniki-'));
    katalogi.push(k);
    const baza = path.join(k, 'oms.sqlite');
    await utworzBazeDemo({ baza, dzis: '2026-10-14' });
    const db = new DatabaseSync(baza);
    try {
      const listy = cennikiOms(db).map((c) => ({
        nazwa: c.nazwa,
        rodzaj: c.rodzaj,
        doG: c.doG,
        kart: c.kart,
        powiazania: c.powiazania.map((p) => [p.konto, p.cennikKanalu]).sort(),
      }));
      const powiazania = [
        ['allegro', 'atrapa-cennik-standard'],
        ['erli_polcien', 'Dostawy Półcień'],
      ];
      expect(listy).toEqual([
        { nazwa: 'Mała paczka', rodzaj: 'rozmiar', doG: 5000, kart: 0, powiazania },
        { nazwa: 'Domyślny', rodzaj: 'domyslny', doG: null, kart: 0, powiazania },
        { nazwa: 'Gabaryt', rodzaj: 'karta', doG: null, kart: 2, powiazania },
      ]);
      const karty = db
        .prepare(
          `SELECT k.sku FROM karty_cennik_oms o JOIN karty_produktow k ON k.id = o.karta_id
          JOIN cenniki_dostaw_oms c ON c.id = o.cennik_id WHERE c.nazwa = 'Gabaryt' ORDER BY k.sku`,
        )
        .all()
        .map((w) => w.sku);
      expect(karty).toEqual(['LMP-POD-001', 'LMP-POD-002']);
    } finally {
      db.close();
    }
  }, 120000);
});
