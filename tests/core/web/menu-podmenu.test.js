import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { nowyPanel, BASIC, get } from '../../pomoc/panel-konta-testowe.js';

it('statusy i liczniki pozostają pod Zamówieniami także w Magazynie', async () => {
  const { db, app } = nowyPanel();
  try {
    const ekran = await get(app, '/magazyn', BASIC);
    expect(ekran.statusCode).toBe(200);
    const listy = ekran.body.match(/<ul class="oms-statusy"[\s\S]*?<\/ul>/g);
    expect(listy).toHaveLength(2);
    for (const lista of listy) expect(lista).toContain('+ Nowe zamówienie');
    expect(listy[0]).toContain('data-status=');
    expect(listy[1]).not.toContain('data-status=');
  } finally { await app.close(); db.close(); }
});

it('osobne przyciski kontrolują unikalne podmenu, a Magazyn prowadzi do Produktów, Kategorii i Marek', async () => {
  const { db, app } = nowyPanel();
  try {
    for (const url of ['/', '/magazyn', '/magazyn/nowa']) {
      const { body } = await get(app, url, BASIC);
      const przyciski = [...body.matchAll(/<button\b[^>]*data-podmenu="(zamowienia|magazyn)"[^>]*>/g)];
      expect(przyciski).toHaveLength(4);
      const ids = new Set();
      for (const [html, klucz] of przyciski) {
        expect(html).toContain('type="button"');
        expect(html).toContain('aria-label=');
        expect(html).toContain(`aria-expanded="${klucz === 'zamowienia' || url.startsWith('/magazyn')}"`);
        const id = html.match(/aria-controls="([^"]+)"/)[1];
        ids.add(id);
        expect(body).toContain(`id="${id}"`);
        if (klucz === 'magazyn') {
          const lista = body.slice(body.indexOf(`id="${id}"`)).split('</ul>')[0];
          const produkty = lista.match(/<a href="\/magazyn"([^>]*)>Produkty<\/a>/);
          expect(produkty).not.toBeNull();
          expect(produkty[1].includes('aria-current="page"')).toBe(url === '/magazyn');
          expect(produkty[1].includes('aria-current="true"')).toBe(url === '/magazyn/nowa');
          // „Kategorie”/„Marki wkrótce” stały się działającymi odnośnikami.
          expect(lista).toContain('<a href="/magazyn/kategorie">Kategorie</a>');
          expect(lista).toContain('<a href="/magazyn/marki">Marki</a>');
          expect(lista).not.toContain('aria-disabled');
          expect(lista).not.toContain('menu-ustawien-wkrotce');
          expect(lista.match(/href=/g)).toHaveLength(3);
        }
      }
      expect(ids.size).toBe(4);
    }
  } finally { await app.close(); db.close(); }
});

it('zapisane zwinięcie obu podmenu wygrywa z mobilnym display:flex przed inicjalizacją JS', () => {
  const css = readFileSync('src/public/oms-design.css', 'utf8');
  // Te selektory składają się wyłącznie z klas, atrybutów i nazw elementów.
  const specyficznosc = selektor => [
    (selektor.match(/\.[\w-]+|\[[^\]]+\]/g) ?? []).length,
    selektor.replace(/\.[\w-]+|\[[^\]]+\]/g, '').trim().split(/\s+/).filter(Boolean).length,
  ];
  const mobilne = [...css.matchAll(/([^{}]+)\{display:flex[;}]/g)]
    .map(m => m[1].trim()).filter(s => s.startsWith('.oms-menu-mobile .oms-menu '));
  expect(mobilne.length).toBeGreaterThan(0);
  for (const klucz of ['zamowienia', 'magazyn']) {
    const ukrywanie = css.match(new RegExp(`(html\\[data-podmenu-${klucz}="false"\\][^,{]+)`))[1];
    const [klasy, elementy] = specyficznosc(ukrywanie);
    for (const selektor of mobilne) {
      const [klasyMobilne, elementyMobilne] = specyficznosc(selektor);
      expect(klasy > klasyMobilne || klasy === klasyMobilne && elementy > elementyMobilne).toBe(true);
    }
  }
});

function uruchom(zapis = new Map(), domyslny = 'false', blokada = false) {
  const atrybuty = { 'aria-expanded': domyslny };
  const lista = { hidden: false };
  let klik;
  const przycisk = { dataset: { podmenu: 'magazyn' }, hidden: true,
    getAttribute: k => k === 'aria-controls' ? 'lista' : atrybuty[k],
    setAttribute: (k, v) => { atrybuty[k] = String(v); },
    addEventListener: (typ, fn) => { if (typ === 'click') klik = fn; },
  };
  const document = { documentElement: { dataset: {} },
    querySelectorAll: () => [przycisk], getElementById: () => lista,
    addEventListener: (_, fn) => fn(),
  };
  const localStorage = {
    getItem: k => { if (blokada) throw Error('brak dostępu'); return zapis.get(k) ?? null; },
    setItem: (k, v) => { if (blokada) throw Error('brak dostępu'); zapis.set(k, v); },
  };
  runInNewContext(readFileSync('src/public/oms-podmenu.js', 'utf8'), { document, localStorage });
  return { atrybuty, lista, przycisk, klik, document };
}

it('klik przełącza aria i widoczność, a zapis ma pierwszeństwo przy ponownym wczytaniu', () => {
  const zapis = new Map();
  const pierwszy = uruchom(zapis);
  expect(pierwszy.lista.hidden).toBe(true);
  pierwszy.klik();
  expect(pierwszy.atrybuty['aria-expanded']).toBe('true');
  expect(pierwszy.lista.hidden).toBe(false);
  expect([...zapis.values()]).toEqual(['true']);
  expect(uruchom(zapis).lista.hidden).toBe(false);
  pierwszy.klik();
  expect(pierwszy.atrybuty['aria-expanded']).toBe('false');
  expect(pierwszy.lista.hidden).toBe(true);
  expect(uruchom(zapis, 'true').lista.hidden).toBe(true);
});

it('odmowa localStorage zachowuje domyślne stany i działające przełączanie', () => {
  for (const domyslny of ['true', 'false']) {
    const menu = uruchom(new Map(), domyslny, true);
    expect(menu.lista.hidden).toBe(domyslny === 'false');
    menu.klik();
    expect(menu.lista.hidden).toBe(domyslny === 'true');
    expect(menu.przycisk.hidden).toBe(false);
  }
});
