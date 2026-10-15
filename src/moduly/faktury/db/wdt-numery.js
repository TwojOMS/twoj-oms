// Licznik osobnej serii faktur WDT (WDT/n/MM/RRRR) — warstwa bazy. Format numeru i całą
// resztę reguły trzyma domain/wdt.js; tutaj jest wyłącznie SQL.
//
// ⚠️ REZERWACJA JEST ATOMOWA (jeden UPSERT z RETURNING), bo wystawianie faktury to długie
// `await` na inFakcie — dwa wystawiania WDT naraz nie mogą wyjść z tym samym numerem.
// Wzorzec RETURNING jak w db/magazyn.js.

/** Zajmuje i oddaje kolejny numer serii w danym miesiącu (1, 2, 3…). */
export function zarezerwujNumerWdt(db, { rok, miesiac }) {
  return db.prepare(
    'INSERT INTO wdt_numery (rok, miesiac, kolejny) VALUES (?, ?, 1) '
    + 'ON CONFLICT (rok, miesiac) DO UPDATE SET kolejny = kolejny + 1 '
    + 'RETURNING kolejny',
  ).get(rok, miesiac).kolejny;
}

/**
 * Zwalnia numer po JEDNOZNACZNEJ odmowie inFaktu (4xx — dokumentu na pewno nie ma),
 * ale WYŁĄCZNIE jeśli wciąż jest ostatnim w miesiącu. Cofnięcie środka serii zrobiłoby
 * z następnej rezerwacji duplikat numeru, który już wyszedł na dokument — dlatego
 * `WHERE kolejny = ?`, a wynik mówi wołającemu, czy numer wrócił do puli (false = dziura
 * w serii, do odnotowania w logu).
 */
export function cofnijRezerwacjeWdt(db, { rok, miesiac, kolejny }) {
  const wynik = db.prepare(
    'UPDATE wdt_numery SET kolejny = kolejny - 1 WHERE rok = ? AND miesiac = ? AND kolejny = ?',
  ).run(rok, miesiac, kolejny);
  return wynik.changes > 0;
}

export function createZapytania(db) {
  return {
    zarezerwujNumerWdt: (...args) => zarezerwujNumerWdt(db, ...args),
    cofnijRezerwacjeWdt: (...args) => cofnijRezerwacjeWdt(db, ...args),
  };
}
