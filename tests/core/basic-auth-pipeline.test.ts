import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import basicAuth from '@fastify/basic-auth';
import { connect } from 'node:net';
import { setTimeout as poczekaj } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { otworzBaze, wykonajMigracje } from '../../src/core/baza.ts';
import { rdzen } from '../pomoc/bezpieczenstwo-prz-007.ts';
import { zalozKonto } from '../../src/core/bezpieczenstwo/konta.js';
import { zgodneHaslo } from '../../src/domena/hasla.js';
import { zbudujStraznika } from '../../src/core/bezpieczenstwo/straznik.js';
import { wczytajSekret } from '../../src/core/bezpieczenstwo/sekret-sesji.js';

let app: FastifyInstance;
let db: DatabaseSync;
let walidacje: number;
let aktywne: number;
let najwiecejAktywnych: number;
let port: number;

beforeEach(async () => {
  db = otworzBaze(':memory:');
  wykonajMigracje(db, [rdzen]);
  zalozKonto(db, { login: 'syntetyczny', imie: 'Test', haslo: 'poprawne', rola: 'sprzedaz' });
  const hash = db.prepare('SELECT hash_hasla FROM konta WHERE login = ?').get('syntetyczny')!.hash_hasla;
  wczytajSekret(db);
  walidacje = 0; aktywne = 0; najwiecejAktywnych = 0;
  app = Fastify({ logger: false });
  await app.register(basicAuth, { authenticate: true, validate: async (login, haslo) => {
    walidacje++;
    aktywne++;
    najwiecejAktywnych = Math.max(najwiecejAktywnych, aktywne);
    try {
      // Prawdziwy asynchroniczny validator + scrypt. To samo okno co callback
      // wtyczki, rozszerzone dla deterministycznego dowodu niezależności IP.
      await poczekaj(20);
      const zgodne = zgodneHaslo(haslo, hash);
      if (!zgodne || login !== 'syntetyczny') throw new Error('Unauthorized');
    } finally { aktywne--; }
  } });
  app.addHook('onRequest', zbudujStraznika({ basicAuth: app.basicAuth, db, nazwaCiasteczka: 'syntetyczna' }));
  app.get('/api/proba', async () => 'chronione');
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
});
afterEach(async () => { await app?.close(); db?.close(); });

// Jedno write TCP niesie cały rzeczywisty pipeline HTTP/1.1. Ostatnie żądanie
// zamyka połączenie; parser odpowiedzi sprawdza status każdej odpowiedzi.
function pipeline(hasla: string[], localAddress = '127.0.0.1', login = 'syntetyczny', proxyBezKonfiguracji = false): Promise<number[]> {
  return new Promise((resolve, reject) => {
    let dane = '';
    const socket = connect({ host: '127.0.0.1', port, localAddress });
    socket.setTimeout(10_000, () => socket.destroy(new Error('Timeout lokalnego pipeline HTTP')));
    socket.on('error', reject);
    socket.on('data', (chunk) => { dane += chunk.toString(); });
    socket.on('end', () => resolve([...dane.matchAll(/HTTP\/1\.1 (\d+)/g)].map((m) => Number(m[1]))));
    socket.on('connect', () => socket.write(hasla.map((haslo, i) => {
      const auth = Buffer.from(`${login}:${haslo}`).toString('base64');
      return `GET /api/proba HTTP/1.1\r\nHost: localhost\r\n${proxyBezKonfiguracji ? 'X-Forwarded-For: 198.51.100.1\r\n' : ''}Authorization: Basic ${auth}\r\nConnection: ${i === hasla.length - 1 ? 'close' : 'keep-alive'}\r\n\r\n`;
    }).join('')));
  });
}

describe('Basic Auth — równoległy pipeline HTTP', () => {
  it('za tunelem bez konfiguracji inny login nie czeka w kolejce pary napastnika', async () => {
    const [zle, dobre] = await Promise.all([
      pipeline(Array(4).fill('zle'), '127.0.0.1', 'obcy', true),
      pipeline(Array(3).fill('poprawne'), '127.0.0.1', 'syntetyczny', true),
    ]);
    expect(zle).toEqual(Array(4).fill(401));
    expect(dobre).toEqual(Array(3).fill(200));
    expect(najwiecejAktywnych).toBe(2);
  });
  it('20 złych żądań jednym zapisem daje tylko 5 walidacji, 4×401 i 16×429', async () => {
    expect(await pipeline(Array(20).fill('zle'))).toEqual([...Array(4).fill(401), ...Array(16).fill(429)]);
    expect(walidacje).toBe(5);
    expect(najwiecejAktywnych).toBe(1);
  });
  it('po 5 złych żądaniach poprawne szóste w tym samym pipeline dostaje 429', async () => {
    expect(await pipeline([...Array(5).fill('zle'), 'poprawne'])).toEqual([401, 401, 401, 401, 429, 429]);
    expect(walidacje).toBe(5);
  });
  it('20 poprawnych równoległych żądań nie uruchamia kary ani licznika błędów', async () => {
    expect(await pipeline(Array(20).fill('poprawne'))).toEqual(Array(20).fill(200));
    expect(walidacje).toBe(20);
    expect(await pipeline([...Array(5).fill('zle'), 'poprawne'])).toEqual([401, 401, 401, 401, 429, 429]);
  }, 20_000);
  it('drugie IP waliduje niezależnie w trakcie pierwszego pipeline i zachowuje dostęp', async () => {
    const [zle, dobre] = await Promise.all([
      pipeline(Array(20).fill('zle'), '127.0.0.1'),
      pipeline(Array(3).fill('poprawne'), '127.0.0.2'),
    ]);
    expect(zle).toEqual([...Array(4).fill(401), ...Array(16).fill(429)]);
    expect(dobre).toEqual([200, 200, 200]);
    expect(walidacje).toBe(8);
    expect(najwiecejAktywnych).toBe(2);
  });
});
