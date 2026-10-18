import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import basicAuth from '@fastify/basic-auth';
import { setTimeout as czekaj } from 'node:timers/promises';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zbudujStraznika } from '../../src/core/bezpieczenstwo/straznik.js';
import { registerLogowanieRoutes } from '../../src/moduly/ustawienia/trasy/logowanie.js';
import { hamulecLogowaniaDla, utworzHamulecLogowania } from '../../src/core/bezpieczenstwo/hamulec.js';
import { wczytajSekret } from '../../src/core/bezpieczenstwo/sekret-sesji.js';
import { ostatnieLogowania } from '../../src/core/bezpieczenstwo/konta.js';
import * as hasla from '../../src/domena/hasla.js';

let db; let app; let walidacje; let aktywne; let najwiecej; let starty;
beforeEach(() => { db = openOmsDb(':memory:'); wczytajSekret(db); walidacje = 0; aktywne = 0; najwiecej = 0; starty = []; });
afterEach(async () => { await app?.close(); db.close(); vi.restoreAllMocks(); });
async function zbuduj(trustProxy = false) {
  app = Fastify({ logger: false, trustProxy });
  const oryginal = hasla.zgodneHaslo;
  vi.spyOn(hasla, 'zgodneHaslo').mockImplementation((...args) => {
    walidacje++; starty.push(performance.now());
    najwiecej = Math.max(najwiecej, aktywne + 1);
    return oryginal(...args);
  });
  await app.register(basicAuth, { authenticate: true, validate: async (login, haslo) => {
    walidacje++; starty.push(performance.now()); aktywne++; najwiecej = Math.max(najwiecej, aktywne);
    try { await czekaj(20); if (login !== 'operator' || haslo !== 'poprawne') throw Error('Unauthorized'); }
    finally { aktywne--; }
  } });
  app.decorateReply('view', function (_widok, dane) { return this.send(dane); });
  app.addHook('onRequest', zbudujStraznika({ basicAuth: app.basicAuth, db, nazwaCiasteczka: 'testowa', konta: {
    kontoPoLoginie: () => null, czyIstniejeCzynnyAdmin: () => false, loginSerwisowy: 'operator',
  } }));
  registerLogowanieRoutes(app, { db, config: { auth: { user: 'operator', pass: 'poprawne' } } });
  app.get('/api/proba', async () => 'chronione');
  await app.ready();
}
function proba(basic, login, { haslo = 'zle', ip = '127.0.0.1', headers = {} } = {}) {
  return app.inject(basic ? { url: '/api/proba', remoteAddress: ip, headers: {
    ...headers, authorization: `Basic ${Buffer.from(`${login}:${haslo}`).toString('base64')}`,
  } } : { method: 'POST', url: '/login', remoteAddress: ip, headers,
    payload: { uzytkownik: login, haslo } });
}

describe.each([false, true])('twardy adres i awaryjne proxy, Basic=%s', (basic) => {
  it.each([false, true])('41. login nie waliduje hasła; trustProxy=%s', async (proxy) => {
    await zbuduj(proxy ? '127.0.0.1' : false);
    const headers = proxy ? { 'x-forwarded-for': '198.51.100.1' } : {};
    for (let i = 0; i < 40; i++) await proba(basic, `losowy-${i}`, { headers });
    expect(walidacje).toBe(40);
    for (let i = 0; i < 3; i++) {
      const r = await proba(basic, 'operator', { haslo: 'poprawne', headers });
      expect(r.statusCode).toBe(429);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(890);
      expect(walidacje).toBe(40);
    }
    expect(ostatnieLogowania(db, 100).filter(w => w.wynik === 'zablokowane')).toHaveLength(1);
  });
  it.each(['x-forwarded-for', 'cf-connecting-ip'])('%s bez trustProxy zostawia wejście innemu loginowi', async (naglowek) => {
    await zbuduj();
    const headers = { [naglowek]: '198.51.100.1' };
    for (let i = 0; i < 40; i++) await proba(basic, `losowy-${i}`, { headers });
    expect((await proba(basic, 'operator', { haslo: 'poprawne', headers })).statusCode).toBe(basic ? 200 : 302);
    expect(walidacje).toBe(41);
  }, 20_000);
});

it('60 równoległych loginów wiarygodnego adresu wykonuje najwyżej 40 walidacji', async () => {
  await zbuduj();
  const r = await Promise.all(Array.from({ length: 60 }, (_, i) => proba(true, `losowy-${i}`)));
  expect(walidacje).toBeLessThanOrEqual(40);
  expect(r.filter(w => w.statusCode === 429).length).toBeGreaterThanOrEqual(20);
});

it('miękki adres serializuje różne loginy za tunelem także podczas 2 s odmowy', async () => {
  await zbuduj();
  const h = hamulecLogowaniaDla(db);
  for (let i = 0; i < 40; i++) h.odnotujBlad('127.0.0.1', `rozgrzewka-${i}`);
  const r = await Promise.all(Array.from({ length: 3 }, (_, i) => proba(true, `nowy-${i}`, { headers: { 'x-forwarded-for': '198.51.100.1' } })));
  expect(r.every(w => w.statusCode === 429)).toBe(true);
  expect(walidacje).toBe(3);
  expect(najwiecej).toBe(1);
  for (let i = 1; i < starty.length; i++) expect(starty[i] - starty[i - 1]).toBeGreaterThanOrEqual(1_800);
}, 15_000);

it.each([false, true])('limit konta serializuje 10 równoległych prób; mieszany formularz/Basic=%s', async (mieszane) => {
  await zbuduj();
  const h = hamulecLogowaniaDla(db);
  for (let i = 0; i < 30; i++) h.odnotujBlad(`192.0.2.${i}`, 'operator');
  const r = await Promise.all(Array.from({ length: 10 }, (_, i) => proba(!mieszane || i % 2 === 0, 'operator', { ip: `198.51.100.${i}` })));
  expect(r.every(w => w.statusCode === 429)).toBe(true);
  expect(walidacje).toBe(10);
  expect(najwiecej).toBe(1);
  for (let i = 1; i < starty.length; i++) expect(starty[i] - starty[i - 1]).toBeGreaterThanOrEqual(1_800);
}, 40_000);

it('kolejka konta mieści jedną aktywną i 20 oczekujących prób, zwalnia pamięć', async () => {
  const h = utworzHamulecLogowania();
  for (let i = 0; i < 30; i++) h.odnotujBlad(`192.0.2.${i}`, 'operator');
  const req = i => ({ ip: `198.51.100.${i}`, headers: {} });
  const zwolnij = await h.zajmij(req(0), 'operator');
  const oczekujace = Array.from({ length: 20 }, (_, i) => h.zajmij(req(i + 1), 'operator'));
  expect(await h.zajmij(req(22), 'operator')).toBeNull();
  zwolnij();
  for (const p of oczekujace) (await p)();
  const ponownie = await h.zajmij(req(0), 'operator');
  expect(ponownie).toBeTypeOf('function');
  ponownie();
});
