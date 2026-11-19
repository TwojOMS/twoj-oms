// Cena zakupu netto karty z historią „obowiązuje od”. Czyste funkcje — bez bazy i bez zegara:
// „dziś” podaje wołający (dzień Warszawy z `dzienWarszawa`, nigdy `toISOString().slice(0, 10)`,
// bo to dzień UTC i po północy czasu polskiego byłby wczorajszy).
//
// Reguła wyboru ceny na dzień jest w dwóch postaciach: tu (na historii w pamięci) i w jednej stałej SQL
// w `oms/db/ceny-zakupu.js`. Test warstwy bazy porównuje je ze sobą na tej samej historii.
import { groszeZKwoty } from './kwota.js';

const WZOR_KWOTY = /^\d+(\.\d{1,2})?$/;
// Miesiąc 01–12 i dzień 01–31 już na wzorcu: `dzienPolski` nie sprawdza kalendarza, więc bez tego
// „2026-13-05” wyszłoby jako „05.13.2026”. Dni miesiąca (30 lutego) sprawdza dalej `dzienZNapisu`.
const WZOR_DNIA = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
// Literówka o kilka zer („1230000”) nie może przejść po cichu jako cena zakupu.
const NAJWYZSZA_GR = 1_000_000_000;
const NAJWCZESNIEJ = '2000-01-01';
const NAJPOZNIEJ = '2099-12-31';

/**
 * Wpis obowiązujący w dniu `dzien` (`RRRR-MM-DD`): największe `obowiazuje_od <= dzien`, albo `null`.
 * Dzień równy dacie wpisu już się liczy — w dniu zmiany obowiązuje nowa cena.
 * Daty porównywane jako napisy: dla `RRRR-MM-DD` porządek napisów jest porządkiem kalendarza.
 */
export function cenaObowiazujaca(historia, dzien) {
  let wynik = null;
  for (const w of historia ?? []) {
    if (w.obowiazuje_od <= dzien && (wynik === null || w.obowiazuje_od > wynik.obowiazuje_od)) wynik = w;
  }
  return wynik;
}

/** Najbliższy wpis po dniu `dzien` (zapowiedziana zmiana ceny) albo `null`. */
export function cenaPrzyszla(historia, dzien) {
  let wynik = null;
  for (const w of historia ?? []) {
    if (w.obowiazuje_od > dzien && (wynik === null || w.obowiazuje_od < wynik.obowiazuje_od)) wynik = w;
  }
  return wynik;
}

/**
 * Złote z formularza → `{ gr }` albo `{ blad }`. Przecinek i kropka, najwyżej dwie cyfry po nich, bez znaku.
 *
 * Grosze liczy `groszeZKwoty` (po cyfrach napisu, nie przez mnożenie floata). Trzecia cyfra po przecinku
 * jest odmową, a nie zaokrągleniem: przy cenie zakupu „12,345” to raczej literówka niż zamiar.
 * Zero jest dozwolone (próbki, gratisy).
 */
export function kwotaZakupuZNapisu(tekst) {
  if (typeof tekst !== 'string') return { blad: 'Cena zakupu: podaj jedną kwotę.' };
  const napis = tekst.trim().replace(',', '.');
  if (!WZOR_KWOTY.test(napis)) {
    return {
      blad: `Cena zakupu: „${tekst.trim()}” to nie kwota w złotych (np. 12,30; najwyżej 2 miejsca po przecinku).`,
    };
  }
  const zaDuza = { blad: 'Cena zakupu: kwota większa niż 10 000 000,00 zł — sprawdź, czy nie ma literówki.' };
  let gr;
  try {
    gr = groszeZKwoty(napis, 'cena zakupu');
  } catch {
    // Przy bardzo długim napisie `groszeZKwoty` rzuca, bo wynik przestaje być dokładny — to też odmowa przy polu.
    return zaDuza;
  }
  if (!Number.isSafeInteger(gr) || gr > NAJWYZSZA_GR) return zaDuza;
  return { gr };
}

/** Data `RRRR-MM-DD` z formularza → `{ dzien }` albo `{ blad }`. Tylko prawdziwy dzień z lat 2000–2099. */
export function dzienZNapisu(tekst) {
  const odmowa = { blad: 'Obowiązuje od: podaj prawdziwą datę z lat 2000–2099 (RRRR-MM-DD).' };
  if (typeof tekst !== 'string') return odmowa;
  const napis = tekst.trim();
  const czesci = WZOR_DNIA.exec(napis);
  if (!czesci) return odmowa;
  const [rok, miesiac, dzien] = czesci.slice(1).map(Number);
  // Kalendarz w obie strony: 2026-02-30 przeszedłby jako 2026-03-02.
  const data = new Date(Date.UTC(rok, miesiac - 1, dzien));
  const prawdziwa = data.getUTCFullYear() === rok && data.getUTCMonth() === miesiac - 1 && data.getUTCDate() === dzien;
  if (!prawdziwa || napis < NAJWCZESNIEJ || napis > NAJPOZNIEJ) return odmowa;
  return { dzien: napis };
}

// Kod źródła w bazie → słowo na ekranie. Nieznany kod zostaje, jak przyszedł: lepiej pokazać surowy
// napis niż ukryć, skąd wpis się wziął.
const ZRODLA = Object.freeze({ karta: 'karta', hurt: 'edycja hurtem' });
export const zrodloCenyZakupu = (zrodlo) =>
  zrodlo === null || zrodlo === undefined || zrodlo === ''
    ? '—'
    : Object.hasOwn(ZRODLA, zrodlo)
      ? ZRODLA[zrodlo]
      : String(zrodlo);

/** `2026-11-05` → `05.11.2026`; na napisie, bez `Date` (bez przeliczania strefy). */
export function dzienPolski(dzien) {
  const czesci = WZOR_DNIA.exec(String(dzien ?? ''));
  return czesci ? `${czesci[3]}.${czesci[2]}.${czesci[1]}` : '';
}

/**
 * Pola `cena_zakupu_netto` i `cena_zakupu_od` formularza → `{ wpis: { gr, od } | null, blad }`.
 * Pusta cena znaczy „nie zmieniaj” (nigdy nie kasuje), także gdy data jest wpisana — pole daty ma
 * domyślnie dziś. Cena bez daty obowiązuje od `dzis`. Pole przysłane dwa razy to błąd (jak w hurcie).
 */
export function wpisZFormularza(body, dzis) {
  const cena = body?.cena_zakupu_netto;
  const od = body?.cena_zakupu_od;
  if (Array.isArray(cena) || Array.isArray(od)) {
    return { wpis: null, blad: 'Cena zakupu: pole przysłane dwa razy — odśwież kartę i zapisz jeszcze raz.' };
  }
  if (cena === undefined || cena === null || String(cena).trim() === '') return { wpis: null, blad: null };

  const kwota = kwotaZakupuZNapisu(String(cena));
  if (kwota.blad) return { wpis: null, blad: kwota.blad };
  if (od === undefined || od === null || String(od).trim() === '')
    return { wpis: { gr: kwota.gr, od: dzis }, blad: null };

  const dzien = dzienZNapisu(String(od));
  if (dzien.blad) return { wpis: null, blad: dzien.blad };
  return { wpis: { gr: kwota.gr, od: dzien.dzien }, blad: null };
}

/**
 * Czy zapis `{ gr, od }` niczego nie zmieni: w dniu `od` obowiązuje już ta sama kwota. Wpis z dokładnie
 * tą datą i inną kwotą sam jest ceną obowiązującą w tym dniu, więc wtedy wynik to `false` (zapis ją zastąpi).
 */
export function wpisZbedny(historia, wpis) {
  return cenaObowiazujaca(historia, wpis.od)?.cena_netto_gr === wpis.gr;
}
