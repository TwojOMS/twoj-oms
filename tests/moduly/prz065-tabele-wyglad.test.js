import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const odczytaj = (sciezka) => readFileSync(resolve(root, sciezka), 'utf8');

describe('PRZ-065 — zwarte tabele Przesyłek i Faktur', () => {
  it('ma wspólny, ograniczony do tych ekranów arkusz oraz nową hierarchię roboczą', () => {
    const przesylki = odczytaj('src/moduly/wysylka/widoki/przesylki-lista.ejs');
    const faktury = odczytaj('src/moduly/faktury/widoki/faktury.ejs');
    const css = odczytaj('src/public/tabele-prz065.css');

    for (const widok of [przesylki, faktury]) {
      expect(widok).toContain('href="/public/tabele-prz065.css"');
      expect(widok).toContain('prz065-tabele');
      expect(widok).toContain('prz065-naglowek');
    }
    expect(css).toContain('.prz065-tabele');
    expect(css).toMatch(/(^|\n)\.prz065-status \{/);
    expect(css).toContain('@media (max-width: 760px)');
  });

  it('zachowuje wszystkie prawdziwe wejścia i wyjścia obu ekranów', () => {
    const przesylki = odczytaj('src/moduly/wysylka/widoki/przesylki-lista.ejs');
    const faktury = odczytaj('src/moduly/faktury/widoki/faktury.ejs');

    for (const fragment of [
      'name="pokaz"', 'name="od"', 'name="do"', 'name="kurier"', 'name="sklep"',
      '/przesylki/podjazdy', '/przesylki/podjazdy/historia', '/ukryj', '/przywroc',
    ]) expect(przesylki).toContain(fragment);

    for (const fragment of [
      'name="miesiac"', 'name="pole"', '/faktury/ksef/podglad',
      '/faktury/archiwum/uruchom', '/faktury/zestawienie-przychodow', 'doOdnotowaniaSkasowania',
    ]) expect(faktury).toContain(fragment);
  });
});
