import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { definicjeKanalowHistoryczne } from '../../pomoc/przykladowe-definicje-kanalow.js';
import { szyfrTestowy } from '../../pomoc/sejf-testowy.ts';

const fixture = JSON.parse(
  readFileSync(new URL('../../fixtures/allegro/e3-dok-slowniki.json', import.meta.url), 'utf8'),
);
const adres = `/magazyn/kategorie/${encodeURIComponent('Lampy')}/allegro`;
const headers = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
let db, app, dopasujKategorie, pobierzKategorie;
// GET /sale/categories/{id}: 257689 (z fixture, bez `leaf`) to liść, 257680 — nie.
const DRZEWO = {
  257689: { id: '257689', leaf: true },
  257680: { id: '257680', leaf: false },
  300: { id: '300', leaf: false },
};

beforeEach(async () => {
  db = openOmsDb(':memory:');
  dopasujKategorie = vi.fn();
  pobierzKategorie = vi.fn(async (id) => {
    if (!DRZEWO[id]) throw new Error('nie ma');
    return DRZEWO[id];
  });
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'atrapa' }, definicje: definicjeKanalowHistoryczne },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: {
      'kanaly.klienciKanalow': { 'allegro-polcien': { dopasujKategorie, pobierzKategorie } },
      'kanaly.repozytoriumKanalow': {
        listaTypu: (typ) =>
          typ === 'allegro'
            ? [{ klucz: 'allegro-polcien', nazwa: 'Półcień', autoryzacja: 'polaczone', srodowisko: 'produkcja' }]
            : [],
        zapisyZablokowane: () => false,
        konfliktKlucza: () => false,
      },
    },
  });
  await app.ready();
  const jwt = [
    'e323',
    Buffer.from(JSON.stringify({ scope: ['allegro:api:sale:offers:read'] })).toString('base64url'),
    'atrapa',
  ].join('.');
  db.prepare(
    `INSERT INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, refresh_wygasa_at, zaktualizowane_at)
    VALUES (?, ?, ?, '2027-01-01T00:00:00Z', '2027-01-01T00:00:00Z', '2026-11-14T10:00:00Z')`,
  ).run(
    'allegro-polcien',
    szyfrTestowy(db, 'tokeny_kanalu', 'access_token', 'allegro-polcien', jwt),
    szyfrTestowy(db, 'tokeny_kanalu', 'refresh_token', 'allegro-polcien', 'ATRAPA'),
  );
  db.prepare('INSERT INTO kategorie_kart (nazwa, utworzona_at) VALUES (?, ?)').run('Lampy', '2026-11-14T10:00:00Z');
});
afterEach(async () => {
  await app?.close();
  db?.close();
});

it('podpowiada tylko liście; brak `leaf` (kształt dokumentacji) sprawdza GET kategorii', async () => {
  dopasujKategorie.mockResolvedValue([
    { id: '257', name: 'Liść', leaf: true },
    { id: '256', name: 'Gałąź', leaf: false },
    ...fixture.kategorie.matchingCategories,
    { id: '300', name: 'Gałąź bez pola leaf' },
    { id: '404', name: 'Nieznana kategoria' },
  ]);
  const r = await app.inject({ url: adres, headers });
  expect(r.statusCode).toBe(200);
  expect(dopasujKategorie).toHaveBeenCalledWith('Lampy');
  expect([...r.body.matchAll(/name="kategoria_id" value="([^"]+)"/g)].map((m) => m[1])).toEqual(['257', '257689']);
  expect(pobierzKategorie.mock.calls.map((c) => c[0]).sort()).toEqual(['257689', '300', '404']);
});

it.each([
  ['same nie-liście', [{ id: '256', name: 'Gałąź', leaf: false }]],
  ['brak leaf, GET kategorii mówi nie-liść', [{ id: '300', name: 'Gałąź bez pola leaf' }]],
])('%s → puste podpowiedzi i dotychczasowy wybór ręczny', async (_opis, lista) => {
  dopasujKategorie.mockResolvedValue(lista);
  const r = await app.inject({ url: adres, headers });
  expect(r.statusCode).toBe(200);
  expect(dopasujKategorie).toHaveBeenCalledWith('Lampy');
  expect(r.body).not.toContain('name="kategoria_id"');
  expect(r.body).not.toContain('Podpowiedzi Allegro (tylko kategorie najniższego poziomu)');
  expect(r.body).toContain('Kategoria nieprzypisana w środowisku produkcja.');
  expect(r.body).toContain('Albo numer kategorii Allegro');
});

it('ta sama gałąź z kilku nazw sprawdzana raz; najwyżej 20 GET-ów kategorii na ekran', async () => {
  for (const n of ['Lampa A', 'Lampa B', 'Lampa C']) {
    db.prepare(
      `INSERT INTO karty_produktow (nazwa, kategoria_glowna, utworzony_at, zmieniony_at) VALUES (?, 'Lampy', '2026-11-14T10:00:00Z', '2026-11-14T10:00:00Z')`,
    ).run(n);
  }
  const galezie = Array.from({ length: 10 }, (_x, i) => ({ id: String(300 + i), name: `Gałąź ${i}` }));
  dopasujKategorie.mockImplementation(async (nazwa) =>
    nazwa === 'Lampa C' ? Array.from({ length: 30 }, (_x, i) => ({ id: String(500 + i), name: `Inna ${i}` })) : galezie,
  );
  const r = await app.inject({ url: adres, headers });
  expect(r.statusCode).toBe(200);
  expect(dopasujKategorie).toHaveBeenCalledTimes(4);
  expect(pobierzKategorie).toHaveBeenCalledTimes(20);
  expect(new Set(pobierzKategorie.mock.calls.map((c) => c[0])).size).toBe(20);
});
