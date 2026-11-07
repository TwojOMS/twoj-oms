import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowyPanel, get, BASIC } from '../pomoc/konta-prz068.js';

const czytaj = p => readFileSync(p, 'utf8');
function pliki(katalog) {
  return readdirSync(katalog, { withFileTypes: true }).flatMap(p => {
    const sciezka = join(katalog, p.name);
    return p.isDirectory() ? pliki(sciezka) : /\.(ejs|css|js|ts)$/.test(p.name) ? [sciezka] : [];
  });
}
const layout = () => czytaj('src/public/oms-uklad.css').replace(/\/\*[\s\S]*?\*\//g, '');
const regula = (css, selektor) => {
  const blok = css.match(new RegExp(`^\\s*${selektor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`, 'm'))?.[1];
  expect(blok, selektor).toBeTruthy();
  return Object.fromEntries([...blok.matchAll(/([\w-]+)\s*:\s*([^;]+)(?:;|$)/g)].map(m => [m[1], m[2].trim()]));
};

describe('PRZ-154 E2.4 — jeden system przycisków', () => {
  it('nie zostawia starej klasy w widokach, CSS ani skryptach przeglądarki', () => {
    expect(pliki('src').filter(p => czytaj(p).includes('ust-przycisk'))).toEqual([]);
  });
  it.each(['/ustawienia/zamowienia-i-wysylka', '/ustawienia/szablony-wiadomosci'])(
    '%s renderuje akcje i tabelę szablonów ze wspólnymi przyciskami', async url => {
      const { app, db } = nowyPanel();
      try {
        const r = await get(app, url, BASIC);
        expect(r.statusCode).toBe(200);
        const main = r.body.slice(r.body.indexOf('<main'));
        expect(main).toMatch(/class="btn(?: [^"]*)?"/);
        expect(main).toMatch(/<table\b[\s\S]*?class="btn btn--maly(?: [^"]*)?"/);
        expect(main).not.toContain('ust-przycisk');
      } finally { await app.close(); db.close(); }
    });
  it('zachowuje grozę zwrotu w zwykłym rozmiarze i drugi wariant historii podjazdów', () => {
    expect(czytaj('src/moduly/zamowienia/widoki/zamowienie.ejs')).toMatch(/class="btn btn--groza"[^\n]*>Zarejestruj zwrot/);
    expect(czytaj('src/moduly/zwroty/widoki/zwrot-podglad.ejs')).toMatch(/class="btn btn--groza">Zarejestruj zwrot/);
    expect(czytaj('src/moduly/wysylka/widoki/przesylki-lista.ejs')).toMatch(/class="btn btn--drugi"[^>]*>Historia podjazdów/);
  });
  it.each([':root', 'html[data-motyw="ciemny"]'])('%s: groza i zapis mają różne tła, również po najechaniu', motyw => {
    const css = layout();
    const paleta = regula(css, motyw);
    const kolor = wartosc => wartosc.replace(/var\((--[\w-]+)\)/g, (_, nazwa) => {
      expect(paleta[nazwa], `${motyw} ${nazwa}`).toBeTruthy();
      return paleta[nazwa];
    }).toLowerCase();
    for (const stan of ['', ':hover']) {
      const glowny = regula(css, `.btn--glowny${stan}`).background;
      const groza = regula(css, `.btn--groza${stan}`).background;
      expect(kolor(groza)).not.toBe(kolor(glowny));
    }
  });
  it('tło grozy ustawiają tylko reguły bazowa i :hover — żaden motyw ani kontekst jej nie nadpisuje', () => {
    const obce = [...layout().matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(([, sel, cialo]) => /\.btn--groza\b/.test(sel) && /\bbackground(?:-color)?\s*:/.test(cialo))
      .map(([, sel]) => sel.trim()).filter(sel => !['.btn--groza', '.btn--groza:hover'].includes(sel));
    expect(obce).toEqual([]);
  });
  it('wiersze tabeli statusów zapisują zwykłym przyciskiem — jedna akcja główna na ekranie', async () => {
    const { app, db } = nowyPanel();
    try {
      const r = await get(app, '/ustawienia/statusy', BASIC);
      expect(r.statusCode).toBe(200);
      expect(r.body.slice(r.body.indexOf('<main')).match(/\bbtn--glowny\b/g) ?? []).toHaveLength(1);
    } finally { await app.close(); db.close(); }
  });
});
