// PRZ-093.10 — inFakt (faktury sprzedaży) skonfigurowany w Ustawieniach. Wzór: kurierzy z PRZ-092 (DPD) i
// PRZ-093.09 (InPost), domena/konfiguracja-inpost.js.
//
// Dla instalacji klientów Twojego OMS-u: klucz API inFaktu wpisuje się na ekranie zamiast do oms.env.
// ⚠️ Gdy inFakt jest w .env (INFAKT_API_KEY), .env WYGRYWA w całości i ekran tylko to pokazuje — instalacja
// skonfigurowana plikiem (w tym produkcja właściciela) nie zmienia zachowania po tej zmianie.
//
// Adres API NIE jest polem formularza: klucz z ekranu idzie zawsze do produkcyjnego inFaktu. Dowolny adres z ekranu
// znaczyłby, że konto z dostępem do Ustawień może wysłać klucz pod obcy adres. Inny adres (np. środowisko testowe
// inFaktu) da się ustawić w pliku (INFAKT_API_URL) — razem z INFAKT_API_KEY, wtedy cała konfiguracja idzie z pliku.
// Archiwum sprzedaży (INFAKT_ARCHIWUM) to katalog na serwerze — zostaje wyłącznie w pliku (ekran go tylko pokazuje).

/** Produkcyjny adres API inFaktu — ten sam, który createInfaktClient przyjmuje, gdy w pliku nie ma INFAKT_API_URL. */
export const ADRES_INFAKT = 'https://api.infakt.pl/api';
/** Ekran Ustawienia → Integracje → inFakt — tu odsyłają komunikaty „inFakt nie jest skonfigurowany”. */
export const EKRAN_INFAKTU = '/ustawienia/integracje/infakt';
/** Odmiana nazwy „inFakt” do zdań dla człowieka (PRZ-118: `opis.nazwa` programu inFakt; jedno źródło z adapterem). */
export const NAZWA_INFAKTU = Object.freeze({
  mianownik: 'inFakt', dopelniacz: 'inFaktu', miejscownik: 'inFakcie', narzednik: 'inFaktem',
});
/** Dopisek do odmów „inFakt nie jest skonfigurowany” w odpowiedziach tekstowych (503) — dokąd pójść. */
export const GDZIE_KLUCZ_INFAKTU = `Klucz API inFaktu wpiszesz w Ustawienia → Integracje → inFakt (${EKRAN_INFAKTU}).`;

const tekst = (v) => String(v ?? '').trim();

/**
 * Sprawdza formularz. Jedyne pole to klucz, więc pusty klucz przy istniejącym zapisie nie ma czego zapisać —
 * błąd „wpisz nowy”, zapisany zostaje (klucz nigdy nie wraca na ekran). Komunikaty nie cytują wpisanej wartości.
 * @returns {{ ustawienia: object, sekrety: { apiKey: string }, bledy: string[] }}
 */
export function sprawdzFormularzInfakt(body = {}, zapisane = null) {
  const bledy = [];
  // Klucz wklejany ze schowka często niesie spację albo koniec linii na brzegu — te obcinamy.
  const klucz = tekst(body.apiKey);
  const stary = String(zapisane?.sekrety?.apiKey ?? '');
  if (!klucz) bledy.push(stary ? 'Wpisz nowy klucz API — zapisany klucz zostaje bez zmian.' : 'Podaj klucz API inFaktu.');
  else if (/\s/u.test(klucz)) bledy.push('Klucz API nie może zawierać spacji — skopiuj go w całości, bez dopisków.');
  // Dolna granica chroni też maskowanie klucza w komunikatach (bardzo krótki „klucz” zamazałby zwykłe słowa).
  else if (klucz.length < 16) bledy.push('To za krótkie na klucz API inFaktu — skopiuj cały klucz z inFaktu (Ustawienia → API).');
  else if (klucz.length > 200) bledy.push('Klucz API może mieć najwyżej 200 znaków.');
  return { ustawienia: {}, sekrety: { apiKey: klucz || stary }, bledy };
}

/** Opcje createInfaktClient z zapisu ekranu: klucz z bazy, adres zawsze produkcyjny (ustawienia zapisu go nie zmienią). */
export function opcjeKlientaInfakt(zapis) {
  // fetchImpl jawnie pusty — jak przy kluczu z pliku (moduly/faktury/modul.ts): transport domyślny.
  return { apiKey: String(zapis?.sekrety?.apiKey ?? ''), baseUrl: ADRES_INFAKT, fetchImpl: undefined };
}
