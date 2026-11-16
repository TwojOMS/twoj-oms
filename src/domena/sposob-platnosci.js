import { czyPobranie } from './wysylka.js';
import { normalizujMetode } from './metody-platnosci.js';

/**
 * Sposob platnosci na fakturze — pole `payment_method` w payloadzie inFaktu.
 *
 * ⚠️ ISTNIEJE, BO PANEL TEGO POLA NIE WYSYLAL W OGOLE. inFakt podstawial wtedy wartosc
 * domyslna z ustawien konta, czyli `transfer` — i KAZDA faktura za pobraniem wychodzila
 * z napisem „przelew".
 *
 * Formalnie taki dokument NIE JEST wadliwy: sposob zaplaty nie stoi w katalogu
 * obowiazkowych elementow faktury (art. 106e ust. 1 ustawy o VAT), wiec ani KSeF, ani
 * urzad go nie odrzuci. Problem jest praktyczny i konkretny: dokument mowi „do zaplaty
 * przelewem, termin dzis", a te same pieniadze klient odda kurierowi przy odbiorze.
 * Przy nabywcy instytucjonalnym — ksiegowosc placaca Z DOKUMENTU, nie z pamieci o paczce —
 * to jest prosta droga do drugiej zaplaty i do zwrotu nadplaty.
 *
 * ⚠️ WARTOSC `delivery` JEST ZMIERZONA NA ZYWYM KONCIE, NIE WZIETA Z DOKUMENTACJI —
 * dokumentacja API v3 listy dopuszczalnych wartosci nie podaje, a zgadywanie nazwy pola
 * dokumentu ksiegowego jest dokladnie tym, czego ten modul unika. Pomiar na kilkuset
 * fakturach konta: najczesciej wystepowal `transfer`, a `delivery` (kilka procent),
 * `przelewy24`, `payu` i `cash` byly rzadkie.
 * Wszystkie faktury z `delivery` wystawił integrator sprzedaży (Apilo), nie ten panel —
 * rozpoznanie po niepustym `notes`.
 *
 * Ze `delivery` znaczy WLASNIE pobranie, potwierdza korelacja z drugiej strony, a nie sama
 * nazwa: sprawdzona faktura z `delivery` miała kwotę i numer zamówienia w `notes` zgodne z jedynym
 * zamówieniem za pobraniem w tamtym okresie.
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
 * wpisanie im wszystkim „przelewu" byloby
 * TAKIM SAMYM klamstwem, jakie wlasnie naprawiamy — tyle ze wpisanym przez nas, a nie przez
 * ustawienie konta. Mapujemy tylko jednoznaczne metody i tylko wartości przyjmowane
 * przez program. Bez deklaracji pozostaje samo `delivery`: zapis `card` w inFakcie
 * nie został zmierzony. Bramki online pozostawiają domyślną metodę programu.
 *
 * ⚠️ `czyPobranie` (domena/wysylka.js), a NIE kolumna `pobranie` wprost: reczna korekta
 * metody wysylki na karcie wygrywa nad tym, co powiedzial sklep. Zamowienie przestawione
 * recznie na pobranie ma dostac dokument mowiacy o pobraniu — inaczej poprawka na karcie
 * i tresc faktury rozjechalyby sie po cichu.
 */
export function sposobPlatnosciFaktury(z, { przyjmuje = ['delivery'] } = {}) {
  const tekst = String(z?.metoda_platnosci ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const bon = /(karta|karty|bon|bony)[\s_-]*(podarunk|prezentow)|gift[\s_-]*card|voucher/u.test(tekst);
  const mapa = { karta: 'card', apple_pay: 'card', gotowka: 'cash', przelew: 'transfer' };
  const metoda = czyPobranie(z) ? PLATNOSC_POBRANIE : bon ? 'voucher' : mapa[normalizujMetode(z?.metoda_platnosci).klucz];
  return przyjmuje.includes(metoda) ? { payment_method: metoda } : {};
}
