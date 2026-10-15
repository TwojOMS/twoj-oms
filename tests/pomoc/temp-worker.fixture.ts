import { it, expect, afterAll } from 'vitest';
import fs, { mkdtempSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];
const original = fs.mkdtempSync;
fs.mkdtempSync = ((...args: Parameters<typeof original>) => {
  const path = original(...args);
  created.push(String(path));
  return path;
}) as typeof original;
syncBuiltinESMExports();
let katalog: string;
if (process.env.OMS_TEMP_PROBE_MODE === 'baza') await import('../core/baza.test.ts');

afterAll(() => {
  fs.mkdtempSync = original;
  syncBuiltinESMExports();
  writeFileSync(process.env.OMS_TEMP_WORKER_REPORT!, JSON.stringify({
    tmpdir: tmpdir(), katalog, created,
    env: Object.fromEntries(['TMPDIR', 'TEMP', 'TMP'].map(key => [key, process.env[key]])),
  }));
});

// Celowo zostawiony katalog: odpowiada historycznym testom bez własnego teardown.
it('sonda katalogu workera', () => {
  katalog = mkdtempSync(join(tmpdir(), 'oms-temp-worker-'));
  writeFileSync(join(katalog, 'dowod.txt'), 'worker');
  expect(katalog).toContain('oms-temp-worker-');
});
