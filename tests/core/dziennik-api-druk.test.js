import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { buildOmsServer } from '../pomoc/serwer-parytetu.ts';
import { zalozKluczApi } from '../../src/core/bezpieczenstwo/klucze-api.js';
import { zapiszZamowienie } from '../../src/oms/db/zamowienia.js';
import { zapiszProforme } from '../../src/moduly/faktury/db/proformy.js';
import { dodajProformeDoKolejki } from '../../src/moduly/faktury/db/kolejka-druku-proform.js';

const TERAZ = '2026-11-06T10:00:00.000Z';
const POST = '/kolejka-druku-faktur/p1/wydrukowano';
const BASIC = `Basic ${Buffer.from('serwis:haslo-testowe').toString('base64')}`;
let db;
let app;
const wiersze = () => db.prepare('SELECT klucz_id, prefiks, metoda, sciezka, status FROM klucze_api_dziennik ORDER BY id').all();
const klucz = (zakresy = ['druk']) => zalozKluczApi(db, {
  nazwa: 'czuwacz testowy', zakresy, kontoId: null, teraz: TERAZ,
});
const post = (authorization, url = POST) => app.inject({
  method: 'POST', url, headers: { authorization, origin: 'http://localhost:80' },
});

beforeEach(async () => {
  db = openOmsDb(':memory:');
  const zamowienieId = zapiszZamowienie(db, 'pro', {
    zrodlo_id: 7001, numer: 'TEST-7001', klient: { first_name: 'Ala Testowa' }, dostawa: {},
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: null,
    status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: TERAZ,
    kwota_brutto: '10.00', koszt_dostawy_brutto: '0.00', pozycje: [],
  }, {});
  const p = zapiszProforme(db, zamowienieId, { kwotaBrutto: '10.00', rok: 2026, miesiac: 11, utworzonaAt: TERAZ });
  dodajProformeDoKolejki(db, p.id);
  app = buildOmsServer({ db, config: { auth: { user: 'serwis', pass: 'haslo-testowe' }, klienciZbiorczy: [] } });
  await app.ready();
});
afterEach(async () => { await app.close(); db.close(); });

describe('dziennik API kolejek druku', () => {
  it('POST kluczem druk zapisuje jeden wpis z klucz_id i bez zapytania', async () => {
    const k = klucz();
    expect((await post(`Bearer ${k.klucz}`, `${POST}?tajne=1`)).statusCode).toBe(200);
    expect(wiersze()).toEqual([{ klucz_id: k.id, prefiks: k.prefiks, metoda: 'POST', sciezka: POST, status: 200 }]);
  });

  it('zły Bearer zapisuje 401 z klucz_id NULL i prefiksem z poprawnego formatu', async () => {
    const zly = `toms_zzzzzzzz_${'D'.repeat(43)}`;
    expect((await post(`Bearer ${zly}`)).statusCode).toBe(401);
    expect(wiersze()).toEqual([{ klucz_id: null, prefiks: 'zzzzzzzz', metoda: 'POST', sciezka: POST, status: 401 }]);
  });

  it('klucz bez zakresu druk zapisuje 403 także na zakodowanej ścieżce', async () => {
    const k = klucz(['zamowienia:odczyt']);
    const url = POST.replace('kolejka-druku', 'kolejka%2Ddruku');
    expect((await post(`Bearer ${k.klucz}`, url)).statusCode).toBe(403);
    expect(wiersze()).toEqual([{ klucz_id: k.id, prefiks: k.prefiks, metoda: 'POST', sciezka: url, status: 403 }]);
  });

  it('udany GET kolejki nie zapisuje wpisu', async () => {
    const k = klucz();
    expect((await app.inject({ url: '/kolejka-druku-faktur', headers: { authorization: `Bearer ${k.klucz}` } })).statusCode).toBe(200);
    expect(wiersze()).toEqual([]);
  });

  it('Basic nie zapisuje wpisu przy POST ani błędzie GET', async () => {
    expect((await post(BASIC)).statusCode).toBe(200);
    expect((await app.inject({ url: '/kolejka-druku-faktur/1/pdf', headers: { authorization: BASIC } })).statusCode).toBe(404);
    expect(wiersze()).toEqual([]);
  });

  it('/api/v1 zapisuje dokładnie jeden wpis przez plugin', async () => {
    const k = klucz();
    expect((await app.inject({ url: '/api/v1/nie-ma', headers: { authorization: `Bearer ${k.klucz}` } })).statusCode).toBe(404);
    expect(wiersze()).toEqual([{ klucz_id: k.id, prefiks: k.prefiks, metoda: 'GET', sciezka: '/api/v1/nie-ma', status: 404 }]);
  });
});
