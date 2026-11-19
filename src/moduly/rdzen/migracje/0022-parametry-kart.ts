import type { DatabaseSync } from 'node:sqlite';
import type { Migracja } from '../../../core/kontrakty.ts';

// Parametry własne kart: każda firma ma inne cechy produktów (kolor, materiał, moc), więc definiuje je sama.
// `parametry_kart` to definicje, `karty_parametry` — wartości kart. Brak wartości to brak wiersza, nigdy pusty
// napis: braki karty i filtr „bez wartości” liczą wtedy jedno i to samo. Reguły pól są w domenie
// (`domena/parametry-kart.js`); CHECK-i są drugą zaporą. SQLite `lower()` składa tylko litery ASCII, więc
// unikalność nazwy z polskimi literami bez względu na wielkość pilnuje domena, indeks łapie resztę.
//
// Klucze obce z ON DELETE CASCADE: usunięcie karty albo definicji zabiera jej wartości (baza włącza
// foreign_keys przy otwarciu). Nowe tabele z ograniczeniami przechodzą przez strażnika migracji — zakaz
// dotyczy dokładania ograniczeń do tabel, które już były.
//
// Dawna kolumna `karty_produktow.paczkomat` była polem stałym jednej firmy; tu staje się zwykłym parametrem
// typu lista. Parametr powstaje tylko w bazie, która ma choć jedno oznaczenie — świeża instalacja nie dostaje
// cudzego parametru. `wymagany = 1`, bo karta bez oznaczenia liczyła się do braków i licznik kompletu ma się nie
// zmienić. Kolumna zostaje w bazie z danymi (migracja tylko dokłada).
//
// Odporna na ponowienie: parametr o tej nazwie już jest → niczego nie przepisujemy, bo firma mogła zdążyć
// zmienić wartości kart.

const PARAMETRY = `CREATE TABLE IF NOT EXISTS parametry_kart (
  id           INTEGER PRIMARY KEY,
  nazwa        TEXT NOT NULL CHECK (length(trim(nazwa)) BETWEEN 1 AND 60),
  typ          TEXT NOT NULL CHECK (typ IN ('liczba', 'tekst', 'lista')),
  jednostka    TEXT CHECK (jednostka IS NULL OR length(jednostka) <= 12),
  wartosci_json TEXT CHECK (wartosci_json IS NULL OR json_valid(wartosci_json)),
  wymagany     INTEGER NOT NULL DEFAULT 0 CHECK (wymagany IN (0, 1)),
  kolejnosc    INTEGER NOT NULL,
  utworzono_at TEXT NOT NULL,
  zmieniono_at TEXT NOT NULL
)`;

const NAZWA_UNIKALNA = `CREATE UNIQUE INDEX IF NOT EXISTS parametry_kart_nazwa ON parametry_kart (lower(trim(nazwa)))`;

const WARTOSCI = `CREATE TABLE IF NOT EXISTS karty_parametry (
  karta_id     INTEGER NOT NULL REFERENCES karty_produktow(id) ON DELETE CASCADE,
  parametr_id  INTEGER NOT NULL REFERENCES parametry_kart(id) ON DELETE CASCADE,
  wartosc      TEXT NOT NULL CHECK (length(wartosc) BETWEEN 1 AND 200),
  zmieniono_at TEXT NOT NULL,
  kto          TEXT,
  PRIMARY KEY (karta_id, parametr_id)
)`;

const WARTOSCI_PARAMETRU = `CREATE INDEX IF NOT EXISTS karty_parametry_parametr ON karty_parametry (parametr_id, wartosc)`;

const NAZWA_PRZENIESIONEGO = 'Paczkomat';
const WARTOSCI_PRZENIESIONEGO = ['tak', 'nie'];
// Ten sam zapis czasu co `toISOString()` w reszcie kodu; migracja nie dostaje zegara.
const TERAZ_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

function przeniesPaczkomat(db: DatabaseSync) {
  const kolumny = db
    .prepare('PRAGMA table_info(karty_produktow)')
    .all()
    .map((k) => (k as { name: string }).name);
  if (!kolumny.includes('paczkomat')) return;
  const juzJest = db.prepare('SELECT 1 FROM parametry_kart WHERE lower(trim(nazwa)) = lower(?)').get(NAZWA_PRZENIESIONEGO);
  if (juzJest) return;
  const oznaczone = db.prepare("SELECT 1 FROM karty_produktow WHERE paczkomat IN ('tak', 'nie') LIMIT 1").get();
  if (!oznaczone) return;

  const at = (db.prepare(`SELECT ${TERAZ_SQL} AS at`).get() as { at: string }).at;
  const id = Number(
    (
      db
        .prepare(
          `INSERT INTO parametry_kart (nazwa, typ, jednostka, wartosci_json, wymagany, kolejnosc, utworzono_at, zmieniono_at)
           VALUES (?, 'lista', NULL, ?, 1, 1, ?, ?) RETURNING id`,
        )
        .get(NAZWA_PRZENIESIONEGO, JSON.stringify(WARTOSCI_PRZENIESIONEGO), at, at) as { id: number | bigint }
    ).id,
  );
  db.prepare(
    `INSERT INTO karty_parametry (karta_id, parametr_id, wartosc, zmieniono_at, kto)
     SELECT id, ?, paczkomat, ?, 'migracja' FROM karty_produktow WHERE paczkomat IN ('tak', 'nie')`,
  ).run(id, at);
}

export const migracjaParametrowKart: Migracja = {
  numer: 22,
  nazwa: 'parametry wlasne kart',
  wykonaj(db: DatabaseSync) {
    db.exec(PARAMETRY);
    db.exec(NAZWA_UNIKALNA);
    db.exec(WARTOSCI);
    db.exec(WARTOSCI_PARAMETRU);
    przeniesPaczkomat(db);
  },
};
