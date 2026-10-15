// PRZ-083 — dwie poprawki demo od właściciela (15.10):
//  1. „Pobierz z GUS” w demo nie było wcale — bez GUS_KLUCZ przycisk znika z karty, nowego zamówienia i Stałych klientów.
//     Piaskownica dostaje atrapę GUS (jak VIES): przycisk stoi, a kliknięcie mówi wprost, że w demo ta funkcja nie działa.
//  2. Strona główna demo witała trzema powiadomieniami „Nowa wiadomość z Allegro” — dwa wątki są „Załatwione”, zostaje jedno.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { uruchomPiaskownice } from '../../deploy/proba/atrapy/index.mjs';
import { zalozBazeDemo } from '../../deploy/demo/baza.mjs';
import { ENV_DEMO } from '../../scripts/demo-dane.mjs';
import { WATKI_ALLEGRO } from '../../scripts/demo-dane-firma.mjs';
import { createModulZamowienia } from '../../src/moduly/zamowienia/modul.ts';
import { komunikatAwariiGus } from '../../src/domena/gus.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const DZIS = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
const NIP = '1234563218'; // fikcyjny, z poprawną sumą kontrolną
const W_DEMO = 'nie działa w wersji demonstracyjnej';
const katalogi = [];
let live, url, env, gosc, admin;

beforeAll(async () => {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-demo-prz083b-')); katalogi.push(k);
  env = { ...ENV_DEMO, OMS_DB_PATH: path.join(k, 'oms.sqlite'), OMS_PORT: '0', OMS_USER: 'serwis-demo',
    OMS_PASS: 'haslo-serwisowe-testu', OMS_PROFORMY_KATALOG: path.join(k, 'proformy'), OMS_ETYKIETY_KATALOG: path.join(k, 'etykiety'),
    OMS_DEMO_LOGIN: 'demo', OMS_DEMO_HASLO: 'demo' };
  await zalozBazeDemo({ baza: env.OMS_DB_PATH, dzis: DZIS, env,
    kontoAdmina: { login: 'demo-admin', imie: 'Administrator demo', haslo: 'haslo-testu-demo-1' } });
  live = await uruchomPiaskownice(env, { host: '127.0.0.1' });
  url = live.aplikacja.app.listeningOrigin;
  const zaloguj = async (uzytkownik, haslo) => {
    const r = await fetch(url + '/login', { method: 'POST', redirect: 'manual',
      headers: { origin: url, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ uzytkownik, haslo, powrot: '/' }) });
    return r.headers.get('set-cookie').match(/sesja_oms_proba=[^;]+/)[0];
  };
  gosc = await zaloguj('demo', 'demo');
  admin = await zaloguj('demo-admin', 'haslo-testu-demo-1');
}, 120_000);
afterAll(async () => {
  await live?.zamknij();
  for (const k of katalogi.splice(0)) fs.rmSync(k, { recursive: true, force: true });
});

const get = async (adres, cookie = gosc) => (await fetch(url + adres, { headers: { cookie, accept: 'text/html' } })).text();
const post = async (adres, pola, cookie = gosc) => {
  const r = await fetch(url + adres, { method: 'POST', redirect: 'manual',
    headers: { cookie, origin: url, accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(pola) });
  return { status: r.status, html: await r.text() };
};

describe('PRZ-083: „Pobierz z GUS” w demo — przycisk stoi, kliknięcie mówi, że w demo nie działa', () => {
  it('karta zamówienia: przycisk widoczny dla gościa (formularz danych do faktury), po kliknięciu komunikat demo', async () => {
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    const id = db.prepare('SELECT id FROM zamowienia ORDER BY id DESC LIMIT 1').get().id;
    db.close();
    // Przycisk stoi w formularzu danych do faktury (karta → „Edytuj”).
    expect(await get(`/zamowienia/${id}?edytuj=faktura`)).toContain(`/zamowienia/${id}/dane/gus`);
    const r = await post(`/zamowienia/${id}/dane/gus`, { nip: NIP, f_firma: 'Wpisane ręcznie' });
    expect(r.status).toBe(200);
    expect(r.html).toContain(W_DEMO);
    expect(r.html).not.toContain('spróbuj za chwilę');
  });

  it('nowe zamówienie: przycisk widoczny, komunikat demo', async () => {
    expect(await get('/zamowienia/nowe')).toContain('/zamowienia/nowe/gus');
    const r = await post('/zamowienia/nowe/gus', { f_nip: NIP });
    expect(r.status).toBe(200);
    expect(r.html).toContain(W_DEMO);
    expect(r.html).not.toContain('spróbuj za chwilę');
  });

  it('stali klienci: przycisk widoczny, komunikat demo', async () => {
    // Formularz nowego klienta otwiera „+ Nowy klient” (?nowy).
    expect(await get('/klienci?nowy', admin)).toContain('formaction="/klienci/gus');
    const r = await post('/klienci/gus', { f_nip: NIP }, admin);
    expect(r.status).toBe(200);
    expect(r.html).toContain(W_DEMO);
  });

  it('awaria prawdziwego GUS-u nadal mówi „spróbuj za chwilę” — komunikat demo tylko dla atrapy', () => {
    const awaria = Object.assign(new Error('GUS: przekroczony czas'), { dlaOperatora: true });
    expect(komunikatAwariiGus(awaria)).toBe('Nie udało się zapytać GUS: GUS: przekroczony czas Wpisz dane ręcznie albo spróbuj za chwilę.');
  });

  it('atrapa GUS przez fabrykę modułu zamówień odmawia poza trybem próby', () => {
    const modul = createModulZamowienia({ fabryki: { createGusClient: () => ({ firmaPoNip: async () => null }) } });
    expect(() => modul.konfiguracja({ ...env, OMS_TRYB: 'produkcja' })).toThrow(/próby/);
  });
});

describe('PRZ-083: strona główna demo — jedno powiadomienie o wiadomości z Allegro, nie trzy', () => {
  it('trzy wątki bez odpowiedzi w danych, dwa „Załatwione” — na liście jedno powiadomienie, o reklamacji', async () => {
    expect(WATKI_ALLEGRO.filter((w) => !w.odpowiedz)).toHaveLength(3);
    const html = await get('/', admin);
    const powiadomienia = html.match(/Nowa wiadomość z Allegro od/g) ?? [];
    expect(powiadomienia).toHaveLength(1);
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      const czeka = db.prepare(`SELECT w.ostatnia_tresc FROM allegro_watki w
        LEFT JOIN allegro_zamkniecia z ON z.kanal = w.kanal AND z.thread_id = w.thread_id
        WHERE w.ostatnia_od_kupujacego = 1 AND z.zamkniete_do IS NULL`).all();
      expect(czeka.map((w) => w.ostatnia_tresc)).toEqual([expect.stringContaining('pękniętym kloszem')]);
      expect(db.prepare('SELECT COUNT(*) n FROM allegro_zamkniecia').get().n).toBe(2);
    } finally { db.close(); }
  });
});
