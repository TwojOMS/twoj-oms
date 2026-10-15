// Stawka VAT panelu — JEDNO miejsce dla całego modułu.
//
// Wcześniej stała mieszkała w services/faktura.js. Wyprowadzona tutaj, bo od chwili, gdy
// operator może dopisać pozycję ręcznie, netto TAKIEJ pozycji trzeba czymś pokazać na
// karcie — i musi to być DOKŁADNIE ta sama stawka, którą panel wysyła do inFaktu. Druga
// kopia „23" w widoku rozjechałaby się z fakturą przy pierwszej zmianie stawki.
//
// Zaszyta na twardo i tak ma zostać: panel nie liczy podatku i nie zgaduje go z danych Woo
// (`vat` z mapowania jest dziś zawsze null), a produkty PRO to jedna stawka. Gdyby
// kiedykolwiek pojawiła się inna, ma to być ŚWIADOMA zmiana z testem, a nie cicha
// interpretacja pustego pola.
export const STAWKA_VAT = '23';

const DZIELNIK = 1 + Number(STAWKA_VAT) / 100;

// ⚠️ TU DZIELENIE BRUTTO PRZEZ STAWKĘ JEST DOZWOLONE — i to jest jedyne takie miejsce
// w module, więc powód musi być zapisany, żeby nikt tego później nie „poprawił"
// w drugą stronę ani nie rozszerzył na pozycje ze sklepu.
//
// Przewodnik (4.5) zakazuje liczenia netto dzieleniem brutta, bo PRZY POZYCJI ZE SKLEPU
// netto jest wartością ŹRÓDŁOWĄ (Woo podaje `total` bez podatku), a dzielenie i mnożenie
// z powrotem produkowało rozjazd o grosze, o który panel sam się rozbijał na barierze
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
export function nettoZBruttoDoPokazania(bruttoZl) {
  if (bruttoZl === null || bruttoZl === undefined || String(bruttoZl).trim() === '') return null;
  const n = Number(bruttoZl);
  if (!Number.isFinite(n)) return null;
  // Przez grosze, nie na złotówkach: dzielenie floata przez 1,23 i toFixed(2) potrafi
  // chybić o grosz na wartościach granicznych, a tu i tak wszystko jest całkowite.
  return (Math.round(Math.round(n * 100) / DZIELNIK) / 100).toFixed(2);
}

/**
 * Brutto z netto — kierunek odwrotny do nettoZBruttoDoPokazania.
 *
 * Wpisanie netto to WYGODA WEJSCIA, nie druga wartosc do przechowania: przechowujemy
 * dalej WYLACZNIE brutto (spec Etap 3, punkt 5). Gdyby panel trzymal obie i przeliczal
 * je w obie strony, zaokraglenia potrafilyby przesunac cene o grosz przy samym klikaniu
 * po polach.
 *
 * Przeliczenie netto → brutto → netto jest TOZSAMOSCIA przy stawce 23%: brutto rosnie
 * o co najmniej grosz na kazdy grosz netto, wiec dzielenie nie ma jak trafic w cudzy
 * przedzial. Pilnuje tego test przez cale 0,01–200,00 zl.
 *
 * Nie rzuca — brak danych ma wygladac jak brak danych (ta sama zasada, co wyzej).
 */
export function bruttoZNetto(nettoZl) {
  if (nettoZl === null || nettoZl === undefined) return null;
  const tekst = String(nettoZl).trim().replace(',', '.');
  if (tekst === '') return null;
  const n = Number(tekst);
  if (!Number.isFinite(n)) return null;
  return (Math.round(Math.round(n * 100) * DZIELNIK) / 100).toFixed(2);
}
