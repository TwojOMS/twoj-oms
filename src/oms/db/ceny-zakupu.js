// Zapytania historii cen zakupu kart. Reguła i walidacja pól — domena/cena-zakupu.js; tu tylko baza.
//
// Funkcje nie otwierają własnej transakcji: zapis ceny idzie razem z zapisem karty albo całym hurtem,
// a odmowa jednego ma cofnąć oba. Żadna nie dotyka `karty_produktow.zmieniony_at` — to ETag i filtr
// „zmienione od” API kart, a cena zakupu do API nie wychodzi.

const teraz = () => new Date().toISOString();

// Reguła „obowiązuje od” w SQL — w jednym miejscu dla ceny jednej karty i cen wszystkich kart naraz;
// dwie kopie warunku rozjechałyby się po cichu. Wyszukanie idzie po indeksie z UNIQUE (karta_id, obowiazuje_od).
const wpisObowiazujacy = (karta) => `SELECT id FROM ceny_zakupu_kart
  WHERE karta_id = ${karta} AND obowiazuje_od <= :dzien
  ORDER BY obowiazuje_od DESC LIMIT 1`;

const CENA_KARTY_NA_DZIEN = `SELECT cena_netto_gr, obowiazuje_od FROM ceny_zakupu_kart
  WHERE id = (${wpisObowiazujacy(':karta')})`;

// Wszystkie karty jednym zapytaniem: podgląd hurtu na setkach kart bez pętli zapytań i bez limitu parametrów.
const CENY_KART_NA_DZIEN = `SELECT k.karta_id, c.cena_netto_gr
  FROM (SELECT DISTINCT karta_id FROM ceny_zakupu_kart) AS k
  JOIN ceny_zakupu_kart AS c ON c.id = (${wpisObowiazujacy('k.karta_id')})`;

/** Wszystkie wpisy karty rosnąco po dacie „od”. */
export function historiaCenZakupu(db, kartaId) {
  return db
    .prepare(
      `SELECT id, karta_id, cena_netto_gr, obowiazuje_od, wpisano_at, kto, zrodlo
       FROM ceny_zakupu_kart WHERE karta_id = ? ORDER BY obowiazuje_od`,
    )
    .all(kartaId)
    .map((w) => ({ ...w }));
}

/**
 * Cena zakupu karty obowiązująca w dniu `dzien` (`RRRR-MM-DD`, dzień Warszawy):
 * `{ cena_netto_gr, obowiazuje_od }` albo `null`. Jedyne źródło ceny zakupu dla liczenia marży.
 */
export function cenaZakupuNa(db, kartaId, dzien) {
  const w = db.prepare(CENA_KARTY_NA_DZIEN).get({ karta: kartaId, dzien });
  return w ? { cena_netto_gr: w.cena_netto_gr, obowiazuje_od: w.obowiazuje_od } : null;
}

/** Ceny zakupu wszystkich kart w dniu `dzien`: `Map<kartaId, grosze>`; karta bez ceny w tym dniu — brak klucza. */
export function cenyZakupuNa(db, dzien) {
  return new Map(
    db
      .prepare(CENY_KART_NA_DZIEN)
      .all({ dzien })
      .map((w) => [w.karta_id, w.cena_netto_gr]),
  );
}

/**
 * Zapisuje cenę `{ gr, od }` karty. Ten sam dzień tej samej karty zastępuje kwotę (z nowym kto/skąd/kiedy),
 * inny dzień dopisuje wpis — historii nie kasuje. Oddaje id wpisu.
 */
export function zapiszCeneZakupu(db, kartaId, { gr, od }, { kto = null, zrodlo, at = teraz() } = {}) {
  const w = db
    .prepare(
      `INSERT INTO ceny_zakupu_kart (karta_id, cena_netto_gr, obowiazuje_od, wpisano_at, kto, zrodlo)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (karta_id, obowiazuje_od) DO UPDATE SET
         cena_netto_gr = excluded.cena_netto_gr, wpisano_at = excluded.wpisano_at,
         kto = excluded.kto, zrodlo = excluded.zrodlo
       RETURNING id`,
    )
    .get(kartaId, gr, od, at, kto, zrodlo);
  return w ? Number(w.id) : null;
}

/** Usuwa jeden wpis karty; oddaje liczbę usuniętych. Numer wpisu innej karty nie usuwa niczego (0). */
export function usunWpisCenyZakupu(db, kartaId, wpisId) {
  return Number(db.prepare('DELETE FROM ceny_zakupu_kart WHERE id = ? AND karta_id = ?').run(wpisId, kartaId).changes);
}
