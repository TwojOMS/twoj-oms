// PRZ-102.22 — token KSeF do pobierania faktur KOSZTOWYCH skonfigurowany w Ustawieniach. Wzór: klucz GUS z PRZ-102.11
// (domena/konfiguracja-gus.js) i inFakt z PRZ-093.10.
//
// Dla instalacji klientów Twojego OMS-u: token KSeF wpisuje się na ekranie zamiast do oms.env.
// ⚠️ Gdy token jest w .env (KSEF_TOKEN), .env WYGRYWA i ekran tylko to pokazuje — instalacja skonfigurowana plikiem
// (w tym produkcja właściciela) nie zmienia zachowania po tej zmianie.
// ⚠️ Token służy WYŁĄCZNIE do czytania faktur zakupowych (czuwacz kosztów, PDF kosztu, paczka kosztów). Wysyłka
// sprzedaży do KSeF idzie przez inFakt i tego tokenu nie dotyka.
// Adres API (KSEF_API) i archiwum XML (KSEF_ARCHIWUM) NIE są polami formularza — zostają wyłącznie w pliku.
import { znormalizujNip } from './gus.js';

/** Ekran Ustawienia → Integracje → KSeF. */
export const EKRAN_KSEF = '/ustawienia/integracje/ksef';
/** Zdanie na ekranie — jakie uprawnienie ma mieć token (właściciel 20.10). */
export const ZDANIE_UPRAWNIENIA_KSEF = 'Wygeneruj w KSeF token z uprawnieniem tylko do przeglądania faktur zakupowych — panel niczego przez KSeF nie wysyła.';

const tekst = (v) => String(v ?? '').trim();

/**
 * Sprawdza formularz. Pusty token przy istniejącym zapisie zostawia zapisany (token nigdy nie wraca na ekran, więc
 * zmiana samego NIP-u nie wymaga wklejania tokenu od nowa). Komunikaty nie cytują wpisanej wartości.
 * NIP jest opcjonalny i — jak KSEF_NIP w pliku — musi być NIP-em sprzedawcy: KSeF oddaje faktury zakupowe tej firmy,
 * której kontekstem logujemy się tokenem.
 * @returns {{ ustawienia: { nip: string | null }, sekrety: { token: string }, bledy: string[] }}
 */
export function sprawdzFormularzKsef(body = {}, zapisane = null, nipSprzedawcy = null) {
  const bledy = [];
  // Token wklejany z KSeF często niesie spację albo koniec linii na brzegu — te obcinamy.
  const token = tekst(body.token);
  const stary = String(zapisane?.sekrety?.token ?? '');
  if (!token && !stary) bledy.push('Podaj token KSeF.');
  else if (token && /\s/u.test(token)) bledy.push('Token nie może zawierać spacji — skopiuj go z KSeF w całości, bez dopisków.');
  else if (token && token.length < 20) bledy.push('To za krótkie na token KSeF — skopiuj cały token wygenerowany w KSeF.');
  else if (token.length > 1000) bledy.push('Token może mieć najwyżej 1000 znaków.');
  const nipSurowy = tekst(body.nip);
  const nip = nipSurowy ? znormalizujNip(nipSurowy) : null;
  if (nipSurowy && nip !== nipSprzedawcy) {
    bledy.push('NIP musi być NIP-em firmy z konfiguracji (OMS_SPRZEDAWCA_NIP) — KSeF pobiera faktury zakupowe tej firmy. Zostaw pole puste, a OMS użyje NIP-u firmy.');
  }
  return { ustawienia: { nip }, sekrety: { token: token || stary }, bledy };
}

/** Token z zapisu ekranu albo null (brak zapisu, pusty token). */
export function tokenZZapisu(zapis) {
  return tekst(zapis?.sekrety?.token) || null;
}

/**
 * Czy zapis z ekranu da się użyć z tym NIP-em sprzedawcy. NIP zapisany przy tokenie, który przestał zgadzać się
 * z OMS_SPRZEDAWCA_NIP (zmieniony plik po zapisie), NIE jest po cichu zamieniany — token zostaje nieużyty, a ekran
 * mówi dlaczego.
 */
export function nipZapisuZgodny(zapis, nipSprzedawcy) {
  const nip = tekst(zapis?.ustawienia?.nip);
  return !nip || nip === nipSprzedawcy;
}

/**
 * Czy usługa z modułu kosztów jest gotowa (plik albo zapis z ekranu). Usługa z modułu (`dostepny()`) odpowiada przy
 * każdym żądaniu; zwykły obiekt (testy, starsze składy) — samym istnieniem. Wzór: gusDostepny (konfiguracja-gus.js).
 */
export function uslugaKsefDostepna(usluga) {
  return Boolean(usluga) && (typeof usluga.dostepny !== 'function' || usluga.dostepny());
}
