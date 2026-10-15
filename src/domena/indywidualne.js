// Zamowienia z PANELU ZAMOWIEN INDYWIDUALNYCH — czyli takie, ktore powstaly z oferty
// wystawionej klientowi, a nie ze zwyklego koszyka. Wpadaja do WooCommerce razem ze zwyklymi
// zamowieniami tego samego sklepu, wiec kolumna `sklep` ich NIE rozroznia — a rozroznic je
// trzeba, bo raporty licza je osobnym kanalem (prosba wlasciciela 2026-08-04).
//
// ⚠️ OD 2026-08-19 SKLEPEM TYM JEST `sklep_b`, NIE `sklep_a` — wtyczka przeniosla sie na
// sklep B. Oba slady ponizej sa NIEZALEZNE OD SKLEPU I OD ID PRODUKTU, wiec ta zmiana
// nie wymagala tu ani jednej linii; zapisane, bo poprzednia wersja tego komentarza nazywala
// sklep wprost i czytajacy moglby uznac, ze rozpoznanie jest do niego przywiazane.
//
// Wtyczka `psm-zamowienia-indywidualne` znakuje je DWOMA niezaleznymi sladami i czytamy
// OBA. Koszt to jeden warunek; koszt pomylki to zamowienie policzone w zlym kanale raportu.
//
//  1. `_zam_offer_id` w `meta_data` POZYCJI — doklada je koszyk wtyczki przy skladaniu
//     zamowienia (shop-plugin/.../includes/class-psm-zam-cart.php, hak
//     `woocommerce_checkout_create_order_line_item`). Niesie identyfikator oferty.
//  2. SKU zaslepki — ukryty produkt, ktorym wtyczka wstawia pozycje indywidualna, wysylke
//     i realizacje priorytetowa (shop-plugin/.../includes/class-psm-zam-placeholder.php,
//     stala SKU).
//
// ⚠️ Zewnetrzne repo raportow wlasciciela (`klasyfikacja.mjs`, funkcja zPanelu) rozpoznaje
// panel WYLACZNIE po linii zaslepki — tyle ze na danych z Apilo, wiec dopasowuje `originalCode`
// zaczynajacy sie od '28040|' (identyfikator TEGO SAMEGO produktu w Apilo), a nie napis SKU.
// Czytajac oba sygnaly, OMS rozpoznaje wszystko, co rozpoznaje dzis raport, plus zamowienia
// z pozycja z oferty, ale bez linii placeholdera.

export const SKU_PLACEHOLDERA = 'psm-zam-placeholder';

/**
 * Czy pozycja pochodzi z produktu-zaslepki panelu indywidualnego.
 *
 * ⚠️ `startsWith`, a nie rownosc. Dzis w sklepie zaslepka jest JEDNYM produktem o jednym
 * SKU (wtyczka wstawia nim i pozycje, i wysylke, i realizacje priorytetowa), wiec rownosc
 * by wystarczyla — ale wariant z przyrostkiem (osobne SKU per rodzaj linii) jest zmiana
 * o jedno pole w konfiguracji wtyczki, a taka zmiana po cichu wypisalaby czesc zamowien
 * z kanalu indywidualnego. Raport dopasowuje przedrostkiem dokladnie z tego powodu.
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
