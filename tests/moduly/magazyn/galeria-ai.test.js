import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
let db, app, katalog;
const lista = () => db.prepare('SELECT * FROM zdjecia_kart ORDER BY id').all();
const post = (id, payload = {}, headers = auth) =>
  app.inject({ method: 'POST', url: `/magazyn/1000/zdjecia/${id}/ai`, headers, payload });
function dodaj(ai = null, wyslane = null, zrodlo = 'allegro:demo', karta = 1000) {
  return Number(
    db
      .prepare(
        `INSERT INTO zdjecia_kart (karta_id,kolejnosc,zrodlo,adres_zrodlowy,utworzono_at,ai,wyslane_at)
    VALUES (?,0,?,?,'2026-11-13',?,?)`,
      )
      .run(karta, zrodlo, `https://obrazy.example/lampa-${lista().length}.png`, ai, wyslane).lastInsertRowid,
  );
}
function upload(ai, polePrzedPlikiem = false) {
  const png = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(png);
  png.writeUInt32BE(2, 16);
  png.writeUInt32BE(3, 20);
  const pole =
    ai === undefined
      ? Buffer.alloc(0)
      : Buffer.from(`--galeria\r\nContent-Disposition: form-data; name="ai"\r\n\r\n${ai}\r\n`);
  const plik = Buffer.concat([
    Buffer.from(
      '--galeria\r\nContent-Disposition: form-data; name="zdjecie"; filename="lampa.png"\r\nContent-Type: image/png\r\n\r\n',
    ),
    png,
    Buffer.from('\r\n'),
  ]);
  return app.inject({
    method: 'POST',
    url: '/magazyn/1000/zdjecia/wgraj',
    headers: { ...auth, 'content-type': 'multipart/form-data; boundary=galeria' },
    payload: Buffer.concat([...(polePrzedPlikiem ? [pole, plik] : [plik, pole]), Buffer.from('--galeria--\r\n')]),
  });
}
beforeEach(async () => {
  katalog = await mkdtemp(join(tmpdir(), 'galeria-ai-'));
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

it.each([false, true])('wgranie z AI zapisuje ręczne 1 niezależnie od kolejności pól (%s)', async (przed) => {
  expect((await upload('1', przed)).statusCode).toBe(303);
  expect(lista()[0]).toMatchObject({ ai: 1, ai_reczne: 1 });
});
it('wgranie bez pola zapisuje ręczne 0', async () => {
  expect((await upload()).statusCode).toBe(303);
  expect(lista()[0]).toMatchObject({ ai: 0, ai_reczne: 1 });
});
it.each(['allegro:demo', 'woo:demo', 'reczne'])(
  'zmienia znacznik przed wysyłką i zapisuje historię (%s)',
  async (zrodlo) => {
    const id = dodaj(0, null, zrodlo);
    expect((await post(id, { ai: '1' })).statusCode).toBe(303);
    expect(lista()[0]).toMatchObject({ ai: 1, ai_reczne: 1 });
    expect(
      db.prepare("SELECT * FROM karty_zrodla_pol WHERE karta_id=1000 AND pole LIKE 'zdjecie:%:ai'").get(),
    ).toMatchObject({ zrodlo: 'reczne', reczne: 1 });
    expect((await post(id)).statusCode).toBe(303);
    expect(lista()[0].ai).toBe(0);
  },
);
it('wgranie z jawnym 0 zapisuje ręczne 0, a złą wartość odrzuca bez zapisu', async () => {
  expect((await upload('2')).statusCode).toBe(400);
  expect(lista()).toEqual([]);
  expect((await upload('0')).statusCode).toBe(303);
  expect(lista()[0]).toMatchObject({ ai: 0, ai_reczne: 1 });
});
it('po wysyłce odmawia 409 po polsku bez zmiany ani historii', async () => {
  const id = dodaj(1, '2026-11-13');
  const r = await post(id);
  expect(r.statusCode).toBe(409);
  expect(r.body).toContain('wysłanego do kanału');
  expect(lista()[0]).toMatchObject({ ai: 1, ai_reczne: 0 });
  expect(db.prepare('SELECT * FROM karty_zrodla_pol').all()).toEqual([]);
});
it('odmawia cudzego zdjęcia i nieprawidłowej wartości bez zmian', async () => {
  const id = dodaj(),
    cudze = dodaj(0, null, 'woo:demo', 1001);
  expect((await post(cudze, { ai: '1' })).statusCode).toBe(404);
  expect((await post(id, { ai: 'bledne' })).statusCode).toBe(400);
  expect(lista().map((z) => z.ai)).toEqual([null, 0]);
});
it('odmawia bez CSRF i bez uprawnienia magazyn jak przy dodawaniu', async () => {
  const id = dodaj();
  expect((await post(id, { ai: '1' }, { authorization: auth.authorization })).statusCode).toBe(403);
  await app.ready();
  zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
  const konto = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
  ustawUprawnienia(db, konto, []);
  const headers = {
    origin: auth.origin,
    cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}`,
  };
  expect((await post(id, { ai: '1' }, headers)).statusCode).toBe(403);
  expect(lista()[0]).toMatchObject({ ai: null, ai_reczne: 0 });
});
it('galeria pokazuje stan importu, plakietki, domyślnie puste pole dodawania i blokadę po wysyłce', async () => {
  const ai = dodaj(1),
    zwykle = dodaj(0, null, 'woo:demo'),
    stare = dodaj(),
    wyslane = dodaj(1, '2026-11-13');
  const r = await app.inject({ url: '/magazyn/1000', headers: auth });
  expect(r.statusCode).toBe(200);
  const formularz = (id) =>
    r.body.match(new RegExp(`<form[^>]*action="/magazyn/1000/zdjecia/${id}/ai"[\\s\\S]*?</form>`))?.[0] ?? '';
  expect(r.body).toContain('>AI</span>');
  expect(r.body).toContain('AI: nieznane');
  expect(formularz(ai)).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
  expect(formularz(zwykle)).not.toContain('checked');
  expect(formularz(stare)).toContain('type="checkbox"');
  expect(formularz(ai)).not.toContain('disabled');
  expect(formularz(wyslane)).toMatch(/<input[^>]*type="checkbox"[^>]*disabled/);
  expect(formularz(wyslane)).toMatch(/<button[^>]*disabled/);
  expect(r.body).toContain(
    'Zdjęcie poszło już do kanału — Allegro przyjmuje oznaczenie AI tylko przy wgraniu, ERLI zachowuje je na zawsze',
  );
  const dodawanie = r.body.match(/<form[^>]*enctype="multipart\/form-data"[\s\S]*?<\/form>/)?.[0] ?? '';
  expect(dodawanie).toContain('Zdjęcie wygenerowane lub istotnie zmienione przez AI');
  expect(dodawanie).not.toContain('checked');
  expect(dodawanie).toContain('Allegro i ERLI dodadzą oznaczenie AI; po wysłaniu zdjęcia na rynek nie da się go zdjąć');
});

const json = { ...auth, accept: 'application/json' };
it('znacznik AI z Accept JSON oddaje zapisany stan, a odmowę po wysyłce jako JSON 409', async () => {
  const id = dodaj(0),
    wyslane = dodaj(1, '2026-11-13');
  const r = await post(id, { ai: '1' }, json);
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ id, ai: 1 });
  expect((await post(id, {}, json)).json()).toEqual({ id, ai: 0 });
  const odmowa = await post(wyslane, { ai: '0' }, json);
  expect(odmowa.statusCode).toBe(409);
  expect(odmowa.json()).toEqual({ blad: 'Nie można zmienić znacznika AI zdjęcia wysłanego do kanału.' });
  expect((await post(9999, { ai: '1' }, json)).statusCode).toBe(404);
});

it('dane galerii niosą kanały, w których jest zdjęcie, i zdanie ostrzeżenia przed usunięciem', async () => {
  await app.ready();
  const { daneGalerii } = await import('../../../src/moduly/magazyn/galeria.js');
  const definicje = [
    { klucz: 'allegro-polcien', typ: 'allegro', etykieta: 'Allegro Półcień' },
    { klucz: 'erli-polcien', typ: 'erli', etykieta: 'ERLI Półcień' },
    { klucz: 'erli-zapas', typ: 'erli', etykieta: 'ERLI zapas' },
  ];
  const tylkoKarta = dodaj(0),
    tylkoAllegro = dodaj(0, '2026-11-13T10:00:00Z'),
    tylkoErli = dodaj(0, '2026-11-13T09:00:00Z'),
    nieznane = dodaj(0, '2026-11-13T09:00:00Z', 'woo:demo', 1001);
  db.prepare(
    `INSERT INTO zdjecia_kart_allegro (zdjecie_id, konto, adres, ai, wgrano_at)
    VALUES (?, 'allegro-polcien', 'https://allegro.example/z.png', 0, '2026-11-13T10:00:00Z')`,
  ).run(tylkoAllegro);
  const oferta = db.prepare(
    `INSERT INTO oferty_kanalow (karta_id, kanal, id_zewnetrzne, pochodzenie, tryb, wyslany_skrot, utworzono_at, zmieniono_at)
    VALUES (?, ?, ?, 'oms', 'zarzadzana', ?, '2026-11-13', '2026-11-13')`,
  );
  oferta.run(1000, 'erli-polcien', 'e-1', 'skrot');
  oferta.run(1000, 'erli-zapas', 'e-2', null);
  oferta.run(1000, 'allegro-polcien', 'a-1', 'skrot');
  const galeria = new Map(daneGalerii(db, 1000, definicje).map((z) => [z.id, z]));
  expect(galeria.get(tylkoKarta)).toMatchObject({ kanaly: [], uwagaUsuwania: null });
  expect(galeria.get(tylkoAllegro).kanaly).toEqual(['Allegro Półcień', 'ERLI Półcień']);
  expect(galeria.get(tylkoErli).kanaly).toEqual(['ERLI Półcień']);
  expect(galeria.get(tylkoErli).uwagaUsuwania).toBe(
    'Zdjęcie jest w ofercie ERLI Półcień — zniknie z karty. W ofercie zarządzanej z OMS zdjęcie zniknie przy ' +
      'następnym przebiegu pętli ofert (chyba że treść jest zamrożona albo czeka). Oferty obserwowane i sklep Woo bez zmian.',
  );
  expect(galeria.get(tylkoAllegro).uwagaUsuwania).toMatch(/^Zdjęcie jest w ofertach Allegro Półcień, ERLI Półcień — /);
  // Zdjęcie wysłane, ale bez śladu konta (np. kanał usunięty z konfiguracji) nadal ostrzega.
  const obca = daneGalerii(db, 1001, definicje).find((z) => z.id === nieznane);
  expect(obca.kanaly).toEqual(['kanału']);
  expect(obca.uwagaUsuwania).toMatch(/^Zdjęcie jest w ofercie kanału — zniknie z karty\. /);
});
