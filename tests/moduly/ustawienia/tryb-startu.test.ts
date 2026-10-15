import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function start(tryb: string | undefined) {
  const katalog = mkdtempSync(join(tmpdir(), 'oms030-tryb-'));
  // Proces produktu nie dziedziczy żadnych kluczy ani konfiguracji instalacji.
  const env = {
    ...(tryb === undefined ? {} : { OMS_TRYB: tryb }), OMS_PORT: '0', OMS_DB_PATH: join(katalog, 'oms.sqlite'),
    OMS_USER: 'operator', OMS_PASS: 'atrapa', OMS_SPRZEDAWCA_NIP: '1234563218',
    OMS_RACHUNEK: '34109010140000000000000000', OMS_KANALY: '[]',
    OMS_ETYKIETY_KATALOG: katalog, OMS_PROFORMY_KATALOG: katalog,
  };
  const preload = new URL('../../pomoc/blokada-sieci-entrypoint.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', preload, 'src/oms.js'], { cwd: process.cwd(), env, stdio: ['ignore','pipe','pipe'] });
  let out = '', errors = '';
  child.stdout.on('data', b => { out += b; });
  child.stderr.on('data', b => { errors += b; });
  const exit = once(child, 'exit');
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`Brak startu produktu: ${errors}`)), 15000);
      child.stdout.on('data', () => { if (out.includes('OMS na :')) { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { clearTimeout(timer); reject(Error(`Produkt zakończył start kodem ${code}: ${errors}`)); });
    });
    // Osobne zapisy stdout mogą zostać odebrane w dwóch porcjach.
    await new Promise(resolve => setTimeout(resolve, 100));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exit;
  }
  expect(errors).not.toContain('ZABRONIONE WYJŚCIE DO SIECI');
  return out;
}

describe('D02: jawny efektywny tryb w logu rzeczywistego produktu', () => {
  it.each([[undefined, 'produkcja'], ['produkcja', 'produkcja'], ['proba', 'proba']] as const)(
    'OMS_TRYB=%s zapisuje dokładnie jedną linię %s', async (wejscie, oczekiwany) => {
      const output = await start(wejscie);
      expect(output.split(/\r?\n/).filter(l => l.startsWith('OMS tryb:'))).toEqual([`OMS tryb: ${oczekiwany}`]);
    }, 20000,
  );
});
