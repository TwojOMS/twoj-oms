import type { Srodowisko } from './kontrakty.ts';
import { poprawnyNip, poprawnyRachunek } from './walidatory.ts';

export type DaneSprzedawcy = { nip: string | null; rachunek: string | null; bdo: string | null; bank: string | null };

const oczysc = (v: string) => v.replace(/^PL/i, '').replace(/[\s-]/g, '');

/** Dane sprzedawcy z pliku konfiguracji; brak NIP-u, BDO i rachunku nie blokuje startu (PRZ-102.20, PRZ-108.10 — panel). */
export function wczytajSprzedawce(env: Srodowisko): DaneSprzedawcy {
  const bledy: string[] = [];
  const nipSurowy = env.OMS_SPRZEDAWCA_NIP?.trim() ?? '';
  const rachSurowy = env.OMS_RACHUNEK?.trim() ?? '';
  const nip = oczysc(nipSurowy);
  const rachunek = oczysc(rachSurowy);
  // PRZ-108.10: pusty OMS_SPRZEDAWCA_NIP = NIP z Ustawień → Firma (src/oms/db/nip-bdo-firmy.js); wpisany musi być poprawny.
  if (nipSurowy && !poprawnyNip(nip)) bledy.push('OMS_SPRZEDAWCA_NIP: ' + zdanieONipie(nip));
  // PRZ-102.20: pusty OMS_RACHUNEK = rachunek z Ustawień → Firma (src/oms/db/rachunek-firmy.js); wpisany musi być poprawny.
  if (rachSurowy && !poprawnyRachunek(rachunek)) bledy.push('OMS_RACHUNEK: ' + zdanieORachunku(rachunek));
  const bdo = env.OMS_SPRZEDAWCA_BDO?.trim() || null;
  if (bdo && !/^\d{9}$/.test(bdo)) bledy.push('OMS_SPRZEDAWCA_BDO: ' + ZDANIE_BDO + BDO_PUSTE_W_PLIKU);
  if (bledy.length) throw new Error([...bledy, GDZIE_POPRAWIC].join('\n'));
  return { nip: nipSurowy ? nip : null, rachunek: rachSurowy ? rachunek : null, bdo, bank: env.OMS_BANK?.trim() || null };
}

// Treści komunikatów startu. Stoją pod funkcją, żeby numery linii odczytów zmiennych (docs/konfiguracja.json) się nie
// przesunęły; funkcja woła je dopiero po załadowaniu modułu. Opisują dokładnie to, co `wczytajSprzedawce` przyjmuje:
// NIP i rachunek — po zdjęciu przedrostka PL, spacji i myślników same cyfry; BDO — 9 cyfr bez żadnego czyszczenia.
// Żaden komunikat nie zawiera wpisanej wartości.
const DOZWOLONE = 'przedrostek PL, spacje i myślniki są dozwolone i pomijane';
// PRZ-108.10: zdania o złym NIP-ie i BDO wspólne dla startu (z przedrostkiem „OMS_SPRZEDAWCA_…: ”) i formularzy
// Ustawienia → Firma (src/domena/nip-bdo-firmy.js) — jedna walidacja, jedno zdanie. Treść startu bez zmian.
export const ZDANIE_NIP_FORMAT = 'niepoprawny NIP — ' + DOZWOLONE + ', ale reszta musi mieć dokładnie 10 cyfr, bez liter i innych znaków';
export const ZDANIE_NIP_SUMA = 'niepoprawny NIP — to 10 cyfr, ale nie zgadza się cyfra kontrolna; sprawdź, czy w numerze nie ma literówki';
export const ZDANIE_BDO = 'oczekiwano 9 cyfr bez spacji i myślników (numer rejestrowy BDO)';
const BDO_PUSTE_W_PLIKU = '; jeśli firma nie ma numeru BDO, zostaw zmienną pustą albo usuń jej linię';
// PRZ-102.20: zdania o złym rachunku wspólne dla startu (z przedrostkiem „OMS_RACHUNEK: ”) i formularza
// Ustawienia → Firma (src/domena/rachunek-firmy.js) — jedna walidacja, jedno zdanie.
export const ZDANIE_RACHUNEK_FORMAT = 'niepoprawny numer rachunku — ' + DOZWOLONE + ', ale reszta musi mieć dokładnie 26 cyfr (NRB), bez liter i innych znaków';
export const ZDANIE_RACHUNEK_SUMA = 'niepoprawny numer rachunku — to 26 cyfr, ale nie zgadzają się cyfry kontrolne; sprawdź, czy w numerze nie ma literówki';
const GDZIE_POPRAWIC = 'Popraw w pliku konfiguracji OMS i uruchom OMS od nowa: w instalacji Dockerowej to /opt/oms/config/produkcja.env przy przejściu na pracę, później /opt/oms/config/oms.env (docs/instalacja-docker.md, sekcje 8 i 9); bez Dockera — plik .env.';

/** Zdanie o niepoprawnym numerze po normalizacji: 26 cyfr = zła suma kontrolna, inaczej zły format. */
function zdanieORachunku(cyfry: string): string {
  return /^\d{26}$/.test(cyfry) ? ZDANIE_RACHUNEK_SUMA : ZDANIE_RACHUNEK_FORMAT;
}

/**
 * PRZ-102.20: numer wpisany w panelu — ta sama normalizacja (PL, spacje, myślniki) i ta sama walidacja NRB co
 * OMS_RACHUNEK przy starcie. Zwraca 26 cyfr albo zdanie błędu (bez wpisanej wartości); pusty wpis = { rachunek: null }.
 */
export function sprawdzNumerRachunku(wpisany: unknown): { rachunek: string | null; blad: string | null } {
  const surowy = String(wpisany ?? '').trim();
  if (!surowy) return { rachunek: null, blad: null };
  const cyfry = oczysc(surowy);
  return poprawnyRachunek(cyfry) ? { rachunek: cyfry, blad: null } : { rachunek: null, blad: zdanieORachunku(cyfry) };
}

/** Zdanie o niepoprawnym NIP-ie po normalizacji: 10 cyfr = zła cyfra kontrolna, inaczej zły format. */
function zdanieONipie(cyfry: string): string {
  return /^\d{10}$/.test(cyfry) ? ZDANIE_NIP_SUMA : ZDANIE_NIP_FORMAT;
}

/**
 * PRZ-108.10: NIP wpisany w panelu — ta sama normalizacja (PL, spacje, myślniki) i ta sama walidacja (10 cyfr, suma
 * kontrolna) co OMS_SPRZEDAWCA_NIP przy starcie. Zwraca 10 cyfr albo zdanie błędu (bez wpisanej wartości); pusty = null.
 */
export function sprawdzNumerNip(wpisany: unknown): { nip: string | null; blad: string | null } {
  const surowy = String(wpisany ?? '').trim();
  if (!surowy) return { nip: null, blad: null };
  const cyfry = oczysc(surowy);
  return poprawnyNip(cyfry) ? { nip: cyfry, blad: null } : { nip: null, blad: zdanieONipie(cyfry) };
}

/** PRZ-108.10: BDO wpisany w panelu — jak OMS_SPRZEDAWCA_BDO przy starcie: 9 cyfr, bez czyszczenia; pusty = null. */
export function sprawdzNumerBdo(wpisany: unknown): { bdo: string | null; blad: string | null } {
  const surowy = String(wpisany ?? '').trim();
  if (!surowy) return { bdo: null, blad: null };
  return /^\d{9}$/.test(surowy) ? { bdo: surowy, blad: null } : { bdo: null, blad: ZDANIE_BDO };
}
