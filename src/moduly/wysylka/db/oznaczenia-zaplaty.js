// ⚠️ REZERWACJA PRZED ZLECENIEM OZNACZENIA ZAPŁATY — patrz komentarz przy tabeli
// w schema.sql. Ten sam wzorzec, co db/wysylki-ksef.js.

const teraz = () => new Date().toISOString();

/** Wiersz rezerwacji albo `undefined`. */
export function oznaczenieZaplaty(db, uuid) {
  return db.prepare('SELECT * FROM oznaczenia_zaplaty WHERE uuid = ?').get(uuid);
}

/**
 * Atomowe zajęcie dokumentu. Oddaje `{ zajete, wiersz }`.
 *
 * ⚠️ SPRAWDZENIE I ZAPIS SĄ JEDNĄ INSTRUKCJĄ — dokładnie jak w `zajmijWysylkeKsef`. Odczyt
 * „czy już zlecaliśmy?", a po nim osobny INSERT, to ta sama luka, tylko węższa: SQLite
 * serializuje POJEDYNCZY INSERT, więc z dwóch równoległych przebiegów dokładnie jeden
 * dostanie `changes === 1`.
 *
 * ⚠️ NIE MA FUNKCJI ZWALNIAJĄCEJ i to jest decyzja. Zwolnienie po awarii NIEJEDNOZNACZNEJ
 * (zerwane połączenie, 5xx) otwierałoby drogę do drugiego zlecenia dla dokumentu, który
 * mógł już zostać oznaczony. Koszt niezwolnienia jest znikomy — dokument zostaje ze starym
 * statusem, czyli dokładnie tam, gdzie był przed tym projektem — a wyjściem jest CZŁOWIEK
 * i skrypt sprzątający, który taki przypadek pokaże w kubełku „nie wiem, dlaczego".
 */
export function zajmijOznaczenieZaplaty(db, uuid, { powod, dataZaplaty = null, kiedy = teraz() } = {}) {
  const info = db.prepare(
    'INSERT INTO oznaczenia_zaplaty (uuid, zlecone_at, powod, data_zaplaty) VALUES (?, ?, ?, ?) '
    + 'ON CONFLICT(uuid) DO NOTHING',
  ).run(uuid, kiedy, powod, dataZaplaty);
  if (Number(info.changes) === 1) return { zajete: true, wiersz: null };
  return { zajete: false, wiersz: oznaczenieZaplaty(db, uuid) ?? null };
}

// Zapytania wiązane przez moduł do jego kontekstu bazy; istniejące eksporty zachowują parytet testów.
export function createZapytania(db) {
  return {
    oznaczenieZaplaty: (...args) => oznaczenieZaplaty(db, ...args),
    zajmijOznaczenieZaplaty: (...args) => zajmijOznaczenieZaplaty(db, ...args),
  };
}
