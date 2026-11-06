// PRZ-153.E9: demo publiczne ma jawny klucz API wyłącznie do odczytu (deploy/demo/klucz-demo.mjs),
// wstawiany przy każdej budowie bazy demo (reset co godzinę) i opisany w docs/api/README.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uruchomPiaskownice } from '../../deploy/proba/atrapy/index.mjs';
import { zalozBazeDemo } from '../../deploy/demo/baza.mjs';
import { KLUCZ_DEMO } from '../../deploy/demo/klucz-demo.mjs';
import { ENV_DEMO } from '../../scripts/demo-dane.mjs';
import { rozbierzNaglowek } from '../../src/domena/klucze-api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DZIS = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
const ADMIN = { login: 'admin-demo-testu', imie: 'Admin testu', haslo: 'haslo-testu-demo-1' };
const ODCZYT = ['zamowienia:odczyt', 'produkty:odczyt', 'stany:odczyt', 'sprzedaz:odczyt'];
const katalogi = [];
let live, url;

const zKluczem = (adres, opcje = {}) => fetch(url + adres, { redirect: 'manual', ...opcje,
  headers: { authorization: `Bearer ${KLUCZ_DEMO.klucz}`, ...opcje.headers } });

beforeAll(async () => {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-demo-klucz-')); katalogi.push(k);
  const env = { ...ENV_DEMO, OMS_DB_PATH: path.join(k, 'oms.sqlite'), OMS_PORT: '0', OMS_USER: 'serwis-demo',
    OMS_PASS: 'haslo-serwisowe-testu', OMS_PROFORMY_KATALOG: path.join(k, 'proformy'),
    OMS_ETYKIETY_KATALOG: path.join(k, 'etykiety'), OMS_DEMO_LOGIN: 'demo', OMS_DEMO_HASLO: 'demo' };
  await zalozBazeDemo({ baza: env.OMS_DB_PATH, dzis: DZIS, env, kontoAdmina: ADMIN });
  live = await uruchomPiaskownice(env, { host: '127.0.0.1' });
  url = live.aplikacja.app.listeningOrigin;
}, 120_000);
afterAll(async () => {
  await live?.zamknij();
  for (const k of katalogi.splice(0)) fs.rmSync(k, { recursive: true, force: true });
});

describe('PRZ-153.E9: klucz API demo tylko do odczytu', () => {
  it('ma poprawny format klucza i wyłącznie zakresy *:odczyt', () => {
    expect(rozbierzNaglowek(`Bearer ${KLUCZ_DEMO.klucz}`)).toBe(KLUCZ_DEMO.klucz);
    expect([...KLUCZ_DEMO.zakresy]).toEqual(ODCZYT);
  });

  it('GET /api/v1/ja zwraca klucz demo z czterema zakresami odczytu', async () => {
    const r = await zKluczem('/api/v1/ja');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ nazwa: KLUCZ_DEMO.nazwa, prefiks: 'demodemo', zakresy: ODCZYT });
  });

  it('czyta zamówienia, produkty, stany i sprzedaż z danych demo', async () => {
    const zamowienia = await (await zKluczem('/api/v1/zamowienia?ile=5')).json();
    expect(zamowienia.pozycje.length).toBe(5);
    expect((await zKluczem(`/api/v1/zamowienia/${zamowienia.pozycje[0].id}`)).status).toBe(200);
    const produkty = await (await zKluczem('/api/v1/produkty?ile=3')).json();
    expect(produkty.pozycje.length).toBe(3);
    expect((await zKluczem('/api/v1/stany?ile=3')).status).toBe(200);
    expect((await zKluczem(`/api/v1/sprzedaz?od=${DZIS}&do=${DZIS}`)).status).toBe(200);
  });

  it('każdy zapis i druk odmawia 403 brak_zakresu', async () => {
    const json = { 'content-type': 'application/json' };
    const proby = [
      zKluczem('/api/v1/produkty', { method: 'POST', headers: json, body: JSON.stringify({ nazwa: 'x' }) }),
      zKluczem('/api/v1/stany/ruchy', { method: 'POST', headers: { ...json, 'idempotency-key': 'demo-1' },
        body: JSON.stringify({ karta_id: 1, rodzaj: 'przyjecie', ilosc: 1 }) }),
      zKluczem('/api/v1/zamowienia/1/proforma', { method: 'POST' }),
      zKluczem('/api/v1/zamowienia/1/w-realizacji', { method: 'POST' }),
      zKluczem('/kolejka-druku'),
    ];
    for (const r of await Promise.all(proby)) {
      expect(r.status).toBe(403);
      expect((await r.json()).kod).toBe('brak_zakresu');
    }
  });

  it('README API podaje ten sam klucz i te same zakresy', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'docs/api/README.md'), 'utf8');
    expect(readme).toContain(KLUCZ_DEMO.klucz);
    for (const z of ODCZYT) expect(readme).toContain(z);
  });
});
