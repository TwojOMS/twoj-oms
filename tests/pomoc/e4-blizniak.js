// Test bliźniaczy: przy wyłączonych stanach pętle ofert ERLI i Allegro wysyłają
// do kanału DOKŁADNIE te same żądania, co przed obsługą stanów (nagranie w `tests/fixtures/e4-blizniak-*.json`).
//
// Jedna funkcja przygotowania na kanał (`przygotujErli`, `przygotujAllegro`) z parametrem `wariant`:
//   'i'   — brak wierszy przełącznika stanów (`magazyn_przelaczenia` puste),
//   'ii'  — włącz → (ruchy magazynowe) → wyłącz, bez `stany_zatwierdzenia`,
//   'iii' — DO DOPISANIA: włącz → zatwierdź (wiersz
//           `stany_zatwierdzenia` dla bieżącego przełączenia) → wyłącz. Dopisać gałąź
//           w `przygotujPrzelacznik` poniżej i 'iii' do `it.each` w tests/moduly/magazyn/wylaczone-stany-kanalow.test.js; nagranie to samo.
//
// Zegar stały (przesuwany ręcznie), znak instalacji z `losuj: () => 0`, UUID z atrapy `node:crypto` w teście
// i dodatkowo zastąpione w nagraniu kolejnymi `<uuid-N>` (UUID spoza żądań nie przesuwa numeracji).
// Żadnej sieci: ERLI — serwer w pamięci, Allegro — atrapa ofert (deploy/proba/atrapy) przez prawdziwy rejestr kanałów.
// Dane zmyślone: lampy „Pracownia Półcień”, SKU LMP-*.
import { DatabaseSync } from 'node:sqlite';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { modulyDla } from '../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../scripts/demo-dane.mjs';
import { eanDemo, kategoriaAllegroDemo, parametryKategoriiAllegroDemo } from '../../scripts/demo-dane-katalog.mjs';
import { opisKategorii } from '../../src/domena/tresc-oferty-allegro.js';
import { utworzKarte } from '../../src/oms/db/magazyn.js';
import { zapiszUstawieniaOfertKonta, wstawOferte, ofertaPoId } from '../../src/oms/db/oferty-kanalow.ts';
import { przelaczStany, dodajRuch } from '../../src/oms/db/stany-magazynowe.js';
import { znakInstalacji } from '../../src/moduly/magazyn/services/oferty-wspolne.js';
import { createErliClient } from '../../src/oms/erli/client.js';
import { createAllegroClient } from '../../src/oms/allegro/client.js';
import { katalogErli, katalogAllegro, wezlyAllegro } from '../../src/integracje/kanal-modul.ts';
import { createSerwerOfertAllegro, API_ATRAPY_ALLEGRO } from '../../deploy/proba/atrapy/allegro-oferty.mjs';
import { fixtureAllegro, daneAllegro, aktorAllegro } from './allegro-konfigurator.ts';
import { createRejestrKanalow } from '../../src/moduly/kanaly/services/rejestr-kanalow.ts';
import { createPetlaOfert } from '../../src/moduly/magazyn/services/petla-ofert.js';
import { createPetlaOfertAllegro } from '../../src/moduly/magazyn/services/petla-ofert-allegro.js';

export const WARIANTY = ['i', 'ii'];
export const T0 = Date.parse('2026-11-01T12:00:00.000Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

/** UUID atrapy `node:crypto` (test podstawia `randomUUID`): kolejne, przewidywalne. */
export function uuidZLicznika(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const WZOR_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Nagrywarka żądań: metoda, ścieżka z zapytaniem, surowa treść, numer przebiegu — w kolejności wysłania. */
function nagrywarka() {
  const zadania = [];
  const st = { przebieg: 0 };
  function zapisz(metoda, url, init) {
    if (!st.przebieg) return;
    const adres = new URL(url);
    const cialo = init?.body;
    let tresc = null;
    if (typeof cialo === 'string') tresc = cialo;
    else if (cialo instanceof Uint8Array) tresc = `<bajty ${Buffer.from(cialo).toString('hex')}>`;
    else if (cialo != null) tresc = `<${Object.prototype.toString.call(cialo)}>`;
    zadania.push({ przebieg: st.przebieg, metoda, sciezka: adres.pathname + adres.search, tresc });
  }
  /** Tekst nagrania (porównywany bajt w bajt): UUID zastąpione `<uuid-N>` według kolejności pojawienia się. */
  function tekst() {
    const numery = new Map();
    const zamien = (s) => (s == null ? s : s.replace(WZOR_UUID, (u) => {
      const k = u.toLowerCase();
      if (!numery.has(k)) numery.set(k, numery.size + 1);
      return `<uuid-${numery.get(k)}>`;
    }));
    const lista = zadania.map((z) => ({ ...z, sciezka: zamien(z.sciezka), tresc: zamien(z.tresc) }));
    return `${JSON.stringify(lista, null, 1)}\n`;
  }
  return { zadania, st, zapisz, tekst };
}

/** Wariant przełącznika stanów (Zasada 1). Wywoływane po zbudowaniu danych, przed nagrywanymi przebiegami. */
function przygotujPrzelacznik(db, wariant, kartyIds, czas) {
  if (wariant === 'i') return;
  if (wariant === 'ii') {
    const konto = { id: 1, login: 'admin' };
    przelaczStany(db, { wlacz: true, konto, at: iso(czas - 30 * MIN) });
    for (const [i, kartaId] of kartyIds.slice(0, 5).entries()) {
      dodajRuch(db, { kartaId, rodzaj: 'otwarcie', ilosc: 3 + i, klucz: `e4-blizniak-otwarcie-${kartaId}`, konto, at: iso(czas - 29 * MIN) });
    }
    przelaczStany(db, { wlacz: false, konto, at: iso(czas - 20 * MIN) });
    return;
  }
  // 'iii' — patrz nagłówek pliku: dopisać po E4.01 (zatwierdzenie między włączeniem a wyłączeniem).
  throw new Error(`e4-blizniak: nieznany wariant „${wariant}”`);
}

// ───────────────────────────── ERLI ─────────────────────────────

const KONTO_ERLI = 'erli-polcien';
export const KART_ERLI = 120;

/** Serwer ERLI w pamięci (kontrakt jak w petla-ofert.test.js) — tylko odpowiada, nagrywa nagrywarka. */
function serwerErli(nagr) {
  const produkty = new Map();
  const odp = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  async function fetchImpl(url, init) {
    nagr.zapisz(init.method, url, init);
    const sciezka = new URL(url).pathname.replace(/^\/api/, '');
    const metoda = init.method;
    const cialo = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : undefined;
    if (sciezka === '/products/_search' && metoda === 'POST') {
      const { limit = 100, after } = cialo?.pagination ?? {};
      const lista = [...produkty.values()].sort((a, b) => a.externalId.localeCompare(b.externalId))
        .filter((p) => after === undefined || p.externalId > after);
      return odp(200, lista.slice(0, limit));
    }
    if (sciezka === '/products/batch-update' && metoda === 'PATCH') {
      return odp(200, cialo.map((z) => {
        const p = produkty.get(z.externalId);
        if (!p) return { externalId: z.externalId, status: 400, polishMessage: 'Produkt nie istnieje' };
        produkty.set(z.externalId, { ...p, ...z });
        return { externalId: z.externalId, status: 202, updatedFields: Object.keys(z).filter((k) => k !== 'externalId') };
      }));
    }
    const id = decodeURIComponent(sciezka.replace(/^\/products\//, ''));
    if (metoda === 'GET') return produkty.has(id) ? odp(200, produkty.get(id)) : odp(404, { message: 'Not found' });
    if (metoda === 'POST') {
      if (produkty.has(id)) return odp(409, [{ errorCode: '409', errorMessage: 'Product already exists' }]);
      produkty.set(id, { ...cialo, externalId: id, images: [], buyableProblems: [] });
      return odp(202, { externalId: id, updatedFields: Object.keys(cialo) });
    }
    if (metoda === 'PATCH') {
      if (!produkty.has(id)) return odp(404, { message: 'Not found' });
      produkty.set(id, { ...produkty.get(id), ...cialo });
      return odp(202, { externalId: id, updatedFields: Object.keys(cialo) });
    }
    return odp(500, { message: 'nieobsłużone' });
  }
  return { produkty, fetchImpl };
}

const idErli = (n) => `pc7k2q-K${String(n).padStart(3, '0')}`;

function kartaErli(db, n, czas) {
  const sku = `LMP-${String(n).padStart(3, '0')}`;
  const id = utworzKarte(db, { nazwa: `Lampa Półcień ${sku}`, cena_gr: 10000 + n * 10, stawka_vat: '23' }, { at: iso(czas) });
  db.prepare('UPDATE karty_produktow SET sku = ? WHERE id = ?').run(sku, id);
  db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at) VALUES (?, 0, 'woo', ?, ?)`)
    .run(id, `https://polcien.example/z/${sku}.png`, iso(czas));
  return id;
}

/**
 * Zestaw ERLI: 120 ofert wystawionych i aktywnych (przygotowanie bez nagrania), potem 3 nagrywane przebiegi:
 *  1. stała ilość 5 → 8 (stock we wszystkich), 10 zmian ceny < progu, 3 zmiany nazwy (PATCH treści), 5 nowych ofert (POST);
 *  2. kupujący zmienił stock 20 produktów, 2 ceny powyżej progu (czekają), 2 karty wycofane (status inactive),
 *     1 produkt z zamrożoną ceną przy zmianie ceny;
 *  3. ręczna zmiana ceny 5 produktów w ERLI (batch przywraca), reszta bez zmian.
 */
export async function przygotujErli({ wariant }) {
  let czas = T0;
  const nagr = nagrywarka();
  const erli = serwerErli(nagr);
  const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  znakInstalacji(db, { losuj: () => 0, teraz: () => new Date(czas) });
  const ustaw = (zmiany) => zapiszUstawieniaOfertKonta(db, KONTO_ERLI, { czynne: true, narzutProcent: 0, progPotwierdzeniaProcent: 20,
    stalaIlosc: 5, czasWysylkiDni: 2, cennikDostaw: 'Cennik Półcień', stawkaVat: '23', ...zmiany }, { teraz: iso(czas) });
  ustaw({});
  const klient = createErliClient({ adresApi: 'https://polcien.example/api', kluczApi: 'fikcyjny-klucz', wersja: 'test',
    fetchImpl: erli.fetchImpl, czekaj: async () => {} });
  const petla = createPetlaOfert({ db, teraz: () => new Date(czas), log: () => {},
    konta: () => [{ klucz: KONTO_ERLI, katalog: katalogErli(klient), tylkoOdczyt: () => false }] });
  const karty = [];
  const nowa = (n) => {
    const kartaId = kartaErli(db, n, czas);
    karty.push(kartaId);
    return wstawOferte(db, { kartaId, kanal: KONTO_ERLI, idZewnetrzne: idErli(n), stan: 'do_wyslania' }, { teraz: iso(czas) });
  };
  for (let n = 1; n <= KART_ERLI; n++) nowa(n);
  // Przygotowanie (bez nagrania): POST wszystkich, odczyt → nieaktywna, sprzedawca aktywuje w ERLI.
  await petla.przebieg();
  czas += MIN;
  await petla.przebieg();
  for (const [k, p] of erli.produkty) erli.produkty.set(k, { ...p, status: 'active' });
  czas += MIN;
  await petla.przebieg();
  const nieAktywne = db.prepare("SELECT COUNT(*) AS n FROM oferty_kanalow WHERE kanal = ? AND stan <> 'aktywna'").get(KONTO_ERLI).n;
  if (nieAktywne) throw new Error(`e4-blizniak ERLI: po przygotowaniu ${nieAktywne} ofert nie jest aktywnych`);
  przygotujPrzelacznik(db, wariant, karty, czas);

  const cena = (kartaId, gr) => db.prepare('UPDATE karty_produktow SET cena_gr = ? WHERE id = ?').run(gr, kartaId);
  const kroki = [
    () => {
      ustaw({ stalaIlosc: 8 });
      for (let i = 0; i < 10; i++) cena(karty[i], 10000 + (i + 1) * 10 + 500);
      for (const i of [20, 21, 22]) db.prepare('UPDATE karty_produktow SET nazwa = nazwa || \' — klosz mleczny\' WHERE id = ?').run(karty[i]);
      for (let n = KART_ERLI + 1; n <= KART_ERLI + 5; n++) nowa(n);
    },
    () => {
      for (let i = 30; i < 50; i++) {
        const k = idErli(i + 1);
        erli.produkty.set(k, { ...erli.produkty.get(k), stock: i % 3 });
      }
      cena(karty[60], 20000);
      cena(karty[61], 5000);
      for (const i of [70, 71]) db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(karty[i]);
      const k = idErli(81);
      erli.produkty.set(k, { ...erli.produkty.get(k), frozen: [{ field: 'price' }] });
      cena(karty[80], 10900);
    },
    () => {
      for (let i = 90; i < 95; i++) {
        const k = idErli(i + 1);
        erli.produkty.set(k, { ...erli.produkty.get(k), price: erli.produkty.get(k).price - 100 });
      }
    },
  ];
  async function przebiegi() {
    for (const [i, krok] of kroki.entries()) {
      czas += MIN;
      krok();
      nagr.st.przebieg = i + 1;
      await petla.przebieg();
    }
    nagr.st.przebieg = 0;
  }
  return { db, nagr, przebiegi, zamknij: () => db.close(), oferta: (id) => ofertaPoId(db, id) };
}

// ───────────────────────────── Allegro ─────────────────────────────

const BEZPIECZENSTWO = JSON.stringify({ typ: 'TEXT', tekst: 'Nie zostawiaj włączonej lampy bez nadzoru.' });
export const KART_ALLEGRO = 14;

/** Karta z kategorią z mapy, regułami, marką, GPSR konta i 2 zdjęciami (jak petla-ofert-allegro.test.js). */
export function kartaAllegro(db, konto, n, czas) {
  const at = iso(czas);
  const id = utworzKarte(db, { nazwa: `Lampa stołowa Gliwka ${n} z kloszem`, cena_gr: 5900 + n * 100, stawka_vat: '23',
    marka: 'Pracownia Półcień', kategoria_glowna: 'Lampy stołowe', szerokosc_mm: 255,
    opis_sekcje_json: JSON.stringify({ sekcje: [{ elementy: [{ typ: 'tekst', html: '<p>Lampa z mlecznym kloszem.</p>' }] }] }) },
  { at });
  db.prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = ?, ean = ? WHERE id = ?').run(BEZPIECZENSTWO, eanDemo(1), id);
  const zdj = db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, sha256, typ, ai, ai_reczne, utworzono_at)
    VALUES (?, ?, 'reczne', ?, NULL, 'image/jpeg', 0, 1, ?)`);
  for (let i = 0; i < 2; i++) zdj.run(id, i, `https://polcien.example.invalid/gliwka-${id}-${i + 1}.jpg`, at);
  const opis = opisKategorii(['5', '256', '257'].map(kategoriaAllegroDemo), parametryKategoriiAllegroDemo('257'));
  db.prepare(`INSERT OR IGNORE INTO kanaly_kategorie (polaczenie, kategoria_id, sciezka_json, parametry_json, pobrano_at) VALUES (?, '257', ?, ?, ?)`)
    .run(konto, JSON.stringify(opis.sciezka), JSON.stringify({ wersja: opis.wersja, lisc: opis.lisc, tworzenieProduktu: opis.tworzenieProduktu, parametry: opis.parametry }), at);
  db.prepare(`INSERT OR IGNORE INTO allegro_mapa_kategorii (kategoria_karty, srodowisko, kategoria_allegro_id) VALUES ('Lampy stołowe', 'produkcja', '257')`).run();
  const regula = db.prepare(`INSERT OR IGNORE INTO allegro_reguly_parametrow (srodowisko, kategoria_allegro_id, parametr_id, rodzaj,
    wartosc_json, pole, zmieniono_at) VALUES ('produkcja', '257', ?, ?, ?, ?, ?)`);
  regula.run('11323', 'stala', JSON.stringify({ valuesIds: ['11323_1'] }), null, at);
  regula.run('248811', 'pole', null, 'marka', at);
  db.prepare(`INSERT OR IGNORE INTO allegro_marki (marka, srodowisko, parametr_id, wartosc_id, kategorie_sprawdzone_json, zmieniono_at)
    VALUES ('Pracownia Półcień', 'produkcja', '248811', '248811_9001', '["257"]', ?)`).run(at);
  db.prepare(`INSERT OR IGNORE INTO allegro_marki_gpsr (marka, konto, zrodlo, zmieniono_at) VALUES ('Pracownia Półcień', ?, 'konto', ?)`)
    .run(konto, at);
  const wiersz = wstawOferte(db, { kartaId: id, kanal: konto, idZewnetrzne: `ext:${znakInstalacji(db)}-K${id}`, tryb: 'zarzadzana', stan: 'do_wyslania' },
    { teraz: at });
  return { kartaId: id, ofertaId: wiersz.id };
}

/**
 * Zestaw Allegro: 10 ofert wystawionych do `aktywna` (przygotowanie bez nagrania), potem 3 nagrywane przebiegi:
 *  1. 2 nowe oferty (do_wyslania → POST/PATCH), ceny 2 kart −5% (komendy ceny), 1 cena +25% (czeka),
 *     oferta wyprzedana (ENDED przy 0 → wznowienie), oferta zakończona ręcznie (ENDED przy 3), kupujący zdjął 2 sztuki;
 *  2. stała ilość 5 → 7 (komendy ilości), karta wycofana (zdjęcie oferty);
 *  3. przebieg po 6 s z odczytem operacji i zadań komend, 1 oferta obserwowana z inną ceną (bez zapisu).
 */
export async function przygotujAllegro({ wariant }) {
  let czas = T0;
  const teraz = () => new Date(czas);
  const nagr = nagrywarka();
  const f = fixtureAllegro();
  const s = f.szkic();
  const KONTO = daneAllegro(f.repo.zapiszZmiane(s.klucz, s.wersja, { autoryzacja: 'polaczone', kontoId: '123' }, aktorAllegro)).klucz;
  const dbAtrapy = new DatabaseSync(':memory:');
  const serwer = createSerwerOfertAllegro({ db: dbAtrapy, kanal: KONTO, env: ENV_DEMO, teraz });
  async function fetchImpl(url, init = {}) {
    nagr.zapisz(String(init.method ?? 'GET').toUpperCase(), url, init);
    return serwer.fetchImpl(url, init);
  }
  const rejestr = createRejestrKanalow({ repozytorium: f.repo, fetchImpl, limitCzasuMs: 2000, teraz,
    fabryki: ({ http }) => ({
      klient: createAllegroClient({ ustawienia: { api: API_ATRAPY_ALLEGRO, userAgent: 'test/1 (+https://x.invalid)' },
        tokeny: { waznyToken: async () => 'token-atrapy-e4' }, http }),
      poller: { stan: () => null, przebieg: async () => {} },
    }) });
  const klient = rejestr.klient(KONTO);
  const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  znakInstalacji(db, { losuj: () => 0, teraz });
  const ustaw = (zmiany) => zapiszUstawieniaOfertKonta(db, KONTO, { czynne: true, aktywujPoSprawdzeniu: true, narzutProcent: 0,
    stalaIlosc: 5, czasWysylkiDni: 2, cennikDostaw: 'cennik-1', stawkaVat: '23', zwrotyId: 'zwrot-1', reklamacjeId: 'rekl-1',
    producentId: 'prod-konta', ...zmiany }, { teraz: iso(czas) });
  ustaw({});
  const konto = { klucz: KONTO, nazwa: 'Półcień Allegro', srodowisko: 'produkcja', zgoda: true, tylkoOdczyt: () => false,
    katalog: katalogAllegro(klient), allegro: wezlyAllegro(klient) };
  const petla = createPetlaOfertAllegro({ db, konta: () => [konto], teraz,
    zwolnijOperacje: (klucz, metoda, zasob) => f.repo.zwolnijOperacje(klucz, metoda, zasob),
    czytajZdjecie: async (z) => new Uint8Array([7, z.id, z.kolejnosc + 1]) });
  const przesun = (ms) => { czas += ms; f.setCzas(iso(czas)); };
  const ofertaWAtrapie = (id) => JSON.parse(dbAtrapy.prepare('SELECT dane_json FROM atrapa_allegro_oferty WHERE kanal = ? AND id = ?')
    .get(KONTO, String(id)).dane_json);
  const zmienWAtrapie = (id, fn) => dbAtrapy.prepare('UPDATE atrapa_allegro_oferty SET dane_json = ? WHERE kanal = ? AND id = ?')
    .run(JSON.stringify(fn(ofertaWAtrapie(id))), KONTO, String(id));

  const karty = [];
  for (let n = 1; n <= 10; n++) karty.push(kartaAllegro(db, KONTO, n, czas));
  // Przygotowanie (bez nagrania): przebiegi co 6 s, aż wszystkie oferty są aktywne.
  for (let i = 0; i < 12; i++) {
    const wToku = db.prepare("SELECT COUNT(*) AS n FROM oferty_kanalow WHERE kanal = ? AND stan <> 'aktywna'").get(KONTO).n;
    if (!wToku) break;
    przesun(6000);
    await petla.przebieg();
  }
  const nieAktywne = db.prepare("SELECT COUNT(*) AS n FROM oferty_kanalow WHERE kanal = ? AND stan <> 'aktywna'").get(KONTO).n;
  if (nieAktywne) throw new Error(`e4-blizniak Allegro: po przygotowaniu ${nieAktywne} ofert nie jest aktywnych`);
  przygotujPrzelacznik(db, wariant, karty.map((k) => k.kartaId), czas);

  const ext = (i) => ofertaPoId(db, karty[i].ofertaId).idZewnetrzne;
  const cena = (i, gr) => db.prepare('UPDATE karty_produktow SET cena_gr = ? WHERE id = ?').run(gr, karty[i].kartaId);
  const kroki = [
    [MIN, () => {
      for (let n = 11; n <= 12; n++) karty.push(kartaAllegro(db, KONTO, n, czas));
      cena(0, Math.round((5900 + 100) * 0.95));
      cena(1, Math.round((5900 + 200) * 0.95));
      cena(2, Math.round((5900 + 300) * 1.25));
      zmienWAtrapie(ext(3), (x) => ({ ...x, stock: { ...x.stock, available: 0 }, publication: { ...x.publication, status: 'ENDED' } }));
      zmienWAtrapie(ext(4), (x) => ({ ...x, stock: { ...x.stock, available: 3 }, publication: { ...x.publication, status: 'ENDED' } }));
      zmienWAtrapie(ext(5), (x) => ({ ...x, stock: { ...x.stock, available: x.stock.available - 2 } }));
    }],
    [MIN, () => {
      ustaw({ stalaIlosc: 7 });
      db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(karty[6].kartaId);
    }],
    [6000, () => {
      db.prepare("UPDATE oferty_kanalow SET tryb = 'obserwowana' WHERE id = ?").run(karty[7].ofertaId);
      cena(7, 9900);
    }],
  ];
  async function przebiegi() {
    for (const [i, [ms, krok]] of kroki.entries()) {
      przesun(ms);
      krok();
      nagr.st.przebieg = i + 1;
      await petla.przebieg();
    }
    nagr.st.przebieg = 0;
  }
  return { db, nagr, przebiegi, oferta: (id) => ofertaPoId(db, id),
    zamknij: () => { db.close(); dbAtrapy.close(); f.db.close(); } };
}
