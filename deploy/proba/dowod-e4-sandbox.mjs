#!/usr/bin/env node
// PRZ-160.E4 — dowód 2 (plan §7.2): prawdziwy Allegro Sandbox (kanał B) + atrapa Woo (A) + atrapa ERLI (C).
//
// Instancja LOKALNA w procesie (OMS_TRYB=proba, OMS_PROBA_ALLEGRO_SANDBOX=tak), własna baza w ~/.allegro-sandbox-e3/d2.
// Piaskownicy 3005 nie dotyka: jedyny odczyt to aplikacja Device z jej bazy, tylko do odczytu (readOnly).
// ⚠️ Tokenów, sekretów i nagłówków Authorization nic tu nie wypisuje ani nie zapisuje poza plikiem tokenów:
//    na starcie fazy token idzie z pliku do bazy lokalnej, na wyjściu (także przy błędzie i `exit(9)`) wraca do pliku
//    atomowo (.nowy + rename, 600) i znika z bazy lokalnej razem z aplikacją Device.
// Sieć: wyłącznie https + *.allegrosandbox.pl (inny host = wyjątek i wpis STOP). ERLI nie ma klucza → atrapa.
// PRZ-182: poświadczenia w obu bazach leżą zaszyfrowane kluczem piaskownicy — skrypt czyta je i zapisuje wyłącznie
// warstwą dostępu z przypiętym sejfem. Klucz: OMS_KLUCZ_SEKRETOW z /srv/oms-proba/konfiguracja/proba.env, wczytany
// do środowiska bez wypisywania (np. `export "$(grep '^OMS_KLUCZ_SEKRETOW=' /srv/oms-proba/konfiguracja/proba.env)"`).
// Bez klucza — odmowa przed otwarciem którejkolwiek bazy.
//
// Użycie: node deploy/proba/dowod-e4-sandbox.mjs <faza>
//   przygotuj | kup | anuluj | zero | przyjecie | restart | restart2 | d14 | przywroc | stan
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { przygotujUruchomienieSandbox } from './sandbox-uruchomienie.ts';
import { envDemo, createLicznik, PETLE, wlaczOferty, zasiej, KONTA_DEMO } from './dowod-e4.mjs';
import { createAtrapaWoo } from './atrapy/kanaly.mjs';
import { createZakup } from './zakup.mjs';
import { uruchomPulsPollerow } from './atrapy/pollery.mjs';
import { migawkaStanow } from '../../src/oms/db/stany-magazynowe.js';
import { iloscDlaKanalu } from '../../src/domena/ilosc-kanalu.js';
import { definicjeKanalow } from '../../src/moduly/kanaly/konfiguracja.ts';
import { otworzBazeStartu } from '../../src/oms/db/db.ts';
import { zbudujAplikacje } from '../../src/core/aplikacja.ts';
import { createRepozytoriumKanalow } from '../../src/moduly/kanaly/repozytorium-kanalow.ts';
import { usunKonfiguracjeIntegracji, wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji } from '../../src/oms/db/konfiguracja-integracji.js';
import { wczytajTokeny, zapiszTokeny } from '../../src/oms/db/tokeny.js';
import { przypnijSejf, sejfZEnv, ZMIENNA_KLUCZA } from '../../src/core/bezpieczenstwo/sejf-sekretow.js';
import { utworzBazeDemo } from '../../scripts/demo-dane.mjs';
import { powiazProdukt } from '../../src/oms/db/magazyn.js';

const PRYWATNY = path.join(os.homedir(), '.allegro-sandbox-e3');
const PLIK_TOKENOW = path.join(PRYWATNY, 'tokeny.json');
const KAT = path.join(PRYWATNY, 'd2');
const BAZA = path.join(KAT, 'oms.sqlite');
const BAZA_PROBY = '/srv/oms-proba/dane/oms.sqlite';
const DEVICE = 'allegro_aplikacja_device:sandbox';
const TMP = '/srv/praca/kierownik-petla/tmp/160-e4-d2';
const ODP = path.join(TMP, 'odpowiedzi');
const WYNIKI = path.join(TMP, 's');
const HTTP = path.join(TMP, 'http.jsonl');
const STAN = path.join(TMP, 'stan.json');
const OFERTY = ['7782543277', '7782543278', '7782543279', '7782543286', '7782543280'];
const OBJETE = ['7782543277', '7782543279', '7782543286']; // 277 = przejęta (K1), 279 i 286 = przejęte zamiast wystawionych
const WOO = 'polcien';
const ERLI = 'erli_polcien';
const FAZA = process.argv[2] ?? 'stan';
const AKTOR = { id: 0, login: 'dowod' };
// Klucz poświadczeń przed czymkolwiek innym (brak albo zła postać = BladKonfiguracji). Ten sam dla bazy piaskownicy
// (odczyt aplikacji Device) i bazy dowodu. Wartość nie trafia nigdzie poza środowisko tego procesu.
const SEJF = sejfZEnv(process.env);
const KLUCZ_ENV = { [ZMIENNA_KLUCZA]: process.env[ZMIENNA_KLUCZA] };

for (const k of [KAT]) fs.mkdirSync(k, { recursive: true, mode: 0o700 });
for (const k of [ODP, WYNIKI]) fs.mkdirSync(k, { recursive: true });
const spij = (ms) => new Promise((r) => setTimeout(r, ms));
const czytajStan = () => { try { return JSON.parse(fs.readFileSync(STAN, 'utf8')); } catch { return {}; } };
const zapiszStan = (z) => fs.writeFileSync(STAN, JSON.stringify({ ...czytajStan(), ...z }, null, 1));
let KLUCZ = czytajStan().klucz ?? null;

// ——— Czyszczenie odpowiedzi: dane osobowe i wszystko, co wygląda na poświadczenie, nie trafia do tmp ———
const WYTNIJ = new Set(['login', 'taxId', 'email', 'phone', 'phoneNumber', 'firstName', 'lastName', 'street', 'zipCode', 'postCode',
  'companyName', 'address', 'buyer', 'seller', 'Authorization', 'authorization', 'access_token', 'refresh_token', 'clientSecret', 'clientId']);
const PODEJRZANE = /Bearer\s|access_token|refresh_token|clientSecret|eyJ[A-Za-z0-9_-]{12,}/;
function czysc(v) {
  if (Array.isArray(v)) return v.map(czysc);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, w]) => [k, WYTNIJ.has(k) ? '[wycięte]' : czysc(w)]));
  return v;
}
function bezpiecznie(obj) {
  const t = JSON.stringify(czysc(obj), null, 1);
  return PODEJRZANE.test(t) ? JSON.stringify({ pominieto: 'treść wyglądała na poświadczenie' }) : t;
}

// ——— Jedyny fetch procesu: tylko Allegro Sandbox, z licznikami i zapisem odpowiedzi ———
const liczniki = [];
let ostatnie = 0, nr = 0, etap = 'oms';
const AWARIA = FAZA === 'restart';
let awariaTrafiona = false;
const rodzaj = (m, p) => m === 'PUT' && p.includes('/offer-quantity-change-commands/') ? 'putIlosci'
  : m === 'PUT' && p.includes('/offer-publication-commands/') ? 'putPublikacji'
  : p.includes('/offer-price-change-commands/') && m === 'PUT' ? 'putCeny'
  : /commands\/[^/]+\/tasks/.test(p) ? 'zadania'
  : p.includes('/pricing/offer-fee-preview') || p.includes('/pricing/fee-preview') ? 'podgladOplat'
  : p.includes('/auth/') ? 'auth'
  : ['POST', 'PATCH', 'DELETE', 'PUT'].includes(m) ? 'innyZapis' : 'odczyt';
async function fetchDowodu(u, init = {}) {
  const url = new URL(u instanceof Request ? u.url : String(u));
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.allegrosandbox.pl')) {
    fs.appendFileSync(HTTP, JSON.stringify({ t: new Date().toISOString(), faza: FAZA, STOP: 'zakazany host', host: url.hostname }) + '\n');
    throw new Error(`dowód 2: zakazany host ${url.hostname}`);
  }
  const czekaj = ostatnie + 600 - Date.now();
  if (czekaj > 0) await spij(czekaj);
  ostatnie = Date.now();
  const metoda = String(init?.method ?? (u instanceof Request ? u.method : 'GET')).toUpperCase();
  const auth = url.pathname.includes('/auth/');
  const t0 = Date.now();
  const r = await fetch(u, init);
  const wpis = { t: new Date().toISOString(), faza: FAZA, etap, metoda, host: url.hostname, sciezka: url.pathname,
    zapytanie: auth ? '' : url.search, status: r.status, ms: Date.now() - t0, rodzaj: rodzaj(metoda, url.pathname) };
  liczniki.push(wpis);
  if (!auth) {
    let odp = null;
    try { const t = await r.clone().text(); odp = t ? JSON.parse(t) : null; } catch { odp = '[nie-JSON]'; }
    let zad = null;
    if (typeof init?.body === 'string') { try { zad = JSON.parse(init.body); } catch { zad = '[nie-JSON]'; } }
    const istotne = wpis.rodzaj !== 'odczyt' || /\/sale\/product-offers\/\d+$/.test(url.pathname);
    if (istotne) {
      nr++;
      const plik = `${FAZA}-${String(nr).padStart(3, '0')}-${metoda}-${url.pathname.replace(/[^a-z0-9]+/gi, '_').slice(0, 80)}.json`;
      const tekst = bezpiecznie({ metoda, sciezka: url.pathname, status: r.status, zadanie: zad, odpowiedz: odp });
      fs.writeFileSync(path.join(ODP, plik), tekst.length > 40000 ? tekst.slice(0, 40000) + '\n…[ucięte]' : tekst);
      wpis.plik = plik;
    }
  }
  fs.appendFileSync(HTTP, JSON.stringify(wpis) + '\n');
  if (AWARIA && wpis.rodzaj === 'putIlosci' && !awariaTrafiona) {
    awariaTrafiona = true;
    fs.appendFileSync(HTTP, JSON.stringify({ t: new Date().toISOString(), faza: FAZA, AWARIA: 'exit(9) po odpowiedzi PUT, przed odczytem zadań', sciezka: url.pathname }) + '\n');
    zapiszStan({ awariaKomenda: url.pathname.split('/').at(-1) });
    process.exit(9);
  }
  return r;
}
const podsumujLiczniki = (od = 0, tylkoEtap = null) => {
  const w = {};
  for (const l of liczniki.slice(od)) if (!tylkoEtap || l.etap === tylkoEtap) w[l.rodzaj] = (w[l.rodzaj] ?? 0) + 1;
  return w;
};

// ——— Tokeny: z pliku do bazy na starcie, z bazy do pliku na wyjściu (zawsze) ———
function wczytajTokenyDoBazy(db) {
  const t = JSON.parse(fs.readFileSync(PLIK_TOKENOW, 'utf8'));
  zapiszTokeny(db, KLUCZ, { accessToken: t.access_token, refreshToken: t.refresh_token, wygasaAt: t.wygasa_at,
    refreshWygasaAt: new Date(Date.now() + 80 * 86400000).toISOString() }, undefined);
}
function wczytajAplikacjeDevice(db) {
  // Baza piaskownicy tylko do odczytu, z przypiętym kluczem piaskownicy; wiersz nieczytelny = BladSekretow.
  const p = przypnijSejf(new DatabaseSync(BAZA_PROBY, { readOnly: true }), SEJF);
  try {
    const w = wczytajKonfiguracjeIntegracji(p, DEVICE);
    if (!w) throw new Error('brak aplikacji Device w bazie piaskownicy');
    zapiszKonfiguracjeIntegracji(db, DEVICE, { ustawienia: w.ustawienia, sekrety: w.sekrety });
  } finally { p.close(); }
}
let oddane = false;
function oddajTokeny() {
  if (oddane || !KLUCZ || !fs.existsSync(BAZA)) return;
  oddane = true;
  let db;
  try {
    db = przypnijSejf(new DatabaseSync(BAZA), SEJF);
    const w = wczytajTokeny(db, KLUCZ);
    if (w?.access_token && w?.refresh_token) {
      const stary = JSON.parse(fs.readFileSync(PLIK_TOKENOW, 'utf8'));
      const zmiana = stary.refresh_token !== w.refresh_token || stary.access_token !== w.access_token;
      const nowe = { ...stary, access_token: w.access_token, refresh_token: w.refresh_token,
        wygasa_at: new Date(w.wygasa_at).toISOString(), zapisano_at: zmiana ? new Date().toISOString() : stary.zapisano_at };
      const tmp = PLIK_TOKENOW + '.nowy';
      fs.writeFileSync(tmp, JSON.stringify(nowe, null, 1), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, PLIK_TOKENOW);
      fs.appendFileSync(HTTP, JSON.stringify({ t: new Date().toISOString(), faza: FAZA, tokeny: zmiana ? 'oddane (zmienione)' : 'bez zmian' }) + '\n');
    }
    db.prepare('DELETE FROM tokeny_kanalu WHERE kanal = ?').run(KLUCZ);
    usunKonfiguracjeIntegracji(db, DEVICE);
  } catch (e) {
    fs.appendFileSync(HTTP, JSON.stringify({ t: new Date().toISOString(), faza: FAZA, tokeny: 'BŁĄD oddania', blad: e?.name ?? 'Error' }) + '\n');
  } finally { try { db?.close(); } catch { /* nic */ } }
}
process.on('exit', oddajTokeny);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(130));

// ——— Aplikacja ———
async function zbuduj() {
  const katalog = path.join(KAT, 'pliki');
  for (const k of ['proformy', 'etykiety']) fs.mkdirSync(path.join(katalog, k), { recursive: true });
  const env = { ...(await envDemo()), ...KLUCZ_ENV, OMS_PROBA_ALLEGRO_SANDBOX: 'tak', OMS_DB_PATH: BAZA,
    OMS_PROFORMY_KATALOG: path.join(katalog, 'proformy'), OMS_ETYKIETY_KATALOG: path.join(katalog, 'etykiety') };
  const plan = przygotujUruchomienieSandbox(env, { srodowisko: 'sandbox' }, fetchDowodu);
  const licznik = createLicznik();
  let uslugi = null;
  const moduly = plan.moduly.map((m) => m.nazwa !== 'kanaly' ? m : { ...m, zbuduj: (ctx) => {
    const z = m.zbuduj(ctx);
    uslugi = z.uslugi;
    z.uslugi.klienciSklepow = licznik.owinMape(z.uslugi.klienciSklepow);
    return z;
  } });
  // Kontrola klucza przed otwarciem, potem sejf przypięty do uchwytu (wspólne wejście ścieżek startu).
  const db = otworzBazeStartu(env, BAZA, { moduly, bezKataloguBazy: true });
  if (KLUCZ) { wczytajAplikacjeDevice(db); wczytajTokenyDoBazy(db); }
  const aplikacja = await zbudujAplikacje({ moduly, env, db, nadpisania: plan.nadpisania(db), log: () => {} });
  const zegary = new Map(aplikacja.zegary.map((z) => [z.nazwa, z]));
  const auth = { authorization: `Basic ${Buffer.from(`${env.OMS_USER}:${env.OMS_PASS}`).toString('base64')}`, origin: 'http://localhost' };
  const get = (url) => aplikacja.app.inject({ method: 'GET', url, headers: auth });
  const post = (url, payload = {}) => aplikacja.app.inject({ method: 'POST', url, payload, headers: auth });
  const klient = () => uslugi.klienciKanalow[KLUCZ];
  const zamknij = async () => { await aplikacja.app.close(); db.close(); };
  return { db, env, aplikacja, zegary, licznik, get, post, klient, zamknij };
}

const tekst = (html) => (/<main[\s\S]*?<\/main>/.exec(html)?.[0] ?? html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();
const token = (html) => /name="podglad" value="([^"]+)"/.exec(html)?.[1] ?? null;
const typKanalu = (k) => k === WOO ? 'woo' : k.startsWith('erli') ? 'erli' : 'allegro';
const objeta = (o) => o.tryb === 'zarzadzana' || (o.tryb === 'obserwowana' && o.ilosc_z_oms);

/** Odczyt ofert sandboxa przez klienta OMS (GET product-offers) — etap „dowod”, nie liczy się do zapisów OMS. */
async function ofertySandbox(a, ids = OFERTY) {
  const poprzedni = etap; etap = 'dowod';
  try {
    const w = {};
    for (const id of ids) {
      try { const o = await a.klient().pobierzOferte(id); w[id] = { status: o?.publication?.status ?? null, ilosc: o?.stock?.available ?? null }; }
      catch (e) { w[id] = { blad: String(e?.message ?? e).slice(0, 200) }; }
    }
    return w;
  } finally { etap = poprzedni; }
}
async function odczytKanalu(a, o, sandbox) {
  const typ = typKanalu(o.kanal);
  if (o.kanal === KLUCZ) return sandbox[o.id_zewnetrzne] ?? { ilosc: null, status: null };
  if (typ === 'erli') {
    const w = a.db.prepare("SELECT dane_json FROM atrapa_erli_stan WHERE kanal = ? AND rodzaj = 'produkt' AND id = ?").get(o.kanal, o.id_zewnetrzne);
    const p = w ? JSON.parse(w.dane_json) : null;
    return { ilosc: p?.stock ?? null, status: p?.status ?? null };
  }
  if (typ === 'woo') {
    const woo = createAtrapaWoo({ db: a.db, kanal: o.kanal, env: a.env, log: () => {} });
    const [produkt, wariant] = String(o.id_zewnetrzne).split('/');
    const lista = wariant ? await woo.pobierzStanyWariantow(Number(produkt), [Number(wariant)]) : await woo.pobierzStany([Number(produkt)]);
    return { ilosc: lista[0]?.stock_quantity ?? null, status: lista[0]?.status ?? null };
  }
  return { ilosc: null, status: 'atrapa-allegro-pominieta' };
}
/** Karty dowodu (1–3) we wszystkich trzech kanałach: cel OMS (D51) i odczyt kanału. */
async function bilans(a) {
  const karty = czytajStan().karty ?? [];
  const sandbox = await ofertySandbox(a, OBJETE);
  const migawka = migawkaStanow(a.db);
  const bufor = new Map(a.db.prepare('SELECT klucz, bufor_szt FROM oferty_ustawienia_kont').all().map((w) => [w.klucz, Number(w.bufor_szt ?? 0)]));
  const stala = new Map(a.db.prepare('SELECT klucz, stala_ilosc FROM oferty_ustawienia_kont').all().map((w) => [w.klucz, w.stala_ilosc]));
  const wiersze = [];
  const oferty = a.db.prepare(`SELECT * FROM oferty_kanalow WHERE kanal IN (?, ?, ?) AND karta_id IN (${karty.map(() => '?').join(',') || 'NULL'}) ORDER BY karta_id, kanal`)
    .all(KLUCZ, WOO, ERLI, ...karty);
  for (const o of oferty) {
    const cel = objeta(o) ? iloscDlaKanalu({ migawka, kartaId: Number(o.karta_id), tryb: o.tryb, iloscZOms: o.ilosc_z_oms,
      bufor: bufor.get(o.kanal) ?? 0, stalaIlosc: stala.get(o.kanal) ?? null }) : { ilosc: null, powod: 'nieobjeta' };
    const k = await odczytKanalu(a, o, sandbox);
    wiersze.push({ oferta: Number(o.id), kanal: o.kanal === KLUCZ ? 'SANDBOX' : o.kanal, ext: o.id_zewnetrzne, karta: Number(o.karta_id),
      tryb: o.tryb, zOms: o.ilosc_z_oms, cel: cel.ilosc, powod: cel.powod, odczyt: k.ilosc, status: k.status,
      problem: o.ilosc_problem_json ? JSON.parse(o.ilosc_problem_json)?.kod ?? 'tak' : null, wToku: o.ilosc_w_toku_json ? 1 : 0,
      znacznik: o.wyslane_pola_json ? o.wyslane_pola_json.slice(0, 160) : null });
  }
  return wiersze;
}
/** n przebiegów pętli (opcjonalnie najpierw puls pollera — D64) z pauzą na zadania Allegro. */
async function przebiegi(a, n, { poller = false, pauza = 6000 } = {}) {
  const wynik = [];
  for (let i = 0; i < n; i++) {
    const startL = a.licznik.od(), startH = liczniki.length;
    if (poller) {
      uruchomPulsPollerow({ db: a.db, env: a.env, zrodla: definicjeKanalow(a.env).map((d) => d.klucz) })();
      await a.zegary.get('poller').przebieg();
    }
    const petle = [];
    for (const n of PETLE) if (a.zegary.has(n)) { petle.push(n); await a.zegary.get(n).przebieg(); }
    const atrapy = a.licznik.zapisyOd(startL).map((z) => `${z.kanal}.${z.metoda}`);
    wynik.push({ i, petle: petle.length, sandbox: podsumujLiczniki(startH, 'oms'), atrapy,
      wToku: a.db.prepare('SELECT COUNT(*) n FROM oferty_kanalow WHERE kanal = ? AND ilosc_w_toku_json IS NOT NULL').get(KLUCZ).n });
    if (i < n - 1) await spij(pauza);
  }
  return wynik;
}
/** Przebiegi aż nic nie jest w toku i ostatni przebieg nie pisał do sandboxa (najwyżej `maks`). */
async function doSpokoju(a, maks = 6, opcje = {}) {
  const w = [];
  for (let i = 0; i < maks; i++) {
    const [p] = await przebiegi(a, 1, i === 0 ? opcje : { ...opcje, poller: false });
    w.push(p);
    const pisal = (p.sandbox.putIlosci ?? 0) + (p.sandbox.putPublikacji ?? 0) + p.atrapy.length;
    if (!pisal && !p.wToku && i > 0) break;
    await spij(opcje.pauza ?? 6000);
  }
  return w;
}
const problemySandbox = (a) => a.db.prepare('SELECT id, id_zewnetrzne, ilosc_problem_json FROM oferty_kanalow WHERE kanal = ? AND ilosc_problem_json IS NOT NULL').all(KLUCZ)
  .map((w) => ({ id: w.id, ext: w.id_zewnetrzne, kod: JSON.parse(w.ilosc_problem_json)?.kod ?? null }));
const stanKarty = (a, karta) => iloscDlaKanalu({ migawka: migawkaStanow(a.db), kartaId: Number(karta), tryb: 'zarzadzana', iloscZOms: 1, bufor: 0, stalaIlosc: null }).ilosc;
const ruch = async (a, karta, rodzaj, ilosc, powod) => {
  const r = await a.post(`/magazyn/${karta}/ruch`, { rodzaj, ilosc: String(ilosc), powod, klucz: `dowod2-${randomUUID().replaceAll("-", "")}` });
  return { kod: r.statusCode, blad: r.statusCode >= 400 ? tekst(r.body).slice(0, 300) : null };
};
const ofertaSandbox = (a, ext) => a.db.prepare('SELECT * FROM oferty_kanalow WHERE kanal = ? AND id_zewnetrzne = ?').get(KLUCZ, ext);

// ——— Fazy ———
const FAZY = {
  async przygotuj() {
    const w = {};
    if (fs.existsSync(BAZA)) throw new Error('baza dowodu już istnieje — usuń ~/.allegro-sandbox-e3/d2 ręcznie, jeśli to świadomy restart');
    // Jak utworzDemo z dowod-e4.mjs, ale z kluczem poświadczeń w env generatora (zapisuje sekret ERLI warstwą).
    await utworzBazeDemo({ baza: BAZA, dzis: new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' }), env: { ...(await envDemo()), ...KLUCZ_ENV } });
    let a = await zbuduj();
    const repo = createRepozytoriumKanalow({ db: a.db, definicjeEnv: [], konfiguracjaEnv: {} });
    const od = new Date(); od.setUTCHours(0, 0, 0, 0);
    const s = repo.utworzSzkic({ nazwa: 'Sandbox dowód 2', odUtc: od.toISOString().replace(/\.\d{3}Z$/, '.000Z'), srodowisko: 'sandbox' }, AKTOR);
    if (!s.ok) throw new Error('szkic konta: ' + JSON.stringify(s).slice(0, 200));
    const z = repo.zapiszZmiane(s.dane.klucz, s.dane.wersja, { autoryzacja: 'polaczone', kontoId: '111663487', aplikacja: 'device', pobieranie: 'wlaczone' }, AKTOR);
    if (!z.ok) throw new Error('konto: ' + JSON.stringify(z).slice(0, 200));
    KLUCZ = s.dane.klucz;
    const karty = a.db.prepare('SELECT id FROM karty_produktow WHERE coalesce(wycofana, 0) = 0 ORDER BY id LIMIT 3').all().map((k) => Number(k.id));
    zapiszStan({ klucz: KLUCZ, karty, mapa: Object.fromEntries(OBJETE.map((o, i) => [o, karty[i]])) });
    await a.zamknij();
    w.oferty = await wlaczOferty({ baza: BAZA, konta: [...KONTA_DEMO, KLUCZ] });
    w.erli = await zasiej({ baza: BAZA, karty: 3, kanal: ERLI });
    a = await zbuduj();
    w.wejscie = await ofertySandbox(a);
    zapiszStan({ wejscie: w.wejscie });
    // Lustro: odczyt katalogu konta w tle; czekamy na wiersze sandboxa.
    w.odswiez = (await a.post('/magazyn/odswiez', { konto: KLUCZ })).statusCode;
    for (let i = 0; i < 40; i++) {
      if (a.db.prepare('SELECT COUNT(*) n FROM produkty_sklepowe WHERE kanal = ?').get(KLUCZ).n >= 3) break;
      await spij(3000);
    }
    w.lustro = a.db.prepare('SELECT id, produkt_id, wariant_id, karta_id, stan_prowadzony FROM produkty_sklepowe WHERE kanal = ? ORDER BY produkt_id').all(KLUCZ);
    const mapa = czytajStan().mapa;
    w.powiazania = [];
    for (const [ext, karta] of Object.entries(mapa)) {
      const p = w.lustro.find((r) => String(r.produkt_id) === ext);
      if (p) { powiazProdukt(a.db, p.id, karta, { konto: AKTOR }); w.powiazania.push({ ext, karta }); }
    }
    // Wystawienie dwóch kart przez OMS: tylko podgląd; blokada = linia raportu, dalej trzy przejęte (decyzja 4).
    const pw = await a.post('/magazyn/oferty/podglad', { konto: KLUCZ, zaznaczone: karty.slice(1).map(String) });
    w.wystawienie = { kod: pw.statusCode, token: Boolean(token(pw.body)), tekst: tekst(pw.body).slice(0, 900) };
    w.przelacz = (await a.post('/ustawienia/magazyn/stany', { wlacz: '1' })).statusCode;
    // Przejęcie (podgląd → zatwierdź) i objęcie trzech ofert sandboxa oraz Woo.
    w.przejecie = [];
    for (const konto of [KLUCZ, WOO]) {
      const p = await a.post('/magazyn/stany/kanaly/przejecie', { konto });
      const t = token(p.body);
      const zt = t ? await a.post('/magazyn/stany/kanaly/przejecie', { konto, zatwierdz: '1', podglad: t }) : null;
      w.przejecie.push({ konto: konto === KLUCZ ? 'SANDBOX' : konto, podglad: p.statusCode, zatwierdz: zt?.statusCode ?? null, blad: t ? null : tekst(p.body).slice(0, 400) });
    }
    w.ofertySandbox = a.db.prepare('SELECT id, id_zewnetrzne, karta_id, tryb, stan FROM oferty_kanalow WHERE kanal = ? ORDER BY id_zewnetrzne').all(KLUCZ);
    const karty3 = new Set(karty);
    w.objecie = [];
    for (const konto of [KLUCZ, WOO]) {
      const lista = await a.post('/magazyn/stany/kanaly/przejecie', { konto });
      const naEkranie = new Set([...lista.body.matchAll(/name="zaznaczone" value="(\d+)"/g)].map((m) => Number(m[1])));
      const ids = a.db.prepare('SELECT id, id_zewnetrzne, karta_id FROM oferty_kanalow WHERE kanal = ?').all(konto)
        .filter((o) => naEkranie.has(Number(o.id)) && karty3.has(Number(o.karta_id)) && (konto !== KLUCZ || OBJETE.includes(String(o.id_zewnetrzne))))
        .map((o) => String(o.id));
      const p = await a.post('/magazyn/stany/kanaly/objecie', { konto, zaznaczone: ids });
      const zt = await a.post('/magazyn/stany/kanaly/objecie', { konto, zaznaczone: ids, zatwierdz: '1', podglad: token(p.body) });
      w.objecie.push({ konto: konto === KLUCZ ? 'SANDBOX' : konto, naEkranie: naEkranie.size, objete: ids.length, zatwierdz: zt.statusCode,
        blad: zt.statusCode >= 400 ? tekst(zt.body).slice(0, 300) : null,
        zFlaga: a.db.prepare('SELECT COUNT(*) n FROM oferty_kanalow WHERE kanal = ? AND ilosc_z_oms = 1').get(konto).n });
    }
    // Stan otwarcia → podgląd → zatwierdź.
    const o = await a.post('/magazyn/stany/otwarcie/odczytaj', {});
    const pola = Object.fromEntries([...o.body.matchAll(/name="(ilosc_\d+)" value="(\d*)"/g)].map((m) => [m[1], m[2] === '' ? '6' : m[2]]));
    const zo = await a.post('/magazyn/stany/otwarcie/zapisz', { podglad: token(o.body), ...pola });
    w.otwarcie = { odczytaj: o.statusCode, zapisz: zo.statusCode, karty: Object.fromEntries(karty.map((k) => [k, pola[`ilosc_${k}`] ?? null])),
      blad: zo.statusCode >= 400 ? tekst(zo.body).slice(0, 300) : null };
    const pg = await a.get('/magazyn/stany/kanaly/podglad');
    const zz = await a.post('/magazyn/stany/kanaly/zatwierdz', { podglad: token(pg.body) });
    w.zatwierdz = { podglad: pg.statusCode, zatwierdz: zz.statusCode, tekst: tekst(pg.body).replace(/^.*?Podgląd stanów/, 'Podgląd stanów').slice(0, 700) };
    w.przebiegi = await doSpokoju(a, 6);
    w.bilans = await bilans(a);
    w.problemy = problemySandbox(a);
    return { a, w };
  },
  /** Puls pollera (D64) + przebiegi do spokoju — podwyżki czekające na „brak-pollera” po stanie otwarcia. */
  async spokoj() {
    const a = await zbuduj();
    const w = { przed: await bilans(a) };
    await spij(Number(process.argv[3] ?? 0) * 1000);
    w.przebiegi = await doSpokoju(a, 6, { poller: true });
    w.po = await bilans(a);
    w.problemy = problemySandbox(a);
    return { a, w };
  },
  async kup() {
    const a = await zbuduj();
    // Karta 2 (oferta 279): karta 1 demo ma stan 0 i nie ma objętej oferty Woo — jej zero dał już stan otwarcia.
    const karta = czytajStan().karty[1];
    const w = { przed: await bilans(a) };
    const z = await createZakup({ db: a.db, env: a.env, log: () => {} }).kup({ kanal: WOO, karta, ilosc: 2 });
    zapiszStan({ zamowienie: z.zamowienieId });
    w.zakup = z;
    w.przebiegi = await doSpokoju(a, 6, { poller: true });
    w.po = await bilans(a);
    return { a, w };
  },
  async anuluj() {
    const a = await zbuduj();
    const w = { przed: await bilans(a) };
    w.anulowanie = await createZakup({ db: a.db, env: a.env, log: () => {} }).anuluj({ zamowienie: czytajStan().zamowienie });
    w.przebiegi = await doSpokoju(a, 6, { poller: true });
    w.po = await bilans(a);
    return { a, w };
  },
  async zero() {
    const a = await zbuduj();
    const karta = czytajStan().karty[0];
    const w = { stan: stanKarty(a, karta) };
    w.ruch = await ruch(a, karta, 'korekta', -w.stan, 'dowód 2: cel 0');
    w.stanPo = stanKarty(a, karta);
    w.przebiegi = await doSpokoju(a, 6, { pauza: 8000 });
    w.po = await bilans(a);
    w.oferta277 = (({ stan, tryb, wyslane_pola_json, ilosc_problem_json }) => ({ stan, tryb, wyslane_pola_json, ilosc_problem_json }))(ofertaSandbox(a, '7782543277'));
    return { a, w };
  },
  async przyjecie() {
    const a = await zbuduj();
    const karta = czytajStan().karty[0];
    const w = { ruch: await ruch(a, karta, 'przyjecie', 4, 'dowód 2: przyjęcie po zerze') };
    w.przebiegNatychmiast = await przebiegi(a, 1);
    await spij(130000); // D64: wznowienie po pulsie pollera (co 120 s na produkcji)
    w.przebiegi = await doSpokoju(a, 8, { poller: true, pauza: 9000 });
    await spij(16000);
    w.dobicie = await przebiegi(a, 2, { pauza: 8000 });
    w.po = await bilans(a);
    w.oferta277 = (({ stan, tryb, wyslane_pola_json, ilosc_problem_json }) => ({ stan, tryb, wyslane_pola_json, ilosc_problem_json }))(ofertaSandbox(a, '7782543277'));
    return { a, w };
  },
  async restart() {
    const a = await zbuduj();
    const karta = czytajStan().karty[1];
    // Zejście idzie od razu (podniesienie Allegro czeka na puls pollera, D64), więc awarię łapiemy na korekcie w dół.
    const [rodzaj, ilosc] = process.argv[3] === 'przyjecie' ? ['przyjecie', 1] : ['korekta', -2];
    const w = { ruch: await ruch(a, karta, rodzaj, ilosc, 'dowód 2: restart') };
    fs.writeFileSync(path.join(WYNIKI, 'restart.json'), JSON.stringify(w, null, 1));
    w.przebiegi = await przebiegi(a, 1); // proces kończy się exit(9) w fetchDowodu po odpowiedzi PUT
    return { a, w: { ...w, uwaga: 'awaria nie trafiła — brak PUT ilości' } };
  },
  async restart2() {
    const a = await zbuduj();
    const s = czytajStan();
    const o = ofertaSandbox(a, '7782543279');
    const w = { komendaPrzedAwaria: s.awariaKomenda, wTokuPoRestarcie: o.ilosc_w_toku_json ? JSON.parse(o.ilosc_w_toku_json) : null };
    w.przebiegi = await doSpokoju(a, 4);
    w.po = await bilans(a);
    return { a, w };
  },
  async d14() {
    const a = await zbuduj();
    const w = { wylacz: (await a.post('/ustawienia/magazyn/stany', { wlacz: '0', rozumiem: '1' })).statusCode };
    w.przebiegi = await przebiegi(a, 3, { pauza: 6000 });
    w.problemy = problemySandbox(a);
    w.po = await bilans(a);
    return { a, w };
  },
  async przywroc() {
    const a = await zbuduj();
    const wej = czytajStan().wejscie;
    etap = 'dowod';
    const w = { przed: await ofertySandbox(a), kroki: [] };
    const k = a.klient();
    const czekajNa = async (typ, id, ms) => { await spij(ms); return k.wynikKomendy(typ, id); };
    for (const id of OFERTY) {
      const cel = wej[id], teraz = w.przed[id];
      if (!cel || cel.blad || !teraz || teraz.blad) continue;
      if (teraz.ilosc !== cel.ilosc && cel.ilosc > 0) {
        const c = randomUUID(); await k.komendaIlosci(c, [{ ofertaId: id, ilosc: cel.ilosc }]);
        w.kroki.push({ id, krok: `FIXED ${cel.ilosc}`, zadania: (await czekajNa('ilosc', c, 5000))?.tasks?.map((t) => t.status) ?? null });
      }
      if (teraz.status !== cel.status && (cel.status === 'ENDED' || cel.status === 'ACTIVE')) {
        const c = randomUUID(); await k.komendaPublikacji(c, [id], cel.status === 'ENDED' ? 'END' : 'ACTIVATE');
        w.kroki.push({ id, krok: cel.status === 'ENDED' ? 'END' : 'ACTIVATE', zadania: (await czekajNa('publikacja', c, cel.status === 'ENDED' ? 5000 : 16000))?.tasks?.map((t) => t.status) ?? null });
      }
    }
    await spij(3000);
    w.wyjscie = await ofertySandbox(a);
    w.zgodne = OFERTY.every((id) => w.wyjscie[id]?.status === wej[id]?.status && w.wyjscie[id]?.ilosc === wej[id]?.ilosc);
    zapiszStan({ wyjscie: w.wyjscie });
    return { a, w };
  },
  async stan() {
    const a = await zbuduj();
    return { a, w: { oferty: await ofertySandbox(a), bilans: await bilans(a), problemy: problemySandbox(a) } };
  },
};

async function main() {
  const f = FAZY[FAZA];
  if (!f) throw new Error(`nieznana faza ${FAZA}`);
  if (FAZA !== 'przygotuj' && !KLUCZ) throw new Error('najpierw faza przygotuj');
  const t0 = Date.now();
  const { a, w } = await f();
  const wynik = { faza: FAZA, czas_s: Math.round((Date.now() - t0) / 1000), sandboxOms: podsumujLiczniki(0, 'oms'), sandboxDowod: podsumujLiczniki(0, 'dowod'), ...w };
  fs.writeFileSync(path.join(WYNIKI, `${FAZA}.json`), JSON.stringify(wynik, null, 1));
  await a.zamknij();
  console.log(`${FAZA}: gotowe w ${wynik.czas_s} s; zapisy OMS do sandboxa ${JSON.stringify(wynik.sandboxOms)}; wynik ${path.join(WYNIKI, FAZA + '.json')}`);
}
main().then(() => process.exit(0), (e) => {
  const komunikat = String(e?.message ?? e).slice(0, 300);
  console.error(`${FAZA}: BŁĄD ${PODEJRZANE.test(komunikat) ? '[komunikat ukryty]' : komunikat}`);
  process.exit(1);
});
