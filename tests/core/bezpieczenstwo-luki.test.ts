import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import basicAuth from '@fastify/basic-auth';
import type { DatabaseSync } from 'node:sqlite';
import { otworzBaze, wykonajMigracje } from '../../src/core/baza.ts';
import { rdzen as modulRdzen, podpiszWersje as podpisz, straznikZKontami as zbudujStraznika } from '../pomoc/bezpieczenstwo-prz-007.ts';
import * as konta from '../../src/core/bezpieczenstwo/konta.js';
import { zgodneHaslo } from '../../src/domena/hasla.js';
import { wczytajSekret, odczytajSekret } from '../../src/core/bezpieczenstwo/sekret-sesji.js';
import { sprawdz, zNaglowka } from '../../src/core/bezpieczenstwo/sesja.js';
import { zarejestrujOchroneCsrf } from '../../src/core/bezpieczenstwo/csrf.js';

// Prawdziwe migracje, zapytania kont, scrypt i wtyczka Basic Auth. Zero portów.
let db: DatabaseSync;
let app: FastifyInstance;
let sekret: string;
let a: number;
let czas: number;
const nazwa = 'sesja_oms';
const basic = (login = 'serwis', haslo = 'haslo-serwis') => `Basic ${Buffer.from(`${login}:${haslo}`).toString('base64')}`;
const cookie = (login: string, wersja?: number, kiedy = czas) => `${nazwa}=${podpisz(login, sekret, kiedy, wersja)}`;

beforeEach(async () => {
  czas = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => czas);
  db = otworzBaze(':memory:');
  wykonajMigracje(db, [modulRdzen]);
  a = konta.zalozKonto(db, { login: 'alfa', imie: 'Alfa', haslo: 'haslo-alfa', rola: 'sprzedaz', admin: true });
  konta.zalozKonto(db, { login: 'beta', imie: 'Beta', haslo: 'haslo-beta', rola: 'sprzedaz', admin: true });
  konta.zalozKonto(db, { login: 'serwis', imie: 'Serwis', haslo: 'haslo-serwis', rola: 'sprzedaz' });
  sekret = wczytajSekret(db);
  app = Fastify({ logger: false });
  await app.register(basicAuth, { authenticate: true, validate: async (login, haslo) => {
    // Serwis ma prawdziwy hash; nieznany login wykonuje ten sam kosztowny scrypt.
    const w = db.prepare('SELECT hash_hasla FROM konta WHERE login = ?').get('serwis')!;
    const zgodne = zgodneHaslo(haslo, w.hash_hasla);
    if (login !== 'serwis' || !zgodne) throw new Error('Unauthorized');
  } });
  app.addHook('onRequest', zbudujStraznika({ basicAuth: app.basicAuth, db, nazwaCiasteczka: nazwa,
    konta: { kontoPoLoginie: (login: string) => konta.kontoPoLoginie(db, login),
      czyIstniejeCzynnyAdmin: () => konta.czyIstniejeCzynnyAdmin(db), loginSerwisowy: 'serwis' },
  }));
  zarejestrujOchroneCsrf(app);
  for (const url of ['/api/proba', '/zamowienia', '/kolejka-druku/proba', '/health', '/login', '/public/proba']) {
    app.get(url, async () => 'chronione');
  }
  app.post('/zamowienia', async () => 'zmienione');
});

afterEach(async () => {
  await app?.close();
  db?.close();
  vi.restoreAllMocks();
});

describe('Basic Auth — hamulec pary IP i login', () => {
  it('piąta błędna próba dostaje 429, również poprawne hasło podczas kary; inne IP działa', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await app.inject({ url: '/api/proba', remoteAddress: '127.0.0.2', headers: { authorization: basic('serwis', 'zle') } });
      expect(r.statusCode).toBe(401);
      expect(r.headers['www-authenticate']).toContain('Basic');
    }
    const szosta = await app.inject({ url: '/api/proba', remoteAddress: '127.0.0.2', headers: { authorization: basic('serwis', 'zle') } });
    expect(szosta.statusCode).toBe(429);
    expect(Number(szosta.headers['retry-after'])).toBe(60);
    const poprawna = await app.inject({ url: '/api/proba', remoteAddress: '127.0.0.2', headers: { authorization: basic() } });
    expect(poprawna.statusCode).toBe(429);
    expect((await app.inject({ url: '/api/proba', remoteAddress: '127.0.0.3', headers: { authorization: basic() } })).body).toBe('chronione');
    czas += 60_001;
    expect((await app.inject({ url: '/api/proba', remoteAddress: '127.0.0.2', headers: { authorization: basic() } })).body).toBe('chronione');
  });

  it('sukces zeruje serię błędów, a autoryzacyjne 403 nie nalicza błędu hasła', async () => {
    const proba = (haslo: string, url = '/api/proba') => app.inject({ url, headers: { authorization: basic('serwis', haslo) } });
    for (let i = 0; i < 4; i++) expect((await proba('zle')).statusCode).toBe(401);
    expect((await proba('haslo-serwis')).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) expect((await proba('zle')).statusCode).toBe(401);
    for (let i = 0; i < 6; i++) expect((await proba('haslo-serwis', '/zamowienia')).statusCode).toBe(403);
    expect((await proba('haslo-serwis', '/kolejka-druku/proba')).body).toBe('chronione');
    for (let i = 0; i < 4; i++) expect((await proba('zle')).statusCode).toBe(401);
    expect((await proba('zle')).statusCode).toBe(429);
    expect((await proba('haslo-serwis')).statusCode).toBe(429);
  });

  it('otwarte trasy, ważne sesje i zwykła nawigacja bez hasła zachowują wejście podczas kary', async () => {
    for (let i = 0; i < 8; i++) {
      expect((await app.inject({ url: '/zamowienia', headers: { accept: 'text/html' } })).statusCode).toBe(302);
    }
    expect((await app.inject({ url: '/api/proba', headers: { authorization: basic() } })).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) await app.inject({ url: '/api/proba', headers: { authorization: basic('serwis', 'zle') } });
    expect((await app.inject({ url: '/api/proba', headers: { authorization: basic() } })).statusCode).toBe(429);
    for (const url of ['/health', '/login', '/public/proba']) {
      expect((await app.inject({ url })).body).toBe('chronione');
    }
    expect((await app.inject({ url: '/zamowienia', headers: { cookie: cookie('alfa') } })).body).toBe('chronione');
  });
});

describe('sesja — zmiana hasła jednego konta', () => {
  it('stare cookie konta alfa dostaje 302 po zmianie hasła, beta pozostaje ważna', async () => {
    const alfa = cookie('alfa');
    const beta = cookie('beta');
    expect((await app.inject({ url: '/zamowienia', headers: { cookie: alfa, accept: 'text/html' } })).body).toBe('chronione');
    expect((await app.inject({ url: '/zamowienia', headers: { cookie: beta } })).body).toBe('chronione');
    konta.zmienHaslo(db, a, 'nowe-haslo');
    const r = await app.inject({ url: '/zamowienia', headers: { cookie: alfa, accept: 'text/html' } });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/login?powrot=%2Fzamowienia');
    expect(r.headers['set-cookie']).toContain('Max-Age=0');
    expect((await app.inject({ url: '/zamowienia', headers: { cookie: beta } })).body).toBe('chronione');
    expect(odczytajSekret(db)).toBe(sekret);
    expect((await app.inject({ url: '/zamowienia', headers: { cookie: cookie('alfa', 1) } })).body).toBe('chronione');
  });

  it.each([undefined, 0])('sesja z wersją %s nie odnawia się po zmianie hasła; JSON dostaje 401', async (wersja) => {
    const stare = cookie('alfa', wersja, czas - 2 * 24 * 60 * 60 * 1000);
    konta.zmienHaslo(db, a, 'nowe-haslo');
    const r = await app.inject({ url: '/zamowienia', headers: { cookie: stare, accept: 'application/json' } });
    expect(r.statusCode).toBe(401);
    expect(r.body).not.toBe('chronione');
    expect(r.headers['set-cookie']).toContain('Max-Age=0');
    expect((await app.inject({ method: 'POST', url: '/zamowienia', headers: { cookie: stare, accept: 'text/html' } })).headers.location).toBe('/login');
  });

  it('odnowienie ważnej sesji niesie sprawdzoną wersję, także wersję 0 dawnego cookie', async () => {
    const wiek = czas - 2 * 24 * 60 * 60 * 1000;
    const legacy = await app.inject({ url: '/zamowienia', headers: { cookie: cookie('alfa', undefined, wiek) } });
    expect(legacy.statusCode).toBe(200);
    expect(sprawdz(zNaglowka(nazwa, legacy.headers['set-cookie']), sekret)).toMatchObject({ uzytkownik: 'alfa', wersja_hasla: 0 });
    konta.zmienHaslo(db, a, 'nowe-haslo');
    const aktualna = await app.inject({ url: '/zamowienia', headers: { cookie: cookie('alfa', 1, wiek) } });
    expect(aktualna.statusCode).toBe(200);
    const token = zNaglowka(nazwa, aktualna.headers['set-cookie']);
    expect(sprawdz(token, sekret)).toMatchObject({ uzytkownik: 'alfa', wersja_hasla: 1 });
    konta.zmienHaslo(db, a, 'kolejne-haslo');
    expect((await app.inject({ url: '/zamowienia', headers: { cookie: `${nazwa}=${token}` } })).statusCode).toBe(401);
  });

  it('ważna sesja nadal podlega ochronie CSRF', async () => {
    const headers = { cookie: cookie('alfa') };
    expect((await app.inject({ method: 'POST', url: '/zamowienia', headers: { ...headers, origin: 'https://obce.test' } })).statusCode).toBe(403);
    const r = await app.inject({ method: 'POST', url: '/zamowienia', headers: { ...headers, origin: 'http://localhost:80' } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('zmienione');
  });
});
