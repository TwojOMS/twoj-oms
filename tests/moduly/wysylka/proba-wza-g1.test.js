import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createAtrapaAllegro } from '../../../deploy/proba/atrapy/kanaly.mjs';
import { createAllegroWzaClient } from '../../../src/oms/kurierzy/allegro-wza.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { METODY_WZA } from '../../../src/domena/allegro-wysylka.js';

// Napis na stronie PDF (pdfkit bez kompresji: tekst jako <hex> w tablicach TJ), nie metadane dokumentu.
const tekstPdf = (b) => [...b.toString('latin1').matchAll(/\[([^\]]*)\]\s*TJ/g)]
  .map(m => [...m[1].matchAll(/<([0-9a-f]+)>/gi)].map(h => Buffer.from(h[1], 'hex').toString('latin1')).join('')).join('\n');

const headers = { authorization: `Basic ${Buffer.from('operator:x').toString('base64')}`, origin: 'http://localhost' };
let db, server, katalog;
afterEach(async () => { await server?.close(); db?.close(); if (katalog) fs.rmSync(katalog, { recursive: true, force: true }); });

function przygotuj(brak = false) {
  db = openOmsDb(':memory:');
  const id = zapiszZamowienie(db, 'allegro_demo', {
    zrodlo_id: 'demo-g1', numer: 'DEMO-G1', metoda_wysylki: 'allegro_dpd',
    klient: { email: 'odbiorca@example.test', phone: '+48500100200' },
    dostawa: { first_name: 'Ala', last_name: 'Wzorcowa', address_1: 'Testowa 1', postcode: '00-001', city: 'Warszawa', country: 'PL' },
    kwota_pobrania: null, chce_fakture: 0, nip: null, anulowane: 0,
    kwota_brutto: '99.00', status_woo: 'processing', oplacone_at: '2026-11-01T12:00:00',
    utworzone_at: '2026-11-01T12:00:00', pozycje: [],
  }, {});
  const atrapa = createAtrapaAllegro({ db, kanal: 'allegro_demo', env: { OMS_TRYB: 'proba' }, log: () => {} });
  if (brak) atrapa.pobierzMetodeDostawy = async () => null;
  const wza = createAllegroWzaClient({ allegroDla: () => atrapa, metodaZywa: z => atrapa.pobierzMetodeDostawy(z.zrodlo_id) });
  katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'wza-g1-'));
  const kurierzy = { allegro_wza: wza };
  server = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'x' }, sklepy: {}, kanaly: { allegro_demo: {} },
    definicje: [{ klucz: 'allegro_demo', typ: 'allegro', etykieta: 'Allegro demo', raport: 'ALLEGRO_DEMO', prefiks: 'ALLEGRO_DEMO' }] },
    poller: { stan: () => ({}) }, nadanie: createNadanie({ db, kurierzy, katalogEtykiet: katalog }), kurierzy });
  return id;
}

it('Allegro w próbie otwiera formularz nadania przez prawdziwy adapter WzA', async () => {
  const id = przygotuj();
  const r = await server.inject({ url: `/zamowienia/${id}/nadaj`, headers });
  expect(r.statusCode, r.body.match(/role="alert">([^<]+)/)?.[1]).toBe(200);
  expect(r.body).toContain(`action="/zamowienia/${id}/nadaj"`);
});

it('mapuje metody demo na usługi WzA, a obce i nieznane zamówienia na null', async () => {
  const id = przygotuj();
  const a = createAtrapaAllegro({ db, kanal: 'allegro_demo', env: { OMS_TRYB: 'proba' }, log: () => {} });
  for (const [metoda, nazwa] of [['allegro_dpd', 'Allegro Kurier DPD (AD)'], ['allegro_punkt', 'Allegro One Box, One Kurier'], ['allegro_kurier', 'Allegro Kurier DHL (AD)']]) {
    db.prepare('UPDATE zamowienia SET metoda_wysylki = ? WHERE id = ?').run(metoda, id);
    const usluga = await a.pobierzMetodeDostawy('demo-g1');
    expect(METODY_WZA[usluga]?.nazwa).toBe(nazwa);
  }
  db.prepare("UPDATE zamowienia SET metoda_wysylki = 'allegro_dpd', pobranie = 1 WHERE id = ?").run(id);
  expect(METODY_WZA[await a.pobierzMetodeDostawy('demo-g1')]?.pobranie).toBe(true);
  db.prepare("UPDATE zamowienia SET metoda_wysylki = 'allegro_kurier' WHERE id = ?").run(id);
  expect(METODY_WZA[await a.pobierzMetodeDostawy('demo-g1')]?.pobranie).toBe(true);
  db.prepare("UPDATE zamowienia SET metoda_wysylki = 'nieznana' WHERE id = ?").run(id);
  expect(await a.pobierzMetodeDostawy('demo-g1')).toBeNull();
  expect(await a.pobierzMetodeDostawy('obce-zamowienie')).toBeNull();
});

it('zatwierdzenie formularza zapisuje przesyłkę i PDF ATRAPA bez sieci', async () => {
  const id = przygotuj();
  const r = await server.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers,
    payload: { kolejnosc: '1', waga: '1', dlugosc: '30', szerokosc: '20', wysokosc: '10',
      delivery_method_id_allegro: '03f26351-f683-4db2-8895-f2c599280e3c',
      nazwa: 'Ala Wzorcowa', company: 'Ala Wzorcowa', ulica: 'Testowa 1', kod: '00-001', miasto: 'Warszawa', kraj: 'PL', phone: '+48500100200', email: 'odbiorca@example.test' } });
  expect(r.statusCode, r.body.match(/role="alert">([^<]+)/)?.[1]).toBe(302);
  const p = db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').get(id);
  expect(p.numer_listu).toContain('ATRAPA');
  const pdf = fs.readFileSync(p.etykieta_sciezka);
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(tekstPdf(pdf).split('\n')).toContain('ATRAPA');
});

it.each(['GET', 'POST'])('brak usługi: %s zwraca 400 HTML z układem i bezpiecznym powrotem', async method => {
  const id = przygotuj(true);
  const r = await server.inject({ method, url: `/zamowienia/${id}/nadaj`, headers, ...(method === 'POST' ? { payload: { kolejnosc: '1' } } : {}) });
  expect(r.statusCode).toBe(400);
  expect(r.headers['content-type']).toContain('text/html');
  expect(r.body).toMatch(/<!doctype html>/i);
  expect(r.body).toContain('Wróć do zamówienia');
  expect(r.body).toContain(`href="/zamowienia/${id}"`);
  expect(r.body).toContain('Allegro');
});
