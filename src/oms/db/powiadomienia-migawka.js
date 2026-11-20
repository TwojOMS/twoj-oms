// src/oms/db/powiadomienia-migawka.js
//
// Warstwa zapytań migawki powiadomień (tabele z migracji rdzenia 0024). Co wstawić, odświeżyć, rozwiązać,
// przywrócić i usunąć — rozstrzyga `domena/migawka-powiadomien.js`; tu tylko zapis.

const KOLUMNY = [
  'klucz',
  'typ',
  'tekst',
  'title',
  'href',
  'etykieta_przycisku',
  'etykieta_odrzucenia',
  'pilne',
  'pierwszy_raz_at',
  'ostatnio_at',
  'rozwiazane_at',
];

/** Cała migawka (aktualne i archiwum) — wejście `poprzednie` dla `scalMigawke`. */
export function wczytajMigawke(db) {
  return db
    .prepare(`SELECT ${KOLUMNY.join(', ')} FROM powiadomienia ORDER BY klucz`)
    .all()
    .map((w) => ({ ...w }));
}

/**
 * Zapis wyniku `scalMigawke` i stanu przebiegu w JEDNEJ transakcji: dzwonek czytający w trakcie widzi albo
 * poprzedni przebieg, albo ten — nigdy sprawę już przywróconą, a wciąż przeczytaną. `blad` — źródła, które
 * w tym przebiegu nie odpowiedziały (ślad dla `/health`); `null` czyści poprzedni.
 */
export function zapiszMigawke(
  db,
  { wstaw = [], odswiez = [], rozwiaz = [], wroc = [], usun = [] },
  { teraz, czasMs, blad = null },
) {
  const chwila = teraz.toISOString();
  const wstawSql = db.prepare(
    `INSERT INTO powiadomienia (${KOLUMNY.join(', ')}) VALUES (${KOLUMNY.map(() => '?').join(', ')})`,
  );
  const zmienSql = db.prepare(
    `UPDATE powiadomienia SET ${KOLUMNY.slice(1)
      .map((k) => `${k} = ?`)
      .join(', ')} WHERE klucz = ?`,
  );
  const rozwiazSql = db.prepare('UPDATE powiadomienia SET rozwiazane_at = ? WHERE klucz = ? AND rozwiazane_at IS NULL');
  const usunSql = db.prepare('DELETE FROM powiadomienia WHERE klucz = ?');
  const zapomnijSql = db.prepare('DELETE FROM powiadomienia_przeczytane WHERE klucz = ?');
  const wartosci = (w) => KOLUMNY.map((k) => w[k] ?? null);

  db.exec('BEGIN');
  try {
    for (const w of wstaw) wstawSql.run(...wartosci(w));
    for (const w of odswiez) zmienSql.run(...wartosci(w).slice(1), w.klucz);
    for (const klucz of rozwiaz) rozwiazSql.run(chwila, klucz);
    // Sprawa wraca jako nowa — przeczytanie poprzedniego epizodu nie może jej ukryć przed nikim.
    for (const w of wroc) {
      zmienSql.run(...wartosci(w).slice(1), w.klucz);
      zapomnijSql.run(w.klucz);
    }
    for (const klucz of usun) {
      usunSql.run(klucz);
      zapomnijSql.run(klucz);
    }
    db.prepare(
      `INSERT INTO powiadomienia_stan (id, odswiezone_at, czas_ms, blad, blad_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET odswiezone_at = excluded.odswiezone_at, czas_ms = excluded.czas_ms,
         blad = excluded.blad, blad_at = excluded.blad_at`,
    ).run(chwila, Math.round(czasMs ?? 0), blad, blad ? chwila : null);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Nieudany przebieg: tylko ślad błędu. Migawka i czas ostatniego udanego przebiegu zostają. */
export function zapiszBladMigawki(db, blad, { teraz }) {
  db.prepare(
    `INSERT INTO powiadomienia_stan (id, blad, blad_at) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET blad = excluded.blad, blad_at = excluded.blad_at`,
  ).run(String(blad), teraz.toISOString());
}

/** Ślad ostatniego przebiegu dla `/health`; `null`, gdy migawka jeszcze nie ruszyła. */
export function stanMigawki(db) {
  const w = db.prepare('SELECT odswiezone_at, czas_ms, blad, blad_at FROM powiadomienia_stan WHERE id = 1').get();
  return w ? { ...w } : null;
}
