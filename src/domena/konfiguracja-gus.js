// PRZ-102.11 — klucz GUS (baza REGON, usługa BIR1.1) skonfigurowany w Ustawieniach. Wzór: inFakt z PRZ-093.10
// (domena/konfiguracja-infakt.js) i kurierzy z PRZ-092/093.09.
//
// Dla instalacji klientów Twojego OMS-u: klucz użytkownika BIR wpisuje się na ekranie zamiast do oms.env.
// ⚠️ Gdy klucz jest w .env (GUS_KLUCZ), .env WYGRYWA i ekran tylko to pokazuje — instalacja skonfigurowana plikiem
// (w tym produkcja właściciela) nie zmienia zachowania po tej zmianie.
// Adres usługi NIE jest polem formularza: GUS_URL zostaje wyłącznie w pliku (adres testowy GUS-u do prób) i dotyczy
// klucza z pliku i z ekranu tak samo; ekran go nie pokazuje.

/** Produkcyjny adres usługi BIR1.1 — ten sam, który konfiguracja zamówień bierze, gdy w pliku nie ma GUS_URL. */
export const ADRES_GUS = 'https://wyszukiwarkaregon.stat.gov.pl/wsBIR/UslugaBIRzewnPubl.svc';
/** Ekran Ustawienia → Integracje → GUS. */
export const EKRAN_GUS = '/ustawienia/integracje/gus';
/** Odmowa przycisku „Pobierz z GUS”, gdy nie ma klucza ani w pliku, ani w panelu. */
export const KOMUNIKAT_BRAK_GUS = 'GUS nie jest skonfigurowany — dodaj klucz w Ustawienia → Integracje → GUS albo wpisz dane ręcznie.';

const tekst = (v) => String(v ?? '').trim();

/**
 * Sprawdza formularz. Jedyne pole to klucz, więc pusty klucz przy istniejącym zapisie nie ma czego zapisać —
 * błąd „wpisz nowy”, zapisany zostaje (klucz nigdy nie wraca na ekran). Komunikaty nie cytują wpisanej wartości.
 * @returns {{ ustawienia: object, sekrety: { klucz: string }, bledy: string[] }}
 */
export function sprawdzFormularzGus(body = {}, zapisane = null) {
  const bledy = [];
  // Klucz wklejany z maila często niesie spację albo koniec linii na brzegu — te obcinamy.
  const klucz = tekst(body.klucz);
  const stary = String(zapisane?.sekrety?.klucz ?? '');
  if (!klucz) bledy.push(stary ? 'Wpisz nowy klucz — zapisany klucz zostaje bez zmian.' : 'Podaj klucz użytkownika usługi BIR (GUS).');
  else if (/\s/u.test(klucz)) bledy.push('Klucz nie może zawierać spacji — skopiuj go z maila od GUS w całości, bez dopisków.');
  else if (klucz.length < 10) bledy.push('To za krótkie na klucz GUS — skopiuj cały klucz z maila od GUS.');
  else if (klucz.length > 100) bledy.push('Klucz może mieć najwyżej 100 znaków.');
  return { ustawienia: {}, sekrety: { klucz: klucz || stary }, bledy };
}

/** Klucz z zapisu ekranu albo null (brak zapisu, pusty klucz). */
export function kluczZZapisu(zapis) {
  const klucz = tekst(zapis?.sekrety?.klucz);
  return klucz || null;
}

/**
 * Czy pokazać „Pobierz z GUS”. Usługa z modułu zamówień (moduly/zamowienia/gus-ustawien.ts) mówi to metodą
 * `dostepny()` przy każdym żądaniu; zwykły klient (testy, starsze składy) — samym istnieniem.
 */
export function gusDostepny(gus) {
  return Boolean(gus) && (typeof gus.dostepny !== 'function' || gus.dostepny());
}
