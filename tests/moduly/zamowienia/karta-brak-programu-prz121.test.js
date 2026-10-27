// PRZ-121.03b — zdania „faktury wyłączone” na karcie zamówienia, w korekcie zwrotu i w linii stanu automatu KSeF.
// Pełna aplikacja (zbudujOms), prawdziwe trasy, zero sieci: globalny fetch rzuca i sprawdzamy, że nie został wywołany.
//
// Cztery ustawienia jak w 03a: „plik” i „ustawienia” (jawny brak, klucz inFaktu w środowisku) dają zdanie;
// „nic” (bez klucza, bez wyboru) i „infakt bez klucza” zostawiają STARE teksty znak w znak.
import { afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszWyborProgramu } from '../../../src/oms/db/wybor-programu.js';
import { dodajZwrot } from '../../../src/oms/db/zwroty.js';
import { zapiszUstawieniaAutomatu } from '../../../src/moduly/faktury/db/ksef-automat.js';

const KLUCZ = 'zmyslony-klucz-karty-prz121-0000000001';
const ZDANIE_PLIKU = 'Faktury w OMS-ie są wyłączone — w pliku konfiguracji jest OMS_PROGRAM_FAKTUROWY=brak.';
const ZDANIE_USTAWIEN = 'Faktury w OMS-ie są wyłączone — w Ustawienia → Integracje → Moduł faktur wybrano „Brak”.';
const STARA_FAKTURA = 'inFakt nie jest skonfigurowany — faktury z panelu nie wystawisz. Klucz API wpiszesz w';
const STARE_ALLEGRO = 'Kanał Allegro albo inFakt nie jest skonfigurowany — faktury stąd nie wyślesz. Klucz API inFaktu wpiszesz w';
const STARA_KOREKTA = 'Wystawianie korekt nie jest skonfigurowane (brak inFaktu). Klucz API inFaktu wpiszesz w Ustawienia → Integracje → inFakt (/ustawienia/integracje/infakt).';

const katalogi = [];
const aplikacje = [];
afterAll(async () => {
  vi.unstubAllGlobals();
  for (const a of aplikacje.splice(0)) { await a.app.close(); a.db.close(); }
  for (const p of katalogi.splice(0)) rmSync(p, { recursive: true, force: true });
});

const headers = { authorization: 'Basic ' + Buffer.from('operator:fixture').toString('base64'), origin: 'http://localhost' };
const odescape = (s) => String(s).replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const zamowienie = (nr, sklep) => ({ zrodlo_id: nr, numer: `PZ-${nr}`, klient: { first_name: 'Anna', last_name: 'Półcień', company: 'Pracownia Półcień',
  address_1: 'Lampowa 1', postcode: '00-950', city: 'Warszawa', email: 'biuro@polcien.invalid' },
dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: '5250000009',
kwota_brutto: '258.00', koszt_dostawy_brutto: '0.00', anulowane: 0, status_woo: 'processing', oplacone_at: null,
utworzone_at: '2026-10-01T10:00:00Z', sklep,
pozycje: [{ nazwa: 'Lampa wisząca Półcień', sku: 'LAMPA-W1', ilosc: 2, cena_brutto: '129.00', vat: null }] });

/** Trzy zamówienia: bez faktury (sekcja faktury), z fakturą z Allegro (sekcja Allegro), z fakturą i zwrotem (korekta). */
async function uruchom({ klucz = false, plik = null, zapis = null, automat = false }) {
  const katalog = mkdtempSync(join(tmpdir(), 'karta-brak-prz121-')); katalogi.push(katalog);
  const sciezka = join(katalog, 'oms.db');
  const przed = openOmsDb(sciezka);
  if (zapis) zapiszWyborProgramu(przed, zapis);
  if (automat) zapiszUstawieniaAutomatu(przed, { wlaczony: true, godzina: '20:00', ostatniPrzebieg: null, login: 'admin' });
  przed.close();
  const fetchPuste = vi.fn(async () => { throw new Error('Sieć zabroniona'); });
  vi.stubGlobal('fetch', fetchPuste);
  const env = { OMS_DB_PATH: sciezka, OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog,
    OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_USER: 'operator', OMS_PASS: 'fixture',
    ...(klucz ? { INFAKT_API_KEY: KLUCZ } : {}), ...(plik ? { OMS_PROGRAM_FAKTUROWY: plik } : {}) };
  const a = await zbudujOms({ env, teraz: () => new Date('2026-10-27T10:00:00Z') }); aplikacje.push(a);
  const faktura = (id, uuid, numer) => a.db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, program, dokument_id, numer, utworzona_at) VALUES (?,?,?,?,?,?)')
    .run(id, uuid, 'infakt', uuid, numer, '2026-10-02T10:00:00Z');
  const bez = zapiszZamowienie(a.db, 'reczne', zamowienie(5101, 'reczne'), {});
  const allegro = zapiszZamowienie(a.db, 'allegro_polcien', zamowienie(5102, 'allegro_polcien'), {});
  faktura(allegro, 'dok-allegro-prz121', 'FV/7/10/2026');
  const zFaktura = zapiszZamowienie(a.db, 'reczne', zamowienie(5103, 'reczne'), {});
  faktura(zFaktura, 'dok-zwrot-prz121', 'FV/8/10/2026');
  const zwrotId = dodajZwrot(a.db, zFaktura, { data: '2026-10-20', kwota: '129.00', pozycje: [] }).id;
  return { a, bez, allegro, zFaktura, zwrotId, fetchPuste };
}

const karta = async (c, id) => odescape((await c.a.app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers })).body);
const korekta = (c) => c.a.app.inject({ method: 'POST', url: `/zamowienia/${c.zFaktura}/zwroty/${c.zwrotId}/korekta`, headers, payload: {} });

describe.each([
  ['plik', { klucz: true, plik: 'brak' }, ZDANIE_PLIKU],
  ['ustawienia', { klucz: true, zapis: 'brak' }, ZDANIE_USTAWIEN],
])('PRZ-121.03b jawny „brak” (%s) przy zapisanym kluczu inFaktu', (_n, ustawienie, zdanie) => {
  let ctx;
  const zbuduj = async () => (ctx ??= await uruchom(ustawienie));

  it('karta bez faktury: zdanie zamiast „nie jest skonfigurowany”, bez linku do ekranu inFaktu', async () => {
    const c = await zbuduj();
    const html = await karta(c, c.bez);
    expect(html).toContain(`<p class="pasek-uwaga">${zdanie}</p>`);
    expect(html).not.toContain(STARA_FAKTURA);
    expect(html).not.toContain('href="/ustawienia/integracje/infakt"');
  });

  it('karta z fakturą z Allegro: numer faktury widoczny, zdanie zamiast „Kanał Allegro albo … nie jest skonfigurowany”', async () => {
    const c = await zbuduj();
    const html = await karta(c, c.allegro);
    expect(html).toContain('FV/7/10/2026');
    expect(html).toContain(`<p class="pasek-uwaga">${zdanie}</p>`);
    expect(html).not.toContain(STARE_ALLEGRO);
  });

  it('korekta zwrotu → 503 ze zdaniem, bez „klucz API” i bez żądania do programu', async () => {
    const c = await zbuduj();
    const r = await korekta(c);
    expect(r.statusCode, r.body).toBe(503);
    expect(r.body).toBe(zdanie);
    expect(r.body).not.toMatch(/klucz API|Klucz API|inFakt/);
    expect(c.fetchPuste).not.toHaveBeenCalled();
  });
});

describe.each([
  ['bez klucza i bez wyboru', { klucz: false }],
  ['wybrany inFakt, klucza nie ma', { klucz: false, zapis: 'infakt' }],
  ['plik: infakt, klucza nie ma', { klucz: false, plik: 'infakt' }],
])('PRZ-121.03b stare teksty znak w znak: %s', (_n, ustawienie) => {
  let ctx;
  const zbuduj = async () => (ctx ??= await uruchom(ustawienie));

  it('karta bez faktury: stary akapit z linkiem do ekranu inFaktu', async () => {
    const c = await zbuduj();
    const html = await karta(c, c.bez);
    expect(html).toContain(`<p class="pasek-uwaga">${STARA_FAKTURA} <a href="/ustawienia/integracje/infakt">Ustawienia → Integracje → inFakt</a>.</p>`);
    expect(html).not.toContain('Faktury w OMS-ie są wyłączone');
  });

  it('karta z fakturą z Allegro: stary akapit', async () => {
    const c = await zbuduj();
    const html = await karta(c, c.allegro);
    expect(html).toContain(`<p class="pasek-uwaga">${STARE_ALLEGRO} <a href="/ustawienia/integracje/infakt">Ustawienia → Integracje → inFakt</a>.</p>`);
    expect(html).not.toContain('Faktury w OMS-ie są wyłączone');
  });

  it('korekta zwrotu → stary 503', async () => {
    const c = await zbuduj();
    const r = await korekta(c);
    expect(r.statusCode, r.body).toBe(503);
    expect(r.body).toBe(STARA_KOREKTA);
  });
});

describe('PRZ-121.03b linia stanu automatu KSeF przy „brak”', () => {
  const ekran = async (c) => odescape((await c.a.app.inject({ method: 'GET', url: '/ustawienia/automatyzacje', headers })).body);
  const LINIA_WLACZONY = '<strong>Włączony</strong> — najbliższy przebieg:';

  it('automat włączony, działa (klucz, nic nie wybrano) → „Włączony — najbliższy przebieg”; po zapisie „brak” → „Stoi — faktury wyłączone.”', async () => {
    const c = await uruchom({ klucz: true, automat: true });
    expect(c.a.usluga('faktury', 'automatKsef'), 'automat powstał przy starcie').not.toBeNull();
    const przed = await ekran(c);
    expect(przed).toContain(LINIA_WLACZONY);
    expect(przed).not.toContain('Stoi — faktury wyłączone');
    zapiszWyborProgramu(c.a.db, 'brak');
    const po = await ekran(c);
    expect(po).toContain('<strong>Stoi — faktury wyłączone.</strong>');
    expect(po).not.toContain(LINIA_WLACZONY);
    expect(po).toContain(`id="ksef-automat-bezczynny">${ZDANIE_USTAWIEN} Automatyczna wysyłka do KSeF nic nie wyśle.</p>`);
    expect(c.fetchPuste).not.toHaveBeenCalled();
  });

  it('jawny „brak” w pliku od startu → „Stoi”; automat wyłączony → dalej „Wyłączony.”', async () => {
    const wlaczony = await uruchom({ klucz: true, plik: 'brak', automat: true });
    expect(await ekran(wlaczony)).toContain('<strong>Stoi — faktury wyłączone.</strong>');
    const wylaczony = await uruchom({ klucz: true, plik: 'brak' });
    const html = await ekran(wylaczony);
    expect(html).toContain('<strong>Wyłączony.</strong>');
    expect(html).not.toContain('Stoi — faktury wyłączone');
  });

  it('bez wyboru i bez klucza, automat włączony → stara linia (bez „Stoi”)', async () => {
    const c = await uruchom({ klucz: false, automat: true });
    const html = await ekran(c);
    expect(html).toContain(LINIA_WLACZONY);
    expect(html).not.toContain('Stoi — faktury wyłączone');
  });
});
