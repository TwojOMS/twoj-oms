import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ejs from 'ejs';
import { nowyPanel, get, BASIC } from '../pomoc/konta-prz068.js';

const WYJATKI = new Set([
  'src/core/web/widoki/_naglowek-ekranu.ejs',
  'src/core/web/widoki/brak-dostepu.ejs',
  'src/core/web/widoki/odmowa-rdzenia.ejs',
  'src/core/web/widoki/odmowa.ejs',
  'src/moduly/ustawienia/widoki/login.ejs',
  'src/moduly/ustawienia/widoki/haslo-link.ejs',
]);
function widoki(katalog) {
  return readdirSync(katalog, { withFileTypes: true }).flatMap(p => {
    const sciezka = join(katalog, p.name);
    return p.isDirectory() ? widoki(sciezka) : /\/widoki\/.*\.ejs$/.test(sciezka) ? [sciezka] : [];
  });
}
describe('PRZ-154 E2.1 — wspólny nagłówek ekranu', () => {
  it('h1 pochodzi wyłącznie z partiala (poza logowaniem i odmową)', () => {
    const naruszenia = widoki('src').filter(p => !WYJATKI.has(p) &&
      /<h1\b/i.test(readFileSync(p, 'utf8').replace(/<%#[\s\S]*?%>|<!--[\s\S]*?-->/g, '')));
    expect(naruszenia).toEqual([]);
  });
  it('escapuje tytuł i podtytuł, zachowuje slot akcji i zakładki po h1', async () => {
    const html = await ejs.renderFile('src/core/web/widoki/_naglowek-ekranu.ejs', {
      tytul: '<b>Tytuł</b>', podtytul: '<i>Opis</i>', licznik: '3 karty',
      akcje: '<a class="btn btn--drugi" href="/">Akcja</a>',
      zakladki: '<nav>Zakładki</nav>',
    });
    expect(html).toContain('&lt;b&gt;Tytuł&lt;/b&gt;');
    expect(html).toContain('&lt;i&gt;Opis&lt;/i&gt;');
    expect(html).toContain('3 karty');
    expect(html).toContain('<a class="btn btn--drugi"');
    expect(html.indexOf('<nav>')).toBeGreaterThan(html.indexOf('</h1>'));
  });
  it.each([
    ['/', 'Zamówienia', null],
    ['/raporty', 'Raporty', 'oms-zakladki-analiz'],
    ['/ustawienia/firma', 'Firma', 'ust-zakladki'],
  ])('%s: jeden h1 w nagłówku, zakładki pod tytułem', async (url, tytul, zakladki) => {
    const { app, db } = nowyPanel();
    try {
      const r = await get(app, url, BASIC);
      expect(r.statusCode).toBe(200);
      expect(r.body.match(/<h1\b/g)).toHaveLength(1);
      expect(r.body).toMatch(new RegExp(`<header[^>]*class="[^"]*naglowek-ekranu[^"]*"[^>]*>[\\s\\S]*?<h1[^>]*>${tytul}</h1>`));
      if (zakladki) {
        const main = r.body.slice(r.body.indexOf('<main'));
        expect(main.search(new RegExp(`class="[^"]*\\b${zakladki}\\b`))).toBeGreaterThan(main.indexOf('</h1>'));
      }
    } finally { await app.close(); db.close(); }
  });
  it('akcja szablonów paczek jest w wierszu tytułu działu, przed zakładkami', async () => {
    const { app, db } = nowyPanel();
    try {
      const r = await get(app, '/ustawienia/zamowienia-i-wysylka', BASIC);
      const header = r.body.match(/<header class="naglowek-ekranu"[\s\S]*?<\/header>/)?.[0] ?? '';
      expect(header).toContain('<h1>Wysyłka i druk</h1>');
      expect(header).toContain('class="naglowek-ekranu__akcje"');
      expect(header).toContain('class="btn" href="/ustawienia/zamowienia-i-wysylka?dodaj=1"');
      expect(header.indexOf('?dodaj=1')).toBeLessThan(header.indexOf('class="ust-zakladki"'));
    } finally { await app.close(); db.close(); }
  });
});
