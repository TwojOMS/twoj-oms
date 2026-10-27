// PRZ-118.09 — nazwa programu fakturowego w zdaniach dla człowieka (ekrany, komunikaty domeny).
//
// Zdanie bierze odmianę z `program.opis.nazwa` (mianownik / dopelniacz / miejscownik / narzednik), a odnośnik do
// ekranu programu z `program.opis.ekran`. Obiekt bez opisu (surowy klient inFaktu, mock w teście) i brak programu
// dają nazwę i ekran inFaktu — W PRZ-118 JEDYNEGO programu, więc tekst bez programu zostaje znak w znak ten sam co
// przed zmianą („inFakt nie jest skonfigurowany …”). Zdania o braku programu zmieni dopiero wybór programu (etap A).
//
// ≠ `nazwaProgramu` z moduly/faktury/services/wdt-faktury.js (zapas „program fakturowy”): tamte komunikaty powstają
// wyłącznie przy wystawianiu, gdzie program jest zawsze; te stoją także na ekranach panelu bez programu.
import { EKRAN_INFAKTU, NAZWA_INFAKTU } from './konfiguracja-infakt.js';

/** Odmiana nazwy, gdy wołający nie podał programu (domyślny argument funkcji domeny, panel bez programu). */
export const NAZWA_ZAPASOWA = NAZWA_INFAKTU;

/** Odmiana nazwy programu: `opis.nazwa`, a bez opisu — inFakt. */
export function odmianaNazwyProgramu(program) {
  return program?.opis?.nazwa ?? NAZWA_ZAPASOWA;
}

/** Ekran Ustawień programu (odnośnik „klucz API wpiszesz w …”): `opis.ekran`, a bez opisu — ekran inFaktu. */
export function ekranProgramu(program) {
  return program?.opis?.ekran ?? EKRAN_INFAKTU;
}
