// Test 11: każda ścieżka startu w procesie BEZ sejfu domyślnego — brak klucza = odmowa, klucz w env = działa.
// Sejf domyślny testów nie może ukryć brakującego przypięcia w kodzie programu.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ustawSejfDomyslny, maPrzypietySejf, sejfBazy } from '../../../src/core/bezpieczenstwo/sejf-sekretow.js';
import { BladKonfiguracji } from '../../../src/core/blad-konfiguracji.ts';
import { otworzBazeStartu, openOmsDb } from '../../../src/oms/db/db.ts';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zbudujAplikacje } from '../../../src/core/aplikacja.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { uruchomOms } from '../../../src/main.ts';
import { przywrocSejfDomyslny } from '../../pomoc/sejf-testowy.ts';

const K1 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
let kat;
beforeEach(() => {
  ustawSejfDomyslny(null);
  kat = fs.mkdtempSync(path.join(os.tmpdir(), 'prz182-start-'));
});
afterEach(() => {
  przywrocSejfDomyslny();
  fs.rmSync(kat, { recursive: true, force: true });
});

describe('ścieżki startu bez sejfu domyślnego', () => {
  it('otworzBazeStartu: brak klucza = BladKonfiguracji i pliku bazy nie ma; z kluczem przypięty sejf', () => {
    const plik = path.join(kat, 'oms.sqlite');
    expect(() => otworzBazeStartu({}, plik)).toThrow(BladKonfiguracji);
    expect(fs.existsSync(plik)).toBe(false);
    const db = otworzBazeStartu({ OMS_KLUCZ_SEKRETOW: K1 }, plik);
    expect(maPrzypietySejf(db)).toBe(true);
    db.close();
  });

  it('openOmsDb bez opcji sejf nie przypina — warstwa odmawia BRAK_KLUCZA', () => {
    const db = openOmsDb(':memory:');
    expect(() => sejfBazy(db)).toThrow(expect.objectContaining({ kod: 'BRAK_KLUCZA' }));
    db.close();
  });

  it('zbudujAplikacje na nieprzypiętym uchwycie: bez klucza w env odmowa, z kluczem przypina i działa', async () => {
    const env = { OMS_TRYB: 'proba' };
    const db = openOmsDb(':memory:');
    await expect(zbudujAplikacje({ moduly: [modulRdzen], env, db, log: () => {} })).rejects.toBeInstanceOf(
      BladKonfiguracji,
    );
    const a = await zbudujAplikacje({
      moduly: [modulRdzen],
      env: { ...env, OMS_KLUCZ_SEKRETOW: K1 },
      db,
      log: () => {},
    });
    expect(maPrzypietySejf(db)).toBe(true);
    await a.app.close();
    db.close();
  });

  it('zbudujOms: bez klucza odmowa przed otwarciem bazy, z kluczem działa', async () => {
    const plik = path.join(kat, 'b.sqlite');
    const env = { OMS_TRYB: 'proba', OMS_DB_PATH: plik, OMS_KANALY: '[]' };
    await expect(zbudujOms({ env, moduly: [modulRdzen] })).rejects.toBeInstanceOf(BladKonfiguracji);
    expect(fs.existsSync(plik)).toBe(false);
    const a = await zbudujOms({ env: { ...env, OMS_KLUCZ_SEKRETOW: K1 }, moduly: [modulRdzen] });
    expect(maPrzypietySejf(a.db)).toBe(true);
    await a.app.close();
    a.db.close();
  });

  it('uruchomOms (src/main.ts): bez klucza BladKonfiguracji i pliku bazy nie ma', async () => {
    const plik = path.join(kat, 'c.sqlite');
    await expect(uruchomOms({ OMS_TRYB: 'proba', OMS_DB_PATH: plik }, '127.0.0.1')).rejects.toBeInstanceOf(
      BladKonfiguracji,
    );
    expect(fs.existsSync(plik)).toBe(false);
  });
});
