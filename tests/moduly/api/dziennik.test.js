// PRZ-153.E1.3b — dziennik wywołań /api/v1 (hak onResponse pluginu) i zegar sprzątania (plan PRZ-153, E1.3).
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { pluginApiV1 } from '../../../src/moduly/api/plugin.js';
import { modulApi } from '../../../src/moduly/api/modul.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zalozKluczApi, dopiszDoDziennikaApi } from '../../../src/core/bezpieczenstwo/klucze-api.js';
import { wpisDoDziennika } from '../../../src/core/bezpieczenstwo/dziennik-api.js';

const TERAZ = new Date('2026-11-06T10:00:00.000Z');
const sprzatanie = [];
afterEach(async () => { for (const f of sprzatanie.splice(0).reverse()) await f(); });

function baza() {
  const db = openOmsDb(':memory:');
  sprzatanie.push(() => db.close());
  return db;
}
const wiersze = (db) => db.prepare('SELECT klucz_id, prefiks, at, metoda, sciezka, status, ip FROM klucze_api_dziennik ORDER BY id').all();

describe('dziennik API: hak onResponse pluginu', () => {
  function serwer(db, kluczId) {
    const app = Fastify();
    sprzatanie.push(() => app.close());
    app.register(async (api) => {
      api.addHook('onRequest', async (req) => {
        req.kluczApi = { id: kluczId, nazwa: 'integracja testowa', prefiks: 'abcdefgh', zakresy: new Set(['druk']) };
      });
      await pluginApiV1(api, { ctx: { db, teraz: () => TERAZ } });
      api.post('/zapis', async () => ({ ok: true }));
      api.get('/odczyt', async () => ({ ok: true }));
    }, { prefix: '/api/v1' });
    return app;
  }

  it('POST → wiersz z klucz_id, ścieżką bez zapytania i statusem; udany GET → brak wiersza', async () => {
    const db = baza();
    const { id } = zalozKluczApi(db, { nazwa: 'integracja testowa', zakresy: ['druk'], kontoId: null, teraz: TERAZ.toISOString() });
    const app = serwer(db, id);
    expect((await app.inject({ method: 'GET', url: '/api/v1/odczyt?a=1' })).statusCode).toBe(200);
    expect(wiersze(db)).toEqual([]);
    const r = await app.inject({ method: 'POST', url: '/api/v1/zapis?tajne=1', payload: { a: 1 }, remoteAddress: '10.0.0.9' });
    expect(r.statusCode).toBe(200);
    expect(wiersze(db)).toEqual([{ klucz_id: id, prefiks: 'abcdefgh', at: TERAZ.toISOString(), metoda: 'POST',
      sciezka: '/api/v1/zapis', status: 200, ip: '10.0.0.9' }]);
  });

  it('GET z błędem (404) też trafia do dziennika', async () => {
    const db = baza();
    const { id } = zalozKluczApi(db, { nazwa: 'integracja testowa', zakresy: ['druk'], kontoId: null, teraz: TERAZ.toISOString() });
    const app = serwer(db, id);
    expect((await app.inject('/api/v1/nie-ma')).statusCode).toBe(404);
    expect(wiersze(db)).toMatchObject([{ klucz_id: id, metoda: 'GET', sciezka: '/api/v1/nie-ma', status: 404 }]);
  });
});

describe('dziennik API w pełnym składzie (strażnik + plugin)', () => {
  async function pelny() {
    const db = baza();
    const app = buildOmsServer({ db, config: { auth: { user: 'serwis', pass: 'haslo-env' }, klienciZbiorczy: [] } });
    sprzatanie.push(() => app.close());
    await app.ready();
    return { db, app };
  }

  it('udany GET kluczem → brak wiersza, ustawione ostatnio_uzyty_at', async () => {
    const { db, app } = await pelny();
    const { klucz, id } = zalozKluczApi(db, { nazwa: 'integracja testowa', zakresy: ['druk'], kontoId: null, teraz: TERAZ.toISOString() });
    const r = await app.inject({ url: '/api/v1/ja', headers: { authorization: `Bearer ${klucz}` } });
    expect(r.statusCode).toBe(200);
    expect(wiersze(db)).toEqual([]);
    expect(db.prepare('SELECT ostatnio_uzyty_at FROM klucze_api WHERE id = ?').get(id).ostatnio_uzyty_at).toEqual(expect.any(String));
  });

  it('401 → jeden wiersz z klucz_id NULL i prefiksem z nagłówka; bez nagłówka prefiks NULL', async () => {
    const { db, app } = await pelny();
    const zly = `toms_zzzzzzzz_${'D'.repeat(43)}`;
    expect((await app.inject({ url: '/api/v1/ja?x=1', headers: { authorization: `Bearer ${zly}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/ja' })).statusCode).toBe(401);
    expect(wiersze(db)).toMatchObject([
      { klucz_id: null, prefiks: 'zzzzzzzz', metoda: 'GET', sciezka: '/api/v1/ja', status: 401 },
      { klucz_id: null, prefiks: null, metoda: 'POST', sciezka: '/api/v1/ja', status: 401 },
    ]);
  });

  it('błędny nagłówek bez prefiksu dławi po IP', async () => {
    const { db, app } = await pelny();
    for (let i = 0; i < 3; i++) {
      expect((await app.inject({ url: '/api/v1/ja', headers: { authorization: 'Bearer bledny' }, remoteAddress: '10.0.0.1' })).statusCode).toBe(401);
    }
    expect((await app.inject({ url: '/api/v1/ja', headers: { authorization: 'Bearer bledny' }, remoteAddress: '10.0.0.2' })).statusCode).toBe(401);
    expect(wiersze(db).map((w) => [w.prefiks, w.ip])).toEqual([[null, '10.0.0.1'], [null, '10.0.0.2']]);
  });
});

describe('dziennik API przy blokadzie adresu IP', () => {
  it('100 żądań w oknie blokady → jeden wiersz 429, nie sto', async () => {
    const db = baza();
    const app = buildOmsServer({ db, config: { auth: { user: 'serwis', pass: 'haslo-env' }, klienciZbiorczy: [] } });
    sprzatanie.push(() => app.close());
    await app.ready();
    const zly = `toms_zzzzzzzz_${'D'.repeat(43)}`;
    for (let i = 0; i < 20; i++) {
      expect((await app.inject({ url: '/api/v1/ja', headers: { authorization: `Bearer ${zly}` } })).statusCode).toBe(401);
    }
    for (let i = 0; i < 100; i++) {
      expect((await app.inject({ url: '/api/v1/ja', headers: { authorization: `Bearer ${zly}` } })).statusCode).toBe(429);
    }
    const statusy = wiersze(db).map((w) => w.status);
    expect(statusy.filter((s) => s === 401)).toHaveLength(1);
    expect(statusy.filter((s) => s === 429)).toHaveLength(1);
  });
});

describe('dławienie dziennika przez HTTP', () => {
  function serwer(db, zegar, opcje) {
    const app = Fastify();
    sprzatanie.push(() => app.close());
    app.addHook('onRequest', async (req) => {
      const id = Number(req.headers['x-test-klucz']);
      if (id) req.kluczApi = { id, prefiks: 'abcdefgh', zakresy: new Set(['druk']) };
    });
    app.addHook('onResponse', wpisDoDziennika({ db, teraz: () => zegar.czas }, opcje));
    app.all('/*', async (req, reply) => reply.code(Number(req.headers['x-test-status'] || 200)).send({ ok: true }));
    return app;
  }
  function klucz(db) {
    return zalozKluczApi(db, { nazwa: 'test', zakresy: ['druk'], kontoId: null, teraz: TERAZ.toISOString() }).id;
  }
  const wyslij = (app, url, status, id, extra = {}) => app.inject({ url, headers: { 'x-test-status': String(status), ...(id ? { 'x-test-klucz': String(id) } : {}) }, ...extra });

  it('dławi błędy przez minutę, rozróżnia status, ścieżkę i klucz', async () => {
    const db = baza();
    const id = klucz(db), inny = klucz(db), zegar = { czas: TERAZ };
    const app = serwer(db, zegar);
    for (const status of [401, 403]) {
      for (let i = 0; i < 3; i++) await wyslij(app, '/api/v1/blad?numer=' + i, status, id);
    }
    await wyslij(app, '/api/v1/inny', 401, id);
    await wyslij(app, '/api/v1/blad', 401, inny);
    expect(wiersze(db).map((w) => [w.klucz_id, w.status, w.sciezka])).toEqual([
      [id, 401, '/api/v1/blad'], [id, 403, '/api/v1/blad'],
      [id, 401, '/api/v1/inny'], [inny, 401, '/api/v1/blad'],
    ]);
    zegar.czas = new Date(TERAZ.getTime() + 61_000);
    await wyslij(app, '/api/v1/blad', 401, id);
    expect(wiersze(db)).toHaveLength(5);
  });

  it('brak klucza i prefiksu rozróżnia po IP', async () => {
    const db = baza(), app = serwer(db, { czas: TERAZ });
    for (let i = 0; i < 3; i++) await wyslij(app, '/api/v1/ja', 401, null, { remoteAddress: '10.0.0.1' });
    await wyslij(app, '/api/v1/ja', 401, null, { remoteAddress: '10.0.0.2' });
    expect(wiersze(db).map((w) => w.ip)).toEqual(['10.0.0.1', '10.0.0.2']);
  });

  it('ten sam klucz z dwóch komputerów albo inną metodą daje osobne wiersze', async () => {
    const db = baza(), id = klucz(db), app = serwer(db, { czas: TERAZ });
    for (const ip of ['10.0.0.1', '10.0.0.1', '10.0.0.2', '10.0.0.2']) await wyslij(app, '/api/v1/blad', 401, id, { remoteAddress: ip });
    for (let i = 0; i < 2; i++) await wyslij(app, '/api/v1/blad', 401, id, { method: 'POST', remoteAddress: '10.0.0.1' });
    expect(wiersze(db).map((w) => [w.ip, w.metoda])).toEqual([['10.0.0.1', 'GET'], ['10.0.0.2', 'GET'], ['10.0.0.1', 'POST']]);
  });

  it('udane POST zapisuje zawsze, a nieudany zapis nie zajmuje okna', async () => {
    const db = baza(), id = klucz(db), app = serwer(db, { czas: TERAZ });
    for (let i = 0; i < 3; i++) await wyslij(app, '/api/v1/zapis', 200, id, { method: 'POST' });
    db.exec("CREATE TRIGGER blad_dziennika BEFORE INSERT ON klucze_api_dziennik BEGIN SELECT RAISE(FAIL, 'blad'); END");
    await wyslij(app, '/api/v1/blad', 403, id);
    db.exec('DROP TRIGGER blad_dziennika');
    await wyslij(app, '/api/v1/blad', 403, id);
    expect(wiersze(db).map((w) => w.status)).toEqual([200, 200, 200, 403]);
  });

  it('pamięć dławienia ma twardy limit także dla świeżych wpisów: odpada najstarszy', async () => {
    const db = baza(), id = klucz(db), app = serwer(db, { czas: TERAZ }, { najwiecejWpisow: 2 });
    for (const url of ['/api/v1/a', '/api/v1/b', '/api/v1/c', '/api/v1/a']) await wyslij(app, url, 404, id);
    expect(wiersze(db).map((w) => w.sciezka)).toEqual(['/api/v1/a', '/api/v1/b', '/api/v1/c', '/api/v1/a']);
  });

  it('błąd kolejki druku kluczem druk zapisuje raz', async () => {
    const db = baza();
    const app = buildOmsServer({ db, config: { auth: { user: 'serwis', pass: 'haslo-env' }, klienciZbiorczy: [] } });
    sprzatanie.push(() => app.close());
    const { klucz: token, id } = zalozKluczApi(db, { nazwa: 'druk testowy', zakresy: ['druk'], kontoId: null, teraz: TERAZ.toISOString() });
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({ url: '/kolejka-druku/999999/zpl', headers: { authorization: `Bearer ${token}` } });
      expect(r.statusCode).toBe(404);
    }
    expect(wiersze(db)).toMatchObject([{ klucz_id: id, status: 404, sciezka: '/kolejka-druku/999999/zpl' }]);
    expect(wiersze(db)).toHaveLength(1);
  });
});

describe('zegar modułu api', () => {
  it('co godzinę usuwa wpisy starsze niż 90 dni: sprzed 91 dni znika, sprzed 89 zostaje', async () => {
    const db = baza();
    const dni = (n) => new Date(TERAZ.getTime() - n * 86_400_000).toISOString();
    for (const n of [91, 89]) {
      dopiszDoDziennikaApi(db, { kluczId: null, prefiks: null, at: dni(n), metoda: 'GET', sciezka: '/api/v1/ja', status: 401, ip: null });
    }
    const zbudowany = modulApi.zbuduj({ db, teraz: () => TERAZ, log: () => {} });
    const zegary = zbudowany.zegary ?? [];
    expect(zegary.map((z) => [z.nazwa, z.odstepMs])).toEqual([['api-dziennik', 3_600_000], ['api-idempotencja', 3_600_000]]);
    await zegary[0].przebieg();
    expect(wiersze(db).map((w) => w.at)).toEqual([dni(89)]);
  });

  it('błąd sprzątania trafia do logu i nie wywraca przebiegu', async () => {
    const log = [];
    const db = { prepare: () => { throw new Error('baza zamknięta'); } };
    const [zegar] = modulApi.zbuduj({ db, teraz: () => TERAZ, log: (...t) => log.push(t.join(' ')) }).zegary;
    await expect(zegar.przebieg()).resolves.toBeUndefined();
    expect(log.join('\n')).toContain('baza zamknięta');
  });
});
