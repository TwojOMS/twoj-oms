import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zalozKonto, ostatnieLogowania } from '../../../src/core/bezpieczenstwo/konta.js';
import { setTimeout as czekaj } from 'node:timers/promises';

let db; let app;
beforeEach(() => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'poprawne' } } });
});
afterEach(async () => { await app.close(); db.close(); });
const proba = (login, haslo = 'zle', ip = '192.0.2.1', basic = false) => app.inject(basic ? {
  method: 'GET', url: '/', remoteAddress: ip,
  headers: { 'x-forwarded-for': '198.51.100.99', authorization: `Basic ${Buffer.from(`${login}:${haslo}`).toString('base64')}` },
} : {
  method: 'POST', url: '/login', remoteAddress: ip, headers: { origin: 'http://localhost', 'x-forwarded-for': '198.51.100.99' },
  payload: { uzytkownik: login, haslo },
});

describe.each([false, true])('limity HTTP, Basic Auth = %s', (basic) => {
  it('pięć błędów A nie blokuje poprawnego B za tym samym tunelem', async () => {
    for (let i = 0; i < 5; i++) await proba('obcy', 'zle', '192.0.2.1', basic);
    expect((await proba('operator', 'poprawne', '192.0.2.1', basic)).statusCode).toBe(basic ? 200 : 302);
    const r = await proba(' OBCY ', 'zle', '192.0.2.1', basic);
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    await proba('obcy', 'zle', '192.0.2.1', basic);
    expect(ostatnieLogowania(db, 100).filter(w => w.wynik === 'zablokowane')).toHaveLength(1);
  });
  it('40 loginów z adresu daje 429, a poprawne hasło innego użytkownika nadal wpuszcza', async () => {
    let r;
    for (let i = 0; i < 40; i++) {
      r = await proba(`losowy-${i}`, 'zle', '192.0.2.1', basic);
      expect(r.statusCode).toBe(i < 39 ? 401 : 429);
    }
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect((await proba('operator', 'poprawne', '192.0.2.1', basic)).statusCode).toBe(basic ? 200 : 302);
  }, 20_000);
  it('30 adresów spowalnia konto, ale poprawne hasło z nowego adresu działa także przy ponawianym ataku', async () => {
    for (let i = 0; i < 29; i++) await proba('operator', 'zle', `192.0.2.${i}`, basic);
    for (let i = 0; i < 2; i++) {
      const blokady = () => ostatnieLogowania(db, 100).filter(w => w.wynik === 'zablokowane').length;
      const przed = blokady();
      const start = performance.now();
      const bledna = proba('operator', 'zle', `203.0.113.${i}`, basic).then(r => r);
      for (let j = 0; j < 100 && blokady() === przed; j++) await czekaj(5);
      // Dowód, że poprawne logowanie faktycznie trafia w AKTYWNĄ karę konta.
      expect(blokady()).toBeGreaterThan(przed);
      expect((await proba('operator', 'poprawne', '198.51.100.1', basic)).statusCode).toBe(basic ? 200 : 302);
      expect((await bledna).statusCode).toBe(429);
      expect(performance.now() - start).toBeGreaterThanOrEqual(1_800);
    }
  }, 20_000);
  it('istniejący i nieistniejący login mają te same statusy, treści i kary', async () => {
    zalozKonto(db, { login: 'istniejacy', imie: 'Test', haslo: 'poprawne', rola: 'sprzedaz' });
    for (let i = 0; i < 6; i++) {
      const a = await proba('istniejacy', 'zle', '192.0.2.1', basic);
      const b = await proba('nieistniejacy', 'zle', '192.0.2.2', basic);
      expect(a.statusCode).toBe(i < 4 ? 401 : 429);
      expect(a.statusCode).toBe(b.statusCode);
      expect(a.body).toBe(b.body);
      expect(a.headers['retry-after']).toBe(b.headers['retry-after']);
    }
  });
});

it('formularz i Basic Auth dzielą licznik pary', async () => {
  for (let i = 0; i < 4; i++) await proba('operator');
  expect((await proba('operator', 'zle', '192.0.2.1', true)).statusCode).toBe(429);
  expect((await proba('operator', 'poprawne')).statusCode).toBe(429);
});
