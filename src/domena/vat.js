// Stawka VAT panelu — JEDNO miejsce dla całego modułu.
//
// Netto pozycji dopisanej ręcznie trzeba czymś pokazać na karcie — i musi to być DOKŁADNIE
// ta sama stawka, którą panel wysyła do programu fakturowego. Druga kopia „23" w widoku
// rozjechałaby się z fakturą przy pierwszej zmianie stawki.
//
// Panel nie zgaduje stawki z danych sklepu (`vat` z mapowania Woo jest zawsze null): pusta
// wartość nie jest interpretowana po cichu. Stawka jest per pozycja, a domyślną ustawia admin
// (Ustawienia → Firma, moduly/faktury/db/stawka-vat.js). STAWKA_VAT to WBUDOWANA domyślna: ta,
// którą panel ma, dopóki nikt nic nie zapisał.
export const STAWKA_VAT = '23';

// 23 / 8 / 5 / 0. „zw” i „np” celowo poza listą — bez flagi `zw` proforma i podsumowanie liczą
// wyłącznie stawki liczbowe (domena/podsumowanie-vat.js), a zgadnięcie „zw = 0%” wydrukowałoby
// klientowi wymyśloną stawkę.
export const STAWKI_VAT = Object.freeze(['23', '8', '5', '0']);

// „zw” (zwolnienie z VAT) — WYŁĄCZNIE przy programie fakturowym wbudowanym (TwojeFaktury), bo tylko
// on drukuje adnotację i podstawę zwolnienia. Dopuszcza ją jawna flaga `{ zw: true }` wołającego; bez flagi każda
// funkcja tego pliku działa bez „zw” (inFakt „zw” nie dostaje nigdy). Liczy się jak 0: netto = brutto, VAT 0
// (src/domena/twojefaktury/sumy.js), ale stawką 0% NIE jest — na dokumencie i w podsumowaniu to osobny wiersz.
export const STAWKI_Z_ZW = Object.freeze([...STAWKI_VAT, 'zw']);

/** Lista stawek dla programu fakturowego: wbudowany (`opis.wbudowany === true`) → z „zw”, każdy inny → STAWKI_VAT. */
export function stawkiDlaProgramu(opis) {
  return opis?.wbudowany === true ? STAWKI_Z_ZW : STAWKI_VAT;
}

/**
 * Firma zwolniona z VAT sprzedaje wyłącznie ze stawką „zw” — jedna reguła dla wystawienia (adapter
 * TwojeFaktury: każda pozycja „zw”) i edycji faktury (lista stawek formularza i zapisu). Niezwolniona → `stawki` bez zmian.
 * Edycja: `stawkiDokumentu` = stawki pozycji wersji bazowej. Faktura wystawiona przed włączeniem zwolnienia (ma stawkę
 * inną niż „zw”) zachowuje pełną listę — zwolnienie działa od następnej faktury, nie zmienia wystawionych.
 */
export const STAWKI_FIRMY_ZWOLNIONEJ = Object.freeze(['zw']);
export function stawkiSprzedawcy(stawki, { zwolniona = false, stawkiDokumentu = [] } = {}) {
  if (zwolniona !== true || stawkiDokumentu.some((s) => s !== 'zw')) return stawki;
  return STAWKI_FIRMY_ZWOLNIONEJ;
}

/**
 * Opcje `{ zw }` dla programu — z tej samej reguły co lista stawek (`stawkiDlaProgramu`), żeby lista
 * w formularzu i to, co przyjmuje zapis i liczy dokument, nie mogły się rozjechać. Brak programu / program zewnętrzny → `false`.
 */
export function opcjeZwProgramu(opis) {
  return { zw: stawkiDlaProgramu(opis).includes('zw') };
}

// Flaga czytana ściśle (`=== true`): drugi argument bywa indeksem z `filter`/`every`, a nie opcjami.
const zFlaga = (opcje) => opcje?.zw === true;

/**
 * Czy to stawka z listy — napis albo liczba; „08”, „8.0” i inne zapisy to NIE (formularz wysyła napis z listy).
 * `{ zw: true }` dopuszcza też „zw”.
 */
export function czyStawkaVat(s, opcje) {
  if (s === null || s === undefined) return false;
  return (zFlaga(opcje) ? STAWKI_Z_ZW : STAWKI_VAT).includes(String(s).trim());
}

/**
 * Stawka EFEKTYWNA pozycji — jedna reguła dla faktury, proformy, karty i podsumowania.
 *
 * Własną stawkę ma WYŁĄCZNIE pozycja ręczna (`zrodlo = 'reczna'`, stawka zapisana przy jej dopisaniu).
 * Pozycja ze sklepu i z Allegro dostaje domyślną: stawka, którą Allegro przysyła
 * w linii (`pozycje.vat` z allegro-mapowanie.js), nie wpływa na fakturę.
 * Pozycja ręczna bez zapisanej stawki (`vat` NULL) i zapis spoza listy → domyślna: u instalacji bez
 * wpisu w Ustawieniach to 23.
 *
 * ⚠️ NIP nabywcy z UE (WDT) stoi NAD tą funkcją — patrz `pozycjeDokumentu` (domena/pozycje-faktury.js).
 * `{ zw: true }`: ręczna „zw” zostaje „zw”; bez flagi — domyślna, jak każdy zapis spoza listy.
 */
export function stawkaPozycji(p, domyslna, opcje) {
  if (p?.zrodlo === 'reczna' && czyStawkaVat(p.vat, opcje)) return String(p.vat).trim();
  return String(domyslna);
}

// „zw” z flagą = dzielnik 1 (netto = brutto). Bez flagi — `Number('zw')`, czyli NaN.
const dzielnik = (stawka, opcje) => (zFlaga(opcje) && String(stawka).trim() === 'zw' ? 1 : 1 + Number(stawka) / 100);

// ⚠️ TU DZIELENIE BRUTTO PRZEZ STAWKĘ JEST DOZWOLONE — to jedno z kilku sankcjonowanych miejsc
// (obok domena/podsumowanie-vat.js, domena/wdt.js i netta z Allegro w domena/allegro-mapowanie.js),
// więc powód musi być zapisany, żeby nikt tego później nie „poprawił" w drugą stronę ani nie
// rozszerzył na pozycje ze sklepu.
//
// Reguła netto ze źródła zakazuje liczenia netto dzieleniem brutta, bo PRZY POZYCJI ZE SKLEPU
// netto jest wartością ŹRÓDŁOWĄ (Woo podaje `total` bez podatku), a dzielenie i mnożenie
// z powrotem produkuje rozjazd o grosze, o który panel rozbijałby się na barierze
// arytmetycznej.
//
// Przy pozycji dopisanej (albo przecenionej) ręcznie kierunek jest ODWROTNY: wartością
// źródłową jest BRUTTO, bo to je wpisał operator i to ono jedzie na fakturę. Netto nie
// istnieje wtedy nigdzie indziej — nie ma czego zgubić ani z czym się rozjechać.
//
// Dlatego obowiązują dwie granice:
//  1. wynik tej funkcji służy WYŁĄCZNIE do wyświetlenia na karcie;
//  2. do inFaktu idzie BRUTTO (`gross_price`), tak samo jak przy pozycjach ze sklepu —
//     services/faktura.js nie zna tej funkcji i nie ma prawa jej poznać.
//
// Nie rzuca: karta zamówienia nie ma prawa paść na uszkodzonej cenie (ta sama zasada, co
// przy podsumowaniuPozycji i saldzieWplat) — brak danych ma wyglądać jak brak danych.
export function nettoZBruttoDoPokazania(bruttoZl, stawka = STAWKA_VAT, opcje) {
  if (bruttoZl === null || bruttoZl === undefined || String(bruttoZl).trim() === '') return null;
  const n = Number(bruttoZl);
  if (!Number.isFinite(n)) return null;
  // Przez grosze, nie na złotówkach: dzielenie floata przez 1,23 i toFixed(2) potrafi
  // chybić o grosz na wartościach granicznych, a tu i tak wszystko jest całkowite.
  return (Math.round(Math.round(n * 100) / dzielnik(stawka, opcje)) / 100).toFixed(2);
}

/**
 * Brutto z netto — kierunek odwrotny do nettoZBruttoDoPokazania.
 *
 * Wpisanie netto to WYGODA WEJŚCIA, nie druga wartość do przechowania: przechowujemy
 * WYŁĄCZNIE brutto. Gdyby panel trzymał obie i przeliczał je w obie strony, zaokrąglenia
 * potrafiłyby przesunąć cenę o grosz przy samym klikaniu po polach.
 *
 * Przeliczenie netto → brutto → netto jest TOŻSAMOŚCIĄ przy stawce 23%: brutto rośnie
 * o co najmniej grosz na każdy grosz netto, więc dzielenie nie ma jak trafić w cudzy
 * przedział. Pilnuje tego test przez całe 0,01–200,00 zł.
 *
 * Nie rzuca — brak danych ma wyglądać jak brak danych (ta sama zasada, co wyżej).
 */
export function bruttoZNetto(nettoZl, stawka = STAWKA_VAT, opcje) {
  if (nettoZl === null || nettoZl === undefined) return null;
  const tekst = String(nettoZl).trim().replace(',', '.');
  if (tekst === '') return null;
  const n = Number(tekst);
  if (!Number.isFinite(n)) return null;
  return (Math.round(Math.round(n * 100) * dzielnik(stawka, opcje)) / 100).toFixed(2);
}
