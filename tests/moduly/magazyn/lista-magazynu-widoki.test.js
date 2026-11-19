import { afterEach, beforeEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { dzienWarszawa } from '../../../src/domena/format-daty.js';
import { zapiszCeneZakupu } from '../../../src/oms/db/ceny-zakupu.js';
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
const wierszKarty = (html, nazwa) => html.split('<tr>').find((r) => r.includes(`>${nazwa}</a>`));
const komorkiKarty = (html, nazwa) => komorki(wierszKarty(html, nazwa));

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
    ['/magazyn', [...wspolne, 'Kategoria', ...stan, 'Cena', 'Kanały']],
    [
      '/magazyn?widok=katalog',
      [...wspolne, 'Cena zakupu netto', 'VAT', ...stan, ...definicjeKanalowHistoryczne.map((k) => k.etykieta)],
    ],
  ]) {
    const html = await get(url);
    expect(naglowki(html)).toEqual(oczekiwane);
    expect(html).toContain(`colspan="${oczekiwane.length}" class="pusto"`);
    expect(html).not.toMatch(/porządk|pokaż ceny kanałów/i);
  }
});

it('stawia komórkę stanu bezpośrednio przed ceną produktu', async () => {
  przelaczStany(db, { wlacz: true });
  utworzKarte(db, { nazwa: 'Alfa', cena_gr: 12000 });
  const wiersz = wierszKarty(await get(), 'Alfa');
  expect(wiersz).toMatch(/<td class="liczba kol-na-stanie[^>]*>0<\/td>\s*<td\b[^>]*data-szybka-cena\b/);
});

it('pokazuje obowiązującą cenę zakupu i pomija przyszłe wpisy', async () => {
  const historia = utworzKarte(db, { nazwa: 'Alfa' });
  const tylkoPrzyszla = utworzKarte(db, { nazwa: 'Beta' });
  utworzKarte(db, { nazwa: 'Gamma' });
  const teraz = Date.now();
  const zapisz = (id, gr, przesuniecie) => {
    const od = dzienWarszawa(new Date(teraz + przesuniecie * 86_400_000).toISOString());
    zapiszCeneZakupu(db, id, { gr, od }, { zrodlo: 'karta' });
  };
  zapisz(historia, 3500, -90);
  zapisz(historia, 4500, -30);
  zapisz(historia, 5500, 30);
  zapisz(tylkoPrzyszla, 6500, 30);

  const html = await get('/magazyn?widok=katalog');
  const indeks = naglowki(html).indexOf('Cena zakupu netto');
  expect(indeks).toBeGreaterThan(0);
  expect(['Alfa', 'Beta', 'Gamma'].map((nazwa) => komorkiKarty(html, nazwa)[indeks].trim())).toEqual([
    '45,00 zł',
    '<span class="magazyn-brak">—</span>',
    '<span class="magazyn-brak">—</span>',
  ]);
});

it('pokazuje stawkę VAT karty albo kreskę przy jej braku', async () => {
  utworzKarte(db, { nazwa: 'Alfa', stawka_vat: '23' });
  utworzKarte(db, { nazwa: 'Beta', stawka_vat: '8' });
  utworzKarte(db, { nazwa: 'Gamma', stawka_vat: null });

  const html = await get('/magazyn?widok=katalog');
  const indeks = naglowki(html).indexOf('VAT');
  expect(indeks).toBeGreaterThan(0);
  expect(['Alfa', 'Beta', 'Gamma'].map((nazwa) => tekst(komorkiKarty(html, nazwa)[indeks]))).toEqual([
    '23%',
    '8%',
    '—',
  ]);
});

it.each([false, true])('układa komórki cen i VAT przed kanałami (stany: %s)', async (stany) => {
  if (stany) przelaczStany(db, { wlacz: true });
  const id = utworzKarte(db, { nazwa: 'Alfa', marka: 'Półcień', stawka_vat: '23' });
  zapiszCeneZakupu(db, id, { gr: 4500, od: dzienWarszawa(new Date().toISOString()) }, { zrodlo: 'karta' });
  const produkt = zapiszProduktSklepowy(db, {
    kanal: definicjeKanalowHistoryczne[0].klucz,
    produkt_id: 'alfa',
    nazwa: 'Alfa',
    cena_gr: 12000,
    odczytane_at: '2026-01-01T00:00:00Z',
  });
  powiazProdukt(db, produkt, id);

  const komorki = komorkiKarty(await get('/magazyn?widok=katalog'), 'Alfa');
  expect(komorki.slice(3, stany ? 8 : 7).map(tekst)).toEqual([
    'Półcień',
    '45,00 zł',
    '23%',
    ...(stany ? ['0'] : []),
    '120,00 zł',
  ]);
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
  const produkty = await get();
  const indeksCeny = naglowki(produkty).indexOf('Cena');
  expect(indeksCeny).toBeGreaterThan(0);
  // Ołówek szybkiej zmiany ceny stoi w komórce za kwotą (konto testowe ma prawo edycji magazynu).
  expect(['Alfa', 'Beta', 'Gamma'].map((n) => tekst(komorkiKarty(produkty, n)[indeksCeny]))).toEqual([
    '1 234,50 zł ✎',
    '— ✎',
    '0,00 zł ✎',
  ]);
  const ceny = komorkiKarty(await get('/magazyn?widok=katalog'), 'Alfa').slice(6);
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
