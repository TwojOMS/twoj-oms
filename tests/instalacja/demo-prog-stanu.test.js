import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { utworzBazeDemo } from '../../scripts/demo-dane.mjs';
import { czyPonizejProgu } from '../../src/domena/niski-stan.js';
import { stanyKart } from '../../src/oms/db/stany-magazynowe.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

async function progiZResetu(katalog) {
  const baza = path.join(katalog, 'oms.sqlite');
  await utworzBazeDemo({ baza, dzis: '2026-10-14' });
  const db = new DatabaseSync(baza);
  try {
    const { stany, wlaczone } = stanyKart(db);
    expect(wlaczone).toBe(true);
    const otwarcia = new Set(
      db
        .prepare('SELECT karta_id FROM stany_otwarcia')
        .all()
        .map((w) => w.karta_id),
    );
    return db
      .prepare(
        'SELECT id, prog_niskiego_stanu AS prog FROM karty_produktow WHERE prog_niskiego_stanu IS NOT NULL ORDER BY id',
      )
      .all()
      .map(({ id, prog }) => ({ id, prog, stan: stany.get(id)?.stan ?? 0, maOtwarcie: otwarcia.has(id) }));
  } finally {
    db.close();
  }
}

it('reset demo odtwarza sześć progów i pokazuje niski stan na kilku kartach z otwarciem', async () => {
  const katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-demo-progi-'));
  try {
    const karty = await progiZResetu(path.join(katalog, 'pierwsza'));
    expect(karty).toHaveLength(6);
    expect(karty.every(({ stan, maOtwarcie }) => stan >= 0 && maOtwarcie)).toBe(true);
    const niskie = karty.filter(({ stan, prog }) => czyPonizejProgu(stan, prog));
    expect(niskie.length).toBeGreaterThanOrEqual(2);
    expect(niskie.length).toBeLessThanOrEqual(3);
    expect(await progiZResetu(path.join(katalog, 'druga'))).toEqual(karty);
  } finally {
    fs.rmSync(katalog, { recursive: true, force: true });
  }
}, 240000);
