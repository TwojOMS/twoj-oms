import { afterEach, beforeEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzKarte, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

const auth = { authorization: `Basic ${Buffer.from('operator:x').toString('base64')}`, origin: 'http://localhost' };
const SKLEP = 'sklep_polcien';
const ALLEGRO = 'allegro_polcien';
const ERLI = 'erli_polcien';
const ZDJ = 'https://sklep-polcien.example/wp-content/uploads/2026/11';
let db, app, id;

function przypnij(kanal, produktId, pola = {}) {
  const pid = zapiszProduktSklepowy(db, {
    kanal,
    produkt_id: produktId,
    nazwa: `Szablon Półcień ${produktId}`,
    cena_gr: 4690,
    odczytane_at: '2026-11-18',
    ...pola,
  });
  powiazProdukt(db, pid, id);
  return pid;
}

beforeEach(() => {
  db = openOmsDb(':memory:');
  id = utworzKarte(db, { nazwa: 'Pracownia Półcień — szablon liści' });
  app = buildOmsServer({
    db,
    config: {
      auth: { user: 'operator', pass: 'x' },
      sklepy: { [SKLEP]: {} },
      kanaly: { [ALLEGRO]: {} },
      definicje: [
        { klucz: SKLEP, typ: 'woo', etykieta: 'Sklep Półcień' },
        { klucz: ALLEGRO, typ: 'allegro', etykieta: 'Konto Półcień' },
        { klucz: ERLI, typ: 'erli', etykieta: 'ERLI Półcień' },
      ],
    },
    magazyn: { gotowy: () => true },
  });
});
afterEach(async () => {
  await app?.close();
  db.close();
});

const strona = async () => {
  const r = await app.inject({ url: `/magazyn/${id}`, headers: auth });
  expect(r.statusCode).toBe(200);
  return r.body;
};
// Tabela „Produkty i oferty” — jedyna `tab-pozycje` z nagłówkiem „Zdjęcia”.
const tabela = (html) => {
  const m = html.match(/<table class="tab-pozycje">\s*<thead><tr><th>Produkt<\/th>[^]*?<\/table>/);
  expect(m).not.toBeNull();
  return m[0];
};
const wiersze = (html) =>
  tabela(html)
    .match(/<tr>[^]*?<\/tr>/g)
    .slice(1);

it.each([
  [SKLEP, 'https://sklep-polcien.example/produkt/lisc', 'otwórz w sklepie'],
  [ALLEGRO, 'https://allegro.example/oferta/123', 'otwórz na Allegro'],
  [ERLI, 'https://erli.example/produkt/lisc', 'otwórz na ERLI'],
])('odnośnik kanału %s mówi, dokąd prowadzi', async (kanal, adres, napis) => {
  przypnij(kanal, '11', { adres });
  const html = tabela(await strona());
  expect(html).toContain(`<a href="${adres}" rel="noopener noreferrer" target="_blank">${napis}</a>`);
});

it('komórka ceny trzyma kwotę w jednej linii', async () => {
  przypnij(SKLEP, '12');
  const [wiersz] = wiersze(await strona());
  expect(wiersz).toMatch(/<td class="magazyn-kanal">46,90\s*zł<\/td>/);
});

it('zdjęcie bez adresu z lustra pokazuje oryginał, a nie zgadywane -150x150', async () => {
  przypnij(SKLEP, '13', {
    zdjecia_json: JSON.stringify([`${ZDJ}/lisc-1.jpg`, `${ZDJ}/lisc-2.jpg`, `${ZDJ}/lisc-3.jpg`]),
    miniatura: `${ZDJ}/lisc-1-300x300.jpg`,
  });
  const html = tabela(await strona());
  expect(html).not.toContain('-150x150');
  const src = [...html.matchAll(/<img\s+class="mini" src="([^"]+)"/g)].map((m) => m[1]);
  expect(src).toEqual([`${ZDJ}/lisc-1-300x300.jpg`, `${ZDJ}/lisc-2.jpg`, `${ZDJ}/lisc-3.jpg`]);
  expect(html.match(/width="38" height="38" loading="lazy"/g)?.length).toBe(3);
  expect(html).not.toContain('onerror');
});

it('bez żadnego pewnego adresu zdjęcia stoi kreska zamiast pustej ramki', async () => {
  przypnij(SKLEP, '14', { zdjecia_json: JSON.stringify(['javascript:alert(1)', '']) });
  const [wiersz] = wiersze(await strona());
  expect(wiersz).not.toContain('<img');
  expect(wiersz).toMatch(/<span class="magazyn-brak">—<\/span>/);
});
