import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { pluginApiV1 } from '../../../src/moduly/api/plugin.js';
import { migracjaKartApi } from '../../../src/moduly/rdzen/migracje/0011-karty-api.ts';

let db, app;
beforeEach(async () => {
  db = openOmsDb();
  migracjaKartApi.wykonaj(db);
  const wstaw = db.prepare(`INSERT INTO karty_produktow
    (id, sku, nazwa, opis, kategoria_glowna, utworzony_at, zmieniony_at, wycofana,
     ean, cena_gr, stawka_vat, szerokosc_mm, wysokosc_mm, glebokosc_mm, waga_g)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0000000000000', 1234, '23', 10, 20, 30, 40)`);
  for (const [id, sku, kat, data, wycofana] of [
    [1, ' ABC ', 'Dekoracje', '2026-11-01 10:00:00', 0],
    [4, 'żółć', 'Dekoracje', '2026-11-02T10:00:00Z', 0],
    [9, 'ABC-2', 'Papier', '2026-11-03T12:00:00+02:00', 0],
    [15, 'ABC', 'Papier', '2026-11-04T10:00:00Z', 1],
  ]) wstaw.run(id, sku, 'Próbka 🌙', 'Pracownia Półcień', kat, '2026-10-01 12:00:00', data, wycofana);
  const produkt = db.prepare(`INSERT INTO produkty_sklepowe
    (kanal, produkt_id, nazwa, karta_id, cena_gr, zdjecia_json, miniatura, odczytane_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '2026-11-01T10:00:00Z')`);
  produkt.run('sklep-testowy', 'p-123', 'Próbka sklepowa', 4, 2345,
    JSON.stringify([' https://example.test/oryginal.jpg ', 'javascript:alert(1)', '//example.test/a', 12, 'http://example.test/drugie.png']),
    'https://example.test/miniatura.jpg');
  produkt.run('drugi-testowy', 'p-9', 'Inna próbka', 9, null, 'zepsuty JSON', null);
  produkt.run('inny-testowy', 'p-4', 'Zniknięta próbka', 4, null, '[]', null);
  db.prepare('UPDATE produkty_sklepowe SET zniknal_at = ? WHERE produkt_id = ?').run('2026-11-02T00:00:00Z', 'p-4');
  app = Fastify();
  app.register(async api => {
    api.addHook('onRequest', async req => {
      if (req.headers.authorization === 'Bearer testowy') req.kluczApi = {
        id: 1, zakresy: new Set(req.headers['x-bez-zakresu'] ? [] : ['produkty:odczyt']),
      };
    });
    await api.register(pluginApiV1, { ctx: { db, teraz: () => new Date() } });
  }, { prefix: '/api/v1' });
  await app.ready();
});
afterEach(async () => { await app.close(); db.close(); });
const get = (url, headers = {}) => app.inject({ url: `/api/v1/produkty${url}`, headers: { authorization: 'Bearer testowy', ...headers } });
const ids = r => r.json().pozycje.map(p => p.id);

it('wymaga klucza i zakresu na obu trasach', async () => {
  for (const url of ['', '/4']) {
    const bez = await app.inject(`/api/v1/produkty${url}`);
    expect(bez.statusCode).toBe(401); expect(bez.json().kod).toBe('klucz');
    const brakZakresu = await get(url, { 'x-bez-zakresu': '1' });
    expect(brakZakresu.statusCode).toBe(403); expect(brakZakresu.json().kod).toBe('brak_zakresu');
  }
});
it('stronicuje po id z dziurami i domyślnie ukrywa wycofane', async () => {
  const a = (await get('?ile=2')).json();
  const b = (await get(`?ile=2&po=${a.nastepny}`)).json();
  expect([a.pozycje.map(p => p.id), a.nastepny, b.pozycje.map(p => p.id), b.nastepny]).toEqual([[1, 4], 4, [9], null]);
  expect(ids(await get(''))).toEqual([1, 4, 9]);
  expect(a.pozycje[1].w_sklepach[0].id_w_sklepie).toBe('p-123');
});
it('filtruje SKU dokładnie po trim i wielkich literach, także polskich', async () => {
  expect(ids(await get('?sku=%20abc%20'))).toEqual([1]);
  expect(ids(await get('?sku=%20%C5%BB%C3%93%C5%81%C4%86%20'))).toEqual([4]);
});
it('łączy dokładną kategorię, datę ISO i wycofanie', async () => {
  expect(ids(await get('?kategoria=Dekoracje'))).toEqual([1, 4]);
  expect(ids(await get('?kategoria=dekoracje'))).toEqual([]);
  expect(ids(await get('?zmienione_od=2026-11-03T11:00:00%2B01:00'))).toEqual([9]);
  expect(ids(await get('?wycofane=tak'))).toEqual([15]);
  expect(ids(await get('?wycofane=nie'))).toEqual([1, 4, 9]);
  expect(ids(await get('?wycofane=wszystkie'))).toEqual([1, 4, 9, 15]);
  expect(ids(await get('?wycofane=wszystkie&sku=abc&kategoria=Papier&zmienione_od=2026-11-04T10:00:00Z'))).toEqual([15]);
});
it('odrzuca błędne filtry i stronicowanie', async () => {
  for (const q of ['wycofane=', 'wycofane=inaczej', 'zmienione_od=abc', 'zmienione_od=2026-02-30T12:00:00Z', 'zmienione_od=2026-11-01', 'zmienione_od=2026-11-01T12:00:00']) {
    const r = await get(`?${q}`); expect(r.statusCode).toBe(400); expect(r.json().kod).toBe('filtr');
  }
  for (const q of ['ile=0', 'ile=201', 'ile=abc']) expect((await get(`?${q}`)).statusCode).toBe(400);
});
it('powtórzony parametr sku albo kategoria to 400 filtr, nie 500', async () => {
  for (const q of ['sku=abc&sku=ABC-2', 'kategoria=Papier&kategoria=Dekoracje']) {
    const r = await get(`?${q}`); expect(r.statusCode).toBe(400); expect(r.json().kod).toBe('filtr');
  }
});
it('zwraca pełną kartę, oryginały zdjęć przez bramkę adresów i ETag', async () => {
  const r = await get('/4');
  expect(r.statusCode).toBe(200);
  expect(r.headers.etag).toBe('"2026-11-02T10:00:00Z"');
  expect(r.json()).toEqual({ id: 4, sku: 'żółć', nazwa: 'Próbka 🌙', opis: 'Pracownia Półcień',
    ean: '0000000000000', cena_gr: 1234, stawka_vat: '23', kategoria: 'Dekoracje',
    wymiary: { szerokosc_mm: 10, wysokosc_mm: 20, glebokosc_mm: 30 }, waga_g: 40, wycofana: false,
    utworzony_at: '2026-10-01T12:00:00.000Z', zmieniony_at: '2026-11-02T10:00:00.000Z',
    w_sklepach: [{ kanal: 'sklep-testowy', id_w_sklepie: 'p-123', nazwa: 'Próbka sklepowa', cena_gr: 2345,
      dostepna_w_sklepie: true, zdjecia: ['https://example.test/oryginal.jpg', 'http://example.test/drugie.png'] },
    { kanal: 'inny-testowy', id_w_sklepie: 'p-4', nazwa: 'Zniknięta próbka', cena_gr: null, dostepna_w_sklepie: false, zdjecia: [] }],
  });
  expect((await get('/9')).json().w_sklepach[0].zdjecia).toEqual([]);
  expect((await get('/15')).json().wycofana).toBe(true);
  expect((await get('/1')).json().w_sklepach).toEqual([]);
});
it('oznacza obie oferty na liście i w szczegółach', async () => {
  const lista = (await get('')).json().pozycje.find(p => p.id === 4);
  const szczegoly = (await get('/4')).json();
  for (const karta of [lista, szczegoly]) {
    expect(karta.w_sklepach.map(p => [p.id_w_sklepie, p.dostepna_w_sklepie])).toEqual([['p-123', true], ['p-4', false]]);
  }
});
it('zwraca 404 dla nieistniejącej lub nieprawidłowej karty', async () => {
  for (const id of ['999', 'abc', '0', '9007199254740993']) {
    const r = await get(`/${id}`); expect(r.statusCode).toBe(404); expect(r.json().kod).toBe('brak');
  }
});
