import { describe, it, expect } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runner = fileURLToPath(new URL('../pomoc/temp-process-probe.mjs', import.meta.url));
const keys = ['TMPDIR', 'TEMP', 'TMP'];
const ownRuns = (base: string) => readdirSync(base).filter(name => name.startsWith('twoj-oms-vitest-'));

function removeOwn(path: string, base: string, prefix: string) {
  const target = resolve(path);
  const parent = realpathSync(base);
  if (dirname(target).toLowerCase() !== parent.toLowerCase() || !basename(target).startsWith(prefix)) {
    throw Error('Odmowa cleanup poza własnym katalogiem sondy');
  }
  if (!existsSync(target)) return;
  if (lstatSync(target).isSymbolicLink() || realpathSync(target).toLowerCase() !== target.toLowerCase()) {
    throw Error('Odmowa cleanup dowiązania');
  }
  rmSync(target, { recursive: true, force: true });
}

function probe(mode: 'worker' | 'baza' | 'cleanup-error', check: (data: any, worker: any, base: string) => void) {
  const parent = realpathSync(tmpdir());
  const control = mkdtempSync(join(parent, 'twoj-oms-temp-probe-'));
  const base = join(control, 'system-temp');
  mkdirSync(base);
  const report = join(control, 'process.json');
  const workerReport = join(control, 'worker.json');
  const repoBase = join(root, 'dane-lokalne');
  const repoBefore = existsSync(repoBase) ? new Set(readdirSync(repoBase)) : new Set<string>();
  const childEnv: NodeJS.ProcessEnv = { ...process.env, TMPDIR: base, TEMP: base, TMP: base, OMS_TEMP_WORKER_REPORT: workerReport, OMS_TEMP_PROBE_MODE: mode };
  if (mode === 'baza') {
    // Wabik: druga zmienna wskazuje inny katalog. os.tmpdir() bez TMPDIR czyta na Windows TEMP przed TMP,
    // a na Linuksie TMP przed TEMP (dokumentacja Node) — wabik idzie zawsze do tej, która przegrywa.
    // Na sztywno TMP=wabik dawało na CI ubuntu katalog przebiegu pod wabikiem (16.10.2026).
    const [wygrywa, przegrywa] = process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMP', 'TEMP'];
    delete childEnv.TMPDIR;
    childEnv[wygrywa] = base;
    childEnv[przegrywa] = join(control, 'previous-tmp');
    mkdirSync(childEnv[przegrywa]!);
  }
  try {
    if (mode === 'baza') {
      const wybrany = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").tmpdir())'], { encoding: 'utf8', env: childEnv });
      expect(wybrany.stdout, 'założenie sondy: os.tmpdir() procesu potomnego to katalog systemowy, nie wabik').toBe(base);
    }
    const before = ownRuns(base).length;
    const child = spawnSync(process.execPath, [runner, root, base, report, mode], {
      cwd: root, encoding: 'utf8', timeout: 60_000,
      env: childEnv,
    });
    expect(child.error, child.stdout + child.stderr).toBeUndefined();
    expect(child.status, child.stdout + child.stderr).toBe(mode === 'cleanup-error' ? 1 : 0);
    if (mode === 'cleanup-error') {
      expect(child.stderr).toContain('OMS_TEMP_PROBE_EBUSY');
      expect(child.stderr).toContain('EBUSY');
    }
    expect(existsSync(report), child.stdout + child.stderr).toBe(true);
    const data = JSON.parse(readFileSync(report, 'utf8'));
    const worker = existsSync(workerReport) ? JSON.parse(readFileSync(workerReport, 'utf8')) : null;
    expect(data.after).toEqual(data.before);
    expect(ownRuns(base).length - before, 'liczba własnych katalogów po teardown').toBe(mode === 'cleanup-error' ? 1 : 0);
    check(data, worker, base);
  } finally {
    // RED starego helpera także nie zostawia nowych fixture w repozytorium.
    // Nigdy nie sprzątamy katalogów istniejących przed tą pojedynczą sondą.
    if (existsSync(workerReport) && existsSync(repoBase)) {
      const ownCreated: string[] = JSON.parse(readFileSync(workerReport, 'utf8')).created;
      for (const path of ownCreated) {
        const name = basename(path);
        if (dirname(resolve(path)).toLowerCase() === resolve(repoBase).toLowerCase() && !repoBefore.has(name) && name.startsWith('straznik-')) {
          removeOwn(path, repoBase, 'straznik-');
        }
      }
    }
    removeOwn(control, parent, 'twoj-oms-temp-probe-');
  }
}

describe('TEMP pojedynczego przebiegu Vitest', () => {
  it('worker dziedziczy własny katalog, a close usuwa go i przywraca środowisko', () => {
    probe('worker', (_data, worker, base) => {
      expect(worker).not.toBeNull();
      expect(dirname(resolve(worker.tmpdir))).toBe(resolve(base));
      expect(basename(worker.tmpdir)).toMatch(/^twoj-oms-vitest-/);
      for (const key of keys) expect(worker.env[key]).toBe(worker.tmpdir);
      expect(dirname(worker.katalog)).toBe(worker.tmpdir);
      expect(existsSync(worker.tmpdir)).toBe(false);
    });
  }, 70_000);

  it('rzeczywisty strażnik bazy zapisuje fixture pod TEMP przebiegu zamiast w repo', () => {
    probe('baza', (data, worker, base) => {
      const paths: string[] = worker.created.filter((path: string) => basename(path).startsWith('straznik-'));
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(dirname(path), 'fixture strażnika musi powstać pod TEMP przebiegu').toBe(worker.tmpdir);
        expect(existsSync(path)).toBe(false);
      }
      expect(dirname(worker.tmpdir)).toBe(base);
      expect(data.remaining).toEqual([]);
      expect(ownRuns(base)).toEqual([]);
    });
  }, 70_000);

  it('trwały błąd cleanup kończy proces błędem, pokazuje EBUSY i przywraca env', () => {
    probe('cleanup-error', (data, worker, base) => {
      expect(data.cleanupBlocked.length).toBeGreaterThan(0);
      expect(new Set(data.cleanupBlocked)).toEqual(new Set([worker.tmpdir]));
      expect(dirname(worker.tmpdir)).toBe(base);
      expect(existsSync(worker.tmpdir)).toBe(true);
      const owner = JSON.parse(readFileSync(join(worker.tmpdir, '.twoj-oms-temp-owner.json'), 'utf8'));
      expect(owner.pid).toBe(data.pid);
      expect(resolve(owner.runDirectory)).toBe(resolve(worker.tmpdir));
      for (const key of keys) expect(worker.env[key]).toBe(worker.tmpdir);
      // probe() porównuje env po close z env przed startem; finally usuwa
      // tylko cały własny control, również gdy oczekiwany teardown zawiódł.
    });
  }, 70_000);
});
