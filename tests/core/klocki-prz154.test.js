import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { nowyPanel, get, BASIC } from '../pomoc/konta-prz068.js';

const css = () => readFileSync('src/public/oms-design.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const blok = (tekst, selektor) => {
  const znaleziony = [...tekst.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, s]) => s.trim() === selektor);
  expect(znaleziony, selektor).toBeTruthy();
  return znaleziony[2];
};
const POLA = '.oms-shell main :is(input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="file"]), select, .oms-pole)';

describe('PRZ-154 E2.5 — wspólne klocki', () => {
  it('definiuje tokeny i stosuje je w polach, kartach, tabelach i nagłówkach sekcji', () => {
    const tekst = css();
    for (const [token, wartosc] of Object.entries({ 'pole-h': '36px', 'pole-h-maly': '28px', 'r-el': '6px', 'r-karta': '8px' })) {
      expect(blok(tekst, ':root')).toContain(`--${token}: ${wartosc}`);
    }
    expect(blok(tekst, POLA)).toContain('height: var(--pole-h)');
    expect(blok(tekst, POLA)).toContain('border-radius: var(--r-el)');
    expect(blok(tekst, '.oms-shell main .oms-pole--male')).toContain('height: var(--pole-h-maly)');
    expect(blok(tekst, '.oms-shell main :is(.panel, .ust-sekcja)')).toContain('border-radius: var(--r-karta)');
    expect(blok(tekst, '.oms-shell main :is(.panel-cialo, .ust-sekcja)')).toContain('padding: var(--karta-p)');
    const tabela = blok(tekst, '.oms-shell main table th');
    expect(tabela).toContain('font-size: var(--tabela-font)');
    expect(tabela).toContain('padding: var(--tabela-p)');
    expect(tabela).toContain('text-transform: uppercase');
    // Drugi, celowy wariant h2: etykieta w głowie panelu (karta zamówienia, nadanie) — globalna reguła jej nie nadpisuje.
    expect(blok(tekst, '.oms-shell main h2:not(.panel-glowa h2)')).toContain('font-size: var(--sekcja-font)');
    expect(tekst).not.toMatch(/\.oms-shell main h2\s*\{/);
  });

  it('przełącznik w polach ustawień ma kontrolkę obok podpisu, nie nad nim, a podpis z linkiem płynie jednym tekstem', () => {
    const layout = readFileSync('src/public/oms-uklad.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(blok(layout, '.ust-pola .pole-przelacznik')).toContain('display: block');
    expect(blok(layout, '.ust-pola .pole-przelacznik input')).toContain('width: auto');
  });

  it.each(['/cele/nowy', '/ustawienia/konta'])('%s renderuje pola ze wspólnymi klasami', async url => {
    const { app, db } = nowyPanel();
    try {
      const r = await get(app, url, BASIC);
      expect(r.statusCode).toBe(200);
      const main = r.body.slice(r.body.indexOf('<main'));
      if (url === '/cele/nowy') {
        expect(main).toMatch(/<form[^>]*class="oms-pola"[^>]*>/);
        const form = main.match(/<form[^>]*class="oms-pola"[^>]*>([\s\S]*?)<\/form>/)?.[1] ?? '';
        expect(form.match(/<(?:input|select)\b/g)).toHaveLength(7);
      } else {
        const role = main.match(/<select\b[^>]*name="rola"[^>]*>/g) ?? [];
        expect(role.length).toBeGreaterThan(0);
        for (const pole of role) expect(pole).toMatch(/class="oms-pole"/);
      }
    } finally { await app.close(); db.close(); }
  });

  it.each(['/koszty', '/cele'])('%s ma nagłówki tabel objęte wspólną regułą', async url => {
    const { app, db } = nowyPanel();
    try {
      const r = await get(app, url, BASIC);
      expect(r.statusCode).toBe(200);
      const main = r.body.slice(r.body.indexOf('<main'));
      expect(main).toMatch(/<table\b[^>]*>[\s\S]*?<th\b/);
      expect(main.match(/<th\b[^>]*style=/g) ?? []).toEqual([]);
      expect(blok(css(), '.oms-shell main table th')).toContain('font-size: var(--tabela-font)');
    } finally { await app.close(); db.close(); }
  });
});
