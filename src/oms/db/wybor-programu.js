// PRZ-121.01 — zapisany wybór modułu faktur: wiersz „program_fakturowy” w tabeli konfiguracja_integracji
// (migracja rdzenia 6, bez nowej migracji; wzór: rachunek-firmy.js). Jawne ustawienia {"program": "…"}, puste
// sekrety; zostaje kto i kiedy (konto_login, zmieniono_at). Regułę stosuje domena/wybor-programu.js.
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji, usunKonfiguracjeIntegracji }
  from './konfiguracja-integracji.js';
import { KLUCZ_WYBORU_PROGRAMU, sprawdzFormularzWyboru } from '../../domena/wybor-programu.js';
import { idDokumentuSql, programDokumentuSql } from '../../domena/dokument-programu.js';

/**
 * Zapis albo `null`, gdy niczego nie wybrano. `program` to SUROWA wartość z bazy (pusty tekst, gdy wiersz jej nie ma) —
 * ocenia ją `wybierzProgram` (nieznana wartość = „brak” + uwaga, nie wyjątek).
 * @returns {{ program: string, kontoLogin: string|null, zmienionoAt: string|null }|null}
 */
export function wczytajWyborProgramu(db) {
  const zapis = wczytajKonfiguracjeIntegracji(db, KLUCZ_WYBORU_PROGRAMU);
  if (!zapis) return null;
  const program = zapis.ustawienia.program;
  return { program: typeof program === 'string' ? program : '', kontoLogin: zapis.kontoLogin, zmienionoAt: zapis.zmienionoAt ?? null };
}

/**
 * Zapisuje wybór — wyłącznie moduł dostępny w tej wersji (ten sam sprawdzian co formularz).
 * @param {any} db @param {string} program
 * @param {{ konto?: { id?: number|null, login?: string|null }|null, teraz?: Date }} [o]
 */
export function zapiszWyborProgramu(db, program, { konto = null, teraz = new Date() } = {}) {
  const { ustawienia, bledy } = sprawdzFormularzWyboru({ program });
  if (bledy.length) throw new Error(`zapiszWyborProgramu: ${bledy.join(' ')}`);
  zapiszKonfiguracjeIntegracji(db, KLUCZ_WYBORU_PROGRAMU, { ustawienia, sekrety: {} }, { konto, teraz });
}

export const usunWyborProgramu = (db) => usunKonfiguracjeIntegracji(db, KLUCZ_WYBORU_PROGRAMU);

/**
 * PRZ-121.02 — ile dokumentów (faktur zamówień i faktur okresów) leży w którym programie: `{ <program>: liczba }`.
 * Liczy wiersze nowe (`program` + `dokument_id`) i stare (sam `infakt_uuid`) tym samym odczytem co `programDokumentu`;
 * rezerwacja bez identyfikatora dokumentu się nie liczy.
 * @returns {Record<string, number>}
 */
export function liczbaDokumentowWgProgramu(db) {
  const wynik = {};
  for (const tabela of ['faktury', 'okresy_rozliczeniowe']) {
    const wiersze = db.prepare(`SELECT ${programDokumentuSql()} AS program, COUNT(*) AS ile FROM ${tabela}
      WHERE ${idDokumentuSql()} IS NOT NULL GROUP BY 1`).all();
    for (const { program, ile } of wiersze) wynik[program] = (wynik[program] ?? 0) + ile;
  }
  return wynik;
}
