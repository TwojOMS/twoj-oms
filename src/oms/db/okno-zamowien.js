// Indeks zamowienia_julianday_utworzenia ma dokładnie to wyrażenie. SQL wybiera
// kandydatów z zapasem na obie skale czasu; o dniu nadal rozstrzyga dzienWarszawa.
export const OKNO_ZAMOWIEN = "((julianday(utworzone_at) >= julianday(?, '-2 days')"
  + " AND julianday(utworzone_at) < julianday(?, '+3 days')) OR julianday(utworzone_at) IS NULL)";
// NULL także ma zakres w indeksie. Obejmuje m.in. strefy +0200 (bez dwukropka),
// które rozumie format-daty, ale nie SQLite; dokładny filtr JS musi je zobaczyć.
const indeksDaty = new WeakMap();

function wymuszenieIndeksu(db) {
  if (!indeksDaty.has(db)) {
    indeksDaty.set(db, Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index'"
      + " AND name = 'zamowienia_julianday_utworzenia'").get()));
  }
  // Baza samego rdzenia (bez migracji modułu zamówień) nie ma tego indeksu.
  return indeksDaty.get(db) ? ' INDEXED BY zamowienia_julianday_utworzenia' : '';
}

/**
 * PRZ-102.14: per sklep najwcześniejszy dzień z julianday (dolna granica dnia warszawskiego: data bez
 * strefy to dzień sklepu, data ze strefą jest w UTC, a Warszawa jest przed UTC) i liczba dat, których
 * SQLite nie rozumie. Sam indeks pokrywający (julianday, sklep) — bez odczytu wierszy tabeli.
 * @returns {{ sklep: string, od_dnia: string | null, bez_daty: number }[]}
 */
export function pierwszeDniSklepow(db) {
  return db.prepare('SELECT sklep, date(MIN(julianday(utworzone_at))) AS od_dnia,'
    + ` SUM(julianday(utworzone_at) IS NULL) AS bez_daty FROM zamowienia${wymuszenieIndeksu(db)} GROUP BY sklep`).all();
}

/** Zamówienia sklepu z dniem do `doDnia` (z zapasem; o dniu rozstrzyga dzienWarszawa) i z datami bez skali SQLite. */
export function zamowieniaSklepuDoDnia(db, kolumny, sklep, doDnia) {
  return db.prepare(`SELECT ${kolumny} FROM zamowienia${wymuszenieIndeksu(db)} WHERE sklep = ?`
    + " AND (julianday(utworzone_at) < julianday(?, '+1 day') OR julianday(utworzone_at) IS NULL)").all(sklep, doDnia);
}

/** Porcje id bez pełnej tablicy w pamięci. Kolejność id zachowuje kolejność starego SELECT. */
export function* idZamowienWOkresie(db, od, doDnia) {
  for (const porcja of porcjeZamowienWOkresie(db, 'id', od, doDnia)) {
    yield porcja.map(w => w.id);
  }
}

/** .all() zamyka odczyt przed yield: poller może pisać po zmianie WAL przez inny proces. */
export function* porcjeZamowienWOkresie(db, kolumny, od, doDnia) {
  // Bez INDEXED BY planer wybiera rowid > ? i omija indeks daty. Najpierw
  // sortujemy same id, żeby SQLite nie materializował szerokich wierszy całego okna.
  const zapytanie = db.prepare(`SELECT ${kolumny} FROM zamowienia WHERE id IN (`
    + `SELECT id FROM zamowienia${wymuszenieIndeksu(db)}`
    + ` WHERE ${OKNO_ZAMOWIEN} AND id > ? ORDER BY id LIMIT 500) ORDER BY id`);
  let ostatnieId = 0;
  while (true) {
    const porcja = zapytanie.all(od, doDnia, ostatnieId);
    if (!porcja.length) return;
    ostatnieId = porcja.at(-1).id;
    yield porcja;
    if (porcja.length < 500) return;
  }
}
