// PRZ-153.E1.2b — GET /api/v1/ja oddaje zakresy w kolejności ZAKRESY_API, niezależnie od kolejności w Set.
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { pluginApiV1 } from '../../../src/moduly/api/plugin.js';
import { ZAKRESY_API } from '../../../src/domena/klucze-api.js';

const aplikacje = [];
afterEach(async () => { for (const app of aplikacje.splice(0)) await app.close(); });

function serwer(zakresy) {
  const app = Fastify();
  aplikacje.push(app);
  app.register(async (api) => {
    api.addHook('onRequest', async (req) => {
      req.kluczApi = { id: 1, nazwa: 'integracja testowa', prefiks: 'abcdefgh', zakresy };
    });
    await api.register(pluginApiV1, { ctx: {} });
  }, { prefix: '/api/v1' });
  return app;
}

describe('GET /api/v1/ja', () => {
  it('zakresy w kolejności ZAKRESY_API, nie w kolejności wstawienia', async () => {
    const odwrotnie = new Set([...ZAKRESY_API].reverse());
    const r = await serwer(odwrotnie).inject('/api/v1/ja');
    expect(r.statusCode).toBe(200);
    expect(r.json().zakresy).toEqual([...ZAKRESY_API]);
  });
  it('pomija napisy spoza ZAKRESY_API', async () => {
    const r = await serwer(new Set(['druk', 'admin', 'produkty:odczyt'])).inject('/api/v1/ja');
    expect(r.json()).toEqual({ nazwa: 'integracja testowa', prefiks: 'abcdefgh', zakresy: ['produkty:odczyt', 'druk'] });
  });
});
