import { KLUCZ_USTAWIEN, odczytajSzablony } from '../../domena/szablony-wiadomosci.js';

// Szablony wiadomości (PRZ-101.03) — jeden wiersz tabeli `ustawienia` (klucz `szablony.wiadomosci`, JSON),
// bez migracji. Reguły zapisu w domena/szablony-wiadomosci.js; tu tylko odczyt i zapis.
//
// Rozmiar: 30 szablonów własnych + 4 wbudowane po najwyżej 4000 znaków treści i 200 tematu ≈ 140 KB w najgorszym
// razie. Kolumna `wartosc` to TEXT bez limitu (SQLite), a `wczytajUstawienia` czyta całą tabelę przy karcie
// zamówienia — przy typowych kilku szablonach to pojedyncze kilobajty.

/** Szablony zapisane w bazie (pusty stan, gdy nic nie zapisano albo wiersz jest uszkodzony). */
export function wczytajSzablonyWiadomosci(db) {
  const w = db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_USTAWIEN);
  return odczytajSzablony(w ? { [KLUCZ_USTAWIEN]: w.wartosc } : {});
}

/**
 * Odczyt–zmiana–zapis w JEDNEJ transakcji (`BEGIN IMMEDIATE`): dwie karty przeglądarki zapisujące naraz nie
 * zgubią sobie nawzajem szablonu (druga czyta stan już po pierwszym zapisie).
 * `zmiana(stan)` zwraca `{ ok, stan, … }` albo `{ ok: false, blad }` — przy odmowie nic się nie zapisuje.
 */
export function zmienSzablonyWiadomosci(db, zmiana, teraz = new Date().toISOString()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const wynik = zmiana(wczytajSzablonyWiadomosci(db));
    if (wynik.ok) {
      db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
        ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, zmienione_at = excluded.zmienione_at`)
        .run(KLUCZ_USTAWIEN, JSON.stringify(wynik.stan), teraz);
    }
    db.exec('COMMIT');
    return wynik;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
