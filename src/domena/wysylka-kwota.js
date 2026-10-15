import { odczytajNadpisania, obiektAlboPusty } from './dane-reczne.js';
import { parsujCeneBrutto, parsujIlosc, znormalizujKwotowe } from './pozycje-reczne.js';

// ⚠️ PO CO TO ISTNIEJE (07.08.2026, prośba właściciela: „Nie mogę edytować ceny wysyłki do
// utworzonego zamówienia. Wysyłka powinna być edytowalna tak samo jak produkty. Ilość oraz
// cena").
//
// Do tego dnia wiersz „Wysyłka" na karcie był TYLKO DO ODCZYTU i było to zapisane wprost
// jako decyzja („nikt o to nie prosił, a każde dodatkowe pole dotykające kwoty to kolejne
// miejsce, w którym można się pomylić o pieniądze"). Prośba zdejmuje pierwszą połowę tego
// zdania; druga została i to ona wyznaczyła kształt tego modułu.
//
// ⚠️ POPRAWKA NIE MOŻE MIESZKAĆ W `zamowienia.koszt_dostawy_brutto`. To jest kolumna SKLEPU
// i poller przepisuje ją przy każdej synchronizacji (UPDATE w db/zamowienia.js) — czyli co
// dwie minuty. Wpisana tam działałaby w testach i znikała na produkcji, zanim ktokolwiek
// zdążyłby wystawić fakturę. Dokładnie ta sama pułapka, co przy pozycjach i przy danych
// klienta (przewodnik OMS, 4.7).
//
// ⚠️ DLACZEGO `pozycje_reczne_json`, A NIE NOWA KOLUMNA. Wysyłka jest na karcie WIERSZEM
// TABELI POZYCJI i edytuje się ją tym samym formularzem, tym samym przyciskiem „Zapisz
// pozycje" i tym samym jednym zapisem do bazy. Osobna kolumna znaczyłaby drugi zapis w tej
// samej operacji — czyli stan, w którym pozycje zapisały się, a wysyłka nie.
//
// Klucz `wysylka` NIE MOŻE zderzyć się z kluczem pozycji: `kluczPozycji` produkuje wyłącznie
// `s<id>`, `r<id>` i `p<index>` (domain/pozycje-reczne.js), a `nalozNadpisaniaPozycji`
// chodzi po LIŚCIE POZYCJI, więc klucz, do którego nie ma wiersza, jest tam bezczynny.
export const KLUCZ_WYSYLKI = 'wysylka';

// ⚠️ NAZWY WYSYŁKI NIE MA NA LIŚCIE PÓL i to jest decyzja, nie przeoczenie. Na fakturze ta
// linia nazywa się „Dostawa" (domain/pozycje-faktury.js), na karcie „Wysyłka" — nazwa jest
// tu ETYKIETĄ USŁUGI, a nie uzgodnieniem z klientem. Edytowalna rozjechałaby oba te miejsca
// i dała trzecią nazwę tego samego wiersza. Właściciel poprosił dokładnie o dwa pola:
// „Ilość oraz cena".
export const POLA_WYSYLKI = ['ilosc', 'cena_brutto'];

// Wartości SKLEPOWE czytamy idempotentnie — dokładnie tak, jak `zeSklepu` w domain/wysylka.js
// i z tego samego powodu: te funkcje wołane są ZARÓWNO na surowym wierszu z bazy, JAK
// I na wierszu przepuszczonym przez `zLinii`, gdzie `koszt_dostawy_brutto` jest już
// wartością EFEKTYWNĄ, a sklepowa leży obok w `koszt_dostawy_brutto_sklep`.
//
// Bez tego nakładka policzyłaby się DRUGI RAZ na własnym wyniku: cena podniesiona raz
// rosłaby przy każdym odczycie, a różnica w `kwotaOczekiwanaGrosze` wyszłaby zerowa —
// czyli bariera arytmetyczna faktury przepuściłaby kwotę, której nikt nie zatwierdził.
const zeSklepu = (z, pole) => (z && Object.hasOwn(z, `${pole}_sklep`) ? z[`${pole}_sklep`] : z?.[pole]);

const nadpisanie = (z) => obiektAlboPusty(odczytajNadpisania(z?.pozycje_reczne_json)[KLUCZ_WYSYLKI]);

/**
 * Wysyłka WEDŁUG SKLEPU — jedna sztuka jednej usługi, po cenie z kolumny.
 *
 * Ilość 1 nie jest tu wartością „domyślną do zmiany": sklep pojęcia ilości przesyłek nie ma
 * i mieć nie będzie. Zamówienie ze sklepu ma jedną dostawę i jedną kwotę za nią — liczba
 * paczek to nasza decyzja, podejmowana już po złożeniu zamówienia.
 */
export function wysylkaZeSklepu(zamowienie) {
  return {
    ilosc: 1,
    cena_brutto: zeSklepu(zamowienie, 'koszt_dostawy_brutto') ?? null,
    cena_netto: zeSklepu(zamowienie, 'koszt_dostawy_netto') ?? null,
  };
}

/**
 * Wysyłka, którą panel uważa za prawdziwą: sklep plus ręczna poprawka.
 *
 * Nadpisanie jest POLOWE — `{"wysylka":{"ilosc":2}}` znaczy „dwie paczki po cenie ze
 * sklepu", a nie „zamroź też cenę". Ta sama zasada, co przy pozycjach i przy danych klienta:
 * gdyby w kolumnie leżała kopia całego wiersza, zmiana samej ilości zamrażałaby cenę na
 * zawsze i obniżka dostawy w sklepie nigdy by już nie doszła.
 */
export function wysylkaEfektywna(zamowienie) {
  const sklep = wysylkaZeSklepu(zamowienie);
  const n = nadpisanie(zamowienie);
  const efektywna = { ...sklep };
  for (const pole of POLA_WYSYLKI) {
    if (Object.hasOwn(n, pole)) efektywna[pole] = n[pole];
  }
  efektywna.ilosc = Number(efektywna.ilosc);

  // Liczone z PORÓWNANIA WARTOŚCI, nie z obecności klucza — gdy sklep dogoni ręczną
  // poprawkę, nie ma już czego oznaczać (ta sama zasada, co przy pozycjach).
  const sklepNorm = znormalizujKwotowe(sklep);
  const efektNorm = znormalizujKwotowe(efektywna);
  efektywna.polaZmienione = POLA_WYSYLKI.filter(
    (pole) => String(sklepNorm[pole] ?? '') !== String(efektNorm[pole] ?? ''),
  );

  // ⚠️ NETTO ZE SKLEPU ZNIKA RAZEM ZE ZMIANĄ KWOTY i to jest świadome — dokładnie jak przy
  // przecenionej pozycji (`nalozNadpisaniaPozycji`). `koszt_dostawy_netto` jest wartością
  // ŹRÓDŁOWĄ z Woo (przewodnik 4.5), więc po zmianie ceny albo liczby paczek po prostu do
  // tej linii nie pasuje. Kolumnę netto liczy wtedy widok, ze stawki VAT (domain/vat.js) —
  // jawnie i wyłącznie do pokazania. Do inFaktu i tak jedzie brutto.
  if (efektywna.polaZmienione.length) efektywna.cena_netto = null;
  return efektywna;
}

/** Czy wysyłka ma ręczną poprawkę — steruje oznaczeniem na karcie i przyciskiem przywrócenia. */
export const wysylkaZmienionaRecznie = (z) => wysylkaEfektywna(z).polaZmienione.length > 0;

/**
 * Wiersz wysyłki z formularza „Edytuj pozycje" — DOKŁADNIE te same walidatory, co przy
 * pozycjach (`parsujIlosc`, `parsujCeneBrutto` w domain/pozycje-reczne.js).
 *
 * ⚠️ Cena zero rozstrzyga się WOBEC SKLEPU — dlatego ta funkcja wymaga wiersza sklepowego
 * (`wysylkaZeSklepu`). Wpisanie zera tam, gdzie sklep policzył dostawę, znaczy „zabierz
 * klientowi koszt, który sklep policzył" — obniżenie kwoty oczekiwanej od klienta, czyli
 * decyzja o pieniądzach, i dalej jest ODMOWĄ. Zero tam, gdzie sklep TEŻ ma zero, jest
 * przepisaniem wartości, którą formularz sam wyświetlił, i przechodzi.
 *
 * ⚠️⚠️ POPRZEDNIA WERSJA TEGO KOMENTARZA TWIERDZIŁA, ŻE PRZYPADEK DARMOWEJ DOSTAWY JEST JUŻ
 * OBSŁUŻONY — „nadpisanie zerowe wychodzi z `rozniceWysylki` jako brak zmiany". To była
 * nieprawda i kosztowała usterkę na produkcji (zam. 1192, 20.08.2026): `rozniceWysylki`
 * liczy się DOPIERO PO tym parserze, więc gałąź, na którą się powoływał, była nieosiągalna.
 * Parser rzucał wyjątkiem wcześniej i wywracał CAŁY zapis pozycji — w zamówieniu z darmową
 * dostawą nie dało się poprawić żadnego produktu. Zdanie w komentarzu nie jest testem;
 * pilnuje tego teraz tests/oms/wysylka-kwota.test.js.
 */
export function parsujEdycjeWysylki(body, wysylkaSklepu) {
  return {
    ilosc: parsujIlosc(body?.ilosc),
    cena_brutto: parsujCeneBrutto(body?.cena_brutto, { cenaSklepu: wysylkaSklepu?.cena_brutto }),
  };
}

/**
 * Co zapisać pod kluczem `wysylka`: WYŁĄCZNIE pola odbiegające od sklepu — ta sama zasada
 * i ten sam powód, co przy `roznicePozycji`. Przeglądarka odsyła komplet pól, więc zapis
 * całości zamrażałby cenę dostawy, której nikt nie tknął.
 *
 * Pusty wynik KASUJE nadpisanie (`ustawWMapie`), czyli jest jednocześnie „przywróć wysyłkę
 * ze sklepu": wpisanie z powrotem sklepowej ceny i jedynki sprząta po sobie samo.
 */
export function rozniceWysylki(zeSklepuWiersz, zFormularza) {
  const sklep = znormalizujKwotowe(zeSklepuWiersz);
  const wynik = {};
  for (const pole of POLA_WYSYLKI) {
    if (String(sklep[pole] ?? '') !== String(zFormularza?.[pole] ?? '')) wynik[pole] = zFormularza[pole];
  }
  return wynik;
}
