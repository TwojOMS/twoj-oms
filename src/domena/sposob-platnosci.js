import { czyPobranie } from './wysylka.js';

/**
 * Sposob platnosci na fakturze — pole `payment_method` w payloadzie inFaktu.
 *
 * ⚠️ ISTNIEJE, BO PANEL TEGO POLA NIE WYSYLAL W OGOLE. inFakt podstawial wtedy wartosc
 * domyslna z ustawien konta, czyli `transfer` — i KAZDA faktura za pobraniem wychodzila
 * z napisem „przelew". Zgloszenie wlasciciela 2026-08-07, na fakturze 18/08/2026 do
 * zamowienia allegrowego za pobraniem (220,89 zl, nabywca: spolka z o.o.).
 *
 * Formalnie taki dokument NIE JEST wadliwy: sposob zaplaty nie stoi w katalogu
 * obowiazkowych elementow faktury (art. 106e ust. 1 ustawy o VAT), wiec ani KSeF, ani
 * urzad go nie odrzuci. Problem jest praktyczny i konkretny: dokument mowi „do zaplaty
 * 220,89 przelewem, termin dzis", a te same pieniadze klient odda kurierowi przy odbiorze.
 * Przy nabywcy instytucjonalnym — ksiegowosc placaca Z DOKUMENTU, nie z pamieci o paczce —
 * to jest prosta droga do drugiej zaplaty i do zwrotu nadplaty.
 *
 * ⚠️ WARTOSC `delivery` JEST ZMIERZONA NA ZYWYM KONCIE, NIE WZIETA Z DOKUMENTACJI —
 * dokumentacja API v3 listy dopuszczalnych wartosci nie podaje, a zgadywanie nazwy pola
 * dokumentu ksiegowego jest dokladnie tym, czego ten modul unika od lipca. Pomiar
 * 2026-08-07 na 400 fakturach konta: `transfer` 273, **`delivery` 30**, `przelewy24` 15,
 * `payu` 10, `cash` 2. Wszystkie 30 wystawilo Apilo (rozpoznanie po niepustym `notes` —
 * patrz przewodnik OMS, kolizja numeracji Apilo x OMS).
 *
 * Ze `delivery` znaczy WLASNIE pobranie, potwierdza korelacja z drugiej strony, a nie sama
 * nazwa: faktura `40/07/2026` ma `payment_method: 'delivery'`, kwote **171,80 zl** i w polu
 * `notes` numer zamowienia Woo **28066** — a 171,80 zl to dokladnie to JEDNO zamowienie za
 * pobraniem, jakie sklep A mial w tamtym okresie (przewodnik OMS, Etap 2).
 *
 * ⚠️ CZEGO TEN POMIAR NIE ROZSTRZYGA: wartosci odczytane z dokumentow nie musza byc tym
 * samym zbiorem, ktory API przyjmuje przy ZAPISIE (Apilo mogloby je ustawiac inna droga).
 * Tryb awarii jest jednak bezpieczny i glosny — inFakt odrzuca zly payload kodem 422, czyli
 * JEDNOZNACZNA odmowa, ktora zwalnia rezerwacje faktury (services/faktura.js: jednoznaczna
 * odmowa) i nie zostawia dokumentu-sieroty. Pierwsza fakture za pobraniem po tej zmianie
 * wystawic POD OKIEM.
 */
export const PLATNOSC_POBRANIE = 'delivery';

/**
 * Kawalek payloadu faktury opisujacy sposob zaplaty — pusty obiekt, gdy nie ma co powiedziec.
 *
 * ⚠️ PUSTY OBIEKT, A NIE `{ payment_method: 'transfer' }`, i to jest decyzja. Zamowienie
 * przedplacone bywa oplacone karta, Przelewami24 albo PayU (kolumna `metoda_platnosci`), a
 * panel nie ma mapy tych metod na slownik inFaktu i wpisanie im wszystkim „przelewu" byloby
 * TAKIM SAMYM klamstwem, jakie wlasnie naprawiamy — tyle ze wpisanym przez nas, a nie przez
 * ustawienie konta. Dla wszystkiego poza pobraniem payload zostaje wiec bajt w bajt taki,
 * jaki panel wysylal dotad.
 *
 * ⚠️ `czyPobranie` (domain/wysylka.js), a NIE kolumna `pobranie` wprost: reczna korekta
 * metody wysylki na karcie wygrywa nad tym, co powiedzial sklep. Zamowienie przestawione
 * recznie na pobranie ma dostac dokument mowiacy o pobraniu — inaczej poprawka na karcie
 * i tresc faktury rozjechalyby sie po cichu.
 */
export function sposobPlatnosciFaktury(z) {
  return czyPobranie(z) ? { payment_method: PLATNOSC_POBRANIE } : {};
}
