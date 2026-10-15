// PRZ-072 — generator danych demo (scripts/demo-dane.mjs): każda zakładka menu ma dane, dane są
// zmyślone, generator jest deterministyczny i nie nadpisuje istniejącej bazy.
//
// ⚠️ Zakładki bierzemy z `aplikacja.menu`, nie z listy w teście: nowa zakładka bez znacznika
// w ZNACZNIKI łamie test, zanim demo pokaże gościowi pusty ekran.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { uruchomPiaskownice } from '../../deploy/proba/atrapy/index.mjs';
import { zalozKonto } from '../../src/core/bezpieczenstwo/konta.js';
import { utworzBazeDemo, wygenerujDaneDemo, ENV_DEMO, nipFikcyjny } from '../../scripts/demo-dane.mjs';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const DZIS = '2026-10-14';
// Zakładki (Raporty, Koszty) otwierają się na bieżącym miesiącu wg zegara — demo dla nich liczone od dziś.
const DZIS_TERAZ = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
const katalogi = [];
function katalog() { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-demo-dane-')); katalogi.push(p); return p; }
function envDla(k) {
  fs.mkdirSync(path.join(k, 'proformy'), { recursive: true }); fs.mkdirSync(path.join(k, 'etykiety'), { recursive: true });
  return { ...ENV_DEMO, OMS_DB_PATH: path.join(k, 'oms.sqlite'), OMS_PORT: '0', OMS_USER: 'serwis-demo',
    OMS_PASS: 'haslo-serwisowe-testu', OMS_PROFORMY_KATALOG: path.join(k, 'proformy'), OMS_ETYKIETY_KATALOG: path.join(k, 'etykiety') };
}
afterAll(() => { for (const p of katalogi.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });

// Adres zakładki → co MUSI na niej stać, gdy demo ma dane. Demo stoi jak w piaskownicy: z atrapami inFaktu, Woo
// i Allegro (deploy/proba/atrapy, PRZ-076), więc Faktury i Magazyn — czytające na żywo z inFaktu i sklepu — też mają dane.
const ZNACZNIKI = {
  '/': ['Sklep Półcień', 'Allegro Półcień Outlet'],
  '/przesylki': ['0000'],
  '/faktury': ['FV '], // 1. dnia miesiąca stoi tu 1 faktura, w połowie ~13 (pomiar 14.10) — nic pewniejszego od „FV ”
  '/okresy': ['Kawiarnie Dzbanuszek'],
  '/klienci': ['Hotel Zaciszny Brzeg', 'Wohnlicht Nordstrand GmbH (demo)'],
  '/wiadomosci': ['demo-watek-1', 'oprawka jest E27'],
  '/magazyn': ['Lampa stołowa Gliwka', 'LMP-STO-001', 'Lampa wisząca Kopuła'],
  '/raporty': ['Sprzedaż brutto', 'Lampa'],
  '/statystyki': ['Paczkomat'],
  '/kampania': ['Google · GA4', 'Meta · insights'],
  '/koszty': ['Huta Szkła Brzeziny (demo)', 'Spółdzielnia Warsztatowa Cegielnia (demo)'],
  '/finanse': ['Czynsz pracowni', 'Szkło i klosze'],
  // PRZ-082 (właściciel 14.10): Cele bez danych demo, gość nie ma zakładki (deploy/proba/atrapy/ekrany.mjs); administrator widzi pustą.
  '/cele': ['Cele'],
  '/ustawienia': ['Ustawienia'],
};
const PUSTE = ['W tym okresie nie ma ani jednego zamówienia', 'W tym zakresie nie ma zamówień.',
  'Nie ma jeszcze żadnego okresu rozliczeniowego', 'Nie ma tu żadnej wiadomości', 'Nie ma jeszcze żadnego celu',
  'Brak faktur kosztowych w tym miesiącu', 'Nie da się policzyć'];

describe('generator danych demo na świeżej bazie', () => {
  let env, wynik, live, url, cookie;
  beforeAll(async () => {
    env = envDla(katalog());
    wynik = await utworzBazeDemo({ baza: env.OMS_DB_PATH, dzis: DZIS_TERAZ, env });
    const db = new DatabaseSync(env.OMS_DB_PATH);
    try { zalozKonto(db, { login: 'demo-admin', imie: 'Administrator demo', haslo: 'haslo-testu-demo-1', rola: 'administrator', admin: true }); }
    finally { db.close(); }
    live = await uruchomPiaskownice(env, { host: '127.0.0.1' });
    url = live.aplikacja.app.listeningOrigin;
    const login = await fetch(url + '/login', { method: 'POST', redirect: 'manual',
      headers: { origin: url, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ uzytkownik: 'demo-admin', haslo: 'haslo-testu-demo-1', powrot: '/' }) });
    expect(login.status).toBe(302);
    cookie = login.headers.get('set-cookie').match(/sesja_oms_proba=[^;]+/)[0];
  }, 60000);
  afterAll(async () => { await live?.zamknij(); });

  const strona = async (adres) => {
    let r = await fetch(url + adres, { headers: { cookie }, redirect: 'manual' });
    if (r.status === 302) r = await fetch(url + r.headers.get('location'), { headers: { cookie }, redirect: 'manual' });
    return { status: r.status, html: await r.text() };
  };

  it('ok. 156 zamówień z 60 dni (150 z pliku firmy + 6 uzupełnień PRZ-082), wszystkie statusy, faktury z WDT, zwroty, przesyłki, koszty', () => {
    expect(wynik.zamowienia).toBe(156);
    expect(Object.keys(wynik.statusy).sort()).toEqual(['anulowane', 'indywidualne', 'nowe', 'w_realizacji', 'wyslane', 'zwrot']);
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      const n = (sql) => db.prepare(sql).get().n;
      expect(n('SELECT COUNT(*) n FROM faktury')).toBeGreaterThanOrEqual(20);
      expect(n("SELECT COUNT(*) n FROM faktury WHERE numer LIKE 'WDT/%'")).toBeGreaterThanOrEqual(1);
      expect(n("SELECT COUNT(*) n FROM faktury f JOIN zamowienia z ON z.id = f.zamowienie_id WHERE z.pobranie = 1")).toBeGreaterThanOrEqual(1);
      expect(n('SELECT COUNT(*) n FROM zwroty')).toBeGreaterThanOrEqual(5);
      expect(n("SELECT COUNT(*) n FROM przesylki WHERE numer_listu IS NOT NULL")).toBeGreaterThanOrEqual(50);
      expect(n('SELECT COUNT(DISTINCT sklep) n FROM zamowienia')).toBe(4);
      const [od, doD] = Object.values(db.prepare('SELECT MIN(utworzone_at) a, MAX(utworzone_at) b FROM zamowienia').get());
      expect((Date.parse(doD) - Date.parse(od)) / 86400000).toBeGreaterThan(50);
      // Nic z przyszłości dla gościa, który otwiera demo rano (reset bywa nocny).
      expect(doD < `${DZIS_TERAZ}T06:00:00`).toBe(true);
      const najpozniej = db.prepare(`SELECT MAX(t) t FROM (SELECT MAX(wyslane_at) t FROM zamowienia UNION ALL
        SELECT MAX(oplacone_at) FROM zamowienia UNION ALL SELECT MAX(last_message_date_time) FROM allegro_watki
        UNION ALL SELECT MAX(wyslana_at) FROM wiadomosci UNION ALL SELECT MAX(status_kuriera_at) FROM przesylki)`).get().t;
      expect(najpozniej < `${DZIS_TERAZ}T06:00:00`, najpozniej).toBe(true);
    } finally { db.close(); }
  });

  it('każda zakładka menu odpowiada 200 i pokazuje dane demo', async () => {
    const adresy = live.aplikacja.menu.map((m) => m.adres);
    expect(adresy.filter((a) => !ZNACZNIKI[a]), 'zakładka bez znacznika demo — dopisz do ZNACZNIKI').toEqual([]);
    for (const adres of adresy) {
      const { status, html } = await strona(adres);
      expect.soft(status, adres).toBe(200);
      const z = ZNACZNIKI[adres];

      for (const tekst of z) expect.soft(html, `${adres}: brak „${tekst}”`).toContain(tekst);
      for (const tekst of PUSTE) if (adres !== '/cele') expect.soft(html, `${adres}: pusty stan „${tekst}”`).not.toContain(tekst);
    }
  }, 60000);

  it('licznik każdego statusu na liście zamówień jest niezerowy', async () => {
    const { html } = await strona('/');
    for (const s of ['nowe', 'indywidualne', 'w_realizacji', 'wyslane', 'zwrot', 'anulowane']) {
      const m = html.match(new RegExp(`data-status="${s}">(\\d+)<`));
      expect.soft(Number(m?.[1] ?? 0), s).toBeGreaterThan(0);
    }
  });

  it('karta zamówienia z fakturą WDT i z pobraniem pokazuje numer dokumentu', async () => {
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    let wdt, pobranie;
    try {
      wdt = db.prepare("SELECT zamowienie_id id, numer FROM faktury WHERE numer LIKE 'WDT/%' LIMIT 1").get();
      pobranie = db.prepare('SELECT f.zamowienie_id id, f.numer FROM faktury f JOIN zamowienia z ON z.id = f.zamowienie_id WHERE z.pobranie = 1 LIMIT 1').get();
    } finally { db.close(); }
    for (const f of [wdt, pobranie]) {
      const { status, html } = await strona(`/zamowienia/${f.id}`);
      expect(status).toBe(200);
      expect(html).toContain(f.numer);
    }
  });

  it('strażnik: zero danych spoza puli zmyślonej (e-maile .invalid, NIP 999…, adresy przykładowe)', () => {
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      const tabele = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
      const tekst = tabele.flatMap((t) => db.prepare(`SELECT * FROM "${t}"`).all().map((w) => JSON.stringify(w))).join('\n');
      const maile = [...new Set(tekst.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [])];
      expect(maile.length).toBeGreaterThan(10);
      expect(maile.filter((m) => !/@example\.invalid$/i.test(m))).toEqual([]);
      expect(tekst).not.toMatch(/stencil|lumina|drugamarka|trzeciamarka|zywiecki|twojoms/i);
      const nipy = [...db.prepare('SELECT nip FROM zamowienia WHERE nip IS NOT NULL UNION SELECT nip FROM klienci WHERE nip IS NOT NULL').all()].map((w) => w.nip);
      expect(nipy.length).toBeGreaterThan(5);
      expect(nipy.filter((n) => !/^(999\d{7}|[A-Z]{2}999\d+)$/.test(n))).toEqual([]);
      const adresy = db.prepare('SELECT dostawa_json FROM zamowienia').all().map((w) => JSON.parse(w.dostawa_json));
      expect(adresy.filter((a) => !/^(Ulica Przykładowa \d+|Musterstraße \d+|Ukázková \d+)$/.test(a.address_1))).toEqual([]);
    } finally { db.close(); }
  });
});

describe('generator danych demo — determinizm i odmowy', () => {
  const migawka = async (ziarno) => {
    const k = katalog(); const env = envDla(k);
    await utworzBazeDemo({ baza: env.OMS_DB_PATH, dzis: DZIS, ziarno, env });
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      return db.prepare(`SELECT sklep, numer, kwota_brutto, utworzone_at, wyslane_at, w_realizacji_at, anulowane, nip,
        (SELECT COUNT(*) FROM pozycje p WHERE p.zamowienie_id = z.id) pozycji FROM zamowienia z ORDER BY id`).all();
    } finally { db.close(); }
  };

  it('to samo ziarno i dzień dają te same zamówienia, inne ziarno — inne', async () => {
    const a = await migawka(7), b = await migawka(7), c = await migawka(8);
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  }, 60000);

  it('reset 1. dnia miesiąca: bieżący miesiąc ma koszty (zakładka Koszty otwiera się na nim)', async () => {
    const k = katalog(); const env = envDla(k);
    await utworzBazeDemo({ baza: env.OMS_DB_PATH, dzis: '2026-11-01', env });
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      const w = db.prepare("SELECT COUNT(*) n, MAX(data_wystawienia) d FROM koszty WHERE data_wystawienia LIKE '2026-11-%'").get();
      expect(w.n).toBe(8);
      expect(w.d).toBe('2026-11-01');
    } finally { db.close(); }
  });

  it('istniejący plik bazy: odmowa, bajty nietknięte', async () => {
    const k = katalog(); const plik = path.join(k, 'oms.sqlite'); fs.writeFileSync(plik, 'cudza-baza');
    await expect(utworzBazeDemo({ baza: plik, dzis: DZIS, env: envDla(k) })).rejects.toThrow('DEMO_ODMOWA_NADPISANIA');
    expect(fs.readFileSync(plik, 'utf8')).toBe('cudza-baza');
  });

  it('baza z zamówieniem: odmowa przed jakimkolwiek zapisem', async () => {
    const k = katalog(); const env = envDla(k);
    await utworzBazeDemo({ baza: env.OMS_DB_PATH, dzis: DZIS, env });
    const db = new DatabaseSync(env.OMS_DB_PATH);
    try {
      const przed = db.prepare('SELECT COUNT(*) n FROM zamowienia').get().n;
      expect(() => wygenerujDaneDemo(db, { dzis: DZIS, env })).toThrow('DEMO_BAZA_NIEPUSTA');
      expect(db.prepare('SELECT COUNT(*) n FROM zamowienia').get().n).toBe(przed);
    } finally { db.close(); }
  }, 30000);

  it('NIP fikcyjny ma poprawną sumę kontrolną i prefiks 999', () => {
    for (const n of [0, 1, 1000, 5011, 7013].map(nipFikcyjny)) {
      const c = n.split('').map(Number);
      expect(n).toMatch(/^999\d{7}$/);
      expect([6, 5, 7, 2, 3, 4, 5, 6, 7].reduce((s, w, i) => s + w * c[i], 0) % 11).toBe(c[9]);
    }
  });
});
