// PRZ-102.05 — /raporty przy oknie 1280 przewijało się w bok o 50 px (dokument 1315 px przy 1265 px).
// Sprawca zmierzony w przeglądarce: tekst „vs 2026-09-01 – 2026-09-20” w nagłówku listy kanałów
// (`.kanal-naglowek .liczba`, kolumna 6,5 rem), któremu globalne `.liczba { white-space: nowrap }`
// nie pozwalało się zawinąć. Pomiar w przeglądarce jest dowodem; ten test pilnuje reguły.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const layout = readFileSync(resolve(root, 'src/core/web/widoki/layout-oms.ejs'), 'utf8').replaceAll('\r\n', '\n');
const regula = (selektor) => {
  const i = layout.indexOf(`\n    ${selektor} {`);
  expect(i, `brak reguły ${selektor}`).toBeGreaterThanOrEqual(0);
  return layout.slice(i, layout.indexOf('}', i));
};

describe('PRZ-102.05 — nagłówek kolumn kanałów na /raporty', () => {
  it('globalne .liczba nadal nie zawija (liczby w wierszach zostają w jednej linii)', () => {
    expect(regula('.liczba')).toMatch(/white-space:\s*nowrap/);
  });

  it('podpis kolumn w nagłówku kanałów może się zawinąć', () => {
    expect(regula('.kanal-naglowek .liczba')).toMatch(/white-space:\s*normal/);
  });
});
