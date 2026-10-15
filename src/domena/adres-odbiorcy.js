import { odczytajNadpisania, zastosuj, polaZmienione, sklejUlice } from './dane-reczne.js';

// Adres odbiorcy skladany W JEDNYM MIEJSCU z danych zamowienia (blok `dostawa` to Woo
// `shipping`, `klient` to Woo `billing`). Uzywaja go DWIE strony, ktore MUSZA pokazac
// dokladnie to samo: ekran nadania (GET /zamowienia/:id/nadaj — ostatnie miejsce, w
// ktorym czlowiek widzi adres PRZED nieodwracalnym wywolaniem DPD) i klient DPD
// (src/oms/kurierzy/dpd.js, ktory z tych samych danych sklada koperte SOAP).
//
// Rozdzielenie tego na dwie niezalezne kopie bylo bledem, ktory caly ekran nadania mial
// zamknac: przy pierwszej rozbieznosci pol zrodlowych (np. ktos przy okazji poprawki
// zmienilby jedna strone na inne pole Woo) ekran zaczalby operatorowi KLAMAC — pokazywalby
// jeden adres, a do kuriera pojechalby inny. To jedyny powod istnienia tego ekranu, wiec
// rozjazd unicestwiaby cala jego wartosc.
//
// ⚠️ Od Zadania „edytowalne dane klienta" ta funkcja nakłada na dane ze sklepu RĘCZNE
// POPRAWKI operatora (kolumna `dostawa_reczna_json`, patrz domain/dane-reczne.js) — i to
// jest cały powód, dla którego robi to WŁAŚNIE ona, a nie osobny kawałek kodu przy karcie:
// karta, ekran nadania i klient DPD mają widzieć jeden i ten sam adres. Gdyby poprawkę
// nakładała tylko karta, operator poprawiłby kod pocztowy, zobaczyłby go na ekranie
// i wysłał paczkę pod stary — czyli dokładnie ta edycja POZORNA, której ten panel
// ma nie dopuszczać.

// Pola adresu wysyłki, które operator może poprawić na karcie zamówienia. `kraj` CELOWO
// nie jest tu wymieniony: panel obsługuje wyłącznie przesyłki krajowe (sessionType zaszyty
// na DOMESTIC w kurierzy/dpd.js), więc jego zmiana nie miałaby jak zadziałać, a odmowa
// dla kraju ≠ PL musi zostać nietknięta.
export const POLA_ADRESU_RECZNE = ['nazwa', 'company', 'ulica', 'kod', 'miasto', 'phone', 'email'];

// Ten sam adres w obu blokach? Porównanie po ulicy, kodzie i mieście, znormalizowane
// (małe litery, bez nadmiarowych spacji, kod bez myślnika) — klient wpisuje te same dane
// dwa razy i drobne różnice zapisu nie znaczą, że to inne miejsce.
const norma = (v) => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const kodNorma = (v) => String(v ?? '').replace(/\D+/g, '');

function tenSamAdres(d, k) {
  return norma(sklejUlice(d?.address_1, d?.address_2)) === norma(sklejUlice(k?.address_1, k?.address_2))
    && kodNorma(d?.postcode) === kodNorma(k?.postcode)
    && norma(d?.city) === norma(k?.city);
}

/**
 * Firma z bloku PŁATNOŚCI, gdy blok wysyłki jej nie ma.
 *
 * ⚠️ PO CO. WooCommerce potrafi wypełnić `shipping` imieniem, adresem i telefonem, ale
 * ZOSTAWIĆ `shipping.company` PUSTE, mimo że klient podał firmę przy płatności — pole po
 * prostu nie kopiuje się między blokami. Panel pokazywał wtedy jako „Firma" IMIĘ I NAZWISKO
 * (ostateczny fallback dla DPD, dziś zdjęty stąd na granicę kuriera — patrz komentarz nad
 * adresZeSklepu()) i paczka jechała do firmy bez jej nazwy na etykiecie. Zmierzone na
 * prawdziwym zamówieniu 1277: `shipping.company` puste,
 * `billing.company` = „Gammatech Spółka Sp. z o.o. Sp. K".
 *
 * ⚠️ Ta reguła ZOSTAJE nietknięta po zdjęciu fallbacku: to dana ze sklepu, nie podstawienie.
 *
 * ⚠️ TYLKO GDY ADRES JEST TEN SAM. Paczka bywa wysyłana pod adres montażu, a faktura idzie
 * na siedzibę — wtedy nazwa firmy z płatności na etykiecie pod inny adres byłaby zwykłym
 * błędem, i to takim, którego nikt by nie zauważył.
 */
function firmaZPlatnosci(d, klient) {
  if (!klient?.company) return null;
  return tenSamAdres(d, klient) ? klient.company : null;
}

// Adres wprost ze sklepu. ⚠️ `company` zostaje PUSTE (null), gdy klient firmy nie podał —
// fallback na imię i nazwisko mieszka na GRANICY, nie tutaj (patrz komentarz nad
// adresZeSklepu()). Pusty string byłby tu błędem: dpd.js sięga po nazwisko przez
// `a.company ?? a.nazwa`, a `??` łapie null/undefined, ale NIE ''.
function surowyAdres(zamowienie) {
  const d = zamowienie?.dostawa ?? {};
  const klient = zamowienie?.klient ?? {};

  // Puste, male litery i otoczone spacjami MUSZA znaczyc PL, nie „obcy kraj": zamowienie
  // zalozone w adminie sklepu (albo import) potrafi miec CALKOWICIE pusty blok `shipping`,
  // a wtedy country="" wygladaloby jak przesylka zagraniczna, choc prawdziwa przyczyna to
  // brak adresu. Normalizacja siedzi TUTAJ, nie w dpd.js, zeby ekran i kurier widzialy
  // dokladnie ten sam kraj — dpd.js dalej odmawia nadania, gdy wynik nie jest 'PL'.
  return {
    nazwa: `${d.first_name ?? ''} ${d.last_name ?? ''}`.trim(),
    company: d.company || firmaZPlatnosci(d, klient),
    // Numer budynku bywa OSOBNYM polem sklepu (address_2, patrz sklejUlice w dane-reczne.js)
    // — sklejamy tu, w JEDYNYM miejscu, żeby karta, ekran nadania i klient DPD zawsze widziały
    // ten sam adres (patrz nagłówek modułu).
    ulica: sklejUlice(d.address_1, d.address_2),
    kod: d.postcode || null,
    miasto: d.city || null,
    kraj: String(d.country ?? '').trim().toUpperCase() || 'PL',
    phone: klient.phone || null,
    email: klient.email || null,
  };
}

// ⚠️ FALLBACK FIRMY NA IMIĘ I NAZWISKO STAŁ TUTAJ I ZOSTAŁ STĄD ZDJĘTY (2026-08-05).
// DPD wymaga niepustego <company> na etykiecie i podstawienie nazwiska jest dalej
// potrzebne — ale NIE we wspólnym źródle dla karty, ekranu nadania i klienta kuriera.
// Stąd wychodziło ono na EKRAN: pole „Firma" pokazywało imię i nazwisko przy każdym
// zamówieniu od osoby prywatnej (zgłoszenie właściciela ze zrzutu, 2026-08-04).
//
// To nie była kosmetyka. Operator, który wykasował nazwisko z pola „Firma", widział, że
// pole WRACA do tej samej wartości i NIE dostaje znacznika „zmienione ręcznie" — czyli
// kliknięcie wyglądało na bezskuteczne. A w bazie leżało już `{"company": null}`, które
// od tej chwili BLOKOWAŁO prawdziwą nazwę firmy, gdyby ta kiedyś przyszła ze sklepu:
// zamówienie z `shipping.company = "Gammatech Sp. z o.o."` oddawało z powrotem nazwisko
// i paczka jechała do firmy bez jej nazwy na etykiecie.
//
// Fallback mieszka teraz na DWÓCH GRANICACH, każda z własnym testem:
//   • kurierzy/dpd.js — `a.company ?? a.nazwa` (ścieżka do etykiety, także HURTEM, gdzie
//     formularza w ogóle nie ma: trasa masowa woła nadanie.nadaj z `adres: adresOdbiorcy(z)`);
//   • domain/adres-formularza.js — `tekst(dane?.company) || nazwa` (pole zostawione puste
//     na ekranie nadania).
// Warunek `company && company !== nazwa` w kurierzy/inpost.js ZOSTAJE: broni już nie tej
// funkcji, tylko ścieżki formularzowej, gdzie fallback nakłada adres-formularza.js.

/** Adres DOKŁADNIE taki, jaki przyszedł ze sklepu — bez ręcznych poprawek. Służy do
 *  porównania („co operator zmienił") i do przywracania, NIE do nadawania paczki. */
export function adresZeSklepu(zamowienie) {
  return surowyAdres(zamowienie);
}

/** Adres, który panel uważa za prawdziwy: wartość ręczna, jeśli jest; inaczej ze sklepu. */
export function adresOdbiorcy(zamowienie) {
  const nadpisania = odczytajNadpisania(zamowienie?.dostawa_reczna_json);
  return zastosuj(surowyAdres(zamowienie), nadpisania, POLA_ADRESU_RECZNE);
}

/** Pola adresu odbiegające od sklepu — dostają na karcie oznaczenie „zmienione ręcznie". */
export function polaReczneAdresu(zamowienie) {
  return polaZmienione(adresZeSklepu(zamowienie), adresOdbiorcy(zamowienie), POLA_ADRESU_RECZNE);
}

// Pola, ktorych DPD wymaga do nadania. Puste `shipping` (zamowienie zalozone recznie
// w adminie sklepu, import) przechodzi przez baze bez zadnego bledu i ujawnia sie
// dopiero tutaj — ekran nadania ma to pokazac operatorowi PRZED zatwierdzeniem,
// nie dopiero jako odrzucenie z DPD po kliknieciu.
export const POLA_WYMAGANE_PRZEZ_DPD = ['ulica', 'kod', 'miasto'];

export function brakujacePolaAdresu(adres) {
  return POLA_WYMAGANE_PRZEZ_DPD.filter((pole) => !adres?.[pole]);
}
