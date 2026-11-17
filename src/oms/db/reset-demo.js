import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { doZapisu, klasyfikuj, przypnijSejf, sejfDlaStartu } from '../../core/bezpieczenstwo/sejf-sekretow.js';
import { kontrolaPrzedOtwarciem } from '../../core/bezpieczenstwo/konwersja-sekretow.js';
import { KLUCZ_ZLECENIA_RESETU, ZACHOWANE_PRZY_RESECIE, ZACHOWANE_SANDBOX_ALLEGRO, ZACHOWANE_PROBA_FAKTUROWNIA } from '../../domena/reset-demo.js';

const maTabele = (db, nazwa) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(nazwa));
const maNumeracje = (db) => ['tf_serie', 'tf_liczniki'].every(nazwa =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(nazwa));

export function zlecResetDemo(db, { login, teraz = new Date() }) {
  const zlecono = teraz.toISOString();
  db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc=excluded.wartosc, zmienione_at=excluded.zmienione_at`)
    .run(KLUCZ_ZLECENIA_RESETU, JSON.stringify({ zlecono, login }), zlecono);
}

// Konfiguracja rzeczywistego Allegro Sandbox w piaskownicy — wiersze z poświadczeniami (sekrety_json,
// tokeny_kanalu) jak w bazie; kopia resetu leży obok bazy z tymi samymi uprawnieniami (0600, katalog dane/ 0700).
function odczytajSandbox(db) {
  const konfiguracja = db.prepare(`SELECT * FROM konfiguracja_integracji WHERE integracja IN (${ZACHOWANE_SANDBOX_ALLEGRO.map(() => '?').join(',')})`)
    .all(...ZACHOWANE_SANDBOX_ALLEGRO);
  const kanaly = maTabele(db, 'kanaly_sprzedazy')
    ? db.prepare("SELECT * FROM kanaly_sprzedazy WHERE zrodlo = 'panel' AND srodowisko = 'sandbox'").all()
      // Tylko Allegro: konfiguracja innych kanałów (np. klucz ERLI) nie jest zachowywana — kanał bez niej wywraca start.
      .filter(k => (k.typ ?? 'allegro') === 'allegro') : [];
  const token = maTabele(db, 'tokeny_kanalu') ? db.prepare('SELECT * FROM tokeny_kanalu WHERE kanal = ?') : null;
  const tokeny = token ? kanaly.map(k => token.get(k.klucz)).filter(Boolean) : [];
  return { konfiguracja, kanaly, tokeny };
}

// Kolumny z poświadczeniami w wierszach przenoszonych przez reset (przypięcie szyfrogramu: tabela, kolumna, klucz główny).
const SEKRETY_RESETU = { konfiguracja_integracji: { id: 'integracja', kolumny: ['sekrety_json'], json: true },
  tokeny_kanalu: { id: 'kanal', kolumny: ['access_token', 'refresh_token'] } };

// Kontrola pliku resetu PRZED skasowaniem bazy: każdy szyfrogram musi się odszyfrować bieżącym kluczem (albo poprzednim).
// Niezgodność = odmowa — baza i plik resetu zostają. Wartości jawne (plik sprzed szyfrowania) przejdą przez import niżej.
export function sprawdzSekretyResetu(dane, sejf) {
  const wiersze = [...(dane?.sandbox?.konfiguracja ?? []).map(w => ['konfiguracja_integracji', w]),
    ...(dane?.sandbox?.tokeny ?? []).map(w => ['tokeny_kanalu', w]), ...(dane?.fakturownia ?? []).map(w => ['konfiguracja_integracji', w])];
  for (const [tabela, w] of wiersze) {
    const o = SEKRETY_RESETU[tabela];
    for (const kolumna of o.kolumny) {
      const klasa = klasyfikuj(w[kolumna], { json: o.json });
      if (klasa === 'pusty' || klasa === 'jawny') continue;
      sejf.odszyfruj(w[kolumna], { tabela, kolumna, id: w[o.id] });
    }
  }
}

// Import zachowanych wierszy do nowej bazy — jawnie wydzielona ścieżka: szyfrogram przechodzi bajt w bajt (klucze główne
// te same, więc przypięcie do miejsca się zgadza), wartość jawna ze starego pliku resetu jest szyfrowana przed zapisem.
function doImportu(db, tabela, wiersz) {
  const o = SEKRETY_RESETU[tabela];
  if (!o) return wiersz;
  const wynik = { ...wiersz };
  for (const kolumna of o.kolumny) {
    if (!(kolumna in wynik) || klasyfikuj(wynik[kolumna], { json: o.json }) !== 'jawny') continue;
    wynik[kolumna] = doZapisu(db, { tabela, kolumna, id: wynik[o.id] }, wynik[kolumna]);
  }
  return wynik;
}

// Kolumny wspólne starego wiersza i nowej tabeli — nowa baza po migracjach może mieć ich więcej (DEFAULT) albo mniej.
function wstaw(db, tabela, surowy, konflikt) {
  const wiersz = doImportu(db, tabela, surowy);
  const kolumny = new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map(k => k.name));
  const pola = Object.keys(wiersz).filter(k => kolumny.has(k));
  return db.prepare(`INSERT OR ${konflikt} INTO ${tabela} (${pola.map(p => `"${p}"`).join(',')}) VALUES (${pola.map(() => '?').join(',')})`)
    .run(...pola.map(p => wiersz[p])).changes;
}

function przywrocSandbox(db, { konfiguracja, kanaly, tokeny }) {
  let nKonf = 0, nKanaly = 0;
  // Konta panelu po resecie są nowe — konto_id wskazywałby cudze konto; konto_login zostaje jako ślad.
  for (const w of konfiguracja) nKonf += wstaw(db, 'konfiguracja_integracji', { ...w, konto_id: null }, 'REPLACE');
  if (!maTabele(db, 'kanaly_sprzedazy')) return { konfiguracja: nKonf, kanaly: 0 };
  for (const k of kanaly) {
    // Klucz zajęty w świeżym demo = kanał demo; jego tokenów nie nadpisujemy cudzymi.
    if (!wstaw(db, 'kanaly_sprzedazy', k, 'IGNORE')) continue;
    nKanaly++;
    const t = tokeny.find(w => w.kanal === k.klucz);
    if (t && maTabele(db, 'tokeny_kanalu')) wstaw(db, 'tokeny_kanalu', t, 'REPLACE');
  }
  return { konfiguracja: nKonf, kanaly: nKanaly };
}

// Wiersz Fakturowni profilu próby — cały, z sekretami (jak Allegro Sandbox), tylko na żądanie startu.
function odczytajFakturownieProby(db) {
  return db.prepare(`SELECT * FROM konfiguracja_integracji WHERE integracja IN (${ZACHOWANE_PROBA_FAKTUROWNIA.map(() => '?').join(',')})`)
    .all(...ZACHOWANE_PROBA_FAKTUROWNIA);
}

export function odczytajZlecenieResetu(db, { zachowajSandbox = false, zachowajFakturownie = false } = {}) {
  // Baza bez tabeli `ustawienia` (np. pusty plik) = brak zlecenia — start jak przed RESET-DEMO.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ustawienia'").get()) return null;
  const wpis = db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_ZLECENIA_RESETU);
  if (!wpis) return null;
  let zlecenie;
  try { zlecenie = JSON.parse(wpis.wartosc); } catch { throw new Error('Niepoprawne zlecenie resetu demo'); }
  const odczyt = db.prepare('SELECT integracja, ustawienia_json, konto_login, zmieniono_at FROM konfiguracja_integracji WHERE integracja = ?');
  const zachowane = ZACHOWANE_PRZY_RESECIE.map(k => odczyt.get(k)).filter(Boolean);
  const numeracja = maNumeracje(db) ? {
    serie: db.prepare('SELECT kod, rodzaj, format, reset, zmieniono_at, konto_login FROM tf_serie').all(),
    liczniki: db.prepare('SELECT s.kod, l.okres, l.ostatni FROM tf_liczniki l JOIN tf_serie s ON s.id = l.seria_id').all(),
  } : null;
  return { zlecenie, zachowane, numeracja, sandbox: zachowajSandbox ? odczytajSandbox(db) : null,
    fakturownia: zachowajFakturownie ? odczytajFakturownieProby(db) : null };
}

// `stan.sandbox` dostaje liczby przywróconych wierszy Sandbox (bez wartości) — do logu startu.
// `stan.fakturownia` — nazwy przywróconych wierszy profilu próby Fakturowni (bez wartości).
export function przywrocPoResecie(db, { zachowane, numeracja, sandbox = null, fakturownia = null }, stan = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const integracja = db.prepare(`INSERT INTO konfiguracja_integracji (integracja, ustawienia_json, sekrety_json, konto_id, konto_login, zmieniono_at)
      VALUES (?, ?, '{}', NULL, ?, ?) ON CONFLICT(integracja) DO UPDATE SET ustawienia_json=excluded.ustawienia_json,
      sekrety_json='{}', konto_id=NULL, konto_login=excluded.konto_login, zmieniono_at=excluded.zmieniono_at`);
    for (const w of zachowane) integracja.run(w.integracja, w.ustawienia_json, w.konto_login, w.zmieniono_at);
    const dostepna = numeracja && maNumeracje(db);
    if (dostepna) {
      const seria = db.prepare(`INSERT INTO tf_serie (kod, rodzaj, format, reset, zmieniono_at, konto_login) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(kod) DO UPDATE SET format=excluded.format, reset=excluded.reset,
        zmieniono_at=excluded.zmieniono_at, konto_login=excluded.konto_login`);
      for (const s of numeracja.serie) seria.run(s.kod, s.rodzaj, s.format, s.reset, s.zmieniono_at, s.konto_login);
      const licznik = db.prepare(`INSERT INTO tf_liczniki (seria_id, okres, ostatni)
        VALUES ((SELECT id FROM tf_serie WHERE kod = ?), ?, ?)
        ON CONFLICT(seria_id, okres) DO UPDATE SET ostatni=MAX(tf_liczniki.ostatni, excluded.ostatni)`);
      for (const l of numeracja.liczniki) licznik.run(l.kod, l.okres, l.ostatni);
    }
    stan.sandbox = sandbox ? przywrocSandbox(db, sandbox) : null;
    // Konta panelu po resecie są nowe — konto_id wskazywałby cudze konto (jak w Sandbox).
    stan.fakturownia = (fakturownia ?? [])
      .filter(w => wstaw(db, 'konfiguracja_integracji', { ...w, konto_id: null }, 'REPLACE'))
      .map(w => w.integracja);
    db.exec('COMMIT');
    return dostepna ? 'zachowana' : 'brak';
  } catch (e) {
    db.exec('ROLLBACK');
    throw new Error('Nie udało się przywrócić danych po resecie demo', { cause: e });
  }
}

// Kopia `dane` obok bazy żyje od skasowania starej bazy do COMMIT w nowej: reset przerwany w tym oknie (np. błąd
// migracji) dokończy następny start z kopii, zamiast zgubić numerację TF (KSeF TEST odrzuciłby powtórzony numer).
export const kopiaResetu = (baza) => `${baza}.reset-demo.json`;

// Uszkodzona kopia (np. pad w trakcie zapisu sprzed zapisu atomowego, ENOSPC) przy całej bazie jest zbędna — zlecenie
// czytamy wtedy z bazy. Bez bazy nie ma z czego go odtworzyć: jasny błąd z nazwą pliku zamiast pętli restartów.
function czytajKopie(kopia, baza) {
  if (!fs.existsSync(kopia)) return null;
  try {
    return JSON.parse(fs.readFileSync(kopia, 'utf8'));
  } catch {
    if (!fs.existsSync(baza)) throw new Error(`Uszkodzona kopia resetu demo ${kopia} i brak bazy — usuń ten plik, start założy świeże demo`);
    fs.rmSync(kopia, { force: true });
    return null;
  }
}

// `nas-proba.sh reset` działa poza kontenerem (bez gwarancji sqlite3 na hoście), więc nie kasuje już bazy,
// tylko zostawia ten znacznik w dane/. Start zamienia go na zwykłe zlecenie resetu w bazie — dalej jak reset z panelu
// (kopia, świeże demo, przywrócenie). Bazy nie da się otworzyć = dawne zachowanie: kasujemy ją, start zakłada demo.
export const znacznikResetuProby = (baza) => `${baza}.reset-proba`;

function przyjmijZnacznikProby(baza) {
  const znacznik = znacznikResetuProby(baza);
  if (!fs.existsSync(znacznik)) return;
  if (fs.existsSync(baza) && !fs.existsSync(kopiaResetu(baza))) {
    try {
      const db = new DatabaseSync(baza);
      try { zlecResetDemo(db, { login: 'nas-proba.sh reset' }); } finally { db.close(); }
    } catch (e) {
      // Zajęta baza (stary proces jeszcze trzyma zapis) to nie uszkodzenie: rzucamy, znacznik zostaje na następny start.
      if ([5, 6].includes((e?.errcode ?? 0) & 0xff)) throw e;
      for (const plik of [baza, `${baza}-wal`, `${baza}-shm`]) fs.rmSync(plik, { force: true });
    }
  }
  fs.rmSync(znacznik, { force: true });
}

// `sejf` — klucz poświadczeń ścieżki startu; bez niego sejfDlaStartu({}) odmawia (w programie nie ma sejfu domyślnego).
export async function wykonajZlecenieResetu({ baza, utworzBaze, sejf = sejfDlaStartu({}), zachowajSandbox = false, zachowajFakturownie = false }) {
  // Baza musi być czytelna tym kluczem, zanim cokolwiek ją zmieni albo skasuje: znacznik resetu zapisuje do niej zlecenie,
  // a reset bez zachowanych poświadczeń skasowałby bazę zaszyfrowaną innym kluczem bez odmowy.
  if (fs.existsSync(baza)) {
    // Odmowa tylko z powodu klucza albo formatu; plik, który nie jest bazą, idzie dawną drogą (świeże demo).
    try { kontrolaPrzedOtwarciem(baza, sejf); } catch (e) { if (e?.name === 'BladKonfiguracji') throw new Error('Nie udało się wykonać resetu demo', { cause: e }); }
  }
  przyjmijZnacznikProby(baza);
  const kopia = kopiaResetu(baza);
  if (!fs.existsSync(baza) && !fs.existsSync(kopia)) return null;
  const zKopii = czytajKopie(kopia, baza);
  try {
    let dane = zKopii;
    if (!dane) {
      const db = new DatabaseSync(baza, { readOnly: true });
      try { dane = odczytajZlecenieResetu(db, { zachowajSandbox, zachowajFakturownie }); } finally { db.close(); }
      if (!dane) return null;
      sprawdzSekretyResetu(dane, sejf);
      fs.writeFileSync(`${kopia}.tmp`, JSON.stringify(dane), { mode: 0o600 });
      fs.renameSync(`${kopia}.tmp`, kopia);
    }
    // Wznowienie z pliku: ta sama kontrola, zanim cokolwiek zniknie.
    if (zKopii) sprawdzSekretyResetu(dane, sejf);
    for (const plik of [baza, `${baza}-wal`, `${baza}-shm`]) fs.rmSync(plik, { force: true });
    await utworzBaze();
    const nowa = przypnijSejf(new DatabaseSync(baza), sejf);
    let numeracja; const stan = {};
    try { numeracja = przywrocPoResecie(nowa, dane, stan); } finally { nowa.close(); }
    fs.rmSync(kopia, { force: true });
    return { zlecenie: dane.zlecenie, zachowane: dane.zachowane.map(w => w.integracja), numeracja, sandbox: stan.sandbox,
      fakturownia: stan.fakturownia ?? [] };
  } catch (e) {
    throw new Error('Nie udało się wykonać resetu demo', { cause: e });
  }
}
