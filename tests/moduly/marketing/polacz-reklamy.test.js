import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { polaczenia } from '../../../src/oms/db/reklamy.js';
import { createMagazynSekretow } from '../../../src/moduly/marketing/uslugi/reklamy-sekrety.js';
import { polaczReklamy } from '../../../scripts/oms-reklamy-polacz.mjs';

describe('podłączenie reklam z pliku poza repozytorium', () => {
  it('zapisuje sekret poza SQLite i wymienia go bez utraty ID', async () => {
    const katalog = await mkdtemp(join(tmpdir(), 'oms-polacz-reklamy-'));
    const db = openOmsDb(':memory:');
    const magazyn = createMagazynSekretow({ katalog: join(katalog, 'sekrety') });
    const sekretPlik = join(katalog, 'token.txt');
    try {
      await writeFile(sekretPlik, 'pierwszy-token');
      const dane = { db, magazyn, typ: 'meta', kontoId: 'act_123', kanal: 'sklep_a', sekretPlik };
      const pierwszy = await polaczReklamy(dane);
      await writeFile(sekretPlik, 'drugi-token');
      const drugi = await polaczReklamy(dane);
      expect(drugi).toEqual({ id: pierwszy.id, stan: 'zaktualizowano' });
      expect(polaczenia(db)).toHaveLength(1);
      expect(await magazyn.odczytaj(polaczenia(db)[0].sekretRef)).toBe('drugi-token');
      expect(JSON.stringify(polaczenia(db))).not.toContain('drugi-token');
    } finally {
      db.close();
      await rm(katalog, { recursive: true, force: true });
    }
  });
});
