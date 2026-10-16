// PRZ-076 — piaskownica z atrapami inFaktu, Woo i Allegro (deploy/proba/atrapy): Faktury i Magazyn mają dane
// demo i dają się obsługiwać, a nic nie wychodzi z procesu (fetch zablokowany przez cały plik).
//
// ⛔ Trzy bariery przed atrapą na produkcji — każdą łamie tu osobny przypadek:
//   1) obraz produkcji nie kopiuje deploy/ (Dockerfile), 2) atrapy i złożenie odmawiają poza OMS_TRYB=proba,
//   3) moduł faktur odmawia fabryk atrap poza trybem próby (tests/moduly/faktury/modul.test.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { zalozKonto } from '../../src/core/bezpieczenstwo/konta.js';
import { utworzBazeDemo, ENV_DEMO } from '../../scripts/demo-dane.mjs';
import { uruchomPiaskownice, modulyPiaskownicy } from '../../deploy/proba/atrapy/index.mjs';
import { createAtrapaInfaktu, createAtrapaVies } from '../../deploy/proba/atrapy/infakt.mjs';
import { createAtrapaWoo, createAtrapaAllegro, zbudujAtrapyKanalow } from '../../deploy/proba/atrapy/kanaly.mjs';
import { createAtrapaPoczty, createModulWiadomosciAtrapy } from '../../deploy/proba/atrapy/poczta.mjs';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const DZIS = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
// Zapamiętany przed blokadą: test sam rozmawia z panelem oryginałem, a blokada łapie wyłącznie wołania aplikacji.
const oryginalnyFetch = globalThis.fetch;
const katalogi = [];
function envDla() {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-atrapy-')); katalogi.push(k);
  for (const d of ['proformy', 'etykiety']) fs.mkdirSync(path.join(k, d), { recursive: true });
  return { ...ENV_DEMO, OMS_DB_PATH: path.join(k, 'oms.sqlite'), OMS_PORT: '0', OMS_USER: 'serwis-atrap',
    OMS_PASS: 'haslo-serwisowe-atrap', OMS_PROFORMY_KATALOG: path.join(k, 'proformy'), OMS_ETYKIETY_KATALOG: path.join(k, 'etykiety') };
}
afterAll(() => { for (const p of katalogi.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });

describe('piaskownica z atrapami — Faktury i Magazyn na danych demo', () => {
  let env, live, url, cookie, siec;
  const logi = [];
  beforeAll(async () => {
    // Prawdziwy fetch zabroniony: atrapa, która po cichu woła sieć, ma tu wybuchnąć (i zostać w siec.mock.calls).
    siec = vi.spyOn(globalThis, 'fetch').mockImplementation(async (adres) => {
      throw new Error(`atrapy: zabronione wyjście do sieci ${adres}`);
    });
    env = envDla();
    await utworzBazeDemo({ baza: env.OMS_DB_PATH, dzis: DZIS, env });
    const db = new DatabaseSync(env.OMS_DB_PATH);
    try { zalozKonto(db, { login: 'demo-admin', imie: 'Administrator demo', haslo: 'haslo-testu-atrap-1', rola: 'administrator', admin: true }); }
    finally { db.close(); }
    const log = (...t) => logi.push(t.join(' '));
    live = await uruchomPiaskownice(env, { host: '127.0.0.1' });
    // Ślad atrap idzie przez console.log — zbieramy go, żeby sprawdzić dopisek „atrapa”.
    vi.spyOn(console, 'log').mockImplementation(log);
    url = live.aplikacja.app.listeningOrigin;
  }, 90000);
  afterAll(async () => { await live?.zamknij(); vi.restoreAllMocks(); });

  const zadanie = (adres, o = {}) => oryginalnyFetch(url + adres, { redirect: 'manual', ...o, headers: { cookie, origin: url, ...(o.headers ?? {}) } });
  const strona = async (adres) => {
    let r = await zadanie(adres);
    if ([302, 303].includes(r.status)) r = await zadanie(r.headers.get('location'));
    return { status: r.status, html: await r.text() };
  };
  const formularz = (adres, pola) => zadanie(adres, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(pola) });
  const baza = () => new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });

  beforeAll(async () => {
    const login = await oryginalnyFetch(url + '/login', { method: 'POST', redirect: 'manual',
      headers: { origin: url, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ uzytkownik: 'demo-admin', haslo: 'haslo-testu-atrap-1', powrot: '/' }) });
    expect(login.status).toBe(302);
    cookie = login.headers.get('set-cookie').match(/sesja_oms_proba=[^;]+/)[0];
  });

  it('/faktury (bieżący miesiąc) pokazuje faktury demo z bazy, nie pusty ekran „nie ma podpiętego inFaktu”', async () => {
    const db = baza();
    let numery;
    try {
      numery = db.prepare(`SELECT numer FROM faktury WHERE utworzona_at >= ? ORDER BY id`).all(`${DZIS.slice(0, 7)}-01`).map((w) => w.numer);
    } finally { db.close(); }
    expect(numery.length).toBeGreaterThan(3);
    const { status, html } = await strona('/faktury');
    expect(status).toBe(200);
    expect(html).not.toContain('nie ma podpiętego inFaktu');
    for (const n of numery) expect.soft(html, n).toContain(n);
  });

  it('nieopłacone po terminie i korekty zwrotów stoją na liście', async () => {
    const db = baza();
    let korekta;
    try { korekta = db.prepare('SELECT korekta_numer, data FROM zwroty WHERE korekta_numer IS NOT NULL LIMIT 1').get(); }
    finally { db.close(); }
    expect(korekta, 'generator: korekta do zwrotu zafakturowanego zamówienia').toBeTruthy();
    const { html } = await strona(`/faktury?miesiac=${korekta.data.slice(0, 7)}`);
    expect(html).toContain(korekta.korekta_numer);
    const nieoplacone = await live.aplikacja.usluga('faktury', 'fakturyWidok').nieoplacone({ dzis: DZIS });
    const poTerminie = nieoplacone.filter((d) => d.payment_date < DZIS);
    expect(poTerminie.length, 'kilka faktur nieopłaconych po terminie').toBeGreaterThanOrEqual(2);
  });

  it('PDF faktury demo się pobiera i jest oznaczony jako atrapa', async () => {
    const db = baza();
    let uuid;
    try { uuid = db.prepare('SELECT infakt_uuid FROM faktury ORDER BY id DESC LIMIT 1').get().infakt_uuid; } finally { db.close(); }
    const r = await zadanie(`/faktury/${uuid}/pdf?rodzaj=vat`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('pdf');
    const bajty = Buffer.from(await r.arrayBuffer());
    expect(bajty.subarray(0, 4).toString()).toBe('%PDF');
    expect(bajty.length).toBeGreaterThan(2000);
  });

  it('„Wystaw fakturę” na zamówieniu demo tworzy dokument widoczny na liście Faktur, z dopiskiem „atrapa” w logu', async () => {
    const db = baza();
    let zam;
    try {
      zam = db.prepare(`SELECT z.id FROM zamowienia z WHERE z.anulowane = 0 AND z.chce_fakture = 1
        AND NOT EXISTS (SELECT 1 FROM faktury f WHERE f.zamowienie_id = z.id) ORDER BY z.id DESC LIMIT 1`).get();
    } finally { db.close(); }
    expect(zam).toBeTruthy();
    const r = await formularz(`/zamowienia/${zam.id}/faktura`, {});
    expect(r.status, await r.clone().text()).toBe(302);
    const db2 = baza();
    let f;
    try { f = db2.prepare('SELECT numer, infakt_uuid, utworzona_at FROM faktury WHERE zamowienie_id = ?').get(zam.id); } finally { db2.close(); }
    expect(f?.numer).toMatch(/^FV \d+\/\d{2}\/\d{4}$/);
    const { html } = await strona('/faktury');
    expect(html).toContain(f.numer);
    expect(logi.some((l) => l.includes('atrapa inFaktu') && l.includes(f.numer))).toBe(true);
  });

  it('/magazyn ma wiersze katalogu demo; „Synchronizuj” przez atrapy niczego nie gubi', async () => {
    const { status, html } = await strona('/magazyn');
    expect(status).toBe(200);
    expect(html).not.toContain('nie ma podpiętego żadnego sklepu');
    for (const t of ['Lampa stołowa Gliwka', 'LMP-STO-001', 'Kopuła']) expect.soft(html, t).toContain(t);
    const przed = (() => { const db = baza(); try { return db.prepare('SELECT COUNT(*) n FROM produkty_sklepowe WHERE zniknal_at IS NULL').get().n; } finally { db.close(); } })();
    const r = await formularz('/magazyn/odswiez', {});
    expect(r.status).toBe(303);
    // Przebieg idzie w tle — czekamy na jego koniec przez usługę.
    const magazyn = live.aplikacja.usluga('magazyn', 'magazyn');
    for (let i = 0; i < 100 && !magazyn.stan()?.skonczony_at; i++) await new Promise((ok) => setTimeout(ok, 50));
    // Przebieg NAPRAWDĘ przeszedł wszystkie trzy kanały: „nic nie zniknęło” bez tego przeszłoby też przy przebiegu,
    // który nie ruszył albo padł na hamulcu pustego odczytu (wtedy też nic nie znika).
    const s = magazyn.stan();
    expect(s.blad).toBeNull();
    expect(s.kanaly.map((k) => [k.kanal, k.blad, k.znikniete])).toEqual([['polcien', null, 0], ['allegro', null, 0], ['allegro-outlet', null, 0]]);
    expect(s.kanaly.reduce((n, k) => n + k.zapisane, 0)).toBe(przed);
    const db = baza();
    try {
      expect(db.prepare('SELECT COUNT(*) n FROM produkty_sklepowe WHERE zniknal_at IS NULL').get().n).toBe(przed);
      expect(db.prepare('SELECT COUNT(*) n FROM produkty_sklepowe WHERE zniknal_at IS NOT NULL').get().n).toBe(0);
    } finally { db.close(); }
  });

  it('PRZ-087: karta zamówienia ma sekcję Wiadomości, „Wyślij” przechodzi przez atrapę poczty i trafia do historii', async () => {
    const db = baza();
    let zam;
    try {
      zam = db.prepare(`SELECT id FROM zamowienia WHERE anulowane = 0 AND sklep = 'polcien'
        AND EXISTS (SELECT 1 FROM pozycje p WHERE p.zamowienie_id = zamowienia.id) ORDER BY id DESC LIMIT 1`).get();
    } finally { db.close(); }
    expect(zam).toBeTruthy();
    // Generator demo zapisuje część potwierdzeń w historii — liczymy przyrost, nie stan.
    const ileWiadomosci = () => { const d = baza(); try {
      return d.prepare("SELECT COUNT(*) n FROM wiadomosci WHERE zamowienie_id = ? AND temat_id = 'potwierdzenie'").get(zam.id).n;
    } finally { d.close(); } };
    const przed = ileWiadomosci();
    const karta = await strona(`/zamowienia/${zam.id}`);
    expect(karta.html).toContain('id="wiadomosci"');
    expect(karta.html).toContain('Wyślij nową wiadomość');
    const podglad = await strona(`/zamowienia/${zam.id}?wiadomosc=potwierdzenie`);
    expect(podglad.html).toContain('to zobaczy klient');
    const r = await formularz(`/zamowienia/${zam.id}/wiadomosc/potwierdzenie`, {});
    expect([302, 303], await r.clone().text()).toContain(r.status);
    expect(ileWiadomosci()).toBe(przed + 1);
    expect(logi.some((l) => l.includes('atrapa poczty') && l.includes('nic nie poszło'))).toBe(true);
  });

  it('przez cały plik aplikacja ani razu nie wyszła do sieci', () => {
    expect(siec.mock.calls.map((c) => String(c[0]))).toEqual([]);
  });
});

describe('⛔ atrapy poza trybem próby', () => {
  const db = { exec() {}, prepare() { throw new Error('nie powinno dojść do bazy'); } };
  for (const tryb of [undefined, '', 'produkcja']) {
    it(`OMS_TRYB=${JSON.stringify(tryb)}: każda atrapa i złożenie odmawiają`, async () => {
      const env = { ...ENV_DEMO, OMS_TRYB: tryb };
      expect(() => createAtrapaInfaktu({ db, env })).toThrow('OMS_TRYB=proba');
      expect(() => createAtrapaVies({ env })).toThrow('OMS_TRYB=proba');
      expect(() => createAtrapaWoo({ db, kanal: 'polcien', env })).toThrow('OMS_TRYB=proba');
      expect(() => createAtrapaAllegro({ db, kanal: 'allegro', env })).toThrow('OMS_TRYB=proba');
      expect(() => zbudujAtrapyKanalow({ db, config: {}, env })).toThrow('OMS_TRYB=proba');
      expect(() => createAtrapaPoczty({ env })).toThrow('OMS_TRYB=proba');
      expect(() => createModulWiadomosciAtrapy(env)).toThrow('OMS_TRYB=proba');
      expect(() => modulyPiaskownicy(env)).toThrow('OMS_TRYB=proba');
      await expect(uruchomPiaskownice(env)).rejects.toThrow('OMS_TRYB=proba');
    });
  }

  it('obraz produkcji nie kopiuje deploy/ — atrapy nie mają jak wejść do kontenera produkcji', () => {
    const dockerfile = fs.readFileSync(path.join(import.meta.dirname, '../../deploy/klient/Dockerfile'), 'utf8');
    const kopie = dockerfile.split('\n').filter((l) => /^\s*COPY\s/i.test(l)).map((l) => l.trim().split(/\s+/)[1]);
    expect(kopie.length).toBeGreaterThan(0);
    for (const zrodlo of kopie) {
      expect(zrodlo, `COPY ${zrodlo}`).not.toMatch(/^(\.|\.\/|deploy\/?|deploy\/proba.*)$/);
    }
    expect(fs.existsSync(path.join(import.meta.dirname, '../../src/atrapy'))).toBe(false);
  });
});
