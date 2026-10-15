// PRZ-062: zależności npm w obrazie klienta mają wychodzić z cache budowania przy każdym wydaniu z tym samym
// package-lock. Zmierzone na VM 10.10: `ARG APP_REVISION` przed `RUN npm ci` unieważniał cache (inny commit =
// inna wartość ARG = cache miss) — każde wydanie pobierało pakiety z internetu, a pierwsza próba deploy na bazie
// pracy padła na `npm ci` ETIMEDOUT po 127 s. ARG i etykieta wersji muszą stać PO instalacji zależności.
import { it, expect } from 'vitest';
import fs from 'node:fs';

it('ARG APP_REVISION i etykieta revision dopiero po RUN npm ci (cache zależności przeżywa nowe wydanie)', () => {
  const linie = fs.readFileSync(new URL('../../deploy/klient/Dockerfile', import.meta.url), 'utf8').split(/\r?\n/);
  const npm = linie.findIndex(l => l.startsWith('RUN npm ci'));
  const arg = linie.findIndex(l => l.startsWith('ARG APP_REVISION'));
  const label = linie.findIndex(l => l.startsWith('LABEL org.opencontainers.image.revision=$APP_REVISION'));
  expect(npm).toBeGreaterThan(0);
  expect({ argPoNpm: arg > npm, labelPoArg: label > arg }).toEqual({ argPoNpm: true, labelPoArg: true });
});
