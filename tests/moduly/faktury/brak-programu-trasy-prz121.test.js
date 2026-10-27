// PRZ-121.03a — zdania „faktury wyłączone” w trasach modułu faktur (faktury, druk, dokumenty, okresy, ekran automatu).
// Pełna aplikacja (zbudujOms), prawdziwe trasy, zero sieci: globalny fetch rzuca, a na końcu każdego przypadku „brak”
// sprawdzamy, że nie został wywołany ani razu (klucz inFaktu jest w środowisku — OMS go nie używa).
//
// Cztery ustawienia:
//   • „plik”       — klucz inFaktu + OMS_PROGRAM_FAKTUROWY=brak           → zdanie o pliku konfiguracji,
//   • „ustawienia” — klucz inFaktu + zapis „brak” w Ustawieniach          → zdanie o ekranie Moduł faktur,
//   • „nic”        — bez klucza i bez wyboru                              → TEKSTY JAK DZIŚ, znak w znak,
//   • „infakt bez klucza” — wybrany inFakt, klucza nie ma                 → TEKSTY JAK DZIŚ, znak w znak.
// Kod HTTP w każdym ustawieniu taki sam jak dziś.
import { afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapewnijOkres } from '../../../src/oms/db/okresy.js';
import { zapiszWyborProgramu } from '../../../src/oms/db/wybor-programu.js';
import { zapiszUstawieniaAutomatu } from '../../../src/moduly/faktury/db/ksef-automat.js';
import { rozpocznijFakture, zakonczFakture } from '../../../src/moduly/faktury/db/faktury.js';
import { dodajFaktureDoKolejki } from '../../../src/moduly/faktury/db/kolejka-druku-faktur.js';
import { dopiszKlientaZbiorczego } from './_klient-zbiorczy-pomocniki.js';

const KLUCZ = 'zmyslony-klucz-trasy-prz121-00000000001';
const ZDANIE_PLIKU = 'Faktury w OMS-ie są wyłączone — w pliku konfiguracji jest OMS_PROGRAM_FAKTUROWY=brak.';
const ZDANIE_USTAWIEN = 'Faktury w OMS-ie są wyłączone — w Ustawienia → Integracje → Moduł faktur wybrano „Brak”.';
const G = 'Klucz API inFaktu wpiszesz w Ustawienia → Integracje → inFakt (/ustawienia/integracje/infakt).';
const DOPISEK_PDF = 'PDF wcześniejszej faktury pobierzesz w programie, w którym ją wystawiono.';
const DOPISEK_AUTOMATU = 'Automatyczna wysyłka do KSeF nic nie wyśle.';
const DOPISEK_LISTA = 'Wcześniejsze faktury obejrzysz w programie, w którym je wystawiono.';
const EKRAN_WYBORU = '/ustawienia/integracje/program-fakturowy';

const katalogi = [];
const aplikacje = [];
// Aplikacja w bloku jest budowana raz (pierwszy przypadek) i żyje do końca bloku — sprzątamy po całym pliku.
afterAll(async () => {
  vi.unstubAllGlobals();
  for (const a of aplikacje.splice(0)) { await a.app.close(); a.db.close(); }
  for (const p of katalogi.splice(0)) rmSync(p, { recursive: true, force: true });
});

const headers = { authorization: 'Basic ' + Buffer.from('operator:fixture').toString('base64'), origin: 'http://localhost' };
const odescape = (s) => String(s).replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function zamowienie() {
  return { zrodlo_id: 4101, numer: 'PZ-4101', klient: { first_name: 'Anna', last_name: 'Półcień', company: 'Pracownia Półcień',
    address_1: 'Lampowa 1', postcode: '00-950', city: 'Warszawa', email: 'biuro@polcien.invalid' },
    dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: '5250000009',
    kwota_brutto: '258.00', koszt_dostawy_brutto: '0.00', anulowane: 0, status_woo: 'processing', oplacone_at: null,
    utworzone_at: '2026-10-01T10:00:00Z',
    pozycje: [{ nazwa: 'Lampa wisząca Półcień', sku: 'LAMPA-W1', ilosc: 2, cena_brutto: '129.00', vat: null }] };
}

/** Aplikacja z bazą w pliku (zapis wyboru przed startem), z zamówieniem, pozycją kolejki druku i okresem. */
async function uruchom({ klucz = false, plik = null, zapis = null }) {
  const katalog = mkdtempSync(join(tmpdir(), 'brak-trasy-prz121-')); katalogi.push(katalog);
  const sciezka = join(katalog, 'oms.db');
  const przed = openOmsDb(sciezka);
  if (zapis) zapiszWyborProgramu(przed, zapis);
  przed.close();
  const fetchPuste = vi.fn(async () => { throw new Error('Sieć zabroniona'); });
  vi.stubGlobal('fetch', fetchPuste);
  const env = { OMS_DB_PATH: sciezka, OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog,
    OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_USER: 'operator', OMS_PASS: 'fixture',
    ...(klucz ? { INFAKT_API_KEY: KLUCZ } : {}), ...(plik ? { OMS_PROGRAM_FAKTUROWY: plik } : {}) };
  const a = await zbudujOms({ env, teraz: () => new Date('2026-10-27T10:00:00Z') }); aplikacje.push(a);
  const id = zapiszZamowienie(a.db, 'reczne', zamowienie(), {});
  const fakturaId = rozpocznijFakture(a.db, id).id ?? a.db.prepare('SELECT id FROM faktury WHERE zamowienie_id = ?').get(id).id;
  zakonczFakture(a.db, fakturaId, { uuid: 'dok-prz121', numer: '1/10/2026', ksefStatus: 'brak' });
  const kolejkaId = dodajFaktureDoKolejki(a.db, fakturaId).id;
  dopiszKlientaZbiorczego(a.db, { klucz: 'polcien', nazwa: 'Pracownia Półcień', nip: '5250000009' });
  const okresId = zapewnijOkres(a.db, { klientKlucz: 'polcien', rok: 2026, miesiac: 10 }).id;
  return { a, id, kolejkaId, okresId, fetchPuste };
}

const zadanie = (ctx, t) => ctx.a.app.inject({ method: t.metoda, url: t.url(ctx), headers, payload: t.metoda === 'POST' ? (t.payload ?? {}) : undefined });

// Odpowiedzi tekstowe (kod, treść) — treść całej odpowiedzi to jedno zdanie.
const TEKSTOWE = [
  { nazwa: 'POST /faktury/archiwum/uruchom', metoda: 'POST', url: () => '/faktury/archiwum/uruchom', kod: 503,
    stary: 'Panel nie ma włączonego archiwum sprzedaży (brak INFAKT_ARCHIWUM).' },
  { nazwa: 'GET /faktury/zestawienie-przychodow', metoda: 'GET', url: () => '/faktury/zestawienie-przychodow?miesiac=2026-10', kod: 503,
    stary: `Panel nie ma podpiętego inFaktu — nie ma z czego zbudować zestawienia przychodów. ${G}` },
  { nazwa: 'GET /faktury/paczka', metoda: 'GET', url: () => '/faktury/paczka?miesiac=2026-10', kod: 503,
    stary: `Panel nie ma podpiętego inFaktu — nie ma z czego złożyć paczki. ${G}` },
  { nazwa: 'GET /faktury/:uuid/pdf', metoda: 'GET', url: () => '/faktury/u1/pdf?rodzaj=vat', kod: 503, dopisek: DOPISEK_PDF,
    stary: `Panel nie ma podpiętego inFaktu. ${G}` },
  { nazwa: 'POST /faktury/ksef/podglad', metoda: 'POST', url: () => '/faktury/ksef/podglad', kod: 503,
    stary: `Panel nie ma podpiętego inFaktu — nie ma czego wysłać do KSeF. ${G}` },
  { nazwa: 'POST /faktury/ksef/wyslij', metoda: 'POST', url: () => '/faktury/ksef/wyslij', kod: 503,
    stary: `Panel nie ma podpiętego inFaktu — nie ma czego wysłać do KSeF. ${G}` },
  { nazwa: 'GET /zamowienia/:id/faktura/pdf', metoda: 'GET', url: (c) => `/zamowienia/${c.id}/faktura/pdf`, kod: 503, dopisek: DOPISEK_PDF,
    stary: 'Panel nie ma podpiętego inFaktu.' },
  { nazwa: 'GET /kolejka-druku-faktur/:id/pdf', metoda: 'GET', url: (c) => `/kolejka-druku-faktur/${c.kolejkaId}/pdf`, kod: 503, dopisek: DOPISEK_PDF,
    stary: 'Panel nie ma podpiętego inFaktu.' },
  { nazwa: 'POST /zamowienia/faktury-hurtem', metoda: 'POST', url: () => '/zamowienia/faktury-hurtem', kod: 503,
    stary: `Wystawianie faktur nie jest skonfigurowane (brak danych inFaktu). ${G}` },
  { nazwa: 'POST /zamowienia/:id/faktura', metoda: 'POST', url: (c) => `/zamowienia/${c.id}/faktura`, kod: 503,
    stary: `inFakt nie jest skonfigurowany. ${G}` },
  { nazwa: 'POST /zamowienia/:id/faktura-allegro', metoda: 'POST', url: (c) => `/zamowienia/${c.id}/faktura-allegro`, kod: 503,
    stary: 'Kanał Allegro nie jest skonfigurowany — faktury stąd nie wyślesz.' },
  { nazwa: 'POST /okresy/:id/wystaw-fakture', metoda: 'POST', url: (c) => `/okresy/${c.okresId}/wystaw-fakture`, kod: 503,
    stary: `inFakt nie jest skonfigurowany — faktury z panelu nie wystawisz. ${G}` },
];

// Strony HTML — akapit ze zdaniem w treści ekranu.
const STRONY = [
  { nazwa: 'GET /faktury (zakładka bez programu)', metoda: 'GET', url: () => '/faktury', kod: 200, dopisek: DOPISEK_LISTA,
    stary: 'Ten panel nie ma podpiętego inFaktu, więc nie ma skąd wziąć faktur — zakładka jest pusta celowo.',
    odnosnikBrak: EKRAN_WYBORU, odnosnikStary: '/ustawienia/integracje/infakt' },
  { nazwa: 'POST /zamowienia/faktury-hurtem/podglad', metoda: 'POST', url: () => '/zamowienia/faktury-hurtem/podglad', kod: 200,
    payload: (c) => ({ id: [String(c.id)] }),
    stary: 'Wystawianie faktur nie jest skonfigurowane (brak danych inFaktu) — klucz API wpiszesz w' },
  { nazwa: 'GET /okresy/:id (karta okresu)', metoda: 'GET', url: (c) => `/okresy/${c.okresId}`, kod: 200,
    stary: 'inFakt nie jest skonfigurowany — faktury z panelu nie wystawisz. Klucz API wpiszesz w' },
  { nazwa: 'GET /ustawienia/automatyzacje (powód bezczynności automatu)', metoda: 'GET', url: () => '/ustawienia/automatyzacje', kod: 200, dopisek: DOPISEK_AUTOMATU,
    stary: 'inFakt nie jest podłączony — automat nic nie wyśle, dopóki go nie podłączysz (potem potrzebne ponowne uruchomienie OMS-u).' },
];

const wszystkie = [...TEKSTOWE, ...STRONY];
const wyslij = (ctx, t) => ctx.a.app.inject({ method: t.metoda, url: t.url(ctx), headers,
  payload: t.metoda === 'POST' ? (typeof t.payload === 'function' ? t.payload(ctx) : (t.payload ?? {})) : undefined });

const MARKERY_STAREGO = /klucz API|Klucz API|inFakt|Kanał Allegro|INFAKT_ARCHIWUM/;

describe.each([
  ['plik', { klucz: true, plik: 'brak' }, ZDANIE_PLIKU],
  ['ustawienia', { klucz: true, zapis: 'brak' }, ZDANIE_USTAWIEN],
])('PRZ-121.03a jawny „brak” (%s) przy zapisanym kluczu inFaktu', (_n, ustawienie, zdanie) => {
  let ctx;
  const zbuduj = async () => (ctx ??= await uruchom(ustawienie));

  it.each(TEKSTOWE.map((t) => [t.nazwa, t]))('%s → kod jak dziś, treść = zdanie, bez „klucz API” i bez żądania do inFaktu', async (_t, t) => {
    const c = await zbuduj();
    const r = await wyslij(c, t);
    expect(r.statusCode, r.body).toBe(t.kod);
    expect(r.body).toBe(t.dopisek ? `${zdanie} ${t.dopisek}` : zdanie);
    expect(r.body).not.toMatch(MARKERY_STAREGO);
    expect(c.fetchPuste).not.toHaveBeenCalled();
  });

  it.each(STRONY.map((t) => [t.nazwa, t]))('%s → kod jak dziś, akapit = zdanie, bez starego akapitu', async (_t, t) => {
    const c = await zbuduj();
    const r = await wyslij(c, t);
    const html = odescape(r.body);
    expect(r.statusCode, r.body.slice(0, 300)).toBe(t.kod);
    expect(html).toContain(t.dopisek ? `${zdanie} ${t.dopisek}` : zdanie);
    expect(html).not.toContain(t.stary);
    if (t.odnosnikBrak) {
      expect(html).toContain(`href="${t.odnosnikBrak}"`);
      expect(html).not.toContain(`href="${t.odnosnikStary}"`);
    }
    expect(c.fetchPuste).not.toHaveBeenCalled();
  });

  it('żadna odpowiedź nie sięgnęła do inFaktu (łącznie)', async () => {
    const c = await zbuduj();
    for (const t of wszystkie) await wyslij(c, t);
    expect(c.fetchPuste).not.toHaveBeenCalled();
  });
});

describe.each([
  ['bez klucza i bez wyboru', { klucz: false }],
  ['wybrany inFakt, klucza nie ma', { klucz: false, zapis: 'infakt' }],
  ['plik: infakt, klucza nie ma', { klucz: false, plik: 'infakt' }],
])('PRZ-121.03a stare teksty znak w znak: %s', (_n, ustawienie) => {
  let ctx;
  const zbuduj = async () => (ctx ??= await uruchom(ustawienie));

  it.each(TEKSTOWE.map((t) => [t.nazwa, t]))('%s → kod jak dziś, treść bez zmian', async (_t, t) => {
    const c = await zbuduj();
    const r = await wyslij(c, t);
    expect(r.statusCode, r.body).toBe(t.kod);
    expect(r.body).toBe(t.stary);
    expect(r.body).not.toContain('wyłączone');
  });

  it.each(STRONY.map((t) => [t.nazwa, t]))('%s → stary akapit, bez zdania o wyłączonych fakturach', async (_t, t) => {
    const c = await zbuduj();
    const r = await wyslij(c, t);
    const html = odescape(r.body);
    expect(r.statusCode, r.body.slice(0, 300)).toBe(t.kod);
    expect(html).toContain(t.stary);
    expect(html).not.toContain('Faktury w OMS-ie są wyłączone');
    if (t.odnosnikStary) expect(html).toContain(`href="${t.odnosnikStary}"`);
  });
});

describe('PRZ-121.03a ekran automatu KSeF i zapis „brak” po starcie', () => {
  const ekran = async (c) => odescape((await c.a.app.inject({ method: 'GET', url: '/ustawienia/automatyzacje', headers })).body);

  it('automat WŁĄCZONY i działa (klucz, nic nie wybrano), potem zapis „brak” → ekran mówi, że automat stoi', async () => {
    const katalog = mkdtempSync(join(tmpdir(), 'brak-automat-prz121-')); katalogi.push(katalog);
    const sciezka = join(katalog, 'oms.db');
    const przed = openOmsDb(sciezka);
    zapiszUstawieniaAutomatu(przed, { wlaczony: true, godzina: '20:00', ostatniPrzebieg: null, login: 'admin' });
    przed.close();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Sieć zabroniona'); }));
    const a = await zbudujOms({ env: { OMS_DB_PATH: sciezka, OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog,
      OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_USER: 'operator', OMS_PASS: 'fixture',
      INFAKT_API_KEY: KLUCZ }, teraz: () => new Date('2026-10-27T10:00:00Z') });
    aplikacje.push(a);
    expect(a.usluga('faktury', 'automatKsef'), 'automat powstał przy starcie').not.toBeNull();
    const przedZapisem = await ekran({ a });
    expect(przedZapisem).toContain('<strong>Włączony</strong>');
    expect(przedZapisem).not.toContain('ksef-automat-bezczynny');
    zapiszWyborProgramu(a.db, 'brak');
    const po = await ekran({ a });
    expect(po).toContain(`id="ksef-automat-bezczynny">${ZDANIE_USTAWIEN} ${DOPISEK_AUTOMATU}</p>`);
  });

  it('jawny „brak” w pliku: powód bezczynności to zdanie, bez „nie jest podłączony”', async () => {
    const c = await uruchom({ klucz: true, plik: 'brak' });
    const html = await ekran(c);
    expect(html).toContain(`id="ksef-automat-bezczynny">${ZDANIE_PLIKU} ${DOPISEK_AUTOMATU}</p>`);
    expect(html).not.toContain('nie jest podłączony');
  });
});
