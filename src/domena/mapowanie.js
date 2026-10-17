import { metodaWysylkiZamowienia } from './mapowanie-wysylki.js';
import { zdjecieLinii } from './miniatury.js';
import { czyIndywidualneZeSurowych } from './indywidualne.js';
import { kuponyZeSurowych } from './kupony.js';
import { atrybucjaZeSurowych } from './atrybucja.js';

const meta = (z, klucz) => z?.meta_data?.find((m) => m.key === klucz)?.value ?? null;

/**
 * Punkt odbioru (paczkomat InPost) z `meta_data` zamówienia.
 *
 * Kształty odwzorowane z żywego sklepu (odczyt 2026-08-01): wtyczka paczkomatowa zapisuje
 * `_parcel_machine_id` (kod, np. „WRO10B") i `_parcel_machine_desc` (opis lokalizacji).
 *
 * Wystawione osobno, bo czyta to DWÓCH wywołujących: `mapujZamowienie` przy każdej
 * synchronizacji i przeliczenie wstecz w `db/db.js` — a przeliczenie ma czytać `surowe_json`
 * DOKŁADNIE tak samo jak poller, nie drugą, rozjeżdżającą się kopią reguły.
 *
 * Pusty napis czytamy jako brak: Woo zapisuje niewypełnione pole raz jako `''`, raz wcale,
 * a „paczkomat o kodzie pustym" nie jest wartością, którą wolno wpuścić do bazy.
 */
export function punktOdbioruZeSurowych(surowe) {
  return {
    kod: meta(surowe, '_parcel_machine_id') || null,
    opis: meta(surowe, '_parcel_machine_desc') || null,
  };
}

// Woo podaje `total` pozycji BEZ podatku (tak jak `subtotal`) — to kwota netto z rabatem,
// mimo ze panel etykietuje pole ceny jako brutto. Fallback do subtotal/subtotal_tax dziala
// PARAMI — nie mieszamy total z subtotal_tax ani odwrotnie. Wspolne dla bruttoLinii()
// i nettoLinii(), zeby obie liczyly „ta sama linie" tym samym kawalkiem sklepowych danych.
// DATA ZAMOWIENIA W UTC Z SUFIKSEM `Z` (audyt 22.08.2026). Woo oddaje kazda date podwojnie:
// lokalna sklepu (`date_created`) i UTC (`date_created_gmt`) — obie BEZ oznaczenia strefy.
// Mapowanie bralo lokalna, wiec kanaly Woo pisaly czas warszawski obok allegrowego UTC-Z:
// 53 nagie wiersze na produkcji, 3 ujemne czasy do nadania, kazde porownanie dat miedzy
// kanalami w SQL bledne o 2 h.
//
// ⚠️ WYLACZNIE wersja GMT + dolozone `Z` — zadnego przeliczania stref: ten projekt
// przejechal sie na czasie Warszawy juz dwa razy (przewodnik, rozdz. 10). Payload bez GMT
// (starsze Woo, atrapy) zostaje przy wersji lokalnej NIETKNIETEJ — takie wiersze domyka
// backfill `znormalizujDatyWoo` (db/zamowienia.js), a nie zgadywanie tutaj.
function utcSklepu(gmt, lokalna) {
  const g = String(gmt ?? '').trim();
  if (g) return g.endsWith('Z') ? g : `${g}Z`;
  return lokalna || null;
}

function nettoIPodatekLinii(pozycja) {
  const maTotal = pozycja.total !== undefined && pozycja.total !== null;
  return {
    netto: Number(maTotal ? pozycja.total : (pozycja.subtotal ?? 0)) || 0,
    podatek: Number(maTotal ? (pozycja.total_tax ?? 0) : (pozycja.subtotal_tax ?? 0)) || 0,
  };
}

// BRUTTO CALEJ LINII, dokladnie tak, jak podaje je Woo — i to jest wartosc, ktora idzie
// na fakture (`gross_price` w inFakcie to SUMA LINII, nie cena za sztuke).
export function bruttoLinii(pozycja) {
  const { netto, podatek } = nettoIPodatekLinii(pozycja);
  return (netto + podatek).toFixed(2);
}

// NETTO CALEJ LINII — WPROST z Woo (`total`/`subtotal`, bez podatku), NIGDY dzieleniem
// brutto przez 1,23: to dokladnie ten blad, ktory juz raz zablokowal fakturowanie zamowien
// z rabatem (patrz przewodnik OMS, sekcja 4.5, i cenaJednostkowa nizej). Netto linii idzie
// do kolumny `pozycje.netto_linii` i do kolumny „Cena netto"/„Suma" na karcie.
export function nettoLinii(pozycja) {
  return nettoIPodatekLinii(pozycja).netto.toFixed(2);
}

// Cena jednostkowa sluzy WYLACZNIE widokowi. Faktura jej NIE uzywa i nie wolno do tego
// wrocic: dzielenie sumy linii przez ilosc i zaokraglanie do groszy GUBI INFORMACJE, ktorej
// nie da sie potem odtworzyc mnozeniem. Panel sam produkowal rozjazd, o ktory sam sie
// nastepnie odbijal na barierze arytmetycznej:
//   3 szt., linia 81,30 + VAT 18,70 = 100,00 (rabat 10%) -> 33,33 x 3 = 99,99 != 100,00
//   7 szt., 123,45 + 28,39 = 151,84                      -> 21,69 x 7 = 151,83 != 151,84
// Odmowa byla DETERMINISTYCZNA — ponowienie nie pomagalo, operator klikal w kolko ten sam
// komunikat, a sklep B2B z rabatami trafia na to regularnie.
function cenaJednostkowa(pozycja) {
  const ilosc = Number(pozycja.quantity) || 1;
  return (Number(bruttoLinii(pozycja)) / ilosc).toFixed(2);
}

// Cena jednostkowa NETTO — sam widok, ta sama zasada i to samo ostrzezenie co przy
// cenaJednostkowa: dzielenie NETTO LINII (nie brutta!) przez ilosc, nigdy dzielenie brutto
// przez stawke VAT. Faktura tej wartosci nie uzywa i nie ma prawa jej uzyc.
export function cenaJednostkowaNetto(pozycja) {
  const ilosc = Number(pozycja.quantity) || 1;
  return (Number(nettoLinii(pozycja)) / ilosc).toFixed(2);
}

// Koszt dostawy jest CZESCIA `total`, ale NIE ma go w `line_items`. Bez tego pola panel
// nie ma z czego zlozyc pozycji dostawy na fakturze, a suma pozycji nigdy nie zejdzie sie
// z kwota zamowienia (faktura zanizona o wysylke). Woo trzyma to na poziomie zamowienia
// jako `shipping_total` (netto) + `shipping_tax`; obie kolumny sa stringami.
export function kosztDostawyBrutto(surowe) {
  const netto = Number(surowe.shipping_total ?? 0) || 0;
  const podatek = Number(surowe.shipping_tax ?? 0) || 0;
  return (netto + podatek).toFixed(2);
}

// Koszt dostawy NETTO — WPROST `shipping_total`, bez doliczania `shipping_tax` (w
// odroznieniu od kosztDostawyBrutto wyzej). Zadnego dzielenia przez stawke VAT.
export function kosztDostawyNetto(surowe) {
  const netto = Number(surowe.shipping_total ?? 0) || 0;
  return netto.toFixed(2);
}

//  to CALA tablica dostaw sklepu (instancje + reguly zapasowe po pozycji) —
// patrz domain/mapowanie-wysylki.js. Wczesniej byla to sama mapa instancji, przez co
// zamowienia bez linii wysylki nie mialy jak zostac rozpoznane.
export function mapujZamowienie(surowe, mapowanie) {
  // ⚠️ PARA, nie napis (2026-08-01): rodzaj dostawy i pobranie sa od siebie niezalezne,
  // wiec rozpoznanie zwraca `{ metoda, pobranie }`. Rozpakowujemy TUTAJ, zeby dalej w tej
  // funkcji nie dalo sie przez pomylke wpisac calego obiektu do kolumny `metoda_wysylki`.
  const { metoda, pobranie } = metodaWysylkiZamowienia(surowe, mapowanie);
  const punkt = punktOdbioruZeSurowych(surowe);
  const fakturaMeta = meta(surowe, '_billing_faktura');
  const nip = meta(surowe, '_billing_nip') || null;
  // "0" jest w JS prawdziwe, a Woo zapisuje pola wyboru raz jako '', raz jako '0' —
  // bez tego wyjatku panel proponowalby fakture komus, kto jej nie chcial.
  //
  // `_billing_faktura` to pole WYLACZNIE ze sklepu A (Etap 2) — sklep B, jedyny
  // sklep dzialajacy dzis, w ogole go nie ustawia. Samo `fakturaMeta` jako warunek robilo
  // fakturowanie MARTWE na jedynym sklepie, dla ktorego je zbudowano: prawdziwe zamowienie
  // 1267 mialo `_billing_nip` i nazwe firmy, a mimo to `chce_fakture` wychodzilo 0 — sekcja
  // faktury w widoku w ogole sie nie renderowala. Dlatego liczy sie TAKZE sam NIP: nikt nie
  // wpisuje NIP-u firmy przy zamowieniu bez powodu. Pole `_billing_faktura` zostaje
  // (nietkniete) do Etapu 2, gdy sklep A wejdzie do panelu i checkbox znow bedzie mial
  // sens jako osobny sygnal.
  const chceFakture = (fakturaMeta && fakturaMeta !== '0') || nip ? 1 : 0;
  return {
    zrodlo_id: Number(surowe.id),
    numer: String(surowe.number ?? surowe.id),
    klient: surowe.billing ?? null,
    dostawa: surowe.shipping ?? null,
    metoda_wysylki: metoda,
    // ⚠️ TO SA PIENIADZE. Pobranie ma WLASNA kolumne i musi tu przejechac razem z metoda —
    // zgubione po drodze znaczy paczke nadana bez <cod>, czyli towar oddany za darmo.
    pobranie: pobranie ? 1 : 0,
    // Za pobraniem kurier inkasuje calosc zamowienia, nie samo "co zostalo". Pytamy
    // o POBRANIE, nie o nazwe dostawy — po rozdzieleniu tych dwoch nazwa nic juz o tym
    // nie mowi (kazdy kurier moze jechac i tak, i tak).
    kwota_pobrania: pobranie ? String(surowe.total) : null,
    // ⚠️ Kod paczkomatu jest ADRESEM tej przesyłki — bez niego zamówienia paczkomatowego
    // nie da się nadać. Czytamy go BEZWARUNKOWO, nie tylko przy rozpoznanej metodzie
    // paczkomatowej: meta i tak istnieje wyłącznie przy zamówieniach z paczkomatem, a
    // warunek na metodzie kasowałby dane przy każdej ręcznej korekcie dostawy w panelu.
    punkt_odbioru: punkt.kod,
    punkt_odbioru_opis: punkt.opis,
    chce_fakture: chceFakture,
    nip,
    kwota_brutto: String(surowe.total),
    koszt_dostawy_brutto: kosztDostawyBrutto(surowe),
    koszt_dostawy_netto: kosztDostawyNetto(surowe),
    status_woo: surowe.status ?? null,
    oplacone_at: utcSklepu(surowe.date_paid_gmt, surowe.date_paid),
    // Metoda platnosci ze sklepu — CZYTELNA nazwa (`payment_method_title`: „Przelewy24",
    // „Przelew tradycyjny"), nie identyfikator (`payment_method`: 'p24', 'bacs'). To pole
    // ogląda wyłącznie człowiek w tabeli wpłat na karcie, więc ma być tym, co widział
    // klient w sklepie. Idzie do wplaty zrodla 'sklep' (patrz db/platnosci.js).
    metoda_platnosci: surowe.payment_method_title || null,
    anulowane: surowe.status === 'cancelled' ? 1 : 0,
    utworzone_at: utcSklepu(surowe.date_created_gmt, surowe.date_created),
    // Uwagi klienta z zamówienia (Zadanie D) — Woo trzyma je na poziomie zamówienia jako
    // `customer_note`, NIE w meta_data (inaczej niz NIP/checa faktury wyzej). To dana ZE
    // SKLEPU jak reszta naglowka: poller ma ja nadpisywac normalnie, wiec CELOWO bez wlasnej
    // kolumny recznej. Pusty string (klient nic nie napisal) sklepowo znaczy „brak uwag" —
    // widok renderuje wiersz WYLACZNIE gdy jest prawdziwa tresc.
    uwagi: surowe.customer_note || null,
    // Znacznik zamowienia z panelu indywidualnego — liczony z SUROWEJ odpowiedzi sklepu
    // ta sama funkcja, co przeliczenie wstecz w db/db.js. Poller odswieza go przy kazdej
    // synchronizacji, bo oferta moze dojsc do zamowienia juz po jego zlozeniu.
    indywidualne: czyIndywidualneZeSurowych(surowe) ? 1 : 0,
    // Kupony rabatowe z coupon_lines (kampania WRZESIEN30) — ta sama funkcja, co
    // przeliczenie wstecz w db/db.js (domain/kupony.js). Informacja OPISOWA: ceny pozycji
    // ponizej sa juz PO rabacie, wiec kupon niczego w kwotach nie zmienia.
    kupony: kuponyZeSurowych(surowe),
    // Skad przyszedl kupujacy (WooCommerce Order Attribution) — ta sama funkcja, co
    // przeliczenie wstecz w db/db.js. `null` znaczy „sklep tego nie zapisal", a nie
    // „wejscie bezposrednie" (domain/atrybucja.js).
    atrybucja: atrybucjaZeSurowych(surowe),
    pozycje: (surowe.line_items ?? []).map((p) => ({
      // Identyfikator linii U ZRODLA. Sluzy do JEDNEJ rzeczy i trzeba o niej wiedziec:
      // jest TRWALYM kluczem recznych nadpisan tej pozycji (kluczPozycji
      // w domain/pozycje-reczne.js). Nasze `pozycje.id` sie do tego nie nadaje, bo poller
      // kasuje i wstawia pozycje sklepowe przy kazdej synchronizacji.
      zrodlo_id: Number.isInteger(Number(p.id)) ? Number(p.id) : null,
      nazwa: p.name,
      sku: p.sku || null,
      ilosc: Number(p.quantity) || 1,
      cena_brutto: cenaJednostkowa(p),
      // Odpowiednik netto — TA SAMA para (jednostkowa do widoku, linii do sumy/faktury),
      // liczona WPROST z Woo, nigdy dzieleniem brutto przez 1,23.
      cena_netto: cenaJednostkowaNetto(p),
      // Trzymane OBOK ceny jednostkowej, nie zamiast niej: cena sluzy widokowi, brutto linii
      // fakturze. Jedna kolumna nie moze naraz byc czytelna dla czlowieka i dokladna dla KSeF.
      brutto_linii: bruttoLinii(p),
      netto_linii: nettoLinii(p),
      vat: null,
      // Adres zdjęcia produktu — miniatura w kolumnie „Produkty" na stronie głównej.
      // Zapisujemy ORYGINAŁ tak, jak przyszedł; wariant 150×150 wyprowadza dopiero widok
      // (domain/miniatury.js), żeby poprawka tamtej reguły nie wymagała migracji danych.
      zdjecie_url: zdjecieLinii(p),
      // Identyfikator produktu w sklepie — wylacznie do odnosnika z miniatury na karcie
      // (domain/link-pozycji.js). ⚠️ product_id RODZICA, nigdy variation_id: adres wariantu
      // po identyfikatorze sie nie renderuje, a odnosnik raz dzialajacy, a raz nie, jest
      // gorszy niz jego brak. Brak wartosci ma dac NULL, a nie zero — „produkt numer 0"
      // nie istnieje, a odnoszacy sie do niego adres prowadzi donikad.
      // Ta sama regula stoi w przeliczeniu wstecz (produktLinii w db/db.js).
      produkt_id: Number.isInteger(Number(p.product_id)) && Number(p.product_id) > 0
        ? Number(p.product_id)
        : null,
      // PRZ-091: identyfikator WARIANTU — wylacznie do powiazania pozycji z karta produktu przy stanach
      // magazynowych (karta jest per wariant). Odnosnik dalej idzie po `produkt_id` rodzica (wyzej).
      // Produkt prosty ma `variation_id = 0` — to nie wariant, wiec `null`.
      wariant_id: Number.isInteger(Number(p.variation_id)) && Number(p.variation_id) > 0
        ? String(Number(p.variation_id))
        : null,
    })),
  };
}
