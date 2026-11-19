import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Lista Magazynu na telefonie (400 px). Repo nie ma testów w prawdziwej przeglądarce, więc
// pilnujemy reguł w arkuszu; pomiar `scrollWidth <= innerWidth` robi się ręcznie w Chromium.
const layout = readFileSync(new URL('../../../src/public/oms-uklad.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

// Deklaracje wszystkich reguł, których selektor jest dokładnie taki, jak podany.
function deklaracje(selektor) {
  const wynik = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(layout))) {
    const sel = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (sel.includes(selektor)) wynik.push(m[2].replace(/\s+/g, ' ').trim());
  }
  return wynik.join(' ');
}

describe('lista Magazynu na telefonie', () => {
  it('otwarta akcja belki wypuszcza ciało z ::details-content, żeby zajęło cały wiersz', () => {
    expect(deklaracje('.belka-akcji details.akcja[open]::details-content')).toMatch(/display:\s*contents/);
  });

  it('::details-content dostaje display: contents wyłącznie przy [open] — zamknięte akcje nie pokazują ciał', () => {
    const selektory = [...layout.matchAll(/([^{}]+)\{/g)]
      .flatMap((m) => m[1].split(','))
      .map((s) => s.trim())
      .filter((s) => s.includes('::details-content') && s.includes('.belka-akcji'));
    expect(selektory.length).toBeGreaterThan(0);
    for (const s of selektory) expect(s).toMatch(/details\.akcja\[open\]::details-content$/);
  });

  it('pole filtra i jego lista nie są szersze niż pasek filtrów, choćby opcja miała długą nazwę', () => {
    expect(deklaracje('.pole-filtra')).toMatch(/max-inline-size:\s*100%/);
    expect(deklaracje('.filtry select')).toMatch(/max-inline-size:\s*100%/);
  });
});
