// PRZ-066 (prośby właściciela 13.10.2026): czytelne czcionki, niebieski akcent zamiast zielonego,
// stary ciemny motyw, okienko konta w obrębie menu, bez „Obszaru roboczego”.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const czytaj = (p) => readFileSync(resolve(root, p), 'utf8').replaceAll('\r\n', '\n');
const reguła = (css, selektor) => {
  const i = css.indexOf(`${selektor}{`) >= 0 ? css.indexOf(`${selektor}{`) : css.indexOf(`${selektor} {`);
  expect(i, `brak reguły ${selektor}`).toBeGreaterThanOrEqual(0);
  return css.slice(i, css.indexOf('}', i));
};
const rem = (blok) => Number(blok.match(/font-size:\s*([\d.]+)rem/)?.[1] ?? NaN);
const blokMotywu = (layout, motyw) => {
  const start = motyw === 'ciemny' ? layout.indexOf('html[data-motyw="ciemny"] {') : layout.indexOf(':root {');
  return layout.slice(start, layout.indexOf('\n    }', start));
};
const zmienna = (blok, nazwa) => blok.match(new RegExp(`${nazwa}:\\s*(#[0-9a-f]{3,8})`))?.[1];

describe('PRZ-066 — czcionki', () => {
  const tabele = czytaj('src/public/tabele-prz065.css');
  const rama = czytaj('src/public/oms-design.css');

  it('tabele Faktur i Przesyłek mają tekst 16 px, nagłówki i drobny tekst co najmniej 13 px', () => {
    expect(rem(reguła(tabele, '.prz065-tabela'))).toBe(1);
    expect(rem(reguła(tabele, '.prz065-tabela th'))).toBeGreaterThanOrEqual(0.8);
    expect(rem(reguła(tabele, '.prz065-tabela .drobne, .prz065-tabela .wiersz-szczegoly, .prz065-tabela .ksef-numer'))).toBeGreaterThanOrEqual(0.85);
    expect(rem(reguła(tabele, '.prz065-status'))).toBe(1);
  });

  it('w arkuszach PRZ-065 nie zostaje tekst 10–12 px poza widokiem telefonu', () => {
    for (const css of [tabele, rama]) {
      const bezTelefonu = css.replace(/@media\s*\(max-width:\s*(650|760)px\)\s*\{[\s\S]*?\n\}/g, '');
      expect(bezTelefonu).not.toMatch(/font-size:\s*1[0-2]px/);
    }
  });

  it('menu ma 16 px i kolumnę mieszczącą „Indywidualne” z licznikiem', () => {
    expect(rem(reguła(rama, '.oms-menu'))).toBe(1);
    expect(reguła(rama, '.oms-shell')).toContain('grid-template-columns:13.5rem');
  });
});

describe('PRZ-066 — kolory', () => {
  const layout = czytaj('src/core/web/widoki/layout-oms.ejs');

  it('jasny motyw ma niebieski akcent, bez zieleni PRZ-065', () => {
    const jasny = blokMotywu(layout, 'jasny');
    expect(zmienna(jasny, '--marka')).toBe('#3e5566');
    expect(zmienna(jasny, '--link')).toBe('#3e5566');
    for (const p of ['src/core/web/widoki/layout-oms.ejs', 'src/public/oms-design.css', 'src/public/tabele-prz065.css', 'src/public/messages-prz065.css'])
      expect(czytaj(p)).not.toMatch(/#1f6b45|#19583a|#78c99e/i);
  });

  it('ciemny motyw ma paletę sprzed PRZ-065', () => {
    const ciemny = blokMotywu(layout, 'ciemny');
    expect([zmienna(ciemny, '--tlo'), zmienna(ciemny, '--powierzchnia'), zmienna(ciemny, '--marka'), zmienna(ciemny, '--link')])
      .toEqual(['#191c1f', '#23272b', '#3d5a6e', '#8fb6d0']);
  });
});

describe('PRZ-066 — boczna kolumna', () => {
  const layout = czytaj('src/core/web/widoki/layout-oms.ejs');
  const rama = czytaj('src/public/oms-design.css');

  it('nie ma „Obszaru roboczego”, logo firmy stoi przy nazwie panelu', () => {
    expect(layout).not.toContain('Obszar roboczy');
    expect(layout).not.toContain('oms-workspace');
    expect(layout).toMatch(/<a class="oms-brand"[^\n]*<img class="pas-logo"[^\n]*<span>Twój OMS<\/span><\/a>/);
  });

  // PRZ-067 (prośba właściciela 13.10): konto wróciło do górnego paska, więc reguła „okienko w obrębie
  // bocznej kolumny” z PRZ-066 przestała mieć przedmiot. Pilnujemy, że blok konta nie wraca do
  // kolumny, a okienko na telefonie trzyma się prawej krawędzi i nie wystaje poza ekran.
  it('konto nie stoi w bocznej kolumnie, okienko trzyma się prawej krawędzi paska', () => {
    expect(layout).not.toContain('oms-account');
    expect(rama).not.toContain('.oms-account');
    expect(rama).toContain('.oms-topbar .menu-uzytkownika-panel{max-width:calc(100vw - 24px)}');
    expect(rama).toMatch(/@media\(max-width:650px\)\{[^\n]*\.oms-topbar \.menu-uzytkownika-panel\{right:0\}/);
  });
});
