// Stan bezpiecznika odpytywania zasobu faktur Allegro — wiersz na kanal.
// Reguly (kiedy pytac, kiedy otworzyc, kiedy zamknac) siedza w
// domain/bezpiecznik-weryfikacji.js, zeby dalo sie je przetestowac bez bazy. Ten modul
// wylacznie zapisuje i czyta.

/** Stan kanalu albo `undefined`, gdy jeszcze o nim nie pytalismy. NIGDY nie rzuca. */
export function stanWeryfikacji(db, kanal) {
  return db.prepare('SELECT * FROM stan_weryfikacji_allegro WHERE kanal = ?').get(kanal);
}
export function zapiszStanWeryfikacji(db, kanal, { kolejnePuste, bezpiecznikOd, ostatniaProbaAt }) {
  // ⚠️ `null` jako null, nie `String(null)` === 'null'. Napis 'null' przeszedlby przez
  // kolumne TEXT i „zamkniety bezpiecznik" wygladalby na otwarty — czyli panel przestalby
  // pytac na zawsze, cicho.
  db.prepare(`
    INSERT INTO stan_weryfikacji_allegro (kanal, kolejne_puste, ostatnia_proba_at, bezpiecznik_od)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(kanal) DO UPDATE SET
      kolejne_puste = excluded.kolejne_puste,
      bezpiecznik_od = excluded.bezpiecznik_od,
      ostatnia_proba_at = excluded.ostatnia_proba_at
  `).run(kanal, Number(kolejnePuste) || 0, ostatniaProbaAt ?? null, bezpiecznikOd ?? null);
}
/** Kanaly z otwartym bezpiecznikiem — dla ekranu lacznosci. Nic po cichu. */
export function kanalyZOtwartymBezpiecznikiem(db) {
  return db.prepare('SELECT * FROM stan_weryfikacji_allegro WHERE bezpiecznik_od IS NOT NULL ORDER BY kanal').all();
}
