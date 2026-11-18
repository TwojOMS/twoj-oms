// Reset demo pokazuje zatwierdzone stany kanałów: otwarcia, jedno zatwierdzenie, flagi ilości z OMS
// i po jednym problemie ilości (`skok`, `rozjazd-dol`). Drugi reset daje to samo.
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { utworzBazeDemo } from '../../scripts/demo-dane.mjs';
import { PROBLEMY_ILOSCI, skrotZatwierdzenia } from '../../src/domena/ilosc-kanalu.js';
import { migawkaStanow } from '../../src/oms/db/stany-magazynowe.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const katalogi = [];
afterAll(() => {
  for (const p of katalogi.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

async function reset() {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-demo-stany-'));
  katalogi.push(k);
  const baza = path.join(k, 'oms.sqlite');
  await utworzBazeDemo({ baza, dzis: '2026-10-14' });
  const db = new DatabaseSync(baza);
  try {
    const przelaczenie = db
      .prepare('SELECT id FROM magazyn_przelaczenia WHERE wlaczone = 1 ORDER BY id DESC LIMIT 1')
      .get();
    const migawka = migawkaStanow(db);
    return {
      przelaczenieId: Number(przelaczenie.id),
      zatwierdzenia: db.prepare('SELECT * FROM stany_zatwierdzenia').all(),
      otwarcia: db
        .prepare('SELECT karta_id, granica, ilosc FROM stany_otwarcia ORDER BY karta_id')
        .all()
        .map((w) => ({ ...w })),
      flagi: db.prepare('SELECT COUNT(*) n FROM oferty_kanalow WHERE ilosc_z_oms = 1').get().n,
      problemy: db
        .prepare('SELECT ilosc_problem_json j FROM oferty_kanalow WHERE ilosc_problem_json IS NOT NULL ORDER BY id')
        .all()
        .map((w) => JSON.parse(w.j)),
      granica: migawka.granica,
      oferty: db.prepare('SELECT * FROM oferty_kanalow ORDER BY id').all(),
      migawka,
      maxRuchId: db.prepare('SELECT MAX(id) m FROM ruchy_magazynowe').get().m,
      bufory: db.prepare('SELECT * FROM oferty_ustawienia_kont').all(),
    };
  } finally {
    db.close();
  }
}

describe('demo — stany kanałów', () => {
  it('reset: jedno zatwierdzenie ostatniego włączenia, 6 flag, 2 problemy, otwarcia na granicy', async () => {
    const d = await reset();
    expect(d.zatwierdzenia).toHaveLength(1);
    const [z] = d.zatwierdzenia;
    expect(Number(z.przelaczenie_id)).toBe(d.przelaczenieId);
    expect(Number(z.ofert)).toBe(6);
    expect(d.flagi).toBe(6);
    expect(d.otwarcia.length).toBeGreaterThan(10);
    expect(d.otwarcia.every((o) => o.granica === d.granica)).toBe(true);
    expect(d.problemy.map((p) => p.kod).sort()).toEqual(['rozjazd-dol', 'skok']);
    for (const p of d.problemy) {
      expect(p.wstrzymuje).toBe(PROBLEMY_ILOSCI[p.kod].wstrzymuje);
      expect(p.tekst).toBe(PROBLEMY_ILOSCI[p.kod].tekst);
    }
    // Skrót odpowiada bieżącemu stanowi rejestru: zatwierdzenie nie jest „nieaktualne” zaraz po resecie.
    expect(z.skrot).toBe(
      skrotZatwierdzenia({ oferty: d.oferty, migawka: d.migawka, maxRuchId: d.maxRuchId, bufory: d.bufory }),
    );
    expect(d.migawka.zatwierdzenie?.przelaczenieId).toBe(d.przelaczenieId);
  }, 120000);

  it('drugi reset daje dokładnie to samo', async () => {
    const a = await reset();
    const b = await reset();
    expect(b.zatwierdzenia).toHaveLength(1);
    expect(b.flagi).toBe(a.flagi);
    expect(b.problemy).toEqual(a.problemy);
    expect(b.otwarcia).toEqual(a.otwarcia);
    expect(b.zatwierdzenia[0].skrot).toBe(a.zatwierdzenia[0].skrot);
  }, 240000);
});
