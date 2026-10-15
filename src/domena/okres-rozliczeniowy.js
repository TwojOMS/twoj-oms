import { dzienWarszawa } from './format-daty.js';
import { stanFaktury } from './faktura-stan.js';

// Okres rozliczeniowy: miesiac, ktorego zamowienia skladaja sie na JEDNA fakture.
//
// ⚠️ PRZYPISANIE IDZIE PO DACIE ZLOZENIA, nie po dacie wysylki (decyzja wlasciciela
// 2026-08-01). Zamowienie z 31 lipca wyslane 2 sierpnia nalezy do LIPCA — klient dzieli
// swoje zamowienia tak, jak je sklada, i faktura ma sie z tym zgadzac.
export const STAN = {
  OTWARTY: 'otwarty',
  ZAMKNIETY: 'zamkniety',
  ZAFAKTUROWANY: 'zafakturowany',
};

// ⚠️ EKSPORTOWANE, bo widoki okresu (okres.ejs, okresy-lista.ejs) mialy WLASNE kopie tej
// listy. Trzy kopie znaczyly, ze odmowa („Okres lipiec 2026 jest już rozliczony") i ekran
// moga kiedys nazwac ten sam miesiac inaczej — a operator porownuje wlasnie te dwa napisy.
// Trasy podaja te tablice do szablonow; szablony niczego nie nazywaja same.
export const MIESIACE = [
  'styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec',
  'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień',
];

// Lapie prefiks RRRR-MM-DD na poczatku napisu — CELOWO bez kotwicy `$`, zeby zlapac
// tez pelne znaczniki czasu (`RRRR-MM-DDTHH:mm:ss...`), bo to najczestszy ksztalt
// wejscia w tym systemie (new Date().toISOString()).
const WZORZEC_PREFIKSU_DATY = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Rok i miesiac okresu dla podanej daty zlozenia (ISO).
 *
 * ⚠️ Nieczytelna data rzuca bledem, a NIE oddaje NaN. Ciche NaN zrobiloby wiersz okresu
 * o kluczu (NaN, NaN), do ktorego wpadloby KAZDE zamowienie z popsuta data — i wszystkie
 * wyladowalyby na jednej, przypadkowej fakturze.
 *
 * ⚠️ V8 nie odrzuca dat kalendarzowo niepoprawnych, tylko je cicho przewija: '2026-02-30'
 * staje sie 2 marca, '2026-04-31' staje sie 1 maja. To gorsze niz jawny blad, bo wynik
 * wyglada wiarygodnie i nikt go nie zakwestionuje az do wystawienia faktury — zamowienie
 * z literowka w dacie ladowaloby cicho w zlym okresie rozliczeniowym.
 *
 * Walidujemy date kalendarzowa WPROST Z NAPISU, a nie przez porownanie z wynikiem
 * parsowania (getUTC* po `new Date(...)`). Porownanie ze strefa czasowa jest z definicji
 * niewiarygodne: dla znacznika z jawna strefa (np. '+05:00') albo bez strefy w ogole
 * (parsowany jako czas lokalny) komponenty daty PO parsowaniu legalnie roznia sie od
 * komponentow w napisie — takie porownanie albo falszywie odrzuca poprawne daty, albo
 * (przy zbyt luznym dopasowaniu) przepuszcza bledne. Sama data kalendarzowa (rok-miesiac-dzien)
 * jest natomiast faktem niezaleznym od strefy — mozna ja sprawdzic bez dotykania czasu.
 *
 * ⚠️ ROK I MIESIAC LICZYMY W CZASIE WARSZAWSKIM, NIE W UTC (ustalenie recenzji 2026-08-01).
 * Miesiac rozliczeniowy to pojecie HANDLOWE: „sierpniowa faktura" znaczy tyle, co miesiac,
 * ktory widzi czlowiek w Polsce patrzacy na zegar — a nie miesiac, ktory akurat ma serwer
 * chodzacy w UTC. Kontener panelu stoi z TZ=UTC, a Polska jest o godzine (latem o dwie)
 * do przodu, wiec `getUTCMonth()` rozjezdzal sie z rzeczywistoscia przez pierwsze godziny
 * kazdego pierwszego dnia miesiaca: zamowienie przyjete 1 sierpnia o 01:30 czasu polskiego
 * ma znacznik '2026-07-31T23:30:00Z' i wpadaloby do LIPCA. Skutki obie strony zle —
 * przy lipcu otwartym zamowienie po cichu ladowaloby na lipcowej fakturze zbiorczej,
 * a przy lipcu zamknietym (a zamyka sie go wlasnie na przelomie) operator dostawalby
 * odmowe przy zamowieniu, ktore dla niego jest sierpniowe, i nie mialby jak go zapisac.
 *
 * Przeliczenie idzie `dzienWarszawa` z format-daty.js — TA SAMA funkcja, ktora liczy daty
 * drukowane w tabeli i uzywana przez filtry (domain/filtry-listy.js). Drugie wlasne
 * `Intl.DateTimeFormat` tutaj znaczyloby dwie implementacje jednej reguly, ktore predzej
 * czy pozniej rozjada sie na wartosciach BEZ oznaczenia strefy (daty ze sklepu sa juz
 * w czasie Warszawy i nie wolno ich przeliczac drugi raz — to rozstrzyga format-daty.js).
 *
 * ⚠️ MA DRUGIEGO KONSUMENTA, spoza okresow rozliczeniowych. `web/routes/api-sprzedaz.js`
 * (endpoint zrodlowy dla tygodniowego raportu sprzedazy) uzywa tej funkcji WYLACZNIE jako
 * WALIDATORA daty kalendarzowej — wola ja w try/catch i patrzy tylko na to, czy rzucila,
 * zeby nie pisac trzeciej kopii reguly „V8 cicho przewija 2026-02-30 na 2 marca".
 * Skutek dla przyszlych zmian: to, CZY ta funkcja rzuca i dla jakich napisow, jest teraz
 * kontraktem publicznym, a nie szczegolem okresu rozliczeniowego. Rozluznienie walidacji
 * (np. przepuszczenie bledacego miesiaca) po cichu przesunelo by tydzien w raporcie
 * o dzien, a nie tylko wplynelo na przypisanie faktury. Zmieniajac reguly rzucania,
 * sprawdz tests/oms/api-sprzedaz.test.js. Zwracana wartosc (rok, miesiac) tamten modul
 * ignoruje, wiec jej ksztalt mozna zmieniac swobodnie.
 */
export function kluczOkresu(dataIso) {
  const d = new Date(dataIso ?? '');
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Nieczytelna data złożenia zamówienia: ${JSON.stringify(dataIso)}`);
  }
  const dopasowanie = typeof dataIso === 'string' ? dataIso.match(WZORZEC_PREFIKSU_DATY) : null;
  if (dopasowanie) {
    const [, rokStr, miesiacStr, dzienStr] = dopasowanie;
    const rok = Number(rokStr);
    const miesiac = Number(miesiacStr);
    const dzien = Number(dzienStr);
    const dniWMiesiacu = new Date(Date.UTC(rok, miesiac, 0)).getUTCDate();
    const niepoprawna = miesiac < 1 || miesiac > 12 || dzien < 1 || dzien > dniWMiesiacu;
    if (niepoprawna) {
      throw new Error(`Nieczytelna data złożenia zamówienia: ${JSON.stringify(dataIso)}`);
    }
  }
  // `dzienWarszawa` oddaje 'RRRR-MM-DD'; pusty napis znaczy „nie umiem tego odczytac"
  // (format inny niz ISO) i ma skonczyc tak samo jak kazda inna nieczytelna data — bledem,
  // nigdy cichym (NaN, NaN), do ktorego wpadalyby wszystkie popsute zamowienia naraz.
  const dzien = dzienWarszawa(dataIso);
  if (!dzien) {
    throw new Error(`Nieczytelna data złożenia zamówienia: ${JSON.stringify(dataIso)}`);
  }
  return { rok: Number(dzien.slice(0, 4)), miesiac: Number(dzien.slice(5, 7)) };
}

/**
 * Czy do okresu wolno jeszcze dopisac zamowienie.
 *
 * ⚠️ Nieznany stan czytamy jako ZAMKNIETY, a nie otwarty. Bezpieczna odpowiedz przy
 * niepewnosci to „nie dopisuj" — dopisanie do juz zafakturowanego okresu jest bledem,
 * ktorego nie da sie cofnac inaczej niz korekta w KSeF.
 */
export function okresPrzyjmujeZamowienia(stan) {
  return stan === STAN.OTWARTY;
}

/**
 * Stan faktury OKRESU. Cienka oslona nad `stanFaktury` z domain/faktura-stan.js.
 *
 * ⚠️ POWOD ISTNIENIA. `stanFaktury` czyta pusty `ksef_status` jako „wystawiona", bo po
 * sukcesie inFakt oddaje tam puste `ksef_data`. Dla wiersza w tabeli `faktury` to jest
 * poprawne: tamten wiersz POWSTAJE dopiero przy wystawianiu, wiec samo jego istnienie
 * niesie informacje. Okres jest inny — istnieje od pierwszego zamowienia miesiaca,
 * z pustymi kolumnami faktury. Zmierzone: `stanFaktury({ ksef_status: null })` zwraca
 * 'wystawiona', wiec bez tej oslony swiezy okres udawalby zafakturowany i panel NIGDY
 * nie wystawilby faktury.
 *
 * ⚠️ Pytamy o OBIE kolumny, nie o samo `infakt_uuid`: 'w_toku' i 'do_wyjasnienia' to stany
 * BEZ uuid-a (dokument jeszcze nie powstal albo nie wiadomo, czy powstal), wiec warunek
 * o samym uuid-zie czytalby wiszaca rezerwacje jako „brak" i pozwolil wystawic drugi
 * dokument. Odwrotnie — sam `ksef_status` jest po sukcesie pusty, wiec i on sam nie wystarcza.
 *
 * ⚠️ STAN OKRESU ROZSTRZYGA PIERWSZY, PRZED KOLUMNAMI FAKTURY (ustalenie recenzji 2026-08-01).
 * Warunek o samych kolumnach kasowal blokade podwojnego wystawienia, gdy inFakt oddal
 * odpowiedz BEZ uuid-a i BEZ numeru: `zakonczFaktureOkresu` zapisywalo wtedy same NULL-e,
 * wiec okres byl `stan = 'zafakturowany'`, ale z pusta kolumna `ksef_status` i pustym
 * `infakt_uuid` — czyli dokladnie tak, jak wyglada okres swiezy. Zmierzone na atrapie
 * oddajacej `{uuid:null, numer:null, ksefStatus:null}`: po pierwszym wystawieniu
 * `{stan:'zafakturowany', uuid:null, numer:null}` i DRUGIE wystawienie przechodzilo,
 * czyli `infakt.wystaw` szedl dwa razy. A taka odpowiedz jest realna: `zapytaj`
 * (infakt/client.js) oddaje `null` dla kazdego 2xx, ktorego ciala nie da sie sparsowac
 * jako JSON — puste albo HTML-owe cialo z proxy — a dokument w inFakcie MOGL wtedy powstac.
 * `stan` jest zapisywany tym samym `UPDATE`, wiec jest rownie wiarygodny co kolumny faktury,
 * a w tym jednym przypadku jest JEDYNYM sladem, ze cokolwiek sie wydarzylo.
 */
export function stanFakturyOkresu(okres, teraz = Date.now()) {
  if (!okres) return 'brak';
  if (okres.stan === STAN.ZAFAKTUROWANY) return stanFaktury(okres, teraz);
  if (!okres.ksef_status && !okres.infakt_uuid) return 'brak';
  return stanFaktury(okres, teraz);
}

/** Komunikat dla operatora — musi powiedziec, ktory miesiac i ze decyduje czlowiek. */
export function opisOdmowy(rok, miesiac) {
  const nazwa = MIESIACE[miesiac - 1] ?? `miesiąc ${miesiac}`;
  return `Okres ${nazwa} ${rok} jest już rozliczony — zamówienie z tą datą złożenia `
    + 'wymaga Twojej decyzji (korekta faktury albo zmiana daty).';
}
