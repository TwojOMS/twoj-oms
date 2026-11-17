// PRZ-182 (plan 4 p. 11): ścieżki startu piaskownicy i demo w procesie potomnym — bez sejfu domyślnego testów.
// Brak albo zła postać klucza = odmowa, zanim powstanie albo zostanie ruszona baza (także przy zleconym resecie);
// klucz niezgodny z bazą = odmowa przed migracjami; poprawnie złożona ścieżka z kluczem — panel wstaje.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ENV_DEMO, utworzBazeDemo } from '../../scripts/demo-dane.mjs';
import { formatBazy } from '../../src/core/bezpieczenstwo/konwersja-sekretow.js';
import { nowyKlucz } from '../../src/core/bezpieczenstwo/sejf-sekretow.js';
import { znacznikResetuProby } from '../../src/oms/db/reset-demo.js';
import { KLUCZ_TESTOWY } from '../pomoc/sejf-testowy.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROBA = path.join(ROOT, 'deploy/proba/start.mjs');
const DEMO = path.join(ROOT, 'deploy/demo/start.mjs');
const katalogi = [];
afterEach(() => { for (const k of katalogi.splice(0)) fs.rmSync(k, { recursive: true, force: true }); });
const katalog = () => { const k = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-start-klucz-')); katalogi.push(k); return k; };
// Środowisko potomka bez niczego z OMS_/DEMO_ procesu testów (także bez klucza).
const czysteEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OMS_|DEMO_)/.test(k)));
const envProby = (k, dodatkowe = {}) => ({ ...czysteEnv(), TZ: 'UTC', OMS_TRYB: 'proba', OMS_DB_PATH: path.join(k, 'oms.sqlite'),
  OMS_PORT: '0', OMS_PROFORMY_KATALOG: path.join(k, 'proformy'), OMS_ETYKIETY_KATALOG: path.join(k, 'etykiety'),
  OMS_USER: 'serwis-proby', OMS_PASS: 'haslo-serwisowe-testu', ...dodatkowe });
const uruchomSync = (skrypt, env) => spawnSync(process.execPath, [skrypt], { encoding: 'utf8', timeout: 60_000, env });

/** Start w tle do linii `czekaj` albo wyjścia procesu; potem SIGTERM. */
function uruchomDoLinii(skrypt, env, czekaj) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [skrypt], { env });
    let out = ''; let err = '';
    const koniec = (wynik) => { clearTimeout(zegar); resolve({ ...wynik, out, err }); };
    const zegar = setTimeout(() => { p.kill('SIGKILL'); koniec({ status: 'limit' }); }, 90_000);
    p.stdout.on('data', (d) => {
      out += d;
      if (out.includes(czekaj)) { p.once('exit', () => koniec({ status: 'nasluch' })); p.kill('SIGTERM'); }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (kod) => { if (!out.includes(czekaj)) koniec({ status: kod }); });
  });
}
const sekrety = (plik) => {
  const db = new DatabaseSync(plik, { readOnly: true });
  try {
    return { konf: db.prepare('SELECT integracja, sekrety_json FROM konfiguracja_integracji ORDER BY integracja').all().map(w => ({ ...w })),
      migracje: db.prepare('SELECT COUNT(*) AS n FROM migracje').get().n, format: formatBazy(db) };
  } finally { db.close(); }
};

describe('PRZ-182 deploy/proba/start.mjs — klucz poświadczeń', () => {
  it.each([['brak klucza', undefined, /Brak klucza poświadczeń OMS_KLUCZ_SEKRETOW/],
    ['pusty klucz', '', /Brak klucza poświadczeń OMS_KLUCZ_SEKRETOW/],
    ['zła postać', 'za-krotki', /OMS_KLUCZ_SEKRETOW: zła postać klucza/]])('%s = odmowa, baza nie powstaje', (_opis, klucz, komunikat) => {
    const k = katalog();
    const r = uruchomSync(PROBA, envProby(k, klucz === undefined ? {} : { OMS_KLUCZ_SEKRETOW: klucz }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(komunikat);
    if (klucz) expect(r.stderr).not.toContain(klucz);
    expect(fs.readdirSync(k)).toEqual([]);
  });

  it('brak klucza przy zleconym resecie: baza i znacznik resetu zostają bajt w bajt', async () => {
    const k = katalog();
    const env = { ...ENV_DEMO, OMS_KLUCZ_SEKRETOW: KLUCZ_TESTOWY };
    const plik = path.join(k, 'oms.sqlite');
    await utworzBazeDemo({ baza: plik, dzis: '2026-11-17', env });
    fs.writeFileSync(znacznikResetuProby(plik), 'x');
    const przed = fs.readFileSync(plik);
    const r = uruchomSync(PROBA, envProby(k));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/OMS_KLUCZ_SEKRETOW/);
    expect(fs.readFileSync(plik).equals(przed)).toBe(true);
    expect(fs.existsSync(znacznikResetuProby(plik))).toBe(true);
  }, 60_000);

  it('baza zaszyfrowana innym kluczem: odmowa przed migracjami; z właściwym kluczem panel wstaje i stawia znacznik', async () => {
    const k = katalog();
    const plik = path.join(k, 'oms.sqlite');
    await utworzBazeDemo({ baza: plik, dzis: '2026-11-17', env: { ...ENV_DEMO, OMS_KLUCZ_SEKRETOW: KLUCZ_TESTOWY } });
    const przed = sekrety(plik);
    expect(przed.format).toBeNull();

    const zly = uruchomSync(PROBA, envProby(k, { OMS_KLUCZ_SEKRETOW: nowyKlucz() }));
    expect(zly.status).not.toBe(0);
    expect(zly.stderr).toMatch(/zaszyfrowana kluczem o id [0-9a-f]{8}/);
    expect(sekrety(plik)).toEqual(przed);

    // Moduł TwojeFaktury jawnie wyłączony: start piaskownicy włącza go domyślnie, a kopia publiczna go nie ma —
    // test dotyczy klucza, nie modułu, i ma przechodzić w obu.
    const dobry = await uruchomDoLinii(PROBA, envProby(k, { OMS_KLUCZ_SEKRETOW: KLUCZ_TESTOWY, OMS_TWOJEFAKTURY: '' }), 'OMS piaskownicy na');
    expect(dobry.status, `${dobry.out}\n${dobry.err}`).toBe('nasluch');
    const po = sekrety(plik);
    expect(po.format).toBe(1);
    expect(po.konf).toEqual(przed.konf);
  }, 180_000);
});

describe('PRZ-182 deploy/demo/start.mjs — klucz poświadczeń', () => {
  it.each([['brak klucza', {}], ['zła postać', { OMS_KLUCZ_SEKRETOW: 'x'.repeat(43) }]])('%s = odmowa przed sondą i bazą', (_opis, dodatkowe) => {
    const k = katalog();
    const r = uruchomSync(DEMO, envProby(k, { OMS_DEMO_LOGIN: 'demo', OMS_DEMO_HASLO: 'demo', DEMO_SONDA_CELE: 'tcp://192.0.2.1:9', ...dodatkowe }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/OMS_KLUCZ_SEKRETOW/);
    expect(r.stdout).not.toContain('izolacja sprawdzona');
    expect(fs.readdirSync(k)).toEqual([]);
  });
});
