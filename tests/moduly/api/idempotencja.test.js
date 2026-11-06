// PRZ-153.E5.1 — nagłówek Idempotency-Key na zapisach /api/v1 (plan PRZ-153, E5.1 i Review Focus pkt 3).
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { pluginApiV1 } from '../../../src/moduly/api/plugin.js';
import { modulApi } from '../../../src/moduly/api/modul.ts';
import { zIdempotencja } from '../../../src/moduly/api/idempotencja.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';

const TERAZ = new Date('2026-11-06T10:00:00.000Z');
const sprzatanie = [];
afterEach(async () => { for (const f of sprzatanie.splice(0).reverse()) await f(); });

function baza() {
  const db = openOmsDb(':memory:');
  sprzatanie.push(() => db.close());
  return db;
}
const liczbaKart = (db) => db.prepare('SELECT COUNT(*) AS n FROM karty_produktow').get().n;
const wpisy = (db) => db.prepare('SELECT klucz_id, klucz_zadania, trasa, status, cialo, at FROM api_idempotencja ORDER BY klucz_id, klucz_zadania').all();

// Trasy testowe w pluginie /api/v1; klucz API przypięty jak przez strażnika (id z nagłówka testowego).
function serwer(db) {
  const licznik = { karty: 0, awaria: 0, piecset: 0 };
  const zalozKarte = (nazwa) => {
    licznik.karty++;
    const id = Number(db.prepare(`INSERT INTO karty_produktow (nazwa, utworzony_at, zmieniony_at) VALUES (?, ?, ?)`)
      .run(nazwa, TERAZ.toISOString(), TERAZ.toISOString()).lastInsertRowid);
    return { status: 201, cialo: { id, nazwa, wykonanie: licznik.karty } };
  };
  const app = Fastify();
  sprzatanie.push(() => app.close());
  app.register(async (api) => {
    api.addHook('onRequest', async (req) => {
      const id = Number(req.headers['x-test-klucz'] ?? 1);
      req.kluczApi = { id, nazwa: 'integracja testowa', prefiks: 'abcdefgh', zakresy: new Set(['produkty:zapis']) };
    });
    await pluginApiV1(api, { ctx: { db, teraz: () => TERAZ } });
    const opcje = { teraz: () => TERAZ };
    api.post('/karty', (req, reply) => zIdempotencja(db, req, reply, 'POST /karty',
      () => zalozKarte(req.body?.nazwa ?? 'Lampa Półcień'), opcje));
    api.post('/inna', (req, reply) => zIdempotencja(db, req, reply, 'POST /inna',
      () => zalozKarte('inna'), opcje));
    for (const status of [400, 404, 409, 422]) {
      api.post(`/wynik-${status}`, (req, reply) => zIdempotencja(db, req, reply, `POST /wynik-${status}`, () => {
        const { cialo } = zalozKarte(`przed ${status}`);
        return { status, cialo };
      }, opcje));
    }
    api.post('/awaria', (req, reply) => zIdempotencja(db, req, reply, 'POST /awaria', () => {
      licznik.awaria++;
      const wynik = zalozKarte('po awarii');
      if (licznik.awaria === 1) throw new Error('atrapa: zerwane połączenie z bazą');
      return wynik;
    }, opcje));
    api.post('/piecset', (req, reply) => zIdempotencja(db, req, reply, 'POST /piecset', () => {
      licznik.piecset++;
      if (licznik.piecset === 1) {
        zalozKarte('przed 500');
        return { status: 500, cialo: { kod: 'blad', powod: 'Błąd serwera.' } };
      }
      return zalozKarte('po 500');
    }, opcje));
    api.post('/bez-ciala', (req, reply) => zIdempotencja(db, req, reply, 'POST /bez-ciala', () => {
      zalozKarte('bez ciała');
      return { status: 204 };
    }, opcje));
  }, { prefix: '/api/v1' });
  return { app, licznik };
}

const post = (app, url, klucz, dodatkowe = {}) => app.inject({
  method: 'POST', url, payload: { nazwa: 'Lampa Półcień 🌙' },
  headers: { ...(klucz === undefined ? {} : { 'idempotency-key': klucz }), ...dodatkowe },
});

describe('zIdempotencja', () => {
  it('dwa POST z tym samym kluczem → jedno wykonanie, jedna karta, identyczny status, ciało i typ', async () => {
    const db = baza();
    const { app, licznik } = serwer(db);
    const a = await post(app, '/api/v1/karty', 'zadanie-1');
    const b = await post(app, '/api/v1/karty', 'zadanie-1');
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.body).toBe(a.body);
    expect(b.headers['content-type']).toBe(a.headers['content-type']);
    expect(a.json()).toEqual({ id: 1, nazwa: 'Lampa Półcień 🌙', wykonanie: 1 });
    expect(licznik.karty).toBe(1);
    expect(liczbaKart(db)).toBe(1);
    expect(wpisy(db)).toEqual([{ klucz_id: 1, klucz_zadania: 'zadanie-1', trasa: 'POST /karty', status: 201,
      cialo: a.body, at: TERAZ.toISOString() }]);
  });

  it('bez nagłówka każde wywołanie wykonuje się i nic nie jest zapisane', async () => {
    const db = baza();
    const { app, licznik } = serwer(db);
    expect((await post(app, '/api/v1/karty')).statusCode).toBe(201);
    expect((await post(app, '/api/v1/karty')).statusCode).toBe(201);
    expect(licznik.karty).toBe(2);
    expect(wpisy(db)).toEqual([]);
  });

  it.each([404, 409])('%i nie jest zapamiętane i wycofuje także zapis trasy; powtórka wykonuje się od nowa', async (status) => {
    const db = baza();
    const { app, licznik } = serwer(db);
    const a = await post(app, `/api/v1/wynik-${status}`, `k-${status}`);
    expect(a.statusCode).toBe(status);
    expect(wpisy(db)).toEqual([]);
    expect(liczbaKart(db)).toBe(0);
    const b = await post(app, `/api/v1/wynik-${status}`, `k-${status}`);
    expect(b.statusCode).toBe(status);
    expect(b.json().wykonanie).toBe(2);
    expect(licznik.karty).toBe(2);
    expect(wpisy(db)).toEqual([]);
    expect(liczbaKart(db)).toBe(0);
  });

  it.each([400, 422])('%i jest zapamiętane wraz z zapisem trasy; powtórka nie wykonuje się ponownie', async (status) => {
    const db = baza();
    const { app, licznik } = serwer(db);
    const a = await post(app, `/api/v1/wynik-${status}`, `k-${status}`);
    const b = await post(app, `/api/v1/wynik-${status}`, `k-${status}`);
    expect([a.statusCode, b.statusCode]).toEqual([status, status]);
    expect(b.body).toBe(a.body);
    expect(licznik.karty).toBe(1);
    expect(liczbaKart(db)).toBe(1);
    expect(wpisy(db)).toEqual([expect.objectContaining({ status, cialo: a.body })]);
  });

  it('ten sam klucz na innej trasie → 422 kod idempotencja, bez wykonania', async () => {
    const db = baza();
    const { app, licznik } = serwer(db);
    expect((await post(app, '/api/v1/karty', 'wspolny')).statusCode).toBe(201);
    const r = await post(app, '/api/v1/inna', 'wspolny');
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ kod: 'idempotencja', powod: expect.any(String) });
    expect(licznik.karty).toBe(1);
    expect(liczbaKart(db)).toBe(1);
    expect(wpisy(db).map((w) => w.trasa)).toEqual(['POST /karty']);
  });

  it('wyjątek w wykonaj → 500, nic nie zapisane (także karta), powtórka wykonuje się i zakłada kartę', async () => {
    const db = baza();
    const { app, licznik } = serwer(db);
    const a = await post(app, '/api/v1/awaria', 'po-awarii');
    expect(a.statusCode).toBe(500);
    expect(a.json()).toMatchObject({ kod: 'blad' });
    expect(wpisy(db)).toEqual([]);
    expect(liczbaKart(db)).toBe(0);
    const b = await post(app, '/api/v1/awaria', 'po-awarii');
    expect(b.statusCode).toBe(201);
    expect(licznik.awaria).toBe(2);
    expect(liczbaKart(db)).toBe(1);
    const c = await post(app, '/api/v1/awaria', 'po-awarii');
    expect(c.body).toBe(b.body);
    expect(licznik.awaria).toBe(2);
  });

  it('wynik bez ciała (204) zapisuje pracę i powtórkę, bez 500', async () => {
    const db = baza();
    const { app, licznik } = serwer(db);
    const a = await post(app, '/api/v1/bez-ciala', 'k-204');
    const b = await post(app, '/api/v1/bez-ciala', 'k-204');
    expect([a.statusCode, b.statusCode]).toEqual([204, 204]);
    expect(licznik.karty).toBe(1);
    expect(liczbaKart(db)).toBe(1);
  });

  it('wynik 500 nie jest zapamiętany: powtórka wykonuje się od nowa', async () => {
    const db = baza();
    const { app, licznik } = serwer(db);
    const a = await post(app, '/api/v1/piecset', 'k-500');
    expect(a.statusCode).toBe(500);
    expect(liczbaKart(db)).toBe(0);
    expect(wpisy(db)).toEqual([]);
    const b = await post(app, '/api/v1/piecset', 'k-500');
    expect(b.statusCode).toBe(201);
    expect(licznik.piecset).toBe(2);
    expect(liczbaKart(db)).toBe(1);
  });

  it('dwa różne klucze API z tym samym Idempotency-Key nie kolidują', async () => {
    const db = baza();
    const { app, licznik } = serwer(db);
    const a = await post(app, '/api/v1/karty', 'ten-sam', { 'x-test-klucz': '7' });
    const b = await post(app, '/api/v1/karty', 'ten-sam', { 'x-test-klucz': '8' });
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().id).not.toBe(b.json().id);
    expect(licznik.karty).toBe(2);
    expect(wpisy(db).map((w) => [w.klucz_id, w.klucz_zadania])).toEqual([[7, 'ten-sam'], [8, 'ten-sam']]);
  });

  it('pusty albo dłuższy niż 200 znaków klucz → 400 kod idempotencja, bez wykonania; 200 znaków przechodzi', async () => {
    const db = baza();
    const { app, licznik } = serwer(db);
    for (const klucz of ['', 'x'.repeat(201)]) {
      const r = await post(app, '/api/v1/karty', klucz);
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ kod: 'idempotencja', powod: expect.any(String) });
    }
    expect(licznik.karty).toBe(0);
    expect((await post(app, '/api/v1/karty', 'x'.repeat(200))).statusCode).toBe(201);
    expect(licznik.karty).toBe(1);
  });
});

describe('zegar modułu api — sprzątanie idempotencji', () => {
  it('usuwa wpisy starsze niż 7 dni, zostawia młodsze', async () => {
    const db = baza();
    const dni = (n) => new Date(TERAZ.getTime() - n * 86_400_000).toISOString();
    const ins = db.prepare('INSERT INTO api_idempotencja (klucz_id, klucz_zadania, trasa, status, cialo, at) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run(1, 'stary', 'POST /x', 201, '{}', dni(8));
    ins.run(1, 'mlody', 'POST /x', 201, '{}', dni(6));
    const zegary = modulApi.zbuduj({ db, teraz: () => TERAZ, log: () => {} }).zegary ?? [];
    const zegar = zegary.find((z) => z.nazwa === 'api-idempotencja');
    expect(zegar).toBeDefined();
    await zegar.przebieg();
    expect(wpisy(db).map((w) => w.klucz_zadania)).toEqual(['mlody']);
  });

  it('błąd sprzątania trafia do logu i nie wywraca przebiegu', async () => {
    const log = [];
    const db = { prepare: () => { throw new Error('baza zamknięta'); } };
    const zegar = modulApi.zbuduj({ db, teraz: () => TERAZ, log: (...t) => log.push(t.join(' ')) }).zegary
      .find((z) => z.nazwa === 'api-idempotencja');
    await expect(zegar.przebieg()).resolves.toBeUndefined();
    expect(log.join('\n')).toContain('baza zamknięta');
  });
});
