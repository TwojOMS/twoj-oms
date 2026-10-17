import { DOSTAWY } from './nowe-zamowienie.js';
import { grosze, zl } from './kwoty.js';
import { liczbaDodatnia } from './paczka.js';
import { PACZKA_DOMYSLNA, odczytajSzablony } from './szablony-paczek.js';
export { PACZKA_DOMYSLNA } from './szablony-paczek.js';

// USTAWIENIA PANELU — czysta reguła (2026-08-17). Bez bazy i bez zegara: `zapis` to zwykły
// obiekt klucz → tekst, wczytany przez db/ustawienia.js.
//
// ⚠️⚠️ BRAK WIERSZA ZNACZY DZISIEJSZĄ WARTOŚĆ, NIGDY ZERO. Fallbacki poniżej są jedynym
// powodem, dla którego wdrożenie tej zmiany NICZEGO nie zmienia: baza po wdrożeniu jest pusta,
// więc każda wartość idzie stąd. „Brak → 0 zł" i „brak → paczka 0×0×0" to nie są warianty
// domyślne, tylko ciche błędy o pieniądze i o przesyłki.
//
// ⚠️ FALLBACK DZIAŁA PER POLE, nie per formularz. Jeden zepsuty wiersz (ręczny UPDATE,
// nieudana migracja) ma zabrać JEDNĄ wartość, a nie zwalić całej paczki do stałych.

/**
 * Waga i wymiary, którymi startuje formularz nadania.
 *
 * ⚠️ TO NIE SĄ WYMIARY KARTONU. Gabaryt startowy jest dla PŁASKIEJ paczki wielkoformatowej,
 * więc 110 × 75 × 1 cm jest poprawnym gabarytem, mimo że wygląda nietypowo. Stała mieszkała
 * do 2026-08-17 w services/nadanie.js i jest stamtąd re-eksportowana — kilkanaście miejsc
 * (w tym testy) czyta ją tamtą drogą.
 */

/**
 * Koszt dostawy, którym startuje ekran zakładania zamówienia — w groszach.
 *
 * ⚠️ TA SAMA WARTOŚĆ DLA KAŻDEJ METODY i to jest świadome. Do 2026-08-17 widok wpisywał
 * `19,00` niezależnie od metody, także przy paczkomacie (który w sklepie kosztuje 13 zł) —
 * i właśnie po to powstała ta zakładka. Ale fallback ma ODTWARZAĆ dzisiejsze zachowanie,
 * nie poprawiać go po cichu: 13 zł przy paczkomacie wpisuje człowiek, raz, i widzi, że wpisał.
 */
export const KOSZT_DOSTAWY_DOMYSLNY_GR = 1900;

const ETYKIETY_PACZKI = {
  waga: 'waga (kg)', dlugosc: 'długość (cm)', szerokosc: 'szerokość (cm)', wysokosc: 'wysokość (cm)',
};

/** Grosze z zapisu — liczba całkowita nieujemna albo `null`, gdy wartości nie ma lub jest zepsuta. */
function groszeZZapisu(surowa) {
  const tekst = String(surowa ?? '').trim();
  if (!tekst) return null;
  const liczba = Number(tekst);
  return Number.isInteger(liczba) && liczba >= 0 ? liczba : null;
}

/** Waga i wymiary do formularza nadania — cztery liczby, zawsze komplet. */
export function domyslnaPaczka(zapis = {}) {
  const stan = odczytajSzablony(zapis);
  const { waga, dlugosc, szerokosc, wysokosc } = stan.szablony.find((s) => s.id === stan.domyslnyId);
  return { waga, dlugosc, szerokosc, wysokosc };
}

/**
 * Kwoty dla WSZYSTKICH metod naraz, w postaci gotowej do wpisania w pole formularza
 * (przecinek dziesiętny, dwa miejsca).
 *
 * ⚠️ JEDNA FUNKCJA NA POLE STARTOWE I NA MAPĘ DLA PRZEGLĄDARKI. Ekran zakładania zamówienia
 * dostaje stąd i wartość początkową, i mapę metoda → kwota dla skryptu przełączającego —
 * dwa źródła rozjechałyby się przy pierwszej zmianie ustawienia, a objawem byłaby kwota,
 * która zmienia się po ruszeniu listy rozwijanej i wraca po odświeżeniu strony.
 *
 * ⚠️ WARTOŚCI SĄ FORMATOWANE Z LICZBY, nigdy przepisane z zapisu. To jest jedyny powód,
 * dla którego mapa może pojechać do HTML-a przez `JSON.stringify` bez ucieczki: cokolwiek
 * siedzi w bazie, stąd wychodzą wyłącznie cyfry i przecinek.
 */
export function kwotyDostawy(zapis = {}) {
  const kwoty = {};
  for (const metoda of Object.keys(DOSTAWY)) {
    const gr = groszeZZapisu(zapis[`dostawa.${metoda}`]) ?? KOSZT_DOSTAWY_DOMYSLNY_GR;
    kwoty[metoda] = zl(gr).replace('.', ',');
  }
  return kwoty;
}

/** Kwota JEDNEJ metody. Metoda spoza listy dostaje wartość domyślną, nigdy `undefined`. */
export function kosztDostawy(zapis = {}, metoda) {
  return kwotyDostawy(zapis)[metoda] ?? zl(KOSZT_DOSTAWY_DOMYSLNY_GR).replace('.', ',');
}

/**
 * Formularz „Domyślna paczka" → { wartosci, bledy }.
 *
 * ⚠️ ODMOWA JEST CAŁOŚCIOWA: `wartosci` jest puste, gdy choć jedno pole jest złe. Zapisanie
 * trzech boków i odrzucenie czwartego dałoby paczkę, której nikt świadomie nie ustawił —
 * a ta paczka jedzie do DPD i jest rozliczana po gabarycie.
 */
export function sprawdzPaczke(formularz = {}) {
  const wartosci = {};
  const bledy = [];
  for (const [pole, etykieta] of Object.entries(ETYKIETY_PACZKI)) {
    const liczba = liczbaDodatnia(formularz[pole]);
    if (liczba === null) bledy.push(`${etykieta} — wpisz liczbę większą od zera.`);
    else wartosci[`paczka.${pole}`] = String(liczba);
  }
  return bledy.length ? { wartosci: {}, bledy } : { wartosci, bledy };
}

/**
 * Formularz „Koszty dostawy" → { wartosci, bledy }. Kwoty schodzą do groszy.
 *
 * ⚠️ PUSTE POLE TO ODMOWA, NIE ZERO — i to jest INNA zasada niż przy kwocie pojedynczego
 * zamówienia (domain/koszt-dostawy.js: puste znaczy zero). Tam człowiek wpisuje kwotę JEDNEGO
 * zamówienia i widzi ją na ekranie; tutaj ustawia wartość startową dla wszystkich następnych,
 * więc przypadkowo wyczyszczone pole robiłoby dostawę darmową na miesiące, po cichu.
 *
 * ⚠️ ZERO PRZYJMUJEMY. Odbiór osobisty naprawdę nic nie kosztuje i musi dać się to wpisać.
 */
export function sprawdzKoszty(formularz = {}) {
  const wartosci = {};
  const bledy = [];
  for (const [metoda, etykieta] of Object.entries(DOSTAWY)) {
    const surowa = formularz[metoda];
    // Przecinek dziesiętny przyjmujemy z tego samego powodu, co przy wadze paczki i przy
    // kwocie pobrania: to polska klawiatura, nie błąd wpisu.
    const tekst = String(surowa ?? '').trim().replace(',', '.');
    if (!tekst) {
      bledy.push(`${etykieta} — wpisz kwotę (0,00 znaczy „bez opłaty”).`);
      continue;
    }
    const liczba = Number(tekst);
    if (!Number.isFinite(liczba) || liczba < 0) {
      bledy.push(`${etykieta} — „${surowa}” nie jest kwotą (podaj liczbę nieujemną).`);
      continue;
    }
    // `grosze()` TA SAMA funkcja, która liczy barierę arytmetyczną faktury — zaokrąglenie
    // do grosza musi być identyczne wszędzie.
    wartosci[`dostawa.${metoda}`] = String(grosze(tekst, `koszt dostawy (${etykieta})`));
  }
  return bledy.length ? { wartosci: {}, bledy } : { wartosci, bledy };
}
