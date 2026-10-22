import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const katalog = mkdtempSync(join(process.cwd(), '.tmp-start-'));
afterAll(() => rmSync(katalog, { recursive: true, force: true }));

function start(zmiany: Record<string, string> = {}, kod?: string) {
  // Wyłącznie systemowe env i fikcyjna konfiguracja; bez .env i integracji z powłoki.
  const system = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    /^(PATH|SystemRoot|WINDIR|TEMP|TMP|HOME|USERPROFILE)$/i.test(k)));
  const wynik = spawnSync(process.execPath, kod ? ['--input-type=module', '--eval', kod] : ['src/oms.js'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    env: { ...system, OMS_TRYB: 'produkcja', OMS_USER: 'operator', OMS_PASS: 'fikcyjne',
      OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
      OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog,
      OMS_DB_PATH: join(katalog, 'oms.sqlite'), OMS_PORT: '0', ...zmiany },
  });
  expect(wynik.error).toBeUndefined();
  expect(wynik.signal).toBeNull();
  expect(wynik.status).not.toBe(0);
  return wynik.stderr.trim();
}

function komunikat(stderr: string, zmienna: string) {
  expect(stderr).not.toMatch(/^\s+at /m);
  expect(stderr).toContain('Błąd konfiguracji:');
  expect(stderr).toContain(`Ustaw ${zmienna}`);
  expect(stderr).toContain('Opis: docs/konfiguracja.md');
  expect(stderr.split('\n').length).toBeLessThanOrEqual(3);
}

describe('komunikaty rzeczywistego procesu startu', () => {
  it.each([
    ['OMS_TRUST_PROXY', 'true'], ['OMS_TRYB', 'nieznany'],
    // PRZ-108.10: pusty NIP przestał być błędem (NIP w panelu) — odmowę sprawdzamy na złej cyfrze kontrolnej.
    ['OMS_USER', ''], ['OMS_SPRZEDAWCA_NIP', '1234563219'], ['OMS_KANALY', '{'],
  ])('%s: czytelna odmowa bez stosu', (zmienna, wartosc) => {
    komunikat(start({ [zmienna]: wartosc }), zmienna);
  });

  it('brak katalogu bazy: wskazuje OMS_DB_PATH i wolumin Dockera, nie tworzy katalogu', () => {
    const brak = join(katalog, 'nie-istnieje');
    const stderr = start({ OMS_DB_PATH: join(brak, 'oms.sqlite') });
    komunikat(stderr, 'OMS_DB_PATH');
    expect(stderr).toContain('/data-oms');
    expect(existsSync(brak)).toBe(false);
  });

  it('plik zamiast katalogu bazy: czytelna odmowa', () => {
    const plik = join(katalog, 'plik');
    writeFileSync(plik, 'fixture');
    komunikat(start({ OMS_DB_PATH: join(plik, 'oms.sqlite') }), 'OMS_DB_PATH');
  });

  it('brak prawa zapisu katalogu: wskazuje OMS_DB_PATH', () => {
    komunikat(start({}, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      fs.accessSync = () => { throw Object.assign(new Error('odmowa-fixture'), { code: 'EACCES' }); };
      syncBuiltinESMExports();
      await import('./src/oms.js');
    `), 'OMS_DB_PATH');
  });

  it('nieoczekiwana awaria SQLite zachowuje stos', () => {
    const plik = join(katalog, 'uszkodzona.sqlite');
    writeFileSync(plik, 'to nie jest baza SQLite');
    const stderr = start({ OMS_DB_PATH: plik });
    expect(stderr).toMatch(/^\s+at /m);
    expect(stderr).not.toContain('Błąd konfiguracji:');
  });

  it.each(['Error', 'TypeError'])('nieoczekiwany %s konfiguratora zachowuje stos i przyczynę', (typ) => {
    const stderr = start({}, `
      import { MODULY } from './src/moduly/lista.ts';
      MODULY.find(m => m.nazwa === 'rdzen').konfiguracja = () => { throw new ${typ}('awaria-fixture'); };
      await import('./src/oms.js');
    `);
    expect(stderr).toContain('awaria-fixture');
    expect(stderr).toMatch(/^\s+at /m);
    expect(stderr).not.toContain('Błąd konfiguracji:');
  });
});
