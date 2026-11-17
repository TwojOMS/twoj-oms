// PRZ-160.E4 — dowód etapu 4, rozdz. 7.1 (atrapa), na lokalnej kopii bazy demo. Składa tę samą aplikację co
// piaskownica (deploy/proba/atrapy/index.mjs → modulyPiaskownicy) bez nasłuchu i bez zegarów, a przebiegi pętli
// wywołuje tymi samymi funkcjami `przebieg` zegarów modułu magazynu (petlaOfert, petlaOfertAllegro, petlaStanowWoo).
// Klientów kanałów (atrapy Woo/Allegro i klient ERLI z transportem atrapy) owija licznik wywołań — tak liczymy zapisy.
// `--repo` pozwala złożyć aplikację z innego drzewa (np. kodu bazowego po E3.30) na tej samej kopii bazy.
// Tylko OMS_TRYB=proba: nic stąd nie łączy się z prawdziwym kanałem.
//
//   node deploy/proba/dowod-e4.mjs demo --baza <plik> [--repo <drzewo>]          świeża baza demo generatorem drzewa
//   node deploy/proba/dowod-e4.mjs stany --baza <plik> --tryb puste|wlacz-wylacz  instalacja bez stanów (pkt 1)
//   node deploy/proba/dowod-e4.mjs przebiegi --baza <plik> [--repo <drzewo>] [--n 3]  liczniki zapisów atrap
//   node deploy/proba/dowod-e4.mjs czynne|zasiej|wystaw --baza <plik> …              przygotowanie bazy (patrz main)
//   node deploy/proba/dowod-e4.mjs scenariusz --baza <plik> --krok <krok> [--opcja wartość …]
//     kroki (dowod-e4-scenariusz.mjs): wlaczenie, bilans, przebiegi, ruch, kup, anuluj, akcja, atrapa, restart
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { wymagajTrybuProby } from './atrapy/tryb.mjs';

const TEN_REPO = fileURLToPath(new URL('../..', import.meta.url));
export const ZAPISY = {
  erli: ['zmienProdukty', 'zmienProdukt', 'utworzProdukt'],
  allegro: ['komendaIlosci', 'komendaCeny', 'komendaPublikacji', 'edytujOferte', 'utworzOferte'],
  woo: ['zapiszStanyHurtem', 'zapiszProdukt'],
};
const WSZYSTKIE_ZAPISY = new Set(Object.values(ZAPISY).flat());
export const PETLE = ['petlaOfert', 'petlaOfertAllegro', 'petlaStanowWoo'];

const zRepo = (repo, p) => import(pathToFileURL(path.join(repo, p)).href);

export async function envDemo(repo = TEN_REPO) {
  const { ENV_DEMO } = await zRepo(repo, 'scripts/demo-dane.mjs');
  // Konto serwisowe (Basic) działa, dopóki w bazie nie ma kont — demo ich nie zakłada; hasło losowe, nigdzie nie wypisywane.
  // Klucz poświadczeń z env wołającego (klucz piaskownicy z proba.env); bez niego start odmawia czytelnym zdaniem.
  const klucz = process.env.OMS_KLUCZ_SEKRETOW ? { OMS_KLUCZ_SEKRETOW: process.env.OMS_KLUCZ_SEKRETOW } : {};
  return { ...ENV_DEMO, ...klucz, OMS_USER: 'dowod', OMS_PASS: randomBytes(18).toString('base64url') };
}

export async function utworzDemo({ repo = TEN_REPO, baza }) {
  const env = await envDemo(repo);
  wymagajTrybuProby(env, 'dowód E4');
  const { utworzBazeDemo } = await zRepo(repo, 'scripts/demo-dane.mjs');
  const dzis = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
  await utworzBazeDemo({ baza, dzis, env });
  return { baza, dzis };
}

/** Licznik wywołań metod klientów kanałów: [{ kanal, metoda, zapis, args }]. */
export function createLicznik() {
  const wywolania = [];
  /** @type {{ kanal?: string, metoda?: string, faza?: 'przed'|'po', trafiona?: boolean }} */
  const awaria = {};
  const owinKlienta = (kanal, klient) => {
    if (!klient || typeof klient !== 'object') return klient;
    return new Proxy(klient, { get(cel, nazwa, odbiorca) {
      const w = Reflect.get(cel, nazwa, odbiorca);
      if (typeof w !== 'function' || typeof nazwa !== 'string') return w;
      return function (...args) {
        wywolania.push({ kanal, metoda: nazwa, zapis: WSZYSTKIE_ZAPISY.has(nazwa), args: JSON.parse(JSON.stringify(args ?? null)) });
        const wywolaj = () => w.apply(this === odbiorca ? cel : this, args);
        // Awaria (pkt 5, restart): pierwsze pasujące wywołanie nigdy nie wraca — „przed” atrapa go nie dostaje,
        // „po” atrapa je wykonuje, ale odpowiedź ginie. Proces „pada” w tej chwili; stan bazy zostaje jak w awarii.
        if (awaria.metoda === nazwa && awaria.kanal === kanal && !awaria.trafiona) {
          awaria.trafiona = true;
          return (awaria.faza === 'po' ? Promise.resolve(wywolaj()) : Promise.resolve()).then(() => new Promise(() => {}));
        }
        return wywolaj();
      };
    } });
  };
  const owinMape = (mapa) => mapa && new Proxy(mapa, { get(cel, kanal, odbiorca) {
    const k = Reflect.get(cel, kanal, odbiorca);
    return typeof kanal === 'string' ? owinKlienta(kanal, k) : k;
  } });
  const od = () => wywolania.length;
  const zapisyOd = (start = 0) => wywolania.slice(start).filter(w => w.zapis);
  const podsumuj = (start = 0) => {
    const wynik = {};
    for (const w of wywolania.slice(start)) {
      const k = `${w.kanal}.${w.metoda}`;
      wynik[k] = (wynik[k] ?? 0) + 1;
    }
    return wynik;
  };
  return { wywolania, awaria, owinMape, od, zapisyOd, podsumuj };
}

/** Aplikacja piaskownicy z drzewa `repo` na bazie `baza` (bez nasłuchu i bez zegarów); `app.inject` z kontem serwisowym. */
export async function zbuduj({ repo = TEN_REPO, baza, env, teraz }) {
  env ??= await envDemo(repo);
  const katalog = path.join(path.dirname(baza), `${path.basename(baza, '.sqlite')}-pliki`);
  for (const k of ['proformy', 'etykiety']) fs.mkdirSync(path.join(katalog, k), { recursive: true });
  env = { ...env, OMS_DB_PATH: baza, OMS_PROFORMY_KATALOG: path.join(katalog, 'proformy'),
    OMS_ETYKIETY_KATALOG: path.join(katalog, 'etykiety') };
  wymagajTrybuProby(env, 'dowód E4');
  const { modulyPiaskownicy, nadpisaniaPiaskownicy } = await zRepo(repo, 'deploy/proba/atrapy/index.mjs');
  const { openOmsDb, otworzBazeStartu } = await zRepo(repo, 'src/oms/db/db.ts');
  const { zbudujAplikacje } = await zRepo(repo, 'src/core/aplikacja.ts');
  const licznik = createLicznik();
  const logi = [];
  const log = (...t) => logi.push(t.join(' '));
  let db = null;
  const moduly = modulyPiaskownicy(env, { baza: () => db }).map((m) => m.nazwa !== 'kanaly' ? m : { ...m, zbuduj: (ctx) => {
    const z = m.zbuduj(ctx);
    // Ten sam obiekt usług, który moduł magazynu bierze przez ctx.usluga('kanaly', …) — tylko owinięte liczniki.
    z.uslugi.klienciKanalow = licznik.owinMape(z.uslugi.klienciKanalow);
    z.uslugi.klienciSklepow = licznik.owinMape(z.uslugi.klienciSklepow);
    return z;
  } });
  // Drzewo sprzed szyfrowania poświadczeń nie ma otworzBazeStartu — wtedy dawne otwarcie.
  db = otworzBazeStartu ? otworzBazeStartu(env, baza, { moduly, bezKataloguBazy: true }) : openOmsDb(baza, { moduly });
  const nadpisania = nadpisaniaPiaskownicy({ db, env, log });
  const aplikacja = await zbudujAplikacje({ moduly, env, db, nadpisania, log, ...(teraz ? { teraz } : {}) });
  const zegary = new Map(aplikacja.zegary.map(z => [z.nazwa, z]));
  const auth = { authorization: `Basic ${Buffer.from(`${env.OMS_USER}:${env.OMS_PASS}`).toString('base64')}`,
    origin: 'http://localhost' };
  const get = (url) => aplikacja.app.inject({ method: 'GET', url, headers: auth });
  const post = (url, payload = {}) => aplikacja.app.inject({ method: 'POST', url, payload, headers: auth });
  /** Jeden przebieg pętli = każdy zegar pętli ofert/stanów po kolei (zegar, którego drzewo nie ma, pomijamy). */
  async function przebieg() {
    const start = licznik.od();
    const byly = [];
    for (const n of PETLE) if (zegary.has(n)) { byly.push(n); await zegary.get(n).przebieg(); }
    return { petle: byly, zapisy: licznik.zapisyOd(start) };
  }
  const zamknij = async () => { await aplikacja.app.close(); db.close(); };
  return { db, env, aplikacja, zegary, licznik, logi, get, post, przebieg, zamknij };
}

/** Instalacja ze stanami wyłączonymi: `puste` — pusty `magazyn_przelaczenia`; `wlacz-wylacz` — dopisane wyłączenie. */
export async function ustawBezStanow({ baza, tryb }) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(baza);
  try {
    if (tryb === 'puste') db.exec('DELETE FROM magazyn_przelaczenia');
    else if (tryb === 'wlacz-wylacz') {
      const ost = db.prepare('SELECT wlaczone FROM magazyn_przelaczenia ORDER BY id DESC LIMIT 1').get();
      if (!ost || Number(ost.wlaczone) !== 1) throw new Error('dowód E4: oczekiwano ostatniego wiersza „włączone”');
      db.prepare("INSERT INTO magazyn_przelaczenia (wlaczone, konto_id, konto_login, utworzono_at) VALUES (0, NULL, 'dowod', ?)")
        .run(new Date(Date.now() - 86400000).toISOString());
    } else throw new Error('dowód E4: --tryb puste|wlacz-wylacz');
    return db.prepare('SELECT wlaczone, utworzono_at FROM magazyn_przelaczenia ORDER BY id').all();
  } finally { db.close(); }
}

export const KONTA_DEMO = ['allegro', 'allegro-outlet', 'erli_polcien', 'polcien'];
/** Oferty czynne na kontach (D24: domyślnie wstrzymane, wtedy pętle nic nie piszą i porównanie nic nie mówi). */
export async function wlaczOferty({ baza, konta = KONTA_DEMO }) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(baza);
  try {
    const at = new Date().toISOString();
    // Minimalne ustawienia ofert (stała ilość 5, wysyłka 2 dni, cennik, VAT 23) — bez nich podgląd ofert odmawia.
    for (const k of konta) db.prepare(`INSERT INTO oferty_ustawienia_kont (klucz, oferty_czynne, stala_ilosc, czas_wysylki_dni,
        cennik_dostaw, stawka_vat, zmieniono_at, aktor_login)
      VALUES (?, 1, 5, 2, 'Cennik demo', '23', ?, 'dowod') ON CONFLICT(klucz) DO UPDATE SET oferty_czynne = 1,
        stala_ilosc = coalesce(stala_ilosc, 5), czas_wysylki_dni = coalesce(czas_wysylki_dni, 2),
        cennik_dostaw = coalesce(cennik_dostaw, 'Cennik demo'), stawka_vat = coalesce(stawka_vat, '23'),
        zmieniono_at = excluded.zmieniono_at`).run(k, at);
    return db.prepare('SELECT klucz, oferty_czynne FROM oferty_ustawienia_kont ORDER BY klucz').all();
  } finally { db.close(); }
}

/** Wystawienie ofert jak użytkownik: POST /magazyn/oferty/podglad → zatwierdz (kod drzewa `repo`). */
export async function wystaw({ repo = TEN_REPO, baza, konto, karty = 4 }) {
  const a = await zbuduj({ repo, baza });
  try {
    const ids = a.db.prepare('SELECT id FROM karty_produktow WHERE coalesce(wycofana, 0) = 0 ORDER BY id LIMIT ?').all(karty).map(w => Number(w.id));
    const p = await a.post('/magazyn/oferty/podglad', { konto, zaznaczone: ids });
    const token = /name="podglad" value="([^"]+)"/.exec(p.body)?.[1];
    if (p.statusCode !== 200 || !token || process.env.DOWOD_TEKST) return { konto, ids, podglad: p.statusCode, tekst: p.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(-1500) };
    const z = await a.post('/magazyn/oferty/zatwierdz', { konto, zaznaczone: ids, podglad: token });
    const oferty = a.db.prepare('SELECT id, karta_id, stan, tryb FROM oferty_kanalow WHERE kanal = ? ORDER BY id').all(konto);
    return { konto, ids, podglad: p.statusCode, zatwierdz: z.statusCode, oferty };
  } finally { await a.zamknij(); }
}

/** Oferty ERLI już wystawione (rejestr OMS + produkt w atrapie ERLI ze stock 3 ≠ stała ilość 5): bez nich pętla ERLI
 * na danych demo nie ma czego pisać (karty demo bez ceny i zdjęć nie przejdą podglądu wystawienia). Funkcje drzewa `repo`. */
export async function zasiej({ repo = TEN_REPO, baza, karty = 3, kanal = 'erli_polcien' }) {
  const { DatabaseSync } = await import('node:sqlite');
  const { znakInstalacji } = await zRepo(repo, 'src/moduly/magazyn/services/oferty-wspolne.js');
  const { wstawOferte } = await zRepo(repo, 'src/oms/db/oferty-kanalow.ts');
  const db = new DatabaseSync(baza);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS atrapa_erli_stan (kanal TEXT NOT NULL, rodzaj TEXT NOT NULL, id TEXT NOT NULL,
      dane_json TEXT NOT NULL, PRIMARY KEY (kanal, rodzaj, id))`);
    const ids = db.prepare('SELECT id, nazwa FROM karty_produktow WHERE coalesce(wycofana, 0) = 0 ORDER BY id LIMIT ?').all(karty);
    const wynik = [];
    for (const k of ids) {
      db.prepare('UPDATE karty_produktow SET cena_gr = 12900 WHERE id = ?').run(k.id);
      if (!db.prepare('SELECT 1 FROM zdjecia_kart WHERE karta_id = ?').get(k.id)) db.prepare(`INSERT INTO zdjecia_kart
        (karta_id, kolejnosc, zrodlo, adres_zrodlowy, plik, sha256, typ, rozmiar, szerokosc, wysokosc, utworzono_at)
        VALUES (?, 1, 'url', ?, ?, ?, 'image/jpeg', 1000, 1200, 1200, ?)`).run(k.id, `https://zdjecia.example.invalid/k${k.id}.jpg`,
        `dowod-k${k.id}.jpg`, '0'.repeat(64), new Date().toISOString());
      const ext = `${znakInstalacji(db)}-K${k.id}`;
      const o = wstawOferte(db, { kartaId: Number(k.id), kanal, idZewnetrzne: ext, pochodzenie: 'oms', tryb: 'zarzadzana', stan: 'aktywna' });
      db.prepare('INSERT OR REPLACE INTO atrapa_erli_stan VALUES (?, ?, ?, ?)').run(kanal, 'produkt', ext,
        JSON.stringify({ externalId: ext, name: k.nazwa, price: 12900, stock: 3, status: 'active', frozen: {},
          externalCategories: [{ breadcrumb: [{ id: '101', name: 'Lampy' }] }] }));
      wynik.push({ oferta: o.id, karta: Number(k.id), ext });
    }
    return wynik;
  } finally { db.close(); }
}

export async function przebiegi({ repo = TEN_REPO, baza, n = 3 }) {
  const a = await zbuduj({ repo, baza });
  try {
    const wyniki = [];
    for (let i = 0; i < n; i++) {
      const p = await a.przebieg();
      wyniki.push({ przebieg: i + 1, petle: p.petle, zapisy: p.zapisy.length,
        wgMetody: Object.fromEntries(Object.entries(p.zapisy.reduce((m, z) => ({ ...m, [`${z.kanal}.${z.metoda}`]: (m[`${z.kanal}.${z.metoda}`] ?? 0) + 1 }), {}))) });
    }
    const zapisy = a.licznik.zapisyOd(0);
    return { repo, n, razem: zapisy.length, wyniki, zapisy, wywolania: a.licznik.podsumuj(0),
      logi: a.logi.slice(0, 60) };
  } finally { await a.zamknij(); }
}

function argumenty(lista) {
  const w = {};
  for (let i = 0; i < lista.length; i += 2) {
    if (!lista[i]?.startsWith('--') || lista[i + 1] === undefined) throw new Error(`dowód E4: niepoprawny argument „${lista[i]}”`);
    w[lista[i].slice(2)] = lista[i + 1];
  }
  return w;
}

export async function main(argv) {
  const [komenda, ...reszta] = argv;
  const a = argumenty(reszta);
  const repo = a.repo ? path.resolve(a.repo) : TEN_REPO;
  if (!a.baza) throw new Error('dowód E4: --baza <plik>');
  const baza = path.resolve(a.baza);
  if (komenda === 'demo') return utworzDemo({ repo, baza });
  if (komenda === 'stany') return ustawBezStanow({ baza, tryb: a.tryb });
  if (komenda === 'czynne') return wlaczOferty({ baza, konta: (a.konta ?? KONTA_DEMO.join(',')).split(',') });
  if (komenda === 'wystaw') return wystaw({ repo, baza, konto: a.konto, karty: Number(a.karty ?? 4) });
  if (komenda === 'zasiej') return zasiej({ repo, baza, karty: Number(a.karty ?? 3) });
  if (komenda === 'przebiegi') return przebiegi({ repo, baza, n: Number(a.n ?? 3) });
  if (komenda === 'scenariusz') return (await import('./dowod-e4-scenariusz.mjs')).scenariusz({ ...a, baza });
  throw new Error('Użycie: dowod-e4.mjs demo|stany|czynne|wystaw|zasiej|przebiegi|scenariusz --baza <plik> [--repo <drzewo>] [--n 3] [--tryb …] [--krok …]');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).then((w) => { console.log(JSON.stringify(w, null, 1)); process.exit(0); },
    (e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
}
