// Strażnik „żaden test nie leży poza zasięgiem Vitesta”. Plik `*.test.*` poza wzorcami `include` z vitest.config.ts
// nigdy nie biegnie, a przebieg wygląda na zielony — nowy test wrzucony obok kodu (np. do src/) przepadłby bez śladu.
// Wzorce czyta z konfiguracji, nie kopiuje ich. Wyjątki to lista ZAMROŻONA: dopisanie wpisu to świadoma decyzja
// w diffie tego testu, a wpis bez pliku w repo (usunięty, przeniesiony) czerwieni test.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import picomatch from 'picomatch';
import konfiguracja from '../../vitest.config.ts';

const KORZEN = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ROZSZERZENIE_TESTU = /\.test\.(?:js|mjs|cjs|ts|mts|cts)$/;

// Wpis kończący się na `/` obejmuje cały katalog; pozostałe są dokładnymi ścieżkami plików.
const WYJATKI = {
};

export function plikiTestowe() {
  return execFileSync('git', ['ls-files'], { cwd: KORZEN, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter((p) => ROZSZERZENIE_TESTU.test(p));
}

const wyjatek = (plik, wpis) => (wpis.endsWith('/') ? plik.startsWith(wpis) : plik === wpis);

export function nieobjete(pliki, include, wyjatki) {
  const pasuje = picomatch(include);
  return pliki.filter((p) => !pasuje(p) && !Object.keys(wyjatki).some((w) => wyjatek(p, w)));
}

describe('testy leżą pod include z vitest.config.ts', () => {
  const include = konfiguracja.test.include;
  const pliki = plikiTestowe();

  it('konfiguracja ma niepuste include, a repo pliki testowe', () => {
    expect(include.length).toBeGreaterThan(0);
    expect(pliki.length).toBeGreaterThan(100);
  });

  it('każdy plik *.test.* z repo jest objęty include albo jest na liście wyjątków', () => {
    expect(nieobjete(pliki, include, WYJATKI)).toEqual([]);
  });

  it('każdy wpis listy wyjątków ma plik w repo i podaje powód', () => {
    const martwe = Object.keys(WYJATKI).filter((w) => !pliki.some((p) => wyjatek(p, w)));
    expect(martwe).toEqual([]);
    for (const powod of Object.values(WYJATKI)) expect(powod.length).toBeGreaterThan(10);
  });

  it('wyjątki nie ukrywają testów, które Vitest i tak uruchamia', () => {
    const pasuje = picomatch(include);
    const zbedne = Object.keys(WYJATKI).filter((w) => pliki.some((p) => wyjatek(p, w) && pasuje(p)));
    expect(zbedne).toEqual([]);
  });

  it('wykrywa test położony poza include', () => {
    expect(nieobjete([...pliki, 'src/oms/nowy.test.js'], include, WYJATKI)).toEqual(['src/oms/nowy.test.js']);
  });
});
