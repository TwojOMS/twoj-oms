import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { startVitest } from 'vitest/node';

const [root, base, report, mode] = process.argv.slice(2);
const keys = ['TMPDIR', 'TEMP', 'TMP'];
const env = () => Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]));
const before = env();
const original = fs.mkdtempSync;
const originalRemove = fs.rmSync;
const created = [];
const cleanupBlocked = [];
fs.mkdtempSync = function (...args) {
  const path = original.apply(this, args);
  created.push(path);
  return path;
};
if (mode === 'cleanup-error') {
  fs.rmSync = function (path, ...args) {
    const target = resolve(String(path));
    if (created.includes(target) && dirname(target) === resolve(base)
      && basename(target).startsWith('twoj-oms-vitest-')) {
      cleanupBlocked.push(target);
      throw Object.assign(new Error('OMS_TEMP_PROBE_EBUSY: trwała odmowa cleanup własnego runu'), { code: 'EBUSY' });
    }
    return originalRemove.call(this, path, ...args);
  };
}
syncBuiltinESMExports();
try {
  await startVitest('test', [], {
    root, config: join(root, 'vitest.config.ts'), run: true, watch: false,
    include: ['tests/pomoc/temp-worker.fixture.ts'],
    ...(mode === 'baza' ? { testNamePattern: 'strażnik migracji addytywnych|sonda katalogu workera' } : {}),
    // Bez override pool: sonda używa tej samej domyślnej puli co bramka repo.
    maxWorkers: 1, fileParallelism: false,
  });
} finally {
  fs.mkdtempSync = original;
  fs.rmSync = originalRemove;
  syncBuiltinESMExports();
  fs.writeFileSync(report, JSON.stringify({
    pid: process.pid, before, after: env(), created, cleanupBlocked,
    remaining: fs.readdirSync(base).filter(name => name.startsWith('twoj-oms-vitest-')),
    // Nie ujawniamy nazw cudzych plików; raport zawiera wyłącznie własne katalogi.
    straznik: created.filter(path => basename(path).startsWith('straznik-')),
  }));
}
