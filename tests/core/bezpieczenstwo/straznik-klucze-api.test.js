// PRZ-153.E1.2b — wejście kluczem API do /api/v1 przez strażnika rdzenia (plan docs/plany/PRZ-153-api-v1.md, E1.2).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zalozKonto, ustawCzynne } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { odczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { zalozKluczApi, odwolajKluczApi } from '../../../src/core/bezpieczenstwo/klucze-api.js';
import { MODULY } from '../../../src/moduly/lista.ts';
import { czyAdresApiV1 } from '../../../src/core/bezpieczenstwo/straznik.js';

const CONFIG = { auth: { user: 'serwis', pass: 'haslo-env' }, klienciZbiorczy: [] };
const BASIC = `Basic ${Buffer.from('serwis:haslo-env').toString('base64')}`;
const ODMOWA = { kod: 'klucz', powod: 'Brak, zły albo odwołany klucz API.' };

let db;
let app;
let adminId;
const teraz = () => new Date().toISOString();
const klucz = (dane = {}) => zalozKluczApi(db, {
  nazwa: 'integracja testowa', zakresy: ['druk', 'zamowienia:odczyt'], kontoId: adminId, teraz: teraz(), ...dane,
});
const bearer = (k) => ({ authorization: `Bearer ${k}` });
const ja = (headers = {}) => app.inject({ url: '/api/v1/ja', headers });

beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: CONFIG });
  await app.ready();
  adminId = zalozKonto(db, { login: 'ala', imie: 'Ala Testowa', haslo: 'h', rola: 'admin', admin: true });
});
afterEach(async () => {
  vi.useRealTimers();
  await app.close();
  db.close();
});

describe('strażnik: klucz API na /api/v1', () => {
  it('bez nagłówka → 401 JSON kod klucz, bez WWW-Authenticate', async () => {
    const r = await ja();
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual(ODMOWA);
    expect(r.headers['www-authenticate']).toBeUndefined();
  });

  it('ważny klucz → 200 z tożsamością klucza', async () => {
    const { klucz: k, prefiks } = klucz();
    const r = await ja(bearer(k));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ nazwa: 'integracja testowa', prefiks, zakresy: ['zamowienia:odczyt', 'druk'] });
  });

  it('ten sam kształt zły, nieznany i odwołany klucz → 401', async () => {
    const { klucz: k, id } = klucz();
    const obcy = `toms_abcdefgh_${'A'.repeat(43)}`;
    for (const naglowek of ['Bearer', 'Bearer toms_zly', `Bearer ${obcy}`, `Token ${k}`, `${k}`]) {
      const r = await ja({ authorization: naglowek });
      expect(r.statusCode, naglowek).toBe(401);
      expect(r.json()).toEqual(ODMOWA);
    }
    odwolajKluczApi(db, id, teraz());
    const r = await ja(bearer(k));
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual(ODMOWA);
  });

  it('wygasły klucz → 401, także dokładnie w chwili wygaśnięcia; przed nią → 200', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T10:00:00.000Z'));
    const { klucz: k } = klucz({ wygasaAt: '2026-11-06T10:00:00.000Z' });
    const { klucz: k2 } = klucz({ wygasaAt: '2026-11-06T10:00:00.001Z' });
    const wygasly = await ja(bearer(k));
    expect(wygasly.statusCode).toBe(401);
    expect(wygasly.json()).toEqual(ODMOWA);
    expect((await ja(bearer(k2))).statusCode).toBe(200);
  });

  it('Basic konta serwisowego i ciasteczko admina nie otwierają /api/v1', async () => {
    const basic = await ja({ authorization: BASIC });
    expect(basic.statusCode).toBe(401);
    expect(basic.json()).toEqual(ODMOWA);
    const cookie = `${NAZWA_CIASTECZKA_OMS}=${podpisz('ala', odczytajSekret(db))}`;
    const zCiasteczkiem = await ja({ cookie, accept: 'text/html' });
    expect(zCiasteczkiem.statusCode).toBe(401);
    expect(zCiasteczkiem.json()).toEqual(ODMOWA);
  });

  it('klucz wklejony z końcowym \\r\\n albo spacją → 200', async () => {
    const { klucz: k } = klucz();
    expect((await ja({ authorization: `Bearer ${k}\r\n` })).statusCode).toBe(200);
    expect((await ja({ authorization: `  Bearer ${k}  ` })).statusCode).toBe(200);
  });

  it('klucz, którego twórcę potem wyłączono → 200 (klucz maszyny)', async () => {
    const tworca = zalozKonto(db, { login: 'bartek', imie: 'Bartek Testowy', haslo: 'h', rola: 'admin', admin: true });
    const { klucz: k } = klucz({ kontoId: tworca });
    ustawCzynne(db, tworca, false);
    expect((await ja(bearer(k))).statusCode).toBe(200);
  });

  it('nieznany adres w API z kluczem → 404 kod brak', async () => {
    const { klucz: k } = klucz();
    const r = await app.inject({ url: '/api/v1/nie-ma', headers: bearer(k) });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ kod: 'brak', powod: 'Nie ma takiego adresu w API.' });
  });

  it('POST /api/v1/ja z niepoprawnym JSON → odpowiedź w kształcie {kod, powod}', async () => {
    const { klucz: k } = klucz();
    const r = await app.inject({
      method: 'POST', url: '/api/v1/ja', payload: '{',
      // Origin: ten test dotyczy strażnika i pluginu; wyjątek CSRF dla klucza ma własny test (E1.3).
      headers: { ...bearer(k), 'content-type': 'application/json', origin: 'http://localhost' },
    });
    expect([400, 404]).toContain(r.statusCode);
    expect(r.json()).toEqual({ kod: expect.any(String), powod: expect.any(String) });
  });

  // Kolejki druku (/kolejka-druku*) otwiera od E4.1 klucz z zakresem `druk` — pilnuje tego straznik-druk-klucz.test.js.
  it('ważny klucz nie otwiera ekranów OMS ani starego /api bez v1', async () => {
    const { klucz: k } = klucz({ zakresy: ['zamowienia:odczyt', 'zamowienia:zapis', 'druk', 'produkty:odczyt'] });
    for (const url of ['/zamowienia', '/ustawienia', '/ustawienia/klucze-api', '/api/sprzedaz',
      '/api/zamowienia/1/dostawa', '/api/v1x', '/api/v1/../zamowienia', '/api/v1%2fja']) {
      for (const accept of ['application/json', 'text/html']) {
        const r = await app.inject({ url, headers: { ...bearer(k), accept } });
        expect(r.statusCode, `${url} ${accept}`).not.toBe(200);
        expect(r.statusCode, `${url} ${accept}`).toBeGreaterThanOrEqual(400);
      }
    }
  });

  it('surowe HTTP: /api/v1/../zamowienia z kluczem nie dochodzi do ekranu zamówień', async () => {
    const { klucz: k } = klucz();
    const adres = new URL(await app.listen({ port: 0, host: '127.0.0.1' }));
    const pobierz = (path) => new Promise((ok, zle) => {
      const r = http.request({ host: adres.hostname, port: adres.port, path, headers: bearer(k) }, (res) => {
        let tresc = ''; res.on('data', (c) => { tresc += c; }); res.on('end', () => ok({ status: res.statusCode, tresc }));
      });
      r.on('error', zle);
      r.end();
    });
    for (const path of ['/api/v1/../zamowienia', '/api/v1/%2e%2e/zamowienia', '/api/v1/./ja', '/api/v1//ja']) {
      const r = await pobierz(path);
      expect(r.status, path).toBe(404);
      expect(JSON.parse(r.tresc), path).toEqual({ kod: 'brak', powod: 'Nie ma takiego adresu w API.' });
    }
    expect((await pobierz('/api/v1/ja')).status).toBe(200);
  });

  it('klucz ustawia req.kluczApi i req.konto bez uprawnień (moduł testowy w pełnym składzie)', async () => {
    const testowy = {
      nazwa: 'api-test', wersja: '1.0.0', wymaga: ['api'], migracje: [], menu: [], uprawnienia: [],
      konfiguracja: () => null,
      zbuduj: () => ({ trasy: (a) => { a.register(async (api) => {
        api.get('/test-konto', async (req) => ({
          konto: { ...req.konto, uprawnienia: [...req.konto.uprawnienia] },
          kluczApi: { ...req.kluczApi, zakresy: [...req.kluczApi.zakresy] },
        }));
      }, { prefix: '/api/v1' }); } }),
    };
    const db2 = openOmsDb(':memory:');
    const app2 = buildOmsServer({ db: db2, config: CONFIG, moduly: [...MODULY, testowy] });
    try {
      await app2.ready();
      const { klucz: k, id, prefiks } = zalozKluczApi(db2, {
        nazwa: 'integracja testowa', zakresy: ['druk'], kontoId: null, teraz: teraz(),
      });
      const r = await app2.inject({ url: '/api/v1/test-konto', headers: bearer(k) });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        konto: { imie: 'klucz: integracja testowa', login: `klucz:${prefiks}`, rola: 'klucz-api', admin: false,
          serwisowe: false, kluczApi: true, uprawnienia: [] },
        kluczApi: { id, nazwa: 'integracja testowa', prefiks, zakresy: ['druk'] },
      });
    } finally { await app2.close(); db2.close(); }
  });

  it('klucz odnotowuje użycie najwyżej raz na 60 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T10:00:00.000Z'));
    const { klucz: k, id } = klucz();
    const uzycie = () => db.prepare('SELECT ostatnio_uzyty_at FROM klucze_api WHERE id = ?').get(id).ostatnio_uzyty_at;
    expect((await ja(bearer(k))).statusCode).toBe(200);
    expect(uzycie()).toBe('2026-11-06T10:00:00.000Z');
    vi.setSystemTime(new Date('2026-11-06T10:00:59.000Z'));
    expect((await ja(bearer(k))).statusCode).toBe(200);
    expect(uzycie()).toBe('2026-11-06T10:00:00.000Z');
    vi.setSystemTime(new Date('2026-11-06T10:01:00.000Z'));
    expect((await ja(bearer(k))).statusCode).toBe(200);
    expect(uzycie()).toBe('2026-11-06T10:01:00.000Z');
  });
});

// Poprawka po recenzji PRZ-153.04: router (find-my-way) dekoduje %XX w ścieżce przed dopasowaniem trasy,
// więc `/api/v%31/ja` trafia do trasy /api/v1/ja. Strażnik musi uznać taki adres za API (tylko klucz).
describe('strażnik: zakodowana ścieżka /api/v1 (surowe HTTP)', () => {
  let adres;
  const surowe = (path, { method = 'GET', headers = {} } = {}) => new Promise((ok, zle) => {
    const r = http.request({ host: adres.hostname, port: adres.port, path, method, headers }, (res) => {
      let tresc = ''; res.on('data', (c) => { tresc += c; }); res.on('end', () => ok({ status: res.statusCode, tresc }));
    });
    r.on('error', zle);
    r.end();
  });
  const json = (r) => { try { return JSON.parse(r.tresc); } catch { return null; } };
  const ciasteczko = () => ({ cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('ala', odczytajSekret(db))}` });
  const ZAKODOWANE = ['/api/v%31/ja', '/api/%761/ja'];
  // /ja sama odmawia bez req.kluczApi, a 404 pluginu nie — dlatego obie trasy.
  const ZAKODOWANE_PANEL = [...ZAKODOWANE, '/api/v%31/nie-ma', '/api/%761/nie-ma'];

  beforeEach(async () => { adres = new URL(await app.listen({ port: 0, host: '127.0.0.1' })); });

  it('ciasteczko admina na zakodowanej ścieżce → 401 kod klucz', async () => {
    for (const path of ZAKODOWANE_PANEL) {
      const r = await surowe(path, { headers: { ...ciasteczko(), accept: 'application/json' } });
      expect(r.status, path).toBe(401);
      expect(json(r), path).toEqual(ODMOWA);
    }
  });

  it('Basic konta serwisowego na zakodowanej ścieżce → 401 kod klucz', async () => {
    for (const path of ZAKODOWANE_PANEL) {
      const r = await surowe(path, { headers: { authorization: BASIC } });
      expect(r.status, path).toBe(401);
      expect(json(r), path).toEqual(ODMOWA);
    }
  });

  it('POST na zakodowaną ścieżkę z ciasteczkiem → 401 (nie 403 CSRF ani 200)', async () => {
    for (const path of ZAKODOWANE_PANEL) {
      const r = await surowe(path, { method: 'POST', headers: { ...ciasteczko(), 'content-type': 'application/json' } });
      expect(r.status, path).toBe(401);
      expect(json(r), path).toEqual(ODMOWA);
    }
  });

  it('zakodowana ścieżka z ważnym kluczem → 200 i wywołanie liczy się do limitu klucza', async () => {
    const { klucz: k } = klucz();
    for (let i = 0; i < 120; i++) {
      const r = await surowe(ZAKODOWANE[i % 2], { headers: bearer(k) });
      expect(r.status, `wywołanie ${i + 1}`).toBe(200);
    }
    const ponad = await surowe('/api/v1/ja', { headers: bearer(k) });
    expect(ponad.status).toBe(429);
    expect(json(ponad)).toMatchObject({ kod: 'limit' });
  });

  it('ciasteczko admina na /api/v1x (nie API) nie dostaje odmowy kod klucz', async () => {
    for (const path of ['/api/v1x', '/api/v1x/ja', '/api/v10/ja']) {
      const r = await surowe(path, { headers: { ...ciasteczko(), accept: 'application/json' } });
      expect(r.status, path).not.toBe(401);
      expect(json(r), path).not.toEqual(ODMOWA);
    }
  });
});

describe('czyAdresApiV1: ścieżka zdekodowana jak w routerze', () => {
  it('rozpoznaje zakodowane /api/v1, odróżnia wielkość liter i sąsiednie adresy, złe kodowanie = API', () => {
    for (const url of ['/api/v1', '/api/v1/ja', '/api/v1?x=1', '/api/v%31/ja', '/api/%761/ja', '/%61pi/v1/ja', '/api/v1%2Fja', '/api/v1/ja%zz', '/inne%E0%A4%A']) {
      expect(czyAdresApiV1(url), url).toBe(true);
    }
    for (const url of ['/api/v1x', '/api/v10/ja', '/API/v1/ja', '/api/V1/ja', '/api', '/zamowienia?u=/api/v1/', '/api/v%2531/ja']) {
      expect(czyAdresApiV1(url), url).toBe(false);
    }
  });
});
