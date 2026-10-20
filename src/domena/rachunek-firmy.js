// PRZ-102.20 — rachunek bankowy firmy (i nazwa banku) wpisany w Ustawieniach → Firma, dla instalacji bez OMS_RACHUNEK
// w pliku. Decyzja właściciela (20.10): „po prostu pole do wpisania rachunku. tylko przez admina” — bez podwójnego wpisywania,
// bez hasła i bez maili do adminów. Zapis i odczyt z bazy: src/oms/db/rachunek-firmy.js (wiersz „rachunek_firmy”
// w konfiguracja_integracji, osobny od adresu „firma”: zapis i usunięcie adresu nie ruszają rachunku).
// Rachunek nie jest sekretem — stoi w każdym mailu o płatności i na każdej proformie — więc trzymamy go w jawnych ustawieniach.
import { sprawdzNumerRachunku } from '../core/sprzedawca.ts';
import { poprawnyRachunek } from '../core/walidatory.ts';

export const KLUCZ_RACHUNKU_FIRMY = 'rachunek_firmy';
export const ZAPIS_RACHUNKU_FIRMY = '/ustawienia/firma/rachunek';
/** Uwaga w /health, gdy rachunku nie ma ani w pliku, ani w panelu (mail płatniczy idzie wtedy bez danych do przelewu). */
export const UWAGA_BRAK_RACHUNKU = 'brak rachunku firmy — wpisz w Ustawienia → Firma';

const tekst = (v) => String(v ?? '').trim().replace(/\s+/gu, ' ');
const wielka = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Formularz: numer wymagany, walidowany jak OMS_RACHUNEK (sprawdzNumerRachunku — to samo zdanie co przy starcie),
 * zapisywany jako 26 cyfr; bank opcjonalny, do 100 znaków.
 * @returns {{ ustawienia: { rachunek: string, bank: string }, bledy: string[] }}
 */
export function sprawdzFormularzRachunku(body = {}) {
  const bledy = [];
  const { rachunek, blad } = sprawdzNumerRachunku(body.rachunek);
  const bank = tekst(body.bank);
  if (blad) bledy.push(`${wielka(blad)}.`);
  else if (!rachunek) bledy.push('Wpisz numer rachunku firmy: 26 cyfr (NRB); przedrostek PL, spacje i myślniki są dozwolone.');
  if (bank.length > 100) bledy.push('Nazwa banku może mieć najwyżej 100 znaków.');
  // Przy błędzie odsyłamy wpis takim, jak przyszedł (bez normalizacji), żeby człowiek widział, co poprawić.
  return { ustawienia: { rachunek: rachunek ?? tekst(body.rachunek), bank }, bledy };
}

/**
 * Wiersz z bazy → { rachunek, bank }. Zapis, który dziś nie przeszedłby walidacji (ręcznie zmieniona baza) = brak
 * rachunku, nie wyjątek i nie zły numer w mailu.
 */
export function rachunekZZapisu(zapis) {
  const u = zapis?.ustawienia;
  const rachunek = String(u?.rachunek ?? '');
  if (!poprawnyRachunek(rachunek)) return null;
  return { rachunek, bank: tekst(u.bank) || null };
}

/** Czy rachunek stoi w pliku: którakolwiek z OMS_RACHUNEK / OMS_BANK — wtedy plik wygrywa W CAŁOŚCI (bez zlepka). */
export const rachunekWPliku = (zPliku) => Boolean(zPliku?.rachunek || zPliku?.bank);

/**
 * JEDNA kolejność źródeł: plik → Ustawienia → Firma → brak. `zapis` czytany tylko, gdy pliku nie ma.
 * @param {{ zPliku: { rachunek: string|null, bank: string|null }, zapis: () => any }} o
 * @returns {{ rachunek: string|null, bank: string|null, zrodlo: 'plik'|'baza'|null }}
 */
export function rozstrzygnijRachunekFirmy({ zPliku, zapis }) {
  if (rachunekWPliku(zPliku)) return { rachunek: zPliku.rachunek ?? null, bank: zPliku.bank ?? null, zrodlo: 'plik' };
  const zBazy = rachunekZZapisu(zapis());
  return zBazy ? { ...zBazy, zrodlo: 'baza' } : { rachunek: null, bank: null, zrodlo: null };
}

/** Numer NRB do pokazania człowiekowi: 2 + 6 × 4 cyfry. */
export const rachunekDoOdczytu = (r) => (/^\d{26}$/u.test(String(r ?? '')) ? `${r.slice(0, 2)} ${r.slice(2).replace(/(\d{4})(?=\d)/gu, '$1 ')}` : String(r ?? ''));
