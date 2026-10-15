// PRZ-083 część 2 (właściciel 15.10):
//  1. „+ Nowe zamówienie” w menu z tłem przycisku głównego — wszędzie, nie tylko w demo.
//  2. Ustawienia w demo do OBEJRZENIA: gość widzi wszystkie ekrany (także Konta i Role, które są dla admina), nic nie
//     zapisze (każde POST pod /ustawienia od gościa = 403, zanim dojdzie do trasy), treść ekranów jest martwa (inert).
//     Diagnostyka bez połączeń (atrapa), Konta bez dziennika prób logowania (loginy i IP innych gości) i bez
//     prawdziwego loginu administratora, za to ze zmyślonym zespołem.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { uruchomPiaskownice } from '../../deploy/proba/atrapy/index.mjs';
import { zalozBazeDemo } from '../../deploy/demo/baza.mjs';
import { ENV_DEMO } from '../../scripts/demo-dane.mjs';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DZIS = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
const ADMIN = { login: 'admin-demo-prawdziwy', imie: 'Prawdziwe Imię Admina', haslo: 'haslo-testu-demo-1' };
const PODGLAD = 'W wersji demonstracyjnej ustawienia można tylko obejrzeć';
const katalogi = [];
let live, url, env, gosc, admin;

const zaloguj = async (uzytkownik, haslo) => {
  const r = await fetch(url + '/login', { method: 'POST', redirect: 'manual',
    headers: { origin: url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ uzytkownik, haslo, powrot: '/' }) });
  return r.headers.get('set-cookie').match(/sesja_oms_proba=[^;]+/)[0];
};
const get = async (adres, cookie = gosc) => {
  const r = await fetch(url + adres, { headers: { cookie, accept: 'text/html' }, redirect: 'manual' });
  return { status: r.status, html: await r.text() };
};
const post = async (adres, pola, cookie = gosc) => {
  const r = await fetch(url + adres, { method: 'POST', redirect: 'manual',
    headers: { cookie, origin: url, accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(pola) });
  return { status: r.status, html: await r.text() };
};
const baza = () => new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });

beforeAll(async () => {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-demo-prz083c-')); katalogi.push(k);
  env = { ...ENV_DEMO, OMS_DB_PATH: path.join(k, 'oms.sqlite'), OMS_PORT: '0', OMS_USER: 'serwis-demo',
    OMS_PASS: 'haslo-serwisowe-testu', OMS_PROFORMY_KATALOG: path.join(k, 'proformy'), OMS_ETYKIETY_KATALOG: path.join(k, 'etykiety'),
    OMS_DEMO_LOGIN: 'demo', OMS_DEMO_HASLO: 'demo' };
  await zalozBazeDemo({ baza: env.OMS_DB_PATH, dzis: DZIS, env, kontoAdmina: ADMIN });
  live = await uruchomPiaskownice(env, { host: '127.0.0.1' });
  url = live.aplikacja.app.listeningOrigin;
  admin = await zaloguj(ADMIN.login, ADMIN.haslo);
  // Nieudana próba z „e-mailem” jako loginem — taki wpis dziennika nie może trafić do innych gości.
  await fetch(url + '/login', { method: 'POST', redirect: 'manual',
    headers: { origin: url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ uzytkownik: 'ktos@prywatny-adres.example', haslo: 'zle', powrot: '/' }) });
  gosc = await zaloguj('demo', 'demo');
}, 120_000);
afterAll(async () => {
  await live?.zamknij();
  for (const k of katalogi.splice(0)) fs.rmSync(k, { recursive: true, force: true });
});

describe('PRZ-083: „+ Nowe zamówienie” wyróżnione tłem', () => {
  it('reguła w oms-design.css: tło i kolor tekstu przycisku głównego (tokeny palety, oba motywy)', () => {
    const css = fs.readFileSync(path.join(ROOT, 'src/public/oms-design.css'), 'utf8');
    const regula = css.match(/\.oms-nowe-zamowienie a,[^{]*\{([^}]*)\}/)?.[1] ?? '';
    expect(regula).toContain('background:var(--marka)');
    expect(regula).toContain('color:var(--na-marce)');
  });
});

describe('PRZ-083: strona „Brak dostępu” ze strażnika (także produkcja)', () => {
  // Od PRZ-021 strażnik wołał reply.view('brak-dostepu.ejs') w onRequest — przed podmianą nazw widoków w preHandler —
  // i każde konto bez uprawnienia dostawało JSON „ENOENT … src/brak-dostepu.ejs” zamiast ekranu odmowy.
  it('konto bez ptaszka (gość: Finanse) dostaje stronę HTML 403, nie JSON z błędem pliku', async () => {
    const { status, html } = await get('/finanse');
    expect(status).toBe(403);
    expect(html).not.toContain('ENOENT');
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).toContain('Brak dostępu');
  });
});

describe('PRZ-083: Ustawienia w demo — gość ogląda wszystko', () => {
  it('wszystkie ekrany Ustawień: 200, pasek podglądu i treść martwa (inert)', async () => {
    const db = baza();
    const idAdmina = db.prepare('SELECT id FROM konta WHERE login = ?').get(ADMIN.login).id;
    db.close();
    // /ustawienia przekierowuje na pierwszą podstronę (trasy/wysylka.js).
    const wejscie = await get('/ustawienia');
    expect(wejscie.status).toBe(302);
    expect(wejscie.html).toBe('');
    for (const adres of ['/ustawienia/zamowienia-i-wysylka', '/ustawienia/wiadomosci-i-automatyzacje',
      '/ustawienia/integracje', '/ustawienia/integracje/reklamy', '/ustawienia/konta', `/ustawienia/konta/${idAdmina}`,
      '/ustawienia/role', '/ustawienia/lacznosc']) {
      const { status, html } = await get(adres);
      expect(status, adres).toBe(200);
      expect(html, adres).toContain(PODGLAD);
      expect(html, adres).toMatch(/<div class="podglad-demo" inert>/);
    }
  });

  it('zębatka Ustawień w belce gościa demo', async () => {
    expect((await get('/')).html).toContain('aria-label="Ustawienia"');
  });

  it('żaden zapis: POST pod /ustawienia od gościa = 403 przed trasą, baza bez zmian', async () => {
    const db = baza();
    const przed = { konta: db.prepare('SELECT COUNT(*) n FROM konta').get().n,
      sekret: db.prepare('SELECT sekret FROM sekret_sesji WHERE id = 1').get().sekret,
      role: db.prepare('SELECT COUNT(*) n FROM role').get().n };
    db.close();
    for (const [adres, pola] of [['/ustawienia/konta/wyloguj-wszystkie', {}], ['/ustawienia/konta/nowe', { login: 'wlamywacz', imie: 'X', rola: 'administrator', sposob: 'link' }],
      ['/ustawienia/role/nowa', { nazwa: 'Rola gościa' }], ['/ustawienia/formulka', { tresc: 'x' }], ['/ustawienia/dostawa', {}],
      ['/ustawienia/paczka', {}], ['/ustawienia/integracje/reklamy/zapisz', {}]]) {
      const r = await post(adres, pola);
      expect(r.status, adres).toBe(403);
      expect(r.html, adres).toContain('można tylko obejrzeć');
    }
    const po = baza();
    try {
      expect(po.prepare('SELECT COUNT(*) n FROM konta').get().n).toBe(przed.konta);
      expect(po.prepare('SELECT sekret FROM sekret_sesji WHERE id = 1').get().sekret).toBe(przed.sekret);
      expect(po.prepare('SELECT COUNT(*) n FROM role').get().n).toBe(przed.role);
    } finally { po.close(); }
    // Gość nadal zalogowany — „Wyloguj wszystkich” nie przeszło.
    expect((await get('/')).status).toBe(200);
  });

  it('Konta: bez dziennika prób logowania i IP, administrator jako „Właściciel firmy”, zmyślony zespół', async () => {
    const { html } = await get('/ustawienia/konta');
    expect(html).not.toContain(ADMIN.login);
    expect(html).not.toContain(ADMIN.imie);
    expect(html).not.toContain('ktos@prywatny-adres.example');
    expect(html).not.toContain('127.0.0.1');
    expect(html).toContain('Właściciel firmy');
    expect(html).toContain('Anna Wiśniewska');
    expect(html).toContain('Marek Zieliński');
    // Dziennik zmyślony, nie pusty: „nikt się nie logował” przeczyłoby tabeli kont wyżej.
    expect(html).not.toContain('Jeszcze nikt się nie logował');
    expect(html).toContain('203.0.113.24');
    const db = baza();
    const idAdmina = db.prepare('SELECT id FROM konta WHERE login = ?').get(ADMIN.login).id;
    db.close();
    const strona = (await get(`/ustawienia/konta/${idAdmina}`)).html;
    expect(strona).not.toContain(ADMIN.login);
    expect(strona).not.toContain(ADMIN.imie);
  });

  it('Diagnostyka: atrapa bez połączeń — szybko i wszystko „działa”', async () => {
    const t0 = Date.now();
    const { html } = await get('/ustawienia/lacznosc');
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(html).toContain('inFakt');
    // Adres z zakresu dokumentacyjnego (RFC 5737) daje tylko atrapa — prawdziwa diagnostyka z laptopa z internetem też by przeszła.
    expect(html).toContain('203.0.113.');
    // Adres atrap z konfiguracji nie wychodzi na ekran gościa.
    expect(html).not.toContain('atrapa.example.invalid');
    expect(html).toContain('api.allegro.pl');
    expect(html).not.toMatch(/nie rozwiązuje się|ENOTFOUND|fetch failed/);
  });

  it('Integracje: oba kanały Allegro demo połączone (nie „brak skonfigurowanych kanałów”)', async () => {
    const { html } = await get('/ustawienia/integracje');
    expect(html).not.toContain('nie ma skonfigurowanych kanałów Allegro');
    expect(html.match(/połączenie ważne jeszcze \d+ dni/g) ?? []).toHaveLength(2);
    // Zdrowe kanały nie wołają o pomoc na liście zamówień.
    const lista = (await get('/')).html;
    expect(lista).not.toContain('class="pas-awaria"');
    expect(lista).not.toContain('class="pas-uprzedzenie"');
  });

  it('administrator demo widzi prawdziwe dane i może zapisywać — podgląd dotyczy tylko gościa', async () => {
    const { html } = await get('/ustawienia/konta', admin);
    expect(html).toContain(ADMIN.login);
    expect(html).toContain('ktos@prywatny-adres.example');
    expect(html).not.toContain(PODGLAD);
    const r = await post('/ustawienia/role/nowa', { nazwa: 'Rola testowa admina' }, admin);
    expect(r.status).not.toBe(403);
  });
});
