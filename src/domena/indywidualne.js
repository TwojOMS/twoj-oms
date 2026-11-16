// Zamowienia z PANELU ZAMOWIEN INDYWIDUALNYCH — czyli takie, ktore powstaly z oferty
// wystawionej klientowi, a nie ze zwyklego koszyka. Wpadaja do WooCommerce razem ze zwyklymi
// zamowieniami tego samego sklepu, wiec kolumna `sklep` ich NIE rozroznia — a rozroznic je
// trzeba, bo raporty liczą je osobnym kanałem.
//
// ⚠️ Oba ślady poniżej są NIEZALEŻNE OD SKLEPU I OD ID PRODUKTU, więc przeniesienie wtyczki
// na inny sklep nie wymaga zmian w tym pliku.
//
// Wtyczka `psm-zamowienia-indywidualne` znakuje je DWOMA niezaleznymi sladami i czytamy
// OBA. Koszt to jeden warunek; koszt pomylki to zamowienie policzone w zlym kanale raportu.
//
//  1. `_zam_offer_id` w `meta_data` POZYCJI — doklada je koszyk wtyczki przy skladaniu
//     zamowienia (hak wtyczki
//     `woocommerce_checkout_create_order_line_item`). Niesie identyfikator oferty.
//  2. SKU zaslepki — ukryty produkt, ktorym wtyczka wstawia pozycje indywidualna, wysylke
//     i realizacje priorytetowa (stała SKU we wtyczce).
//
// ⚠️ Rozpoznanie samą linią zaślepki pomija zamówienia z pozycją z oferty, ale bez linii
// placeholdera. Czytając oba sygnały, OMS rozpoznaje je wszystkie.

export const SKU_PLACEHOLDERA = 'psm-zam-placeholder';

/**
 * Czy pozycja pochodzi z produktu-zaslepki panelu indywidualnego.
 *
 * ⚠️ `startsWith`, a nie rownosc. Dzis w sklepie zaslepka jest JEDNYM produktem o jednym
 * SKU (wtyczka wstawia nim i pozycje, i wysylke, i realizacje priorytetowa), wiec rownosc
 * by wystarczyla — ale wariant z przyrostkiem (osobne SKU per rodzaj linii) jest zmiana
 * o jedno pole w konfiguracji wtyczki, a taka zmiana po cichu wypisalaby czesc zamowien
 * z kanalu indywidualnego. Dopasowanie przedrostkiem jest z tego powodu.
 */
export function czyPozycjaPlaceholdera(sku) {
  return typeof sku === 'string' && sku.trim().startsWith(SKU_PLACEHOLDERA);
}

// Wartosc meta bywa raz liczba, raz napisem ('28311' i 28311 to ta sama oferta). Zero
// i pustka znacza BRAK oferty, a nie oferte o numerze zero — inaczej kazde zamowienie
// z pustym polem wpadaloby do kanalu indywidualnego.
function maIdentyfikatorOferty(linia) {
  const meta = Array.isArray(linia?.meta_data) ? linia.meta_data : [];
  const wpis = meta.find((m) => m?.key === '_zam_offer_id');
  if (!wpis) return false;
  const wartosc = String(wpis.value ?? '').trim();
  return wartosc !== '' && wartosc !== '0';
}

/**
 * Czy zamowienie przyszlo z panelu zamowien indywidualnych — liczone z SUROWEJ odpowiedzi
 * sklepu (`surowe_json`).
 *
 * ⚠️ NIGDY NIE RZUCA. Wolaja to i poller (przy kazdej synchronizacji), i przeliczenie
 * wstecz przy starcie panelu — uszkodzone albo niepelne zamowienie nie ma prawa polozyc
 * ani jednego, ani drugiego.
 */
export function czyIndywidualneZeSurowych(surowe) {
  const linie = surowe?.line_items;
  if (!Array.isArray(linie)) return false;
  return linie.some((l) => maIdentyfikatorOferty(l) || czyPozycjaPlaceholdera(l?.sku));
}
