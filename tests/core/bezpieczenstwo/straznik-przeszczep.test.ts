import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import basicAuth from '@fastify/basic-auth';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { zbudujStraznika } from '../../../src/core/bezpieczenstwo/straznik.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';

// Vite 5 nie rozpoznaje jeszcze node:sqlite jako modułu wbudowanego Node 24.
const { DatabaseSync: SQLite } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

// Stare testy strażnika importują cały serwer/bazę OMS i zostają na etap 3.
// Ten dodatkowy test uruchamia skopiowany strażnik z prawdziwym Fastify, Basic Auth
// i minimalną bazą SQLite w pamięci. inject nie otwiera portu ani połączenia sieciowego.
let app: FastifyInstance;
let db: DatabaseSync;
let sekret: string;
beforeEach(async () => {
  db = new SQLite(':memory:');
  db.exec('CREATE TABLE sekret_sesji (id INTEGER PRIMARY KEY, sekret TEXT, zmieniony_at TEXT)');
  sekret = wczytajSekret(db);
  app = Fastify({ logger: false });
  await app.register(basicAuth, { validate: async (uzytkownik, haslo) => {
    if (uzytkownik !== 'test' || haslo !== 'test') throw new Error('Unauthorized');
  } });
  app.addHook('onRequest', zbudujStraznika({ basicAuth: app.basicAuth, db, nazwaCiasteczka: NAZWA_CIASTECZKA_OMS }));
  app.get('/zamowienia', async () => 'chronione');
});
afterEach(async () => {
  await app.close();
  db.close();
});

describe('strażnik po przeszczepie', () => {
  it('bez sesji przekierowuje przeglądarkę do logowania i zachowuje powrót', async () => {
    const r = await app.inject({ method: 'GET', url: '/zamowienia', headers: { accept: 'text/html' } });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/login?powrot=%2Fzamowienia');
    expect(r.body).not.toBe('chronione');
  });
  it('bez sesji i Basic Auth odmawia klientowi API', async () => {
    const r = await app.inject({ method: 'GET', url: '/zamowienia' });
    expect(r.statusCode).toBe(401);
    expect(r.body).not.toBe('chronione');
  });
  it('panel bez kont nadal dopuszcza Basic Auth i nie otwiera sąsiadów ikony', async () => {
    const headers = { authorization: `Basic ${Buffer.from('test:test').toString('base64')}` };
    expect((await app.inject({ url: '/zamowienia', headers })).statusCode).toBe(200);
    for (const url of ['/favicon.ico.bak', '/favicon.icox']) {
      expect((await app.inject(url)).statusCode).toBe(401);
    }
    // Panel bez własnej trasy ikony zwraca 404, jak dla otwartego /health.
    expect((await app.inject('/favicon.ico')).statusCode).toBe(404);
  });
  it('ważna sesja dopuszcza żądanie', async () => {
    const r = await app.inject({ method: 'GET', url: '/zamowienia', headers: {
      cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('test', sekret)}`,
    } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('chronione');
  });
});
