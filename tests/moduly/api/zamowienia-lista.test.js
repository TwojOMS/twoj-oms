import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openOmsDb } from '../../pomoc/baza-prz012.js';
import { pluginApiV1 } from '../../../src/moduly/api/plugin.js';
import { migracjaDokumentuProgramu } from '../../../src/moduly/rdzen/migracje/0008-dokument-programu.ts';

let db, app;
beforeEach(async () => {
  db = openOmsDb();
  migracjaDokumentuProgramu.wykonaj(db);
  db.exec('CREATE INDEX zamowienia_julianday_utworzenia ON zamowienia (julianday(utworzone_at), sklep)');
  const wstaw = db.prepare('INSERT INTO zamowienia (id, sklep, zrodlo_id, numer, klient_json, kwota_brutto, utworzone_at, chce_fakture, nip, metoda_platnosci) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [id, data] of [[1, '2026-10-31T22:30:00Z'], [3, '2026-10-31T23:30:00Z'], [5, '2026-11-01T22:59:59Z'], [7, '2026-11-01T23:00:00Z'], [9, '2026-11-02T12:00:00Z']]) {
    wstaw.run(id, 'testowy', id, `Z-${id}`, JSON.stringify({ first_name: 'Ala', last_name: 'Mak', email: 'ala@example.test', company: 'Pracownia Półcień' }), '123.45', data, 1, '1234567890', 'przelew');
  }
  db.prepare('INSERT INTO pozycje (zamowienie_id, nazwa, sku, ilosc, cena_brutto, vat) VALUES (?, ?, ?, ?, ?, ?)').run(3, 'Próbka', 'ABC', 2, '12.34', '23');
  app = Fastify();
  app.register(async api => {
    api.addHook('onRequest', async req => { req.kluczApi = { id: 1, zakresy: new Set(req.headers['x-bez-zakresu'] ? [] : ['zamowienia:odczyt']) }; });
    await api.register(pluginApiV1, { ctx: { db, teraz: () => new Date() } });
  }, { prefix: '/api/v1' });
  await app.ready();
});
afterEach(async () => { await app.close(); db.close(); });

describe('zamówienia API v1', () => {
  it('stronicuje po identyfikatorach z lukami', async () => {
    const a = (await app.inject('/api/v1/zamowienia?ile=2')).json();
    const b = (await app.inject(`/api/v1/zamowienia?ile=2&po=${a.nastepny}`)).json();
    const c = (await app.inject(`/api/v1/zamowienia?ile=2&po=${b.nastepny}`)).json();
    expect([a.pozycje.map(x => x.id), a.nastepny, b.pozycje.map(x => x.id), b.nastepny, c.pozycje.map(x => x.id), c.nastepny]).toEqual([[1, 3], 3, [5, 7], 7, [9], null]);
  });
  it('filtruje datę według doby warszawskiej', async () => {
    const r = await app.inject('/api/v1/zamowienia?od=2026-11-01&do=2026-11-01');
    expect(r.statusCode).toBe(200);
    expect(r.json().pozycje.map(x => x.id)).toEqual([3, 5]);
  });
  it('odrzuca nieznany status i błędne daty', async () => {
    for (const query of ['status=nieznany', 'od=2026-02-30', 'do=abc']) {
      const r = await app.inject(`/api/v1/zamowienia?${query}`);
      expect(r.statusCode).toBe(400); expect(r.json().kod).toBe('filtr');
    }
  });
  it('łączy filtry numeru, kanału i statusu', async () => {
    db.prepare('UPDATE zamowienia SET w_realizacji_at = ? WHERE id = 3').run('2026-11-01T09:00:00Z');
    const r = await app.inject('/api/v1/zamowienia?status=w_realizacji&kanal=testowy&numer=Z-3');
    expect(r.json().pozycje.map(x => x.id)).toEqual([3]);
    expect((await app.inject('/api/v1/zamowienia?status=nowe&numer=Z-3')).json().pozycje).toEqual([]);
  });
  it('zapis lokalny sklepu zwraca w UTC', async () => {
    db.prepare('UPDATE zamowienia SET utworzone_at = ? WHERE id = 3').run('2026-07-01T12:30:00');
    const r = await app.inject('/api/v1/zamowienia/3');
    expect(r.json().utworzone_at).toBe('2026-07-01T10:30:00.000Z');
  });
  it('zwraca 404 dla nieistniejącego i nieliczbowego id', async () => {
    for (const id of ['999', 'abc']) { const r = await app.inject(`/api/v1/zamowienia/${id}`); expect(r.statusCode).toBe(404); expect(r.json().kod).toBe('brak'); }
  });
  it('wymaga zakresu na obu trasach', async () => {
    for (const url of ['/api/v1/zamowienia', '/api/v1/zamowienia/3']) expect((await app.inject({ url, headers: { 'x-bez-zakresu': '1' } })).statusCode).toBe(403);
  });
  it('zwraca szczegóły i grosze z danych zamówienia', async () => {
    const r = await app.inject('/api/v1/zamowienia/3');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: 3, numer: 'Z-3', kanal: 'testowy', status: 'nowe', utworzone_at: '2026-10-31T23:30:00.000Z', klient: { imie: 'Ala', nazwisko: 'Mak', email: 'ala@example.test' }, suma_gr: 12345, waluta: 'PLN', pozycje: [{ nazwa: 'Próbka', sku: 'ABC', ilosc: 2, cena_brutto_gr: 1234, stawka_vat: '23' }], platnosc: { metoda: 'przelew', oplacone: false }, faktura: { chce: true, nip: '1234567890' } });
  });
  it('zwraca w szczegółach tę samą dostawę co osobna trasa', async () => {
    const szczegoly = await app.inject('/api/v1/zamowienia/3');
    const dostawa = await app.inject('/api/v1/zamowienia/3/dostawa');
    expect(dostawa.statusCode).toBe(200);
    expect(szczegoly.json().dostawa).toEqual(dostawa.json());
  });
});
