import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it.each(['tak', 'nie', '1', ' '])('demo odmawia startu z OMS_TWOJEFAKTURY=%j przed dostępem do bazy i sieci', (wartosc) => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../../deploy/demo/start.mjs', import.meta.url))], {
    encoding: 'utf8', env: { OMS_TRYB: 'proba', OMS_TWOJEFAKTURY: wartosc }, timeout: 10000,
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/Demo.*OMS_TWOJEFAKTURY/);
});
