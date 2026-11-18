// Nazwa programu fakturowego w zdaniach dla człowieka (ekrany, komunikaty domeny).
//
// Zdanie bierze odmianę z `program.opis.nazwa` (mianownik / dopelniacz / miejscownik / narzednik), a odnośnik do
// ekranu programu z `program.opis.ekran`. Obiekt bez opisu (surowy klient inFaktu, mock w teście) i brak programu
// dają nazwę i ekran inFaktu — programu, który `wybierzProgram` (domena/wybor-programu.js) bierze bez jawnego wyboru,
// gdy jest skonfigurowany — więc tekst bez programu zostaje znak w znak ten sam co przed dojściem innych programów
// („inFakt nie jest skonfigurowany …”). Zdanie o fakturach wyłączonych jawnym „Brak” składa `zdanieBrakuProgramu`
// w domena/wybor-programu.js.
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

export function gdzieDokument(program) {
  return program?.opis?.wbudowany === true
    ? 'w zakładce FAKTURY OMS-u'
    : `w ${odmianaNazwyProgramu(program).miejscownik}`;
}

/** Ekran Ustawień programu (odnośnik „klucz API wpiszesz w …”): `opis.ekran`, a bez opisu — ekran inFaktu. */
export function ekranProgramu(program) {
  return program?.opis?.ekran ?? EKRAN_INFAKTU;
}
