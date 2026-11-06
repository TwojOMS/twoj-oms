import { afterEach, describe, expect, it, vi } from 'vitest';
import { utworzLimitApi } from '../../../src/core/bezpieczenstwo/limit-api.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { zalozKluczApi } from '../../../src/core/bezpieczenstwo/klucze-api.js';

// PRZ-153.E1.3b: limit w strażniku przez HTTP (jedna instancja limitu na aplikację, pipeline.js).
describe('limit API przez HTTP /api/v1', () => {
  let db;
  let app;
  afterEach(async () => {
    vi.useRealTimers();
    await app?.close();
    db?.close();
    app = undefined;
  });
  async function start() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T10:00:00.000Z'));
    db = openOmsDb(':memory:');
    app = buildOmsServer({ db, config: { auth: { user: 'serwis', pass: 'haslo-env' }, klienciZbiorczy: [] } });
    await app.ready();
    zalozKonto(db, { login: 'ala', imie: 'Ala Testowa', haslo: 'haslo-ali-123', rola: 'admin', admin: true });
    return zalozKluczApi(db, { nazwa: 'integracja testowa', zakresy: ['druk'], kontoId: null, teraz: new Date().toISOString() }).klucz;
  }
  const ja = (klucz, ip = '10.0.0.5') => app.inject({
    url: '/api/v1/ja', remoteAddress: ip, headers: klucz ? { authorization: `Bearer ${klucz}` } : {},
  });

  it('121. wywołanie w 60 s → 429 z Retry-After w sekundach w górę; 1. w następnym oknie → 200', async () => {
    const klucz = await start();
    for (let i = 0; i < 120; i++) expect((await ja(klucz)).statusCode).toBe(200);
    vi.setSystemTime(new Date('2026-11-06T10:00:30.400Z'));
    const r = await ja(klucz);
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('30');
    expect(r.json()).toEqual({ kod: 'limit', powod: expect.any(String) });
    vi.setSystemTime(new Date('2026-11-06T10:01:00.000Z'));
    expect((await ja(klucz)).statusCode).toBe(200);
  });

  it('20 złych kluczy z jednego IP → 21. żądanie (także z dobrym kluczem) 429; inne IP i POST /login działają', async () => {
    const klucz = await start();
    const zly = `toms_abcdefgh_${'B'.repeat(43)}`;
    for (let i = 0; i < 20; i++) expect((await ja(zly)).statusCode).toBe(401);
    const r = await ja(klucz);
    expect(r.statusCode).toBe(429);
    expect(r.json()).toEqual({ kod: 'limit', powod: expect.any(String) });
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect((await ja(klucz, '10.0.0.6')).statusCode).toBe(200);
    const login = await app.inject({
      method: 'POST', url: '/login', remoteAddress: '10.0.0.5', headers: { origin: 'http://localhost' },
      payload: { uzytkownik: 'ala', haslo: 'haslo-ali-123', powrot: '/' },
    });
    expect(login.statusCode, login.body).toBe(302);
    vi.setSystemTime(new Date('2026-11-06T10:01:00.000Z'));
    expect((await ja(klucz)).statusCode).toBe(200);
  });
});

describe('limit API', () => {
  it('liczy wywołania osobno w stałym oknie dla każdego klucza', () => {
    const limit = utworzLimitApi();
    for (let i = 0; i < 120; i++) {
      expect(limit.sprawdz('a', 1_000 + i)).toEqual({ wolno: true, zostaloMs: 0 });
    }
    expect(limit.sprawdz('a', 2_000)).toEqual({ wolno: false, zostaloMs: 59_000 });
    expect(limit.sprawdz('b', 2_000).wolno).toBe(true);
    expect(limit.sprawdz('a', 61_000)).toEqual({ wolno: true, zostaloMs: 0 });
  });

  it('blokuje tylko dany IP po 20 błędach do końca okna', () => {
    const limit = utworzLimitApi();
    for (let i = 0; i < 19; i++) limit.odnotujZly('ip-a', 1_000 + i);
    expect(limit.zablokowanyIp('ip-a', 2_000)).toEqual({ wolno: true, zostaloMs: 0 });
    limit.odnotujZly('ip-a', 2_000);
    expect(limit.zablokowanyIp('ip-a', 3_000)).toEqual({ wolno: false, zostaloMs: 58_000 });
    expect(limit.zablokowanyIp('ip-b', 3_000).wolno).toBe(true);
    expect(limit.zablokowanyIp('ip-a', 61_000)).toEqual({ wolno: true, zostaloMs: 0 });
    limit.odnotujZly('ip-a', 61_000);
    expect(limit.zablokowanyIp('ip-a', 61_000).wolno).toBe(true);
  });

  it('przycina obie mapy, najpierw wygasłe, a potem najstarsze wpisy', () => {
    const limit = utworzLimitApi({ limit: 1, zleNaIp: 1 });
    for (let i = 0; i < 10_001; i++) {
      limit.sprawdz(`k${i}`, 0);
      limit.odnotujZly(`ip${i}`, 0);
    }
    expect(limit._rozmiar()).toEqual({ klucze: 10_000, adresy: 10_000 });
    expect(limit.sprawdz('k0', 1).wolno).toBe(true);
    expect(limit.zablokowanyIp('ip0', 1).wolno).toBe(true);
    limit.sprawdz('nowy', 60_000);
    limit.odnotujZly('nowy', 60_000);
    expect(limit._rozmiar()).toEqual({ klucze: 2, adresy: 1 });
  });
});
