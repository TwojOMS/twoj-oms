// Ustawienia panelu — jedna tabela klucz → wartość, czytana PRZY KAŻDYM ŻĄDANIU.
//
// ⚠️ CAŁA TABELA NA RAZ, a nie zapytanie per klucz. Wierszy jest siedem i będzie ich
// kilkanaście; jeden `SELECT` bez `WHERE` jest tańszy niż cztery zapytania o wymiary paczki,
// a przy okazji zdejmuje pokusę, żeby ktoś kiedyś przeczytał trzy z czterech wymiarów
// i podstawił czwarty z kodu.
//
// Znaczenia kluczy TU NIE MA — ten moduł nie wie, co to „paczka.waga". Rozstrzyga o tym
// domain/ustawienia-panelu.js, żeby reguła i fallbacki dały się przetestować bez bazy.

/** Wszystkie ustawienia jako zwykły obiekt. Pusta baza oddaje `{}`, nigdy `null`. */
export function wczytajUstawienia(db) {
  const zapis = {};
  for (const w of db.prepare('SELECT klucz, wartosc FROM ustawienia').all()) {
    zapis[w.klucz] = w.wartosc;
  }
  return zapis;
}

/**
 * Upsert wielu kluczy JEDNYM zapisem. Zwraca liczbę zapisanych kluczy.
 *
 * ⚠️ TRANSAKCJA, BO WSZYSTKO ALBO NIC. W `node:sqlite` każdy `run()` poza jawną transakcją
 * to własny autocommit — bez `BEGIN`/`COMMIT` awaria na trzecim wymiarze zostawiłaby paczkę
 * z dwoma nowymi bokami i dwoma starymi. Taka paczka pojechałaby do DPD i została rozliczona.
 *
 * `BEGIN IMMEDIATE`, nie `BEGIN` — ta sama zasada, co przy migracjach w db/db.js: blokadę
 * zapisu bierzemy od razu, zamiast dowiadywać się o konflikcie dopiero przy `COMMIT`.
 */
export function zapiszUstawienia(db, wartosci, teraz = new Date().toISOString()) {
  const wpis = db.prepare(`
    INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, zmienione_at = excluded.zmienione_at
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [klucz, wartosc] of Object.entries(wartosci)) {
      // ⚠️ `null` przekazujemy jako `null`, a nie `String(null)` === 'null'. Kolumna jest
      // NOT NULL i ma odmówić — napis 'null' przeszedłby i stał się „wartością".
      wpis.run(klucz, wartosc == null ? null : String(wartosc), teraz);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return Object.keys(wartosci).length;
}

/** Kiedy ostatnio cokolwiek tu zmieniono — do pokazania pod formularzem. */
export function ustawieniaZmienioneAt(db) {
  return db.prepare('SELECT MAX(zmienione_at) AS kiedy FROM ustawienia').get()?.kiedy ?? null;
}
