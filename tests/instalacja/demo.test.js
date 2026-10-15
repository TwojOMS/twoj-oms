import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { uruchomOms } from '../../src/main.ts';
import { odczytajEnv } from '../../scripts/instalacja-wspolne.mjs';
import { listaZamowien } from '../../src/oms/db/zamowienia.js';
import { wyliczStatus } from '../../src/domena/status.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(ROOT, 'scripts/instalacja-demo.mjs');
const directories = [], links = [];
function root() { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-demo-test-')); directories.push(p); return p; }
function cli(p, port) { return spawnSync(process.execPath, [script, '--katalog', p, '--port', String(port)], { cwd: ROOT, env: { ...process.env, INFAKT_API_KEY: 'foreign-demo-secret', OMS_DB_PATH: 'foreign.sqlite', OMS_KANALY: '[{"typ":"allegro"}]' }, encoding: 'utf8', timeout: 45000 }); }
afterEach(() => { for (const p of links.splice(0)) if (fs.existsSync(p)) fs.unlinkSync(p); for (const p of directories.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
function rows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { expect(db.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok'); return listaZamowien(db); }
  finally { db.close(); }
}
async function visible(env, admin) {
  const live = await uruchomOms({ ...env, OMS_PORT: '0' }, '127.0.0.1');
  try {
    const url = live.aplikacja.app.listeningOrigin;
    const login = await fetch(url + '/login', { method: 'POST', redirect: 'manual', headers: { origin: url, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ uzytkownik: 'administrator-proby', haslo: admin, powrot: '/' }) });
    expect(login.status).toBe(302); await login.arrayBuffer();
    const cookie = login.headers.get('set-cookie').match(/sesja_oms_proba=[^;]+/)[0];
    const list = await fetch(url + '/', { headers: { cookie } }); expect(list.status).toBe(200);
    const html = await list.text();
    for (const number of ['DEMO-001', 'DEMO-002', 'DEMO-003']) expect.soft(html).toContain(number);
    const counters = [...html.matchAll(/data-status="w_realizacji">(\d+)</g)].map(match => Number(match[1]));
    expect.soft(counters, 'licznik rzeczywistych zamówień w realizacji po zalogowaniu').toEqual([1]);
    const first = rows(env.OMS_DB_PATH)[0];
    expect.soft(first, 'pierwsze zamówienie demo dostępne po zalogowaniu').toBeDefined();
    if (first) {
      const detail = await fetch(url + '/zamowienia/' + first.id, { headers: { cookie } });
      expect(detail.status).toBe(200); expect(await detail.text()).toContain('DEMO-SKU-');
    }
  } finally { await live.zamknij(); }
}
describe('samodzielne syntetyczne demo instalacji', () => {
  it('odmawia istniejących danych przed utworzeniem konfiguracji i nie zmienia bajtów', () => {
    const p = root(); fs.writeFileSync(path.join(p, 'oms.sqlite'), 'foreign-db-bytes');
    const result = cli(p, 39381);
    expect(result.status).toBe(1); expect(result.stderr).toContain('INSTALACJA_ODMOWA_NADPISANIA');
    expect(fs.readFileSync(path.join(p, 'oms.sqlite'), 'utf8')).toBe('foreign-db-bytes');
    expect(fs.readdirSync(p)).toEqual(['oms.sqlite']);
  });
  it.each([false, true])('odmawia junction w celu albo przodku ścieżki (przodek=%s)', ancestor => {
    const p = root(), target = path.join(p, 'cudzy-pusty'), link = path.join(p, 'junction'); fs.mkdirSync(target);
    fs.symlinkSync(target, link, 'junction'); links.push(link);
    const result = cli(ancestor ? path.join(link, 'nowy') : link, 39382);
    expect(result.status).toBe(1); expect(result.stderr).toContain('INSTALACJA_DEMO_SCIEZKA_ODMOWA');
    expect(fs.readdirSync(target)).toEqual([]);
  });
  it('tworzy widoczne zamówienia, odrębną kopię demo i zachowuje je po restore z prawdziwym logowaniem', async () => {
    const p = path.join(root(), 'demo ze spacją'); const result = cli(p, 39383);
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('demo-zakonczone');
    expect(result.stdout + result.stderr).not.toContain('foreign-demo-secret');
    const env = odczytajEnv(path.join(p, 'proba.env'));
    expect(env.OMS_KANALY).toBe('[]'); expect(JSON.stringify(env)).not.toContain('foreign-demo-secret');
    const adminFile = fs.readFileSync(path.join(p, 'administrator-proby.env'), 'utf8');
    const admin = /haslo=(.+)/.exec(adminFile)[1];
    expect(result.stdout + result.stderr).not.toContain(admin); expect(result.stdout + result.stderr).not.toContain(env.OMS_PASS);
    const files = ['oms.sqlite', 'backup-demo.sqlite', 'odtworzenie-demo/oms.sqlite'];
    const snapshots = files.map(f => rows(path.join(p, f)));
    for (const snapshot of snapshots) {
      expect.soft(snapshot.map(r => r.numer).sort()).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
      expect.soft(new Set(snapshot.map(wyliczStatus)).size).toBeGreaterThanOrEqual(2);
      expect(snapshot.every(r => r.klient.email.endsWith('@email.invalid'))).toBe(true);
      expect(snapshot.flatMap(r => r.pozycje).every(r => r.sku.startsWith('DEMO-SKU-'))).toBe(true);
    }
    expect(snapshots[1]).toEqual(snapshots[0]); expect(snapshots[2]).toEqual(snapshots[0]);
    expect(rows(path.join(p, 'backup-proba.sqlite'))).toHaveLength(0);
    await visible(env, admin);
    await visible({ ...env, OMS_DB_PATH: path.join(p, 'odtworzenie-demo/oms.sqlite') }, admin);
    const before = fs.readFileSync(path.join(p, 'oms.sqlite'));
    const again = cli(p, 39383); expect(again.status).toBe(1); expect(again.stderr).toContain('INSTALACJA_ODMOWA_NADPISANIA');
    expect(fs.readFileSync(path.join(p, 'oms.sqlite'))).toEqual(before);
  }, 60000);
});
