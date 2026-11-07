import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nowyPanel, get, BASIC } from '../pomoc/konta-prz068.js';
import { dopiszKlientaZbiorczego } from '../moduly/faktury/_klient-zbiorczy-pomocniki.js';
import { zapewnijOkres } from '../../src/oms/db/okresy.js';

describe('PRZ-154 E2.2 — tytuł na sześciu ekranach bez h1', () => {
  let app, db, klientId, okresId;
  beforeAll(() => {
    ({ app, db } = nowyPanel({ podjazdy: {
      sprawdz: async () => ({ id: 1, stan: 'oczekuje', command_id: 'podjazd-testowy' }),
    } }));
    klientId = dopiszKlientaZbiorczego(db);
    okresId = zapewnijOkres(db, {klientKlucz: 'przykladowa', rok: 2026, miesiac: 11}).id;
  });
  afterAll(async () => { await app.close(); db.close(); });

  it.each([
    ['nowe zamówienie', () => '/zamowienia/nowe'],
    ['klienci', () => '/klienci'],
    ['edycja klienta', () => `/klienci/${klientId}/edytuj`],
    ['okresy', () => '/okresy'],
    ['karta okresu', () => `/okresy/${okresId}`],
    ['karta podjazdu', () => '/przesylki/podjazdy/1'],
  ])('%s: dokładnie jeden h1 z tekstem obecnego title', async (_nazwa, adres) => {
    const r = await get(app, adres(), BASIC);
    expect(r.statusCode).toBe(200);
    const tytul = r.body.match(/<title>(.*?)<\/title>/)?.[1];
    expect(tytul).toBeTruthy();
    expect(r.body.match(/<h1\b/g)).toHaveLength(1);
    expect(r.body).toContain(`<h1>${tytul}</h1>`);
    expect(r.body).toMatch(/<header class="naglowek-ekranu"[\s\S]*?<h1>/);
  });
});
