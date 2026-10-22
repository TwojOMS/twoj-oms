// PRZ-108.06: widoki EJS wszystkich modułów leżą w JEDNEJ płaskiej przestrzeni nazw (core/web/widoki.js —
// `reply.view('x.ejs')` i `include('x.ejs')` szukają po liście katalogów). Dwa pliki o tej samej nazwie w dwóch
// modułach to ekran, który przestaje się renderować (sciezkaWidoku: „oczekiwano jednej definicji”) albo — przy
// `include` — po cichu bierze cudzy plik. Przykład z planu: `ustawienia-automatyzacje.ejs` należy do autorespondera
// (wiadomości), więc ekran Ustawienia → Automatyzacje nazywa się `automatyzacje.ejs`.
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { katalogiWidokow } from '../../src/core/web/widoki.js';

const plikiEjs = (katalog) => readdirSync(katalog, { withFileTypes: true, recursive: true })
  .filter((d) => d.isFile() && d.name.endsWith('.ejs'))
  .map((d) => ({ nazwa: relative(katalog, join(d.parentPath ?? d.path, d.name)).replaceAll('\\', '/'), katalog }));

describe('nazwy widoków EJS', () => {
  it('lista katalogów obejmuje core/web/widoki i widoki każdego modułu', () => {
    const katalogi = katalogiWidokow().map((k) => k.replaceAll('\\', '/'));
    expect(katalogi.some((k) => k.endsWith('core/web/widoki'))).toBe(true);
    expect(katalogi.some((k) => k.endsWith('moduly/faktury/widoki'))).toBe(true);
    expect(katalogi.some((k) => k.endsWith('moduly/wiadomosci/widoki'))).toBe(true);
  });

  it('każda nazwa pliku .ejs występuje w dokładnie jednym katalogu widoków', () => {
    const gdzie = new Map();
    for (const { nazwa, katalog } of katalogiWidokow().flatMap(plikiEjs)) {
      gdzie.set(nazwa, [...(gdzie.get(nazwa) ?? []), katalog.replaceAll('\\', '/').replace(/^.*\/src\//, 'src/')]);
    }
    const powtorzone = Object.fromEntries([...gdzie].filter(([, k]) => k.length > 1));
    expect(powtorzone).toEqual({});
    expect(gdzie.size).toBeGreaterThan(50);
  });
});
