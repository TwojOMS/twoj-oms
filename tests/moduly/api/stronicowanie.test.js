import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { pluginApiV1 } from '../../../src/moduly/api/plugin.js';
import { przelaczStany } from '../../../src/oms/db/stany-magazynowe.js';

let db, app;
beforeEach(async () => {
  db = openOmsDb();
  przelaczStany(db, { wlacz: true, at: '2026-01-01T00:00:00Z' });
  app = Fastify();
  app.register(async api => {
    api.addHook('onRequest', async req => {
      req.kluczApi = { id: 1, zakresy: new Set(['produkty:odczyt', 'stany:odczyt', 'zamowienia:odczyt']) };
    });
    await api.register(pluginApiV1, { ctx: { db, teraz: () => new Date() } });
  }, { prefix: '/api/v1' });
  await app.ready();
});
afterEach(async () => { await app.close(); db.close(); });

it.each(['produkty', 'stany', 'zamowienia'])('%s waliduje stronicowanie', async trasa => {
  for (const q of ['po=abc', 'po=-5', 'ile=500', 'po=1&po=2']) {
    const r = await app.inject(`/api/v1/${trasa}?${q}`);
    expect([r.statusCode, r.json().kod], q).toEqual([400, 'stronicowanie']);
  }
  expect((await app.inject(`/api/v1/${trasa}?po=0&ile=1`)).statusCode).toBe(200);
});
