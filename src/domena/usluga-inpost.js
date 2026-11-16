import { umiejetnosciZamowienia } from './moduly-kanalow.ts';

// Usluga ShipX, na ktorej ma pojechac paczka do paczkomatu — czyli TARYFA, wedlug ktorej
// InPost ja rozliczy.
//
// ⚠️⚠️ POWSTALO Z PRAWDZIWEJ POMYLKI, KTORA KOSZTOWALA PIENIADZE. Panel wysylal
// `inpost_locker_standard` NA SZTYWNO, bo poczatkowo obslugiwal wylacznie paczkomaty ze
// sklepu. Pierwsze nadanie paczkomatu z ALLEGRO poszlo wiec na taryfie standardowej zamiast
// allegrowej i trzeba bylo je anulowac.
//
// ⚠️ WARTOSCI SA ZMIERZONE NA ZYWYM KONCIE, NIE WZIETE Z DOKUMENTACJI. `GET /v1/organizations/{id}`
// oddaje pole `services`, a na nim leza SZESC pozycji, nie jedna:
//   inpost_locker_standard, inpost_locker_standard_smart, inpost_locker_pass_thru,
//   inpost_locker_allegro, inpost_locker_allegro_smart, inpost_letter_allegro
// Wsrod prawdziwych przesylek konta w uzyciu byly OBIE allegrowe (`inpost_locker_allegro`
// i `inpost_locker_allegro_smart`) oraz `inpost_locker_standard`. Czyli „SMART" nie jest stala,
// tylko zalezy od ZAMOWIENIA.
//
// ⚠️ CO ROZSTRZYGA: pole `delivery.smart` w surowym zamowieniu z Allegro. Potwierdzone
// DWUSTRONNIE, a nie sama nazwa: zamowienie z `smart: true` i danym paczkomatem mialo na koncie
// InPost przesylke `inpost_locker_allegro_smart` z tym samym `target_point` — ta sama paczka,
// ogladana z dwoch stron.

export const USLUGA_SKLEP = 'inpost_locker_standard';
export const USLUGA_ALLEGRO = 'inpost_locker_allegro';
export const USLUGA_ALLEGRO_SMART = 'inpost_locker_allegro_smart';

/**
 * Czy to zamowienie z Allegro jechalo na Smart! kupujacego.
 *
 * ⚠️ NIGDY NIE RZUCA i nigdy nie zgaduje. Czytamy WYLACZNIE `delivery.smart` z surowej
 * odpowiedzi Allegro (kolumna `surowe_json`, odswiezana przez pollera — domyslnie co 2 minuty) —
 * uszkodzony albo niepelny JSON ma dac `false`, a nie polozyc nadanie. `false` jest tu
 * bezpiecznym domyslnym stanem: przy nieznanym stanie jedziemy taryfa allegrowa ZWYKLA,
 * bo to ona jest wariantem bez zniżki kupujacego.
 */
export function czySmart(zamowienie) {
  try {
    const surowe = JSON.parse(zamowienie?.surowe_json ?? 'null');
    return surowe?.delivery?.smart === true;
  } catch {
    return false;
  }
}

/**
 * Usluga ShipX dla tej przesylki.
 *
 * ⚠️ ROZSTRZYGA UMIEJĘTNOŚĆ KANAŁU (po kolumnie `sklep`), A NIE METODA WYSYLKI — i to
 * jest ta sama zasada, ktora chroni odmowe nadawania w domena/masowe.js. Metoda jest
 * EDYTOWALNA z karty zamowienia, wiec taryfa kluczowana metoda mialaby furtke: wystarczyloby
 * przestawic zamowienie sklepowe na paczkomat, zeby wyszlo na taryfie allegrowej (albo
 * odwrotnie) — czyli rozliczenie z InPostem rozjechaloby sie po jednym klknieciu na karcie.
 * Kolumna `sklep` jest trwala: ustawia ja poller kanalu przy zapisie i nic z panelu jej
 * nie zmienia.
 */
export function uslugaInpost(zamowienie) {
  if (!umiejetnosciZamowienia(zamowienie).wysylkaPlatformy) return USLUGA_SKLEP;
  return czySmart(zamowienie) ? USLUGA_ALLEGRO_SMART : USLUGA_ALLEGRO;
}
