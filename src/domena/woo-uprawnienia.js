// PRZ-149.04 (C8): uprawnienia klucza REST sklepu WooCommerce wybrane w kreatorze (krok 2).
// „Odczyt” — OMS tylko pobiera zamówienia; nie zmienia statusu, nie dopisuje notatki z numerem
// przesyłki i nie zapisuje SKU/wymiarów. Wybór leży w `kanaly_sklepy.ustawienia_json.uprawnienia`;
// sklep bez zapisanego wyboru (sprzed tej zmiany, z env) pracuje jak dotąd — „Zapis/odczyt”.

export const UPRAWNIENIA = Object.freeze(['odczyt', 'zapis']);
export const ETYKIETY_UPRAWNIEN = Object.freeze({ odczyt: 'Odczyt', zapis: 'Zapis/odczyt' });

export const TYLKO_ODCZYT = 'Sklep podłączony tylko do odczytu — status/notatkę zmień w sklepie';
export const KLUCZ_TYLKO_ODCZYT = 'Klucz ma tylko odczyt. Zmień w kreatorze na »Odczyt« albo wygeneruj klucz Zapis/odczyt';

/** @param {{uprawnienia?: unknown}|null|undefined} ustawienia @returns {'odczyt'|'zapis'} */
export function uprawnieniaSklepu(ustawienia) {
  return ustawienia?.uprawnienia === 'odczyt' ? 'odczyt' : 'zapis';
}

/** Klient sklepu (albo jego proxy) przy kluczu „Odczyt” niesie `tylkoOdczyt: true`. */
export function czyTylkoOdczyt(klient) {
  return klient?.tylkoOdczyt === true;
}

export function bladTylkoOdczyt() {
  return Object.assign(new Error(TYLKO_ODCZYT), { name: 'WooTylkoOdczyt' });
}

export function bladKluczaTylkoOdczyt() {
  return Object.assign(new Error(KLUCZ_TYLKO_ODCZYT), { name: 'WooKluczTylkoOdczyt' });
}

/**
 * Czy odpowiedź sklepu na ZAPIS znaczy „klucz nie ma prawa zapisu”. Treść odpowiedzi jest niezaufana:
 * służy wyłącznie do porównania, nigdy nie trafia do komunikatu.
 * - `woocommerce_rest_cannot_edit` (401/403) — brak uprawnienia do edycji;
 * - 401 `woocommerce_rest_authentication_error` z „write permission” — tak WooCommerce odpowiada
 *   na zapis kluczem „Odczyt” (ten sam kod ma zły klucz, stąd sprawdzenie treści).
 */
export function czyOdmowaZapisu(status, dane, metoda) {
  if (status !== 401 && status !== 403) return false;
  if (!metoda || String(metoda).toUpperCase() === 'GET') return false;
  const kod = typeof dane?.code === 'string' ? dane.code : '';
  if (kod === 'woocommerce_rest_cannot_edit') return true;
  const tresc = typeof dane?.message === 'string' ? dane.message : '';
  return status === 401 && kod === 'woocommerce_rest_authentication_error' && /write permission/i.test(tresc);
}
