import type { Srodowisko } from './kontrakty.ts';
import { poprawnyNip, poprawnyRachunek } from './walidatory.ts';

export type DaneSprzedawcy = { nip: string; rachunek: string | null; bdo: string | null; bank: string | null };

const oczysc = (v: string) => v.replace(/^PL/i, '').replace(/[\s-]/g, '');

/** Dane sprzedawcy z pliku konfiguracji; brak NIP-u blokuje start, brak rachunku nie (PRZ-102.20 — można w panelu). */
export function wczytajSprzedawce(env: Srodowisko): DaneSprzedawcy {
  const bledy: string[] = [];
  const nipSurowy = env.OMS_SPRZEDAWCA_NIP?.trim() ?? '';
  const rachSurowy = env.OMS_RACHUNEK?.trim() ?? '';
  const nip = oczysc(nipSurowy);
  const rachunek = oczysc(rachSurowy);
  if (!nipSurowy) bledy.push(BRAK_NIP);
  else if (!poprawnyNip(nip)) bledy.push(/^\d{10}$/.test(nip) ? NIP_SUMA : NIP_FORMAT);
  // PRZ-102.20: pusty OMS_RACHUNEK = rachunek z Ustawień → Firma (src/oms/db/rachunek-firmy.js); wpisany musi być poprawny.
  if (rachSurowy && !poprawnyRachunek(rachunek)) bledy.push('OMS_RACHUNEK: ' + zdanieORachunku(rachunek));
  const bdo = env.OMS_SPRZEDAWCA_BDO?.trim() || null;
  if (bdo && !/^\d{9}$/.test(bdo)) bledy.push(BDO_FORMAT);
  if (bledy.length) throw new Error([...bledy, GDZIE_POPRAWIC].join('\n'));
  return { nip, rachunek: rachSurowy ? rachunek : null, bdo, bank: env.OMS_BANK?.trim() || null };
}

// Treści komunikatów startu. Stoją pod funkcją, żeby numery linii odczytów zmiennych (docs/konfiguracja.json) się nie
// przesunęły; funkcja woła je dopiero po załadowaniu modułu. Opisują dokładnie to, co `wczytajSprzedawce` przyjmuje:
// NIP i rachunek — po zdjęciu przedrostka PL, spacji i myślników same cyfry; BDO — 9 cyfr bez żadnego czyszczenia.
// Żaden komunikat nie zawiera wpisanej wartości.
const DOZWOLONE = 'przedrostek PL, spacje i myślniki są dozwolone i pomijane';
const BRAK_NIP = 'Brak wymaganej zmiennej: OMS_SPRZEDAWCA_NIP — wpisz NIP firmy sprzedawcy: 10 cyfr (' + DOZWOLONE + ')';
const NIP_FORMAT = 'OMS_SPRZEDAWCA_NIP: niepoprawny NIP — ' + DOZWOLONE + ', ale reszta musi mieć dokładnie 10 cyfr, bez liter i innych znaków';
const NIP_SUMA = 'OMS_SPRZEDAWCA_NIP: niepoprawny NIP — to 10 cyfr, ale nie zgadza się cyfra kontrolna; sprawdź, czy w numerze nie ma literówki';
// PRZ-102.20: zdania o złym rachunku wspólne dla startu (z przedrostkiem „OMS_RACHUNEK: ”) i formularza
// Ustawienia → Firma (src/domena/rachunek-firmy.js) — jedna walidacja, jedno zdanie.
export const ZDANIE_RACHUNEK_FORMAT = 'niepoprawny numer rachunku — ' + DOZWOLONE + ', ale reszta musi mieć dokładnie 26 cyfr (NRB), bez liter i innych znaków';
export const ZDANIE_RACHUNEK_SUMA = 'niepoprawny numer rachunku — to 26 cyfr, ale nie zgadzają się cyfry kontrolne; sprawdź, czy w numerze nie ma literówki';
const BDO_FORMAT = 'OMS_SPRZEDAWCA_BDO: oczekiwano 9 cyfr bez spacji i myślników (numer rejestrowy BDO); jeśli firma nie ma numeru BDO, zostaw zmienną pustą albo usuń jej linię';
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
