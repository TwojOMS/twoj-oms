import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';

// Lista Magazynu pokazuje karty po 100 na stronie — przy tysiącach kart sama przeglądarka
// liczyłaby sekundy. Licznik „pasujących”, akcje hurtowe i „zaznacz wszystkie” dalej obejmują
// CAŁE zawężenie: człowiek ma wiedzieć, że dotyka wszystkich kart, a nie tylko tych na ekranie.

const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};

let db, app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({
    db,
    config: { auth: { user: 'adam', pass: 'x' } },
    magazyn: { start: () => ({ wystartowal: true }), stan: () => ({ trwa: false, kanaly: [] }) },
  });
  await app.ready();
});
afterEach(async () => {
  await app?.close();
  db.close();
});

const nazwa = (i) => `Lampa Półcień ${String(i).padStart(3, '0')}`;
function karty(ile) {
  for (let i = 1; i <= ile; i++) utworzKarte(db, { nazwa: nazwa(i), sku: `PLC-${i}` });
}
async function lista(url) {
  const r = await app.inject({ url, headers: auth });
  expect(r.statusCode).toBe(200);
  const html = r.body;
  const pola = [...html.matchAll(/<input\b([^>]*\bname="zaznaczone"[^>]*)>/g)].map((m) => m[1]);
  const nawigacja = /<nav class="hist-strony magazyn-strony"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? null;
  return { html, wierszy: pola.length, zaznaczonych: pola.filter((a) => /\bchecked\b/.test(a)).length, nawigacja };
}
const odnosniki = (nawigacja) => [...nawigacja.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replaceAll('&amp;', '&'));

describe('stronicowanie listy Magazynu', () => {
  it('do 100 kart — bez stronicowania', async () => {
    karty(100);
    const s = await lista('/magazyn');
    expect(s.wierszy).toBe(100);
    expect(s.nawigacja).toBeNull();
  });

  it('230 kart — pierwsza strona ma 100 wierszy, licznik pasujących liczy wszystkie 230', async () => {
    karty(230);
    const s = await lista('/magazyn');
    expect(s.wierszy).toBe(100);
    expect(s.html).toContain(nazwa(1));
    expect(s.html).toContain(nazwa(100));
    expect(s.html).not.toContain(nazwa(101));
    expect(s.html).toContain('<strong class="hurt-pasujace">230</strong>');
    expect(s.html).toContain('bez zawężenia · 230 kart');
    expect(s.nawigacja).toContain('Karty 1–100 z 230');
    expect(odnosniki(s.nawigacja)).toEqual([
      '/magazyn?sort=nazwa&kier=asc&wszystkie=1',
      '/magazyn?sort=nazwa&kier=asc&strona=2',
    ]);
  });

  it('ostatnia strona — reszta kart, odnośnik wstecz, licznik dalej 230', async () => {
    karty(230);
    const s = await lista('/magazyn?strona=3');
    expect(s.wierszy).toBe(30);
    expect(s.html).toContain(nazwa(201));
    expect(s.html).not.toContain(nazwa(200));
    expect(s.html).toContain('<strong class="hurt-pasujace">230</strong>');
    expect(s.nawigacja).toContain('Karty 201–230 z 230');
    expect(odnosniki(s.nawigacja)).toEqual([
      '/magazyn?sort=nazwa&kier=asc&strona=2',
      '/magazyn?sort=nazwa&kier=asc&wszystkie=1',
    ]);
  });

  it('numer strony spoza zakresu albo nieliczbowy — najbliższa istniejąca strona', async () => {
    karty(230);
    expect((await lista('/magazyn?strona=99')).wierszy).toBe(30);
    for (const zly of ['abc', '0', '-2', '1.5']) {
      const s = await lista(`/magazyn?strona=${zly}`);
      expect(s.wierszy, zly).toBe(100);
      expect(s.html, zly).toContain(nazwa(1));
    }
  });

  it('„pokaż wszystkie” — cała lista i powrót do stron po 100', async () => {
    karty(230);
    const s = await lista('/magazyn?wszystkie=1');
    expect(s.wierszy).toBe(230);
    expect(s.nawigacja).toContain('Wszystkie 230 kart');
    expect(odnosniki(s.nawigacja)).toEqual(['/magazyn?sort=nazwa&kier=asc']);
  });

  it('„pokaż wszystkie” przeżywa zmianę sortowania, filtry, szukajkę i „Wyczyść zawężenie”', async () => {
    karty(230);
    const s = await lista('/magazyn?fraza=Lampa&wszystkie=1');
    const html = s.html.replaceAll('&amp;', '&');
    const naglowki = [...html.matchAll(/<a class="zaznacz-wszystkie" href="([^"]*)">/g)].map((m) => m[1]);
    expect(naglowki.length).toBeGreaterThan(3);
    for (const adres of naglowki) expect(adres).toMatch(/[?&]wszystkie=1(&|$)/);
    const ukryteWszystkie = html.match(/<input type="hidden" name="wszystkie" value="1"/g) ?? [];
    // Formularz filtrów i szukajka — oba niosą tryb całej listy dalej.
    expect(ukryteWszystkie.length).toBe(2);
    const wyczysc = /<a class="chipy-wyczysc" href="([^"]*)">/.exec(html)?.[1];
    expect(wyczysc).toMatch(/[?&]wszystkie=1(&|$)/);
    // Po kliknięciu w nagłówek lista dalej jest cała.
    const poSortowaniu = await lista(naglowki[0]);
    expect(poSortowaniu.wierszy).toBe(230);
  });

  it('„zaznacz wszystkie” zaznacza całe zawężenie, nie tylko bieżącą stronę', async () => {
    karty(230);
    const s = await lista('/magazyn?zaznacz=1');
    expect(s.wierszy).toBe(230);
    expect(s.zaznaczonych).toBe(230);
  });

  it('zawężenie frazą — strony i licznik liczą tylko pasujące karty', async () => {
    karty(230);
    for (let i = 1; i <= 40; i++) utworzKarte(db, { nazwa: `Klosz Półcień ${i}`, sku: `KLS-${i}` });
    const s = await lista('/magazyn?fraza=Lampa');
    expect(s.html).toContain('<strong class="hurt-pasujace">230</strong>');
    expect(s.wierszy).toBe(100);
    expect(s.html).not.toContain('Klosz Półcień');
    expect(s.nawigacja).toContain('Karty 1–100 z 230');
    expect(odnosniki(s.nawigacja)).toContain('/magazyn?fraza=Lampa&sort=nazwa&kier=asc&strona=2');
  });

  it('karta otwarta z drugiej strony wraca na tę samą stronę', async () => {
    karty(230);
    const s = await lista('/magazyn?strona=2');
    const adres = /<a href="(\/magazyn\/\d+\?[^"]*)">Lampa Półcień 101<\/a>/.exec(s.html)?.[1];
    expect(adres?.replaceAll('&amp;', '&')).toMatch(
      new RegExp('wroc=' + encodeURIComponent('/magazyn?sort=nazwa&kier=asc&strona=2') + '$'),
    );
  });
});
