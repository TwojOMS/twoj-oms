import { it, expect } from 'vitest';
import { nawigacjaDla } from '../../../src/domena/menu-stron.js';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { nowyPanel, BASIC, get } from '../../pomoc/panel-konta-testowe.js';

const listy = (body, klucz) => [...body.matchAll(new RegExp(`<ul[^>]*data-podmenu-lista="${klucz}"[^>]*>[\\s\\S]*?<\\/ul>`, 'g'))].map(m => m[0]);

it('Faktury grupują trzy pozycje poza Analizami i Klientami na obu wariantach menu', async () => {
  const { db, app } = nowyPanel();
  try {
    for (const url of ['/faktury', '/koszty', '/okresy']) {
      const { body, statusCode } = await get(app, url, BASIC);
      expect(statusCode).toBe(200);
      const rodzice = [...body.matchAll(/<a href="\/faktury" aria-current="([^"]+)"[^>]*>[\s\S]*?<span>Faktury<\/span>/g)];
      expect(rodzice.map(m => m[1])).toEqual([url === '/faktury' ? 'page' : 'true', url === '/faktury' ? 'page' : 'true']);
      const menu = listy(body, 'faktury');
      expect(menu).toHaveLength(2);
      for (const lista of menu) {
        expect([...lista.matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map(m => m[1])).toEqual(['Wystawione', 'Rozliczenia okresowe', 'Koszty']);
        expect(lista).toContain('data-podmenu-domyslnie="true"');
        expect(lista).toContain(`<a href="${url}" aria-current="page">`);
      }
      const model = nawigacjaDla({ sciezka: url });
      expect(model.analizy.pozycje.some(p => p.klucz === 'koszty')).toBe(false);
      expect(model.boczne.find(g => g.klucz === 'klienci').pozycje.some(p => p.klucz === 'okresy')).toBe(false);
    }
  } finally { await app.close(); db.close(); }
});

it('Okresy i Koszty pozostają dostępnymi linkami bez prawa do Faktur', async () => {
  const model = nawigacjaDla({ konto: { admin: false, uprawnienia: new Set(['okresy', 'koszty']) } });
  const pozycje = model.boczne.flatMap(g => g.pozycje);
  expect(pozycje.map(p => p.klucz)).toEqual(['koszty', 'okresy']);
  const html = await ejs.renderFile('src/core/web/widoki/_menu-panelu.ejs', {
    nawigacja: model, statusyMenu: [], mobilna: false,
  });
  expect(html).toContain('href="/okresy"');
  expect(html).toContain('href="/koszty"');
  expect(html).not.toContain('href="/faktury"');
});

it('404 pod Ustawieniami nie włącza powłoki Ustawień ani nie czyta indeksu listy', async () => {
  const { db, app } = nowyPanel();
  const zapytania = [];
  const prepare = db.prepare.bind(db);
  db.prepare = sql => { zapytania.push(String(sql)); return prepare(sql); };
  try {
    const przed = db.prepare('SELECT * FROM lista_meta').all();
    const { body, statusCode } = await get(app, '/ustawienia/konta/999', BASIC);
    expect(statusCode).toBe(404);
    expect(body).not.toContain('oms-shell--ustawienia');
    expect(body).not.toContain('Działy Ustawień');
    expect(zapytania.filter(sql => /lista_stan|(?:INSERT|UPDATE).*lista_meta/i.test(sql))).toEqual([]);
    expect(db.prepare('SELECT * FROM lista_meta').all()).toEqual(przed);
  } finally { await app.close(); db.close(); }
});

it('prawa i wyłączone moduły filtrują dzieci; sama pozycja Wystawione nie tworzy podmenu', async () => {
  for (const odlozoneEkrany of [[], ['koszty'], ['koszty', 'okresy']]) {
    const model = nawigacjaDla({ odlozoneEkrany });
    const faktury = model.boczne.flatMap(g => g.pozycje).find(p => p.klucz === 'faktury');
    expect(faktury.podmenu?.map(p => p.klucz) ?? []).toEqual(odlozoneEkrany.length === 2 ? [] : ['faktury', 'okresy', ...(!odlozoneEkrany.length ? ['koszty'] : [])]);
  }
  for (const prawa of [['faktury', 'okresy'], ['faktury']]) {
    const model = nawigacjaDla({ konto: { admin: false, uprawnienia: new Set(prawa) } });
    const faktury = model.boczne.flatMap(g => g.pozycje).find(p => p.klucz === 'faktury');
    expect(faktury.podmenu?.some(p => p.klucz === 'koszty') ?? false).toBe(false);
    expect(Boolean(faktury.podmenu?.length)).toBe(prawa.includes('okresy'));
    const html = await ejs.renderFile('src/core/web/widoki/_menu-panelu.ejs', {
      nawigacja: model, statusyMenu: [], mobilna: false,
    });
    expect(html).not.toContain('href="/koszty"');
    expect(html.includes('data-podmenu="faktury"')).toBe(prawa.includes('okresy'));
    expect(listy(html, 'faktury')).toHaveLength(prawa.includes('okresy') ? 1 : 0);
  }
});

// Kategorie i Marki są już stronami — „wkrótce” zastąpiły linki.
it('Magazyn prowadzi do Kategorii i Marek, a Produkty odróżniają stronę od sekcji', async () => {
  const { db, app } = nowyPanel();
  try {
    for (const [url, current] of [['/magazyn', 'page'], ['/magazyn/nowa', 'true']]) {
      const { body } = await get(app, url, BASIC);
      const menu = listy(body, 'magazyn');
      expect(menu).toHaveLength(2);
      for (const lista of menu) {
        expect(lista).toContain(`<a href="/magazyn" aria-current="${current}">Produkty</a>`);
        const pozycje = [...lista.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(m => m[1]);
        expect(pozycje).toHaveLength(3);
        for (const [i, [nazwa, adres]] of [['Kategorie', '/magazyn/kategorie'], ['Marki', '/magazyn/marki']].entries()) {
          expect(pozycje[i + 1]).toBe(`<a href="${adres}">${nazwa}</a>`);
          expect(pozycje[i + 1]).not.toMatch(/aria-disabled|wkrótce/);
        }
      }
    }
  } finally { await app.close(); db.close(); }
});

it('Ustawienia zachowują statusy i przycisk Zamówień', async () => {
  const { db, app } = nowyPanel();
  try {
    // /ustawienia jest aliasem przekierowującym do pierwszej zakładki.
    const wejscie = await get(app, '/ustawienia', BASIC);
    expect(wejscie.statusCode).toBe(302);
    const { body, statusCode } = await get(app, wejscie.headers.location, BASIC);
    expect(statusCode).toBe(200);
    expect(listy(body, 'zamowienia')).toHaveLength(2);
    expect(body.match(/<button[^>]*data-podmenu="zamowienia"/g)).toHaveLength(2);
  } finally { await app.close(); db.close(); }
});

it('Faktury mają własny zapis stanu i synchronizują podmenu mobilne z desktopowym', () => {
  const zapis = new Map([['oms-podmenu-magazyn', 'false']]);
  const atrybuty = [{ 'aria-expanded': 'true' }, { 'aria-expanded': 'true' }];
  const listy = [{ hidden: false }, { hidden: false }];
  const kliki = [];
  const przyciski = atrybuty.map((a, i) => ({
    dataset: { podmenu: 'faktury' }, hidden: true,
    getAttribute: k => k === 'aria-controls' ? String(i) : a[k],
    setAttribute: (k, v) => { a[k] = v; },
    addEventListener: (_, fn) => { kliki[i] = fn; },
  }));
  const document = { documentElement: { dataset: {} },
    querySelectorAll: () => przyciski, getElementById: id => listy[Number(id)],
    addEventListener: (_, fn) => fn(),
  };
  const localStorage = { getItem: k => zapis.get(k) ?? null, setItem: (k, v) => zapis.set(k, v) };
  const skrypt = readFileSync('src/public/oms-podmenu.js', 'utf8');
  runInNewContext(skrypt, { document, localStorage });
  expect(listy.map(l => l.hidden)).toEqual([false, false]);
  kliki[0]();
  expect(atrybuty.map(a => a['aria-expanded'])).toEqual(['false', 'false']);
  expect(listy.map(l => l.hidden)).toEqual([true, true]);
  expect(zapis.get('oms-podmenu-faktury')).toBe('false');
  expect(zapis.get('oms-podmenu-magazyn')).toBe('false');
  atrybuty.forEach(a => { a['aria-expanded'] = 'true'; });
  runInNewContext(skrypt, { document, localStorage });
  expect(listy.map(l => l.hidden)).toEqual([true, true]);
});

it('karty Faktur, Kosztów i Okresów wskazują sekcję zamiast strony listy', () => {
  for (const klucz of ['faktury', 'koszty', 'okresy']) {
    const model = nawigacjaDla({ sciezka: `/${klucz}/123` });
    const faktury = model.boczne.flatMap(g => g.pozycje).find(p => p.klucz === 'faktury');
    expect(faktury.aktywna).toBe(true);
    expect(faktury.podmenu.find(p => p.klucz === klucz).biezaca).toBe('true');
  }
});
