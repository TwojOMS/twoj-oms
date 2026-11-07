import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const odczytaj = (sciezka) => readFileSync(resolve(root, sciezka), 'utf8');

describe('PRZ-065 — zwarte tabele Przesyłek i Faktur', () => {
  it('nie centruje ani nie ogranicza szerokości ramy treści', () => {
    const css = odczytaj('src/public/tabele-prz065.css');
    const rama = css.match(/\.prz065-tabele\s*\{([^}]*)\}/)?.[1];
    expect(rama).toBeDefined();
    expect(rama).not.toMatch(/max-width\s*:/);
    expect(rama).not.toMatch(/margin\s*:[^;]*\bauto\b/);
  });

  it('ma wspólny, ograniczony do tych ekranów arkusz oraz nową hierarchię roboczą', () => {
    const przesylki = odczytaj('src/moduly/wysylka/widoki/przesylki-lista.ejs');
    const faktury = odczytaj('src/moduly/faktury/widoki/faktury.ejs');
    const css = odczytaj('src/public/tabele-prz065.css');

    for (const widok of [przesylki, faktury]) {
      expect(widok).toContain(`href="<%= zasob('tabele-prz065.css') %>"`); // PRZ-100: adres z wersją
      expect(widok).toContain('prz065-tabele');
      expect(widok).toContain('_naglowek-ekranu.ejs'); // PRZ-154 E2.1: nagłówek wspólny dla wszystkich ekranów.
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

describe('PRZ-152.G14c — pasek zakładek bez pionowego suwaka', () => {
  const css = odczytaj('src/public/tabele-prz065.css');
  const regula = (selektor) => {
    const i = css.indexOf(`\n${selektor} {`);
    expect(i).toBeGreaterThan(-1);
    return css.slice(i, css.indexOf('}', i));
  };

  it('pasek przewija się tylko w poziomie (overflow-y hidden), bez wystawania chipa poza ramkę', () => {
    const pasek = regula('.prz065-zakladki');
    expect(pasek).toMatch(/overflow-x:\s*auto/);
    expect(pasek).toMatch(/overflow-y:\s*hidden/);
    expect(regula('.prz065-zakladki .chip')).not.toMatch(/margin-bottom:\s*-/);
  });

  it('na telefonie jest jeden przewijak (nav), a nie drugi w środku', () => {
    expect(css).not.toMatch(/\.prz065-przesylki \.chipy-filtrow \{[^}]*overflow/);
    // chipy w jednej linii (przewijanie poziome), nie zawijane w 3 rzędy
    expect(css).toMatch(/\.prz065-zakladki \.chipy-filtrow \{[^}]*flex-wrap:\s*nowrap/);
  });
});
