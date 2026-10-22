// PRZ-108.10 — NIP i numer BDO sprzedawcy wpisane w Ustawieniach → Firma, dla instalacji bez OMS_SPRZEDAWCA_NIP /
// OMS_SPRZEDAWCA_BDO w pliku. Decyzja właściciela (21.10): „NIP i BDO w panelu”. Wzór: rachunek firmy (PRZ-102.20,
// domena/rachunek-firmy.js) — zapisuje tylko administrator, plik wygrywa, czytane przy każdym użyciu, bez migracji.
//
// Różnica wobec rachunku: KAŻDE POLE OSOBNO. NIP i BDO to dwie niezależne dane (firma bez BDO jest normalna), więc
// plik wygrywa dla SWOJEGO pola: NIP w pliku + BDO w panelu (i odwrotnie) jest dozwolone. Dwa wiersze w
// konfiguracja_integracji („nip_firmy”, „bdo_firmy”), dwa formularze, dwie trasy — każdy z własnym „kto i kiedy”.
// Zapis i odczyt z bazy: src/oms/db/nip-bdo-firmy.js. NIP i BDO nie są sekretami (stoją na każdym dokumencie).
//
// ⚠️ Dokument, który niesie NIP sprzedawcy (proforma, specyfikacja, potwierdzenie wywozu, adnotacja WDT na fakturze),
// bez NIP-u ODMAWIA (`nipSprzedawcy`) — nigdy nie wychodzi z pustym NIP-em ani z „PL” bez cyfr.
import { sprawdzNumerNip, sprawdzNumerBdo } from '../core/sprzedawca.ts';
import { poprawnyNip } from '../core/walidatory.ts';
import { bladOperatora } from './bledy.js';

export const KLUCZ_NIP_FIRMY = 'nip_firmy';
export const KLUCZ_BDO_FIRMY = 'bdo_firmy';
export const ZAPIS_NIP_FIRMY = '/ustawienia/firma/nip';
export const ZAPIS_BDO_FIRMY = '/ustawienia/firma/bdo';
/** Uwaga w /health, gdy NIP-u nie ma ani w pliku, ani w panelu (dokumenty z NIP-em odmawiają). */
export const UWAGA_BRAK_NIP = 'brak NIP-u firmy — wpisz w Ustawienia → Firma';
/** Odmowa dokumentu bez NIP-u — jedno zdanie dla wszystkich dokumentów. */
export const ODMOWA_BRAK_NIP = 'Panel nie zna NIP-u firmy, więc dokument wyszedłby bez NIP-u sprzedawcy. '
  + 'Wpisz NIP firmy w Ustawienia → Firma (/ustawienia/firma) albo OMS_SPRZEDAWCA_NIP w pliku konfiguracji.';

const wielka = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const tekst = (v) => String(v ?? '').trim();

/**
 * Formularz NIP-u: wymagany, walidowany jak OMS_SPRZEDAWCA_NIP (to samo zdanie co przy starcie), zapisywany jako 10 cyfr.
 * @returns {{ ustawienia: { nip: string }, bledy: string[] }}
 */
export function sprawdzFormularzNip(body = {}) {
  const { nip, blad } = sprawdzNumerNip(body.nip);
  const bledy = [];
  if (blad) bledy.push(`${wielka(blad)}.`);
  else if (!nip) bledy.push('Wpisz NIP firmy: 10 cyfr; przedrostek PL, spacje i myślniki są dozwolone.');
  // Przy błędzie odsyłamy wpis takim, jak przyszedł, żeby człowiek widział, co poprawić (tylko na ekran, nie do logu).
  return { ustawienia: { nip: nip ?? tekst(body.nip) }, bledy };
}

/**
 * Formularz BDO: opcjonalny — pusty wpis znaczy „firma nie ma BDO” (wiersz z panelu znika). 9 cyfr jak przy starcie.
 * @returns {{ ustawienia: { bdo: string | null }, bledy: string[], wpisane: string }}
 */
export function sprawdzFormularzBdo(body = {}) {
  const { bdo, blad } = sprawdzNumerBdo(body.bdo);
  const bledy = blad ? [`Niepoprawny numer BDO — ${blad}; jeśli firma nie ma numeru BDO, zostaw pole puste.`] : [];
  return { ustawienia: { bdo }, bledy, wpisane: tekst(body.bdo) };
}

/** Wiersz z bazy → NIP albo null. Zapis, który dziś nie przeszedłby walidacji (ręcznie zmieniona baza) = brak NIP-u. */
export function nipZZapisu(zapis) {
  const nip = String(zapis?.ustawienia?.nip ?? '');
  return poprawnyNip(nip) ? nip : null;
}

/** Wiersz z bazy → BDO albo null (9 cyfr, inaczej brak). */
export function bdoZZapisu(zapis) {
  const bdo = String(zapis?.ustawienia?.bdo ?? '');
  return /^\d{9}$/u.test(bdo) ? bdo : null;
}

/**
 * JEDNA kolejność źródeł, osobno dla każdego pola: plik → Ustawienia → Firma → brak. Zapis z bazy czytany tylko dla
 * pola, którego nie ma w pliku.
 * @param {{ zPliku: { nip: string|null, bdo: string|null }, zapisNip: () => any, zapisBdo: () => any }} o
 * @returns {{ nip: string|null, bdo: string|null, zrodloNip: 'plik'|'baza'|null, zrodloBdo: 'plik'|'baza'|null }}
 */
export function rozstrzygnijNipBdoFirmy({ zPliku, zapisNip, zapisBdo }) {
  const nipPlik = zPliku?.nip || null;
  const bdoPlik = zPliku?.bdo || null;
  const nip = nipPlik ?? nipZZapisu(zapisNip());
  const bdo = bdoPlik ?? bdoZZapisu(zapisBdo());
  return { nip, bdo, zrodloNip: nipPlik ? 'plik' : nip ? 'baza' : null, zrodloBdo: bdoPlik ? 'plik' : bdo ? 'baza' : null };
}

/** Bieżące { nip, bdo } z konfiguracji modułu: `config.nipBdoFirmy()` (plik → panel), a w starszych składach plik. */
function biezace(config) {
  if (typeof config?.nipBdoFirmy === 'function') return config.nipBdoFirmy() ?? {};
  return { nip: config?.proforma?.nip ?? null, bdo: config?.proforma?.bdo ?? null };
}

/** NIP sprzedawcy do dokumentu — bez NIP-u odmowa operatorska (dokument nie powstaje). */
export function nipSprzedawcy(config) {
  const nip = tekst(biezace(config).nip);
  if (!nip) throw bladOperatora(ODMOWA_BRAK_NIP);
  return nip;
}

/** NIP sprzedawcy albo null — dla miejsc, gdzie NIP nie jest warunkiem (VIES, faktura krajowa, KSeF bez tokenu). */
export const nipSprzedawcyLubBrak = (config) => tekst(biezace(config).nip) || null;

/** BDO sprzedawcy albo null (firma bez BDO — dokument bez BDO, jak dotąd). */
export const bdoSprzedawcy = (config) => tekst(biezace(config).bdo) || null;
