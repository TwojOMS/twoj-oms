// Okna pobrania i regula stronicowania dla zapytan KSeF v2 (POST /invoices/query/metadata).
// Modul czysto domenowy: bez sieci, bez bazy, bez zaleznosci od innych modulow.

// PODLOGA JEST STALA W KODZIE, NIE ZMIENNA SRODOWISKOWA - i to jest decyzja, nie wygoda.
// Lekcja z SHOP_<SKLEP>_OD: podloga zyjaca w .env bywa przestawiana "na chwile", a jedno
// takie przestawienie wciaga archiwum i po cichu przelicza raporty.
export const PODLOGA_KOSZTOW = '2026-01-01T00:00:00Z';

// Limit MF: zakres dateRange nie moze przekroczyc 3 miesiecy.
const MIESIECY_W_OKNIE = 3;

// ⚠️⚠️ ZAPAS PRZED KURSOREM — I TO JEST WARUNEK POPRAWNOSCI, A NIE OSTROZNOSC (recenzja, K1).
//
// Kursor to MAKSIMUM `permanentStorageDate` dokumentow, KTORE WROCILY Z ZAPYTANIA. Okno
// zaczynajace sie dokladnie na nim zaklada, ze KSeF pokazal juz wszystko, co ma date wczesniejsza
// — a tego nikt nam nie obiecal. Trzy drogi, kazda konczaca sie tak samo:
//   • OPOZNIENIE INDEKSU po stronie MF: dokument ma date trwalego zapisu sprzed godziny,
//     ale w wynikach zapytania pojawia sie pozniej;
//   • DWA DOKUMENTY Z IDENTYCZNYM ZNACZNIKIEM CZASU, z ktorych tylko jeden zmiescil sie
//     w przeczytanej stronie;
//   • `from` okazujace sie WYLACZAJACE (dokumentacja MF tego nie rozstrzyga, a my nie
//     zmierzylismy tego na zywym API).
// W kazdej z nich dokument nie trafi juz do ZADNEGO przyszlego okna, bo kursor nad nim
// przeskoczyl, a podloga zabrania cofania sie recznie. Objaw: zanizona suma miesiaca, bez ani
// jednego bledu — czyli dokladnie ta awaria, przed ktora broni caly ten modul.
//
// DLACZEGO TYDZIEN, A NIE „na styk". Ponowne przeczytanie tych samych dokumentow jest DARMOWE:
// deduplikacja siedzi w bazie (`INSERT OR IGNORE` po `ksef_number`, db/koszty.js), a XML raz
// zarchiwizowany nie pobiera sie drugi raz (bramka po `sciezka_xml`). Cena to WYLACZNIE ruch:
// przy kilkudziesieciu fakturach kosztowych na miesiac tydzien zapasu miesci sie w JEDNEJ
// stronie odpowiedzi (250 rekordow, ksef/client.js). Skoro zapas nic nie kosztuje, dobieramy go
// tak, zeby przykryl takze awarie kilkudniowa (weekend + noc, w ktorej pobranie sie nie udalo),
// a nie tylko opoznienie liczone w godzinach. Zapas krotszy niz doba nie mialby sensu — okno
// pobrania jest raz na dobe.
export const ZAPAS_KURSORA_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Poczatek okna przyrostowego: kursor cofniety o zapas, nigdy ponizej podlogi.
 *
 * `teraz` jest OPCJONALNE i sluzy jednej rzeczy — kursorowi Z PRZYSZLOSCI (recenzja, D1).
 * Kursor pozniejszy niz biezaca chwila (skew zegara kontenera, data z KSeF w innej strefie)
 * dawal `podzielNaOkna` zakres pusty, czyli czuwacza, ktory NIE ROBI NIC — na zawsze, bez
 * bledu i bez sladu. Zamiast tego czytamy ostatni odcinek zapasu: dokumenty w nim znalezione
 * postawia kursor z powrotem na prawdziwej dacie, wiec stan naprawia sie sam.
 */
export function odKursora(kursor, teraz = null) {
  const podloga = new Date(PODLOGA_KOSZTOW).getTime();
  // Kursor nieczytelny (`NaN`) to ta sama cisza, co kursor z przyszlosci: `new Date(NaN)`
  // przegrywa kazde porownanie w `podzielNaOkna` i oddaje pusta liste okien. Czytamy wtedy
  // od podlogi — dublety sa darmowe, dziura w kosztach nie.
  let od = new Date(kursor ?? '').getTime();
  if (!Number.isFinite(od)) return PODLOGA_KOSZTOW;
  const koniec = teraz === null ? NaN : new Date(teraz).getTime();
  if (Number.isFinite(koniec) && od > koniec) od = koniec;
  od -= ZAPAS_KURSORA_MS;
  return od <= podloga ? PODLOGA_KOSZTOW : new Date(od).toISOString();
}

// Dodaje N miesiecy do daty bez przepelnienia. Samo setUTCMonth() potrafi sie przelac na
// kolejny miesiac, gdy miesiac docelowy jest krotszy niz dzien startowy - np. 31 stycznia +
// 3 miesiace celuje w "31 kwietnia" (ktorego nie ma), a JS po cichu przeskakuje na 1 maja.
// Wtedy okno KSeF wychodzi DLUZSZE niz limit 3 miesiecy i zapytanie zostanie odrzucone.
// Wykrywamy przepelnienie porownujac dzien miesiaca po przesunieciu - jesli sie nie zgadza,
// cofamy na ostatni dzien miesiaca docelowego (setUTCDate(0) = dzien przed 1. dniem biezacego
// miesiaca, czyli ostatni dzien miesiaca poprzedniego).
function dodajMiesiaceBezPrzepelnienia(data, liczbaMiesiecy) {
  const docelowyDzien = data.getUTCDate();
  const wynik = new Date(data);
  wynik.setUTCMonth(wynik.getUTCMonth() + liczbaMiesiecy);
  if (wynik.getUTCDate() !== docelowyDzien) {
    wynik.setUTCDate(0);
  }
  return wynik;
}

export function podzielNaOkna(od, doo) {
  const koniec = new Date(doo);
  const okna = [];
  let start = new Date(od);
  while (start < koniec) {
    const nastepny = dodajMiesiaceBezPrzepelnienia(start, MIESIECY_W_OKNIE);
    const stop = nastepny < koniec ? nastepny : koniec;
    okna.push({ from: start.toISOString(), to: stop.toISOString() });
    start = stop;
  }
  return okna;
}

// Petla wprost z dokumentacji MF (POST /invoices/query/metadata).
export function nastepnyKrok({ hasMore, isTruncated, pageOffset, ostatniaData }) {
  if (!hasMore) return { koniec: true };
  if (!isTruncated) return { pageOffset: pageOffset + 1 };
  if (!ostatniaData) {
    // Bez ostatniaData nie da sie bezpiecznie przesunac okna - { from: undefined } dalej
    // robi z tego new Date(undefined) (Invalid Date) i cichutko pusta liste okien: pobieranie
    // konczy sie bez bledu, a w mirrorze zostaje dziura. Dziura w kosztach to zanizona suma
    // w raporcie zarzadczym podana z pelnym przekonaniem, wiec przerywamy z halasem.
    throw new Error(
      'nastepnyKrok: KSeF zwrocil isTruncated=true bez ostatniaData - nie mozna bezpiecznie ' +
        'przesunac okna pobierania. Przerywam, zeby nie zostawic cichej dziury w kosztach.'
    );
  }
  // ZEROWANIE STRONY JEST OBOWIAZKOWE. Przesuniete okno z zachowanym offsetem przeskakuje
  // dokladnie tyle faktur, ile stron zdazylismy przeczytac - i robi to bez bledu.
  return { from: ostatniaData, pageOffset: 0 };
}
