import { afterEach, beforeEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { kartyZKanalami, powiazProdukt, utworzKarte, zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';
import { przelaczStany } from '../../../src/oms/db/stany-magazynowe.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { definicjeKanalowHistoryczne } from '../../pomoc/przykladowe-definicje-kanalow.js';

const headers = { authorization: `Basic ${Buffer.from('tester:x').toString('base64')}` };
let db, app;

beforeEach(() => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({
    db,
    config: { auth: { user: 'tester', pass: 'x' } },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
  });
});

afterEach(async () => {
  await app.close();
  db.close();
});

async function get(url = '/magazyn') {
  const r = await app.inject({ method: 'GET', url, headers });
  expect(r.statusCode).toBe(200);
  return r.body;
}

const tekst = (html) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/[\s▲▼]+/g, ' ')
    .trim();
const naglowki = (html) => [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => tekst(m[1]));
const wiersze = (html) => [...html.matchAll(/<div><a href="[^"]*">([^<]+)<\/a><\/div>/g)].map((m) => m[1]);
const komorki = (html) => [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);

it('pokazuje EAN obok SKU tylko wtedy, gdy karta ma EAN', async () => {
  utworzKarte(db, { nazwa: 'Alfa', sku: 'DEMO-ALFA', ean: '2000000000015' });
  utworzKarte(db, { nazwa: 'Beta', sku: 'DEMO-BETA' });
  utworzKarte(db, { nazwa: 'Gamma', ean: '2000000000022' });

  const html = await get();
  expect(html).toContain('<div class="sku">DEMO-ALFA · EAN 2000000000015</div>');
  expect(html).toContain('<div class="sku">DEMO-BETA</div>');
  expect(html).toContain('<div class="sku">bez SKU · EAN 2000000000022</div>');
});

it.each([
  ['2000000000015', ['Alfa']],
  ['200000000001', ['Alfa']],
  ['000000000015', []],
  ['20000000000_', []],
  ['20000000000%', []],
])('wyszukuje EAN na liście magazynu po frazie %s', async (fraza, oczekiwane) => {
  utworzKarte(db, { nazwa: 'Alfa', sku: 'DEMO-ALFA', ean: '2000000000015' });
  utworzKarte(db, { nazwa: 'Beta', sku: 'DEMO-BETA', ean: '2000000000022' });
  utworzKarte(db, { nazwa: 'Gamma' });

  expect(wiersze(await get(`/magazyn?fraza=${encodeURIComponent(fraza)}`))).toEqual(oczekiwane);
});

const zakladki = (html) => {
  const nav = /<nav[^>]*aria-label="Widoki magazynu"[^>]*>([\s\S]*?)<\/nav>/.exec(html);
  expect(nav).not.toBeNull();
  return [...nav[1].matchAll(/<a\b([^>]+)>([^<]+)<\/a>/g)].map(([, atrybuty, nazwa]) => ({
    nazwa,
    aktywna: atrybuty.includes('aria-current="page"'),
    adres: /href="([^"]+)"/.exec(atrybuty)[1].replaceAll('&amp;', '&'),
  }));
};

it.each([false, true])('układa nagłówki w obu widokach i dopasowuje pustą komórkę (stany: %s)', async (stany) => {
  if (stany) przelaczStany(db, { wlacz: true });
  const wspolne = ['zaznacz', '', 'Karta / SKU', 'Marka'];
  const stan = stany ? ['Na stanie (szt.)'] : [];
  for (const [url, oczekiwane] of [
    ['/magazyn', [...wspolne, 'Kategoria', 'Cena', 'Kanały', ...stan]],
    ['/magazyn?widok=katalog', [...wspolne, ...definicjeKanalowHistoryczne.map((k) => k.etykieta), ...stan]],
  ]) {
    const html = await get(url);
    expect(naglowki(html)).toEqual(oczekiwane);
    expect(html).toContain(`colspan="${oczekiwane.length}" class="pusto"`);
    expect(html).not.toMatch(/porządk|pokaż ceny kanałów/i);
  }
});

it('formatuje cenę karty, osobne ceny kanałów, zero i brak ceny', async () => {
  const id = utworzKarte(db, { nazwa: 'Alfa', cena_gr: 123450 });
  utworzKarte(db, { nazwa: 'Beta' });
  utworzKarte(db, { nazwa: 'Gamma', cena_gr: 0 });
  const adres = 'https://polcien.example.invalid/produkt/alfa';
  for (const [indeks, cena_gr] of [
    [0, 234560],
    [1, null],
  ]) {
    const produkt = zapiszProduktSklepowy(db, {
      kanal: definicjeKanalowHistoryczne[indeks].klucz,
      produkt_id: 'alfa',
      nazwa: 'Alfa',
      cena_gr,
      adres,
      odczytane_at: '2026-01-01T00:00:00Z',
    });
    powiazProdukt(db, produkt, id);
  }
  const komorkiKarty = (html, nazwa) => komorki(html.split('<tr>').find((r) => r.includes(`>${nazwa}</a>`)));
  const produkty = await get();
  const indeksCeny = naglowki(produkty).indexOf('Cena');
  expect(indeksCeny).toBeGreaterThan(0);
  // Ołówek szybkiej zmiany ceny stoi w komórce za kwotą (konto testowe ma prawo edycji magazynu).
  expect(['Alfa', 'Beta', 'Gamma'].map((n) => tekst(komorkiKarty(produkty, n)[indeksCeny]))).toEqual([
    '1 234,50 zł ✎',
    '— ✎',
    '0,00 zł ✎',
  ]);
  const ceny = komorkiKarty(await get('/magazyn?widok=katalog'), 'Alfa').slice(4);
  expect(ceny.map(tekst)).toEqual(['2 345,60 zł', 'bez ceny', '—', '—']);
  expect(ceny[0]).toContain(`href="${adres}"`);
});

it.each([
  ['asc', ['Z tania', 'B droga', 'A bez ceny'], 'ascending', 'desc'],
  ['desc', ['B droga', 'Z tania', 'A bez ceny'], 'descending', 'asc'],
])('sortuje po cenie %s z pustymi na końcu', async (kier, oczekiwane, aria, odwrotny) => {
  utworzKarte(db, { nazwa: 'A bez ceny' });
  utworzKarte(db, { nazwa: 'B droga', cena_gr: 1000 });
  utworzKarte(db, { nazwa: 'Z tania', cena_gr: 99 });
  expect(kartyZKanalami(db, { sort: 'cena', kier }).map((k) => k.nazwa)).toEqual(oczekiwane);
  const html = await get(`/magazyn?sort=cena&kier=${kier}`);
  expect(wiersze(html)).toEqual(oczekiwane);
  expect(html).toMatch(
    new RegExp(`<th[^>]*aria-sort="${aria}"[^>]*>\\s*<a[^>]*sort=cena&amp;kier=${odwrotny}[^>]*>Cena`),
  );
  expect(wiersze(await get(`/magazyn?widok=katalog&sort=cena&kier=${kier}`))).toEqual(oczekiwane);
});

it('przenosi frazę, filtry, sortowanie i widoczną stronę przy zmianie zakładki', async () => {
  for (let i = 0; i < 101; i++) utworzKarte(db, { nazwa: `Półcień ${String(i).padStart(3, '0')}` });
  utworzKarte(db, { nazwa: 'Półcień z wymiarami', szerokosc_mm: 30, wysokosc_mm: 40 });
  const parametry = 'fraza=P%C3%B3%C5%82cie%C5%84&brak=wymiary&sort=nazwa&kier=desc';
  const produkty = await get(`/magazyn?${parametry}&strona=2`);
  const [produktyTab, cenyTab] = zakladki(produkty);
  expect([produktyTab.nazwa, cenyTab.nazwa]).toEqual(['Produkty', 'Ceny w kanałach']);
  expect([produktyTab.aktywna, cenyTab.aktywna]).toEqual([true, false]);
  expect(wiersze(produkty)).toEqual(['Półcień 000']);
  expect(produkty).toMatch(/<option value="wymiary" selected>bez wymiarów<\/option>/);
  expect(cenyTab.adres).toBe(`/magazyn?${parametry}&widok=katalog&strona=2`);
  const ceny = await get(cenyTab.adres);
  expect(wiersze(ceny)).toEqual(['Półcień 000']);
  expect(zakladki(ceny)).toEqual([
    { ...produktyTab, aktywna: false },
    { ...cenyTab, aktywna: true },
  ]);
  const [, zZaznaczeniem] = zakladki(await get(`/magazyn?${parametry}&zaznacz=1`));
  expect(zZaznaczeniem.adres).toBe(`/magazyn?${parametry}&widok=katalog&zaznacz=1`);
  const [powrot] = zakladki(await get(zZaznaczeniem.adres));
  expect(powrot.adres).toBe(`/magazyn?${parametry}&zaznacz=1`);
});

it('lista zakładek trasy nie wycieka do nagłówka ekranu jako „[object Object]”', async () => {
  utworzKarte(db, { nazwa: 'Półcień' });
  expect(await get('/magazyn')).not.toContain('[object Object]');
});
