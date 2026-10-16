// PRZ-082 — poprawki demo od właściciela (14.10): każdy punkt listy ma tu swój test, żeby kolejna zmiana generatora
// (albo nowy reset) nie zgubiła go po cichu. Demo stoi jak w kontenerze: generator + atrapy piaskownicy + konto gościa.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { uruchomPiaskownice } from '../../deploy/proba/atrapy/index.mjs';
import { CO_ILE_MS_PULSU_POLLEROW } from '../../deploy/proba/atrapy/pollery.mjs';
import { MINUTY_RESETU_DOMYSLNIE as MINUTY_DEMO, msDoResetu } from '../../deploy/demo/reset.mjs';
import { zalozKonto } from '../../src/core/bezpieczenstwo/konta.js';
import { kontoDemo, opisResetuDemo, MINUTY_RESETU_DOMYSLNIE } from '../../src/core/demo.ts';
import { PROG_POLLERA_S } from '../../src/domena/zdrowie.js';
import { bezRuchu, etapPrzesylki } from '../../src/domena/etap-przesylki.js';
import { utworzBazeDemo, ENV_DEMO } from '../../scripts/demo-dane.mjs';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const DZIS = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
const plusDni = (dzien, n) => new Date(Date.parse(`${dzien}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const katalogi = [];
afterAll(() => { for (const p of katalogi.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });

describe('napis resetu na ekranie logowania (punkt 1)', () => {
  it('jedno źródło liczby minut: harmonogram demo bierze domyślną z src/core/demo.ts', () => {
    expect(MINUTY_DEMO).toBe(MINUTY_RESETU_DOMYSLNIE);
    expect(MINUTY_RESETU_DOMYSLNIE).toBe(60);
  });

  it('opis po polsku dla każdej dopuszczalnej liczby minut', () => {
    expect(opisResetuDemo(60)).toBe('co godzinę');
    expect(opisResetuDemo(1440)).toBe('co noc');
    expect(opisResetuDemo(30)).toBe('co 30 minut');
    expect(opisResetuDemo(24)).toBe('co 24 minuty');
    expect(opisResetuDemo(120)).toBe('co 2 godziny');
    expect(opisResetuDemo(360)).toBe('co 6 godzin');
    expect(opisResetuDemo(90)).toBe('co 90 minut');
  });

  it('kontoDemo niesie opis z DEMO_RESET_CO_MIN, a bez zmiennej — z domyślnej', () => {
    const env = { OMS_TRYB: 'proba', OMS_DEMO_LOGIN: 'demo', OMS_DEMO_HASLO: 'demo' };
    expect(kontoDemo(env).reset).toBe('co godzinę');
    expect(kontoDemo({ ...env, DEMO_RESET_CO_MIN: '30' }).reset).toBe('co 30 minut');
    // Liczba, której harmonogram nie przyjmie, nie może dać na ekranie obietnicy, której nikt nie dotrzyma.
    expect(() => kontoDemo({ ...env, DEMO_RESET_CO_MIN: '7' })).toThrow('DEMO_RESET_CO_MIN');
    expect(() => msDoResetu(new Date(), 7)).toThrow('DEMO_RESET_CO_MIN');
  });
});

describe('demo po poprawkach PRZ-082', () => {
  let env, live, url, admin, gosc;
  beforeAll(async () => {
    const k = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-demo-prz082-')); katalogi.push(k);
    for (const d of ['proformy', 'etykiety']) fs.mkdirSync(path.join(k, d), { recursive: true });
    env = { ...ENV_DEMO, OMS_DB_PATH: path.join(k, 'oms.sqlite'), OMS_PORT: '0', OMS_USER: 'serwis-demo',
      OMS_PASS: 'haslo-serwisowe-testu', OMS_PROFORMY_KATALOG: path.join(k, 'proformy'), OMS_ETYKIETY_KATALOG: path.join(k, 'etykiety'),
      OMS_DEMO_LOGIN: 'demo', OMS_DEMO_HASLO: 'demo' };
    await utworzBazeDemo({ baza: env.OMS_DB_PATH, dzis: DZIS, env });
    const db = new DatabaseSync(env.OMS_DB_PATH);
    // Jak deploy/demo/start.mjs: administrator i gość z rolą Sprzedaż.
    try {
      zalozKonto(db, { login: 'demo-admin', imie: 'Administrator demo', haslo: 'haslo-testu-demo-1', rola: 'administrator', admin: true });
      zalozKonto(db, { login: 'demo', imie: 'Gość demo', haslo: 'demo', rola: 'sprzedaz' });
    } finally { db.close(); }
    live = await uruchomPiaskownice(env, { host: '127.0.0.1' });
    url = live.aplikacja.app.listeningOrigin;
    const zaloguj = async (uzytkownik, haslo) => {
      const r = await fetch(url + '/login', { method: 'POST', redirect: 'manual',
        headers: { origin: url, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ uzytkownik, haslo, powrot: '/' }) });
      expect(r.status).toBe(302);
      return r.headers.get('set-cookie').match(/sesja_oms_proba=[^;]+/)[0];
    };
    admin = await zaloguj('demo-admin', 'haslo-testu-demo-1');
    gosc = await zaloguj('demo', 'demo');
  }, 90000);
  afterAll(async () => { await live?.zamknij(); });

  const strona = async (adres, cookie = admin) => {
    const r = await fetch(url + adres, { headers: { cookie }, redirect: 'manual' });
    return { status: r.status, html: await r.text() };
  };
  const zBazy = (fn) => { const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true }); try { return fn(db); } finally { db.close(); } };

  it('1. ekran logowania mówi o resecie co godzinę, nie co noc', async () => {
    const { html } = await strona('/login', '');
    expect(html).toContain('wracają do stanu początkowego co godzinę');
    expect(html).not.toContain('co noc');
  });

  it('2. nieopłacona faktura przelewem z terminem za kilka dni', async () => {
    const { html } = await strona('/faktury');
    const wkrotce = zBazy((db) => db.prepare("SELECT dane_json FROM atrapa_infakt_dokumenty WHERE rodzaj = 'vat'").all())
      .map((w) => JSON.parse(w.dane_json))
      .filter((d) => d.payment_method === 'transfer' && Number(d.left_to_pay) > 0
        && d.payment_date >= plusDni(DZIS, 2) && d.payment_date <= plusDni(DZIS, 7));
    expect(wkrotce.length).toBeGreaterThanOrEqual(1);
    expect(html).toContain(wkrotce[0].number);
    expect(html).toMatch(/za [2-7] dni/);
  });

  it('3. najnowsza faktura nie poszła do KSeF — jedyna taka, wystawiona dziś (bez alarmu „przed dzisiejszym dniem”)', async () => {
    const f = zBazy((db) => ({
      najnowsza: db.prepare('SELECT numer, ksef_numer, utworzona_at FROM faktury ORDER BY utworzona_at DESC, id DESC LIMIT 1').get(),
      bez: db.prepare('SELECT COUNT(*) n FROM faktury WHERE ksef_numer IS NULL').get().n,
    }));
    expect(f.najnowsza.ksef_numer).toBeNull();
    expect(f.bez).toBe(1);
    expect(new Date(f.najnowsza.utworzona_at).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' })).toBe(DZIS);
    const { html } = await strona('/faktury');
    expect(html).toContain(f.najnowsza.numer);
    expect((await strona('/', admin)).html).not.toContain('nie została wysłana do KSeF');
  });

  it('4. dwie proformy w każdym miesiącu demo', async () => {
    // Miesiąc po polsku (jak numer proformy); 1. dnia rano bieżący miesiąc może mieć mniej niż dwa zamówienia — wtedy go pomijamy.
    const ile = new Map();
    for (const { t } of zBazy((db) => db.prepare('SELECT utworzone_at t FROM zamowienia WHERE anulowane = 0').all())) {
      const m = new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' }).slice(0, 7);
      ile.set(m, (ile.get(m) ?? 0) + 1);
    }
    const miesiace = [...ile].filter(([, n]) => n >= 2).map(([m]) => m).sort();
    expect(miesiace.length).toBeGreaterThanOrEqual(2);
    const naMiesiac = zBazy((db) => Object.fromEntries(db.prepare('SELECT rok, miesiac, COUNT(*) n FROM proformy GROUP BY rok, miesiac').all()
      .map((w) => [`${w.rok}-${String(w.miesiac).padStart(2, '0')}`, w.n])));
    for (const m of miesiace) expect.soft(naMiesiac[m] ?? 0, m).toBe(2);
    const { html } = await strona(`/faktury?miesiac=${miesiace.at(-1)}`);
    expect(html).not.toContain('W tym miesiącu panel nie wystawił ani jednej proformy');
    const id = zBazy((db) => db.prepare('SELECT id FROM proformy ORDER BY id LIMIT 1').get().id);
    const pdf = await fetch(`${url}/proformy/${id}/pdf`, { headers: { cookie: admin } });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toContain('pdf');
  });

  it('5. utworzone przesyłki DHL, ORLEN Paczka i Allegro One', async () => {
    const { html } = await strona('/przesylki?pokaz=utworzone');
    for (const p of ['DHL', 'ORLEN Paczka', 'Allegro One']) expect.soft(html, p).toContain(`alt="${p}"`);
  });

  it('6. historia podjazdów ma kilka wpisów z paczkami', async () => {
    const n = zBazy((db) => db.prepare('SELECT COUNT(DISTINCT podjazd_id) n FROM podjazdy_przesylki').get().n);
    expect(n).toBeGreaterThanOrEqual(3);
    const { status, html } = await strona('/przesylki/podjazdy/historia');
    expect(status).toBe(200);
    expect(html).not.toContain('Nie ma jeszcze zleconych podjazdów');
    expect(html).toContain('potwierdzony');
    const id = zBazy((db) => db.prepare('SELECT id FROM podjazdy ORDER BY id LIMIT 1').get().id);
    expect((await strona(`/przesylki/podjazdy/${id}`)).status).toBe(200);
  });

  it('7. dokładnie jedna paczka stoi bez ruchu', async () => {
    const teraz = new Date().toISOString();
    const stoi = zBazy((db) => db.prepare('SELECT numer_listu, status_kuriera, status_kuriera_at, utworzona_at FROM przesylki').all())
      .filter((p) => bezRuchu({ etap: etapPrzesylki(p.status_kuriera), statusKurieraAt: p.status_kuriera_at, nadanaAt: p.utworzona_at, teraz }));
    expect(stoi.map((p) => p.numer_listu)).toHaveLength(1);
    const { html } = await strona('/przesylki?pokaz=bez_ruchu');
    expect(html).toContain(stoi[0].numer_listu);
  });

  it('8. realistyczny CTR: Meta 1–3%, Google 3–8%, kampania 1–3%', () => {
    const ctr = zBazy((db) => ({
      meta: db.prepare('SELECT 1.0 * SUM(klikniecia) / SUM(wyswietlenia) c FROM reklamy_meta_dni').get().c,
      google: db.prepare('SELECT 1.0 * SUM(klikniecia) / SUM(wyswietlenia) c FROM reklamy_google_dni').get().c,
      kampania: db.prepare('SELECT 1.0 * SUM(klikniecia) / SUM(wyswietlenia) c FROM kampania_meta_dni').get().c,
    }));
    expect(ctr.meta).toBeGreaterThan(0.01); expect(ctr.meta).toBeLessThan(0.03);
    expect(ctr.google).toBeGreaterThan(0.03); expect(ctr.google).toBeLessThan(0.08);
    expect(ctr.kampania).toBeGreaterThan(0.01); expect(ctr.kampania).toBeLessThan(0.03);
  });

  it('9. firmy poza KSeF: Facebook i Google na liście i z fakturą w zamkniętym miesiącu', async () => {
    const firmy = zBazy((db) => db.prepare('SELECT nazwa, sprzedawca, kategoria FROM firmy_reczne ORDER BY nazwa').all());
    expect(firmy.map((f) => f.nazwa)).toEqual(['Facebook (Meta)', 'Google Ads']);
    const poprzedni = new Date(Date.parse(`${DZIS.slice(0, 7)}-01T00:00:00Z`) - 86400000).toISOString().slice(0, 7);
    const koszty = zBazy((db) => db.prepare(`SELECT sprzedawca_nazwa, sprzedawca_nip FROM koszty WHERE data_wystawienia LIKE ?
      AND sprzedawca_nazwa IN ('Meta Platforms Ireland Limited', 'Google Ireland Limited')`).all(`${poprzedni}-%`));
    expect(koszty.map((k) => k.sprzedawca_nazwa).sort()).toEqual(['Google Ireland Limited', 'Meta Platforms Ireland Limited']);
    expect(koszty.every((k) => k.sprzedawca_nip === null)).toBe(true);
    const { html } = await strona('/koszty');
    for (const f of ['Facebook (Meta)', 'Google Ads']) expect.soft(html).toContain(`<option value="${f}"`);
  });

  it('10. Cele: bez danych, gość nie ma zakładki ani dostępu', async () => {
    expect(zBazy((db) => db.prepare('SELECT COUNT(*) n FROM cele').get().n)).toBe(0);
    const { html } = await strona('/', gosc);
    expect(html).toContain('href="/zamowienia');
    expect(html).not.toContain('href="/cele"');
    expect((await strona('/cele', gosc)).status).toBe(403);
  });

  it('11. pollery atrapy mają świeży przebieg — zdrowie nie krzyczy „Poller … stoi”', async () => {
    expect(CO_ILE_MS_PULSU_POLLEROW).toBeLessThan(PROG_POLLERA_S * 1000 / 3);
    const wiersze = zBazy((db) => db.prepare('SELECT sklep, ostatni_przebieg_at, ostatni_blad FROM stan_pollera ORDER BY sklep').all());
    expect(wiersze.map((w) => w.sklep).sort()).toEqual(['allegro', 'allegro-outlet', 'polcien']);
    for (const w of wiersze) {
      expect(w.ostatni_blad).toBeNull();
      expect(Date.now() - Date.parse(w.ostatni_przebieg_at)).toBeLessThan(120000);
    }
    expect((await strona('/', gosc)).html).not.toMatch(/Poller [\w-]+ (stoi|nie działa)/);
  });

  it('12. zielony pas „Wersja demonstracyjna” nad pasami i ostrzeżeniami', async () => {
    const { html } = await strona('/', gosc);
    const pas = html.indexOf('class="pas-demo"');
    expect(pas).toBeGreaterThan(-1);
    expect(html.slice(pas, pas + 200)).toContain('Wersja demonstracyjna');
    for (const inne of ['class="ostrzezenia"', 'class="pas-awaria"', 'class="pas-uprzedzenie"']) {
      const i = html.indexOf(inne);
      if (i > -1) expect(i, inne).toBeGreaterThan(pas);
    }
    expect(html).not.toContain('Ostatnia synchronizacja');
  });

  it('strażnik danych: nowe wpisy też zmyślone (e-maile .invalid, NIP 999…)', () => {
    zBazy((db) => {
      const tekst = ['zamowienia', 'podjazdy', 'proformy', 'przesylki', 'firmy_reczne']
        .flatMap((t) => db.prepare(`SELECT * FROM ${t}`).all().map((w) => JSON.stringify(w))).join('\n');
      expect((tekst.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? []).filter((m) => !/@example\.invalid$/i.test(m))).toEqual([]);
      expect(tekst).not.toMatch(/stencil|lumina|drugamarka|trzeciamarka|zywiecki/i);
    });
  });
});
