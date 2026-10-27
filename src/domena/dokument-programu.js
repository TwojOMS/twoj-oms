// PRZ-118.04 — identyfikator dokumentu w programie fakturowym: JEDYNE miejsce w `src/`, które czyta
// kolumnę `infakt_uuid` (strażnik: tests/core/straznik-infakt-uuid-prz118.test.js).
//
// Od migracji rdzen/0008 wiersz `faktury` / `okresy_rozliczeniowe` niesie `program` + `dokument_id`.
// `infakt_uuid` zostaje ZAPASEM odczytu, nie źródłem: wiersz zapisany przez obraz sprzed PRZ-118 PO
// migracji (okno wycofania) ma tylko `infakt_uuid` — i ma działać bez naprawy przy starcie.
// Zapis trzech kolumn naraz robią wyłącznie `zakonczFakture` (moduly/faktury/db/faktury.js)
// i `zakonczFaktureOkresu` (oms/db/okresy.js).
import { bladOperatora } from './bledy.js';
import { NAZWA_INFAKTU } from './konfiguracja-infakt.js';
import { etykietaModulu } from './wybor-programu.js';

/** Identyfikator dokumentu w programie fakturowym albo `null`, gdy wiersz go nie ma. */
export function idDokumentu(f) {
  if (!f) return null;
  return f.dokument_id ?? f.infakt_uuid ?? null;
}

/**
 * Program, w którym leży dokument wiersza, albo `null`, gdy wiersz nie ma dokumentu.
 *
 * ⚠️ Brak identyfikatora = `null`, NAWET gdy `program` jest zapisany: `zakonczFakture` zapisuje
 * `program` także wtedy, gdy program oddał odpowiedź bez identyfikatora — taki wiersz nie wskazuje
 * żadnego dokumentu. Identyfikator bez `program` = wiersz starego obrazu, czyli inFakt.
 */
export function programDokumentu(f) {
  if (idDokumentu(f) == null) return null;
  return f.program ?? 'infakt';
}

const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Ten sam odczyt w SQL: `COALESCE(<alias>.dokument_id, <alias>.infakt_uuid)`, a bez aliasu
 * `COALESCE(dokument_id, infakt_uuid)`. Alias trafia do napisu zapytania, więc tylko identyfikator.
 */
export function idDokumentuSql(alias) {
  if (alias === undefined) return 'COALESCE(dokument_id, infakt_uuid)';
  if (typeof alias !== 'string' || !ALIAS.test(alias)) {
    throw new Error(`idDokumentuSql: niedozwolony alias tabeli ${JSON.stringify(alias)}`);
  }
  return `COALESCE(${alias}.dokument_id, ${alias}.infakt_uuid)`;
}

/**
 * PRZ-121.01 — ten sam odczyt co `programDokumentu` w SQL: `NULL`, gdy wiersz nie ma identyfikatora (nawet przy
 * zapisanym `program`), a identyfikator bez `program` (wiersz starego obrazu) = 'infakt'. Alias jak w `idDokumentuSql`.
 */
export function programDokumentuSql(alias) {
  const id = idDokumentuSql(alias);
  const program = alias === undefined ? 'program' : `${alias}.program`;
  return `(CASE WHEN ${id} IS NULL THEN NULL ELSE COALESCE(${program}, 'infakt') END)`;
}

// Program wołającego: identyfikator modułu ('infakt', 'test'…), obiekt programu z `opis.id`, surowy klient bez opisu
// (w etapie A jedyny wykonawca — inFakt, jak w domena/nazwa-programu.js) albo `null` = moduł faktur „Brak”.
const idProgramu = (program) => {
  if (typeof program === 'string') return program;
  if (!program) return 'brak';
  return program.opis?.id ?? 'infakt';
};

/** Gdzie leży dokument — do zdania „Ta faktura jest w …”: inFakt ma odmianę, inny program — nazwę w cudzysłowie. */
const wProgramie = (id) => (id === 'infakt' ? NAZWA_INFAKTU.miejscownik : `programie „${etykietaModulu(id)}”`);

/**
 * Czy dokument wiersza leży w programie wołającego. Wiersz bez dokumentu — `false` (nie ma czego pobrać ani wysłać).
 * Dla automatów: dokument innego programu pomijają, nie przerywają przebiegu.
 */
export function czyDokumentProgramu(f, program) {
  const p = programDokumentu(f);
  return p !== null && p === idProgramu(program);
}

/**
 * Identyfikator dokumentu do żądania w programie wołającego. `null`, gdy wiersz nie ma dokumentu (jak `idDokumentu`).
 * Dokument innego programu (albo moduł „Brak”) = błąd operatora 409 z `bezProgramu: true` — PRZED rezerwacją i siecią.
 */
export function idDokumentuDla(f, program) {
  const id = idDokumentu(f);
  if (id == null) return null;
  if (czyDokumentProgramu(f, program)) return id;
  const gdzie = wProgramie(programDokumentu(f));
  throw bladOperatora(`Ta faktura jest w ${gdzie}, a moduł faktur OMS-u to teraz „${etykietaModulu(idProgramu(program))}” — otworzysz ją w ${gdzie}. Nic nie poszło do programu.`,
    { status: 409, bezProgramu: true });
}
