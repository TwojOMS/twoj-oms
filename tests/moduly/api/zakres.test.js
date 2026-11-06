import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { wymagajZakresu } from '../../../src/moduly/api/zakres.js';

const aplikacje = [];
afterEach(async () => { for (const app of aplikacje.splice(0)) await app.close(); });
describe('zakres klucza API', () => {
  it.each([undefined, new Set(['zamowienia:odczyt']), new Set(['druk'])])('wymaga zakresu druk: %s', async zakresy => {
    const app = Fastify();
    aplikacje.push(app);
    app.addHook('onRequest', async req => { if (zakresy) req.kluczApi = { zakresy }; });
    app.get('/druk', { preHandler: wymagajZakresu('druk') }, async () => ({ ok: true }));
    const r = await app.inject('/druk');
    expect(r.statusCode).toBe(zakresy?.has('druk') ? 200 : 403);
    expect(r.json()).toEqual(zakresy?.has('druk') ? { ok: true } : {
      kod: 'brak_zakresu', powod: 'Klucz nie ma zakresu druk.',
    });
  });
});
