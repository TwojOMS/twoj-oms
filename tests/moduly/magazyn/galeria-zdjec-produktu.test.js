import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';

const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
const url = '/magazyn/1000/zdjecia';
let db, app, katalog;
function png(w = 2) {
  const b = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(3, 20);
  return b;
}
function dodaj(
  karta = 1000,
  kolejnosc = 0,
  zrodlo = 'woo:demo',
  adres = `https://obrazy.example/${karta}-${kolejnosc}.png`,
) {
  return Number(
    db
      .prepare(
        `INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at)
    VALUES (?, ?, ?, ?, '2026-11-13')`,
      )
      .run(karta, kolejnosc, zrodlo, adres).lastInsertRowid,
  );
}
const lista = () => db.prepare('SELECT * FROM zdjecia_kart WHERE karta_id=1000 ORDER BY kolejnosc, id').all();
const reczne = () =>
  expect(db.prepare("SELECT reczne FROM karty_zrodla_pol WHERE karta_id=1000 AND pole='zdjecia'").get()?.reczne).toBe(
    1,
  );
const post = (sciezka, body = {}, headers = auth) =>
  app.inject({ method: 'POST', url: `${url}${sciezka}`, headers, payload: body });
const upload = (bufor = png(), nazwa = 'zdjecie.jpg', headers = auth) =>
  post(
    '/wgraj',
    Buffer.concat([
      Buffer.from(
        `--galeria\r\nContent-Disposition: form-data; name="zdjecie"; filename="${nazwa}"\r\nContent-Type: image/jpeg\r\n\r\n`,
      ),
      bufor,
      Buffer.from('\r\n--galeria--\r\n'),
    ]),
    { ...headers, 'content-type': 'multipart/form-data; boundary=galeria' },
  );

beforeEach(async () => {
  katalog = await mkdtemp(join(tmpdir(), 'galeria-07b-'));
  db = openOmsDb(':memory:');
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'atrapa' } },
    magazyn: {},
    env: { OMS_KATALOG_ZDJEC: katalog },
  });
  for (const id of [1000, 1001])
    db.prepare(
      `INSERT INTO karty_produktow (id,nazwa,utworzony_at,zmieniony_at)
    VALUES (?, 'Lampa testowa', '2026-11-13', '2026-11-13')`,
    ).run(id);
});
afterEach(async () => {
  await app?.close();
  db?.close();
  await rm(katalog, { recursive: true, force: true });
});

it('wgrywa po zawartości, deduplikuje sha na karcie i oznacza ręczną zmianę', async () => {
  expect((await upload()).statusCode).toBe(303);
  expect((await upload()).statusCode).toBe(303);
  expect(lista()).toHaveLength(1);
  expect(lista()[0]).toMatchObject({ zrodlo: 'reczne', typ: 'image/png', kolejnosc: 0 });
  expect(await readFile(join(katalog, lista()[0].plik))).toEqual(png());
  reczne();
});
it('to samo zdjęcie na drugiej karcie dostaje własny wiersz', async () => {
  expect((await upload()).statusCode).toBe(303);
  const r = await app.inject({
    method: 'POST',
    url: '/magazyn/1001/zdjecia/wgraj',
    headers: { ...auth, 'content-type': 'multipart/form-data; boundary=galeria' },
    payload: Buffer.concat([
      Buffer.from(
        '--galeria\r\nContent-Disposition: form-data; name="zdjecie"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n',
      ),
      png(),
      Buffer.from('\r\n--galeria--\r\n'),
    ]),
  });
  expect(r.statusCode).toBe(303);
  expect(
    db
      .prepare('SELECT karta_id FROM zdjecia_kart ORDER BY karta_id')
      .all()
      .map((z) => z.karta_id),
  ).toEqual([1000, 1001]);
});
it('odmawia 21. zdjęcia po polsku, bez zmiany galerii', async () => {
  for (let i = 0; i < 20; i++) dodaj(1000, i);
  const r = await upload();
  expect(r.statusCode).toBe(400);
  expect(r.body).toMatch(/20 zdjęć/);
  expect(lista()).toHaveLength(20);
});
it('duplikat jest dozwolony również przy pełnej galerii', async () => {
  expect((await upload()).statusCode).toBe(303);
  for (let i = 1; i < 20; i++) dodaj(1000, i);
  expect((await upload()).statusCode).toBe(303);
  expect(lista()).toHaveLength(20);
});
it('odmawia tekstu udającego jpg i nie zapisuje pliku ani wiersza', async () => {
  const r = await upload(Buffer.from('To jest tekst, nie obraz.'), 'udawany.jpg');
  expect(r.statusCode).toBe(400);
  expect(r.body).toMatch(/typ zdjęcia/);
  expect(lista()).toHaveLength(0);
  expect(await readdir(katalog)).toEqual([]);
});
it('odmawia pliku większego niż 10 MB', async () => {
  const r = await upload(Buffer.alloc(10 * 1024 * 1024 + 1));
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('10 MB');
  expect(lista()).toHaveLength(0);
});
it('zamienia tylko sąsiadów, również przy równych i nieciągłych numerach', async () => {
  const a = dodaj(1000, 4),
    b = dodaj(1000, 4, 'woo:demo', 'https://obrazy.example/remis.png'),
    c = dodaj(1000, 9);
  expect((await post('/kolejnosc', { zdjecieId: String(b), kierunek: 'prawo' })).statusCode).toBe(303);
  expect(lista().map((z) => z.id)).toEqual([a, c, b]);
  expect((await post('/kolejnosc', { zdjecieId: String(b), kierunek: 'lewo' })).statusCode).toBe(303);
  expect(lista().map((z) => z.id)).toEqual([a, b, c]);
  reczne();
});
it('usuwa wiersz, zachowuje plik i oznacza ręczną zmianę także po opróżnieniu galerii', async () => {
  await upload();
  const z = lista()[0];
  db.prepare("UPDATE karty_zrodla_pol SET zrodlo='woo:demo', reczne=0 WHERE karta_id=1000").run();
  expect((await post(`/${z.id}/usun`)).statusCode).toBe(303);
  expect(lista()).toHaveLength(0);
  expect(await readFile(join(katalog, z.plik))).toEqual(png());
  reczne();
});
it('cudze zdjęcie: usuwanie i kolejność odmawiają 404, bez zmian', async () => {
  const cudze = dodaj(1001);
  expect((await post(`/${cudze}/usun`)).statusCode).toBe(404);
  expect((await post('/kolejnosc', { zdjecieId: String(cudze), kierunek: 'lewo' })).statusCode).toBe(404);
  expect(db.prepare('SELECT id FROM zdjecia_kart WHERE id=?').get(cudze)).toBeTruthy();
  expect(db.prepare('SELECT * FROM karty_zrodla_pol WHERE karta_id=1000').all()).toEqual([]);
});
it('odmawia nieznanej karcie i nieprawidłowemu kierunkowi', async () => {
  const id = dodaj();
  expect((await post('/kolejnosc', { zdjecieId: String(id), kierunek: 'gora' })).statusCode).toBe(400);
  expect(
    (await app.inject({ method: 'POST', url: '/magazyn/9999/zdjecia/wgraj', headers: auth, payload: {} })).statusCode,
  ).toBe(404);
});
it('wszystkie POST-y mają CSRF i uprawnienie magazyn: 403 bez zmiany danych', async () => {
  const id = dodaj();
  const akcje = [
    (h) => post('/kolejnosc', { zdjecieId: String(id), kierunek: 'prawo' }, h),
    (h) => post(`/${id}/usun`, {}, h),
    (h) => upload(png(), 'x.jpg', h),
  ];
  for (const akcja of akcje) expect((await akcja({ authorization: auth.authorization })).statusCode).toBe(403);
  await app.ready();
  zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
  const konto = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
  ustawUprawnienia(db, konto, []);
  const headers = {
    origin: auth.origin,
    cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}`,
  };
  for (const akcja of akcje) expect((await akcja(headers)).statusCode).toBe(403);
  expect(lista()).toHaveLength(1);
});
it('widok ma uporządkowane miniatury, bezpieczne adresy, źródła i formularze bez JS', async () => {
  db.prepare("INSERT INTO magazyn_przelaczenia (wlaczone, utworzono_at) VALUES (1, '2026-11-13')").run();
  dodaj(1000, 3, 'allegro:demo', 'https://obrazy.example/drugie.png');
  dodaj(1000, 0, 'woo:demo', 'http://obrazy.example/pierwsze.png');
  dodaj(1000, 4, 'reczne', 'javascript:alert(1)');
  const r = await app.inject({ url: '/magazyn/1000', headers: auth });
  expect(r.statusCode).toBe(200);
  const sekcja = r.body.match(/<section class="panel" id="zdjecia-karty">[\s\S]*?<\/section>/)?.[0] ?? '';
  expect(sekcja).toContain('3 z 20');
  expect(sekcja).toContain('z Allegro');
  expect(sekcja).toContain('ze sklepu');
  expect(sekcja).toContain('wgrane');
  expect(sekcja.indexOf('pierwsze.png')).toBeLessThan(sekcja.indexOf('drugie.png'));
  expect(sekcja).not.toContain('javascript:');
  expect(sekcja).toContain('loading="lazy"');
  expect(sekcja).toContain('alt="Lampa testowa"');
  expect(sekcja).toContain('width=');
  expect(sekcja).toContain('height=');
  expect(sekcja).toContain('enctype="multipart/form-data"');
  expect(r.body.indexOf('id="zdjecia-karty"')).toBeLessThan(r.body.indexOf('id="stan-karty"'));
});
it('galeria jest widoczna także przy wyłączonych stanach magazynowych', async () => {
  const r = await app.inject({ url: '/magazyn/1000', headers: auth });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('id="zdjecia-karty"');
  expect(r.body).toContain('0 z 20');
  expect(r.body).not.toContain('id="stan-karty"');
});

it('etykieta źródła zdjęcia: Allegro, sklep, API i wgrane', async () => {
  const { daneGalerii } = await import('../../../src/moduly/magazyn/galeria.js');
  const wiersze = ['allegro:konto', 'woo:sklep', 'api', 'reczne'].map((zrodlo, kolejnosc) => ({
    zrodlo,
    kolejnosc,
    adres_zrodlowy: 'https://example.org/a.png',
  }));
  const atrapa = { prepare: () => ({ all: () => wiersze }) };
  expect(daneGalerii(atrapa, 1).map((z) => z.etykieta)).toEqual(['z Allegro', 'ze sklepu', 'przez API', 'wgrane']);
});

const json = { ...auth, accept: 'application/json' };
const pelna = (ids, headers = auth) =>
  app.inject({
    method: 'POST',
    url: `${url}/kolejnosc`,
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(ids.map((id) => ['kolejnosc', String(id)])).toString(),
  });
it('pełna lista ustawia kolejność permutacji i oznacza ręczną zmianę', async () => {
  const a = dodaj(1000, 0),
    b = dodaj(1000, 1),
    c = dodaj(1000, 7);
  const r = await pelna([c, a, b]);
  expect(r.statusCode).toBe(303);
  expect(r.headers.location).toBe('/magazyn/1000#zdjecia-karty');
  expect(lista().map((z) => [z.id, z.kolejnosc])).toEqual([
    [c, 0],
    [a, 1],
    [b, 2],
  ]);
  reczne();
});
it('pełna lista z Accept JSON oddaje nową kolejność, jedno zdjęcie też przechodzi', async () => {
  const a = dodaj(1000, 0),
    b = dodaj(1000, 1);
  const r = await pelna([b, a], json);
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ kolejnosc: [b, a] });
  db.prepare('DELETE FROM zdjecia_kart WHERE id = ?').run(a);
  expect((await pelna([b], json)).json()).toEqual({ kolejnosc: [b] });
});
it.each([
  ['obce id', (a, b, c, cudze) => [a, b, cudze]],
  ['brakujące id', (a, b) => [b, a]],
  ['powtórzone id', (a, b) => [a, b, b]],
  ['nadmiarowe id', (a, b, c, cudze) => [c, b, a, cudze]],
  ['nieliczbowe id', (a, b) => [a, b, 'x']],
  ['pusta lista', () => ['']],
])('pełna lista: %s → 409 bez zmian, także w JSON', async (_, ids) => {
  const a = dodaj(1000, 0),
    b = dodaj(1000, 1),
    c = dodaj(1000, 2),
    cudze = dodaj(1001, 0);
  const przed = lista();
  const r = await pelna(ids(a, b, c, cudze));
  expect(r.statusCode).toBe(409);
  expect(r.body).toContain('Galeria zmieniła się — odśwież');
  const j = await pelna(ids(a, b, c, cudze), json);
  expect(j.statusCode).toBe(409);
  expect(j.json()).toEqual({ blad: 'Galeria zmieniła się — odśwież stronę.' });
  expect(lista()).toEqual(przed);
  expect(db.prepare('SELECT * FROM karty_zrodla_pol WHERE karta_id=1000').all()).toEqual([]);
});
it('pełna lista dla nieznanej karty odmawia 404', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/magazyn/9999/zdjecia/kolejnosc',
    headers: { ...json, 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'kolejnosc=1',
  });
  expect(r.statusCode).toBe(404);
  expect(r.json()).toEqual({ blad: 'Nie ma takiej karty produktu.' });
});
it('stara postać lewo/prawo z Accept JSON oddaje kolejność, a błędy jako JSON', async () => {
  const a = dodaj(1000, 0),
    b = dodaj(1000, 1);
  const r = await post('/kolejnosc', { zdjecieId: String(a), kierunek: 'prawo' }, json);
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ kolejnosc: [b, a] });
  const zly = await post('/kolejnosc', { zdjecieId: String(a), kierunek: 'gora' }, json);
  expect(zly.statusCode).toBe(400);
  expect(zly.json()).toEqual({ blad: 'Wybierz przesunięcie w lewo albo w prawo.' });
});
