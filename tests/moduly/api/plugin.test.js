import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { pluginApiV1 } from '../../../src/moduly/api/plugin.js';
import { czytajStronicowanie } from '../../../src/moduly/api/odpowiedzi.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';

const aplikacje = [];
afterEach(async () => { for (const app of aplikacje.splice(0)) await app.close(); });
function serwer(klucz = true) {
  const app = Fastify();
  aplikacje.push(app);
  app.register(async api => {
    api.addHook('onRequest', async req => {
      if (klucz) req.kluczApi = { id: 1, nazwa: 'integracja testowa', prefiks: 'abcdefgh', zakresy: new Set(['druk', 'zamowienia:odczyt']) };
    });
    await api.register(pluginApiV1, { ctx: {} });
  }, { prefix: '/api/v1' });
  return app;
}

describe('plugin API v1', () => {
  it('startuje w domyślnym składzie buildOmsServer z trasą ja', async () => {
    const db = openOmsDb();
    const app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'fixture' } } });
    try {
      await app.ready();
      const r = await app.inject({ url: '/api/v1/ja', headers: { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}` } });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ kod: 'klucz', powod: 'Brak, zły albo odwołany klucz API.' });
    } finally { await app.close(); db.close(); }
  });
  it('oddaje nazwę, prefiks i zakresy klucza', async () => {
    const r = await serwer().inject('/api/v1/ja');
    expect(r.statusCode).toBe(200);
    // E1.2b: zakresy w kolejności ZAKRESY_API (tests/moduly/api/ja.test.js), nie w kolejności wstawienia do Set.
    expect(r.json()).toEqual({ nazwa: 'integracja testowa', prefiks: 'abcdefgh', zakresy: ['zamowienia:odczyt', 'druk'] });
  });
  it('broni trasy ja przed brakiem klucza', async () => {
    const r = await serwer(false).inject('/api/v1/ja');
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ kod: 'klucz', powod: 'Brak, zły albo odwołany klucz API.' });
  });
  it('bez req.kluczApi każda trasa pluginu i jego 404 → 401 kod klucz (druga warstwa za strażnikiem)', async () => {
    const app = Fastify();
    aplikacje.push(app);
    app.register(async api => {
      await pluginApiV1(api, { ctx: {} });
      api.get('/bez-wlasnej-ochrony', async () => ({ wpuszczono: true }));
      api.post('/zapis', async () => ({ zapisano: true }));
    }, { prefix: '/api/v1' });
    for (const zadanie of [{ url: '/api/v1/bez-wlasnej-ochrony' }, { url: '/api/v1/nie-ma' }, { method: 'POST', url: '/api/v1/zapis' }]) {
      const r = await app.inject(zadanie);
      expect(r.statusCode, zadanie.url).toBe(401);
      expect(r.json(), zadanie.url).toEqual({ kod: 'klucz', powod: 'Brak, zły albo odwołany klucz API.' });
    }
  });
  it('ogranicza format 404 do prefiksu API', async () => {
    const app = serwer();
    const r = await app.inject('/api/v1/nie-ma');
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ kod: 'brak', powod: 'Nie ma takiego adresu w API.' });
    const poza = await app.inject('/inne');
    expect(poza.statusCode).toBe(404);
    expect(poza.json()).not.toHaveProperty('kod');
    expect(poza.json()).not.toHaveProperty('powod');
  });
  it('oddaje uszkodzony JSON w formacie API', async () => {
    const r = await serwer().inject({ method: 'POST', url: '/api/v1/ja', headers: { 'content-type': 'application/json' }, payload: '{' });
    expect([400, 404]).toContain(r.statusCode);
    expect(r.json()).toEqual({ kod: expect.any(String), powod: expect.any(String) });
  });
  it('obsługuje błędy wewnątrz pluginu bez ujawniania szczegółów i bez wpływu na inne trasy', async () => {
    const app = Fastify();
    aplikacje.push(app);
    app.register(async api => {
      // Klucz jak po strażniku: bez niego hak onRequest pluginu odmawia 401, zanim dojdzie do błędów niżej.
      api.addHook('onRequest', async req => { req.kluczApi = { id: 1, nazwa: 'integracja testowa', prefiks: 'abcdefgh', zakresy: new Set() }; });
      await pluginApiV1(api, { ctx: {} });
      api.get('/wyjatek', async () => { throw new Error('Szczegóły wewnętrzne'); });
      api.get('/strona', async req => czytajStronicowanie(req.query));
      api.post('/json', async req => req.body);
      api.get('/walidacja', { schema: { querystring: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } } }, async () => ({}));
      for (const statusCode of [413, 415]) api.get(`/blad-${statusCode}`, async () => { throw Object.assign(new Error('Odrzucone żądanie.'), { statusCode }); });
    }, { prefix: '/api/v1' });
    app.get('/wyjatek', async () => { throw new Error('Poza API'); });
    const r = await app.inject('/api/v1/wyjatek');
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ kod: 'blad', powod: 'Błąd serwera.' });
    expect((await app.inject('/wyjatek')).json()).not.toHaveProperty('kod');
    const strona = await app.inject('/api/v1/strona?ile=201');
    expect(strona.statusCode).toBe(400);
    expect(strona.json()).toEqual({ kod: 'stronicowanie', powod: expect.any(String) });
    for (const response of [await app.inject('/api/v1/walidacja'), await app.inject({ method: 'POST', url: '/api/v1/json', headers: { 'content-type': 'application/json' }, payload: '{' })]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ kod: 'zadanie', powod: expect.any(String) });
    }
    for (const [statusCode, kod] of [[413, 'plik'], [415, 'typ']]) {
      const response = await app.inject(`/api/v1/blad-${statusCode}`);
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual({ kod, powod: expect.any(String) });
    }
  });
});
