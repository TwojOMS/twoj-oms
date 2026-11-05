import { afterEach, expect, it } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { buildOmsServer } from '../pomoc/serwer-parytetu.ts';
import { adresLokalny } from '../../src/core/web/odmowa.js';

// PRZ-152.G13: wspólna strona odmowy (stronaOdmowy) na pierwszej trasie, która jej używa.
const headers = { authorization: `Basic ${Buffer.from('operator:x').toString('base64')}`, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' };
let db, server;
afterEach(async () => { await server?.close(); db?.close(); server = db = null; });

it('odmowa z formularza w układzie OMS: status i tekst bez zmian, pasek uwagi, droga powrotu', async () => {
  db = openOmsDb(':memory:');
  server = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'x' }, sklepy: {}, kanaly: {}, definicje: [] }, poller: { stan: () => ({}) } });
  const r = await server.inject({ method: 'POST', url: '/ostrzezenia/odrzuc', headers, payload: 'klucz=%3Cb%3Ezly' });
  expect(r.statusCode).toBe(400);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toMatch(/<html/);
  expect(r.body).toContain('<p class="pasek-uwaga" role="alert">Nieznany klucz ostrzeżenia.</p>');
  expect(r.body).toContain('<h1>Nie udało się ukryć ostrzeżenia</h1>');
  expect(r.body).toContain('<a class="btn" href="/">Wróć do listy zamówień</a>');
});

it('powrót tylko w obrębie panelu', () => {
  expect(adresLokalny('/zamowienia/7?powrot=%2F')).toBe('/zamowienia/7?powrot=%2F');
  for (const zly of ['//obcy.example.test/x', '/\\obcy.example.test', 'https://obcy.example.test', '', undefined, 7]) expect(adresLokalny(zly)).toBe('/');
});
