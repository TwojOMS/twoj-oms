import { dzienWarszawa } from './format-daty.js';
import { METODY_WYSYLKI } from './wysylka.js';
import { kanalyWidoku } from './kanaly.js';
import { normalizujMetode } from './metody-platnosci.js';
import { ETYKIETY } from './status.js';

// Filtry nad tabelą zamówień: zakres dat złożenia, metoda wysyłki, metoda płatności.
// Cała reguła siedzi TUTAJ, w warstwie czystej — trasa dostaje gotową, przefiltrowaną
// tablicę, dokładnie tak samo jak przy wyszukiwaniu (domain/szukanie.js).
//
// ⚠️ FILTRY I FRAZA DZIAŁAJĄ RAZEM (warunek I), i to jest decyzja właściciela, nie
// przypadek: „chcę poszukać klienta i zobaczyć jego zamówienia z określonego czasu".
// Fraza zdejmuje WYŁĄCZNIE zakładkę statusu z panelu bocznego — bo tamta jest nawigacją
// („co mam dziś do zrobienia"), a nie filtrem wpisanym świadomie. Szczegóły przy
// składaniu listy w web/routes/zamowienia.js.

// Metody wysyłki, po których wolno filtrować. 'nieznana' JEST na liście, bo to nie jest
// stan pusty, tylko realna wartość kolumny — zamówienie, którego metody panel nie rozpoznał,
// jest rzeczą DO WYJAŚNIENIA i trzeba umieć wyciągnąć wszystkie takie naraz.
export const METODY_DO_FILTRA = [...METODY_WYSYLKI, 'nieznana'];

// Tylko RRRR-MM-DD. Wartość w innym formacie to literówka w adresie, a nie życzenie
// „pokaż wszystko" — ale przepuszczona dalej weszłaby w porównanie napisów, w którym
// „01.07.2026" jest większe od każdej daty ISO, czyli oddałaby PUSTĄ listę bez słowa
// wyjaśnienia. Odrzucamy ją tak samo, jak nieznany status w `?status=`.
const WZORZEC_DATY = /^\d{4}-\d{2}-\d{2}$/;

function data(surowa) {
  if (typeof surowa !== 'string') return null;
  const s = surowa.trim();
  if (!WZORZEC_DATY.test(s)) return null;
  // Sam wzorzec przepuściłby „2026-13-40". Sprawdzamy przez formater, którym i tak
  // liczymy dzień zamówienia — jedna reguła poprawności, nie dwie.
  return dzienWarszawa(`${s}T00:00:00`) === s ? s : null;
}

function napis(surowy) {
  if (typeof surowy !== 'string') return null;
  const s = surowy.trim();
  return s || null;
}

// ⚠️ FILTR POBRANIA USUNIETY 2026-08-04 (prosba wlasciciela) — jego miejsce zajal filtr
// kanalu sprzedazy. Informacja o pobraniu NIE zniknela z panelu: dalej stoi w kolumnie
// „Dostawa" (etykietaWysylki) i na karcie zamowienia. Zniknela wylacznie mozliwosc
// zawezania listy po tym kryterium.

// Kolejność konfiguracji oraz wbudowane kategorie; kanał nie wymaga zamówienia w DB.
export const kanalyDoFiltra = (definicje) => kanalyWidoku(definicje);

/**
 * Filtry z adresu. Wartość nieznana albo w złym formacie spada do `null` (czyli „bez
 * filtra"), nigdy nie leci dalej — ta sama zasada, co przy `?status=` i `?szukaj=`.
 */
export function parsujFiltry(query = {}, definicje) {
  const dozwoloneKanaly = kanalyWidoku(definicje).map(k=>k.klucz);
  const wysylka = napis(query?.wysylka);
  const kanal = napis(query?.kanal);
  return {
    od: data(query?.od),
    do: data(query?.do),
    wysylka: METODY_DO_FILTRA.includes(wysylka) ? wysylka : null,
    // Metoda płatności to CZYTELNA nazwa ze sklepu („Przelew tradycyjny", „Za pobraniem"),
    // więc listy dopuszczalnych wartości nie ma i być nie może — sklep dokłada bramki bez
    // pytania nas o zdanie. Nazwa spoza bazy po prostu nie trafi w żadne zamówienie.
    platnosc: napis(query?.platnosc),
    // Kanal spoza zamknietej listy spada do null — tak samo, jak nieznana metoda wysylki.
    kanal: dozwoloneKanaly.includes(kanal) ? kanal : null,
  };
}

/**
 * Numer strony listy z adresu (PRZ-051): dodatnia liczba całkowita zapisana cyframi, inaczej 1.
 * Śmieć to nieaktualny albo ręcznie popsuty link, a nie powód do błędu — pierwsza strona jest
 * jedynym bezpiecznym domyślnym widokiem. Sufit chroni przed OFFSET-em liczonym z liczby
 * spoza zakresu dokładnych liczb całkowitych.
 */
export function numerStrony(surowa) {
  const s = typeof surowa === 'number' ? String(surowa) : surowa;
  if (typeof s !== 'string' || !/^[1-9]\d{0,8}$/.test(s.trim())) return 1;
  return Number(s.trim());
}

/** Czy cokolwiek jest ustawione — do pokazania chipów i przycisku „Wyczyść". */
export function saJakiesFiltry(filtry) {
  return Boolean(filtry?.od || filtry?.do || filtry?.wysylka || filtry?.platnosc || filtry?.kanal);
}

/**
 * Czy zamówienie mieści się w filtrach. Warunki łączą się przez I: każdy dołożony filtr
 * może wynik wyłącznie zawęzić.
 */
export function pasujeDoFiltrow(z, filtry) {
  return pasujaKlucze(kluczeFiltrow(z), filtry);
}

/**
 * Wartości zamówienia, które czytają filtry — wyliczone RAZ (PRZ-051). Indeks listy zapisuje
 * je przy zamówieniu i pyta `pasujaKlucze` z SQL-a, więc reguła filtrów istnieje w jednym
 * miejscu, a nie drugi raz jako WHERE obok tego pliku.
 */
export function kluczeFiltrow(z) {
  return {
    dzien: dzienWarszawa(z?.utworzone_at) || null,
    // ⚠️ Metoda EFEKTYWNA, czyli po ręcznych korektach. Wiersz przepuszczony przez `zLinii`
    // ma w `metoda_wysylki` wartość efektywną (sklepowa leży w `metoda_wysylki_sklep`), więc
    // czytamy WPROST tę kolumnę — tak samo, jak robi to kolumna „Dostawa" w tabeli i ekran
    // nadania. Filtrowanie po wartości ze sklepu znaczyłoby, że zamówienia przełączonego
    // ręcznie na pobranie nie da się znaleźć pod tym, co panel pokazuje na ekranie.
    wysylka: z?.metoda_wysylki ?? 'nieznana',
    indywidualne: Boolean(z?.indywidualne),
    sklep: z?.sklep ?? '',
    platnosc: normalizujMetode(z?.metoda_platnosci).klucz,
  };
}

/** Czy klucze zamówienia (`kluczeFiltrow`) mieszczą się w filtrach — reguła `pasujeDoFiltrow`. */
export function pasujaKlucze(k, filtry) {
  if (filtry?.od || filtry?.do) {
    const dzien = k.dzien;
    // Zamówienie bez daty (albo z datą nie do odczytania) NIE ma prawa udawać, że mieści
    // się w każdym zakresie: wynik filtrowania po lipcu zawierałby wtedy wiersze, o których
    // nie wiadomo, kiedy powstały — a właśnie po to ktoś ten zakres ustawił.
    if (!dzien) return false;
    if (filtry.od && dzien < filtry.od) return false;
    if (filtry.do && dzien > filtry.do) return false;
  }
  if (filtry?.wysylka && k.wysylka !== filtry.wysylka) return false;
  // ⚠️ KANAL SPRZEDAZY. „indywidualne" NIE jest wartoscia kolumny `sklep` — to znacznik
  // wyliczony z surowej odpowiedzi sklepu (domain/indywidualne.js), bo takie zamowienia
  // wpadaja do WooCommerce sklepu `sklep_a` razem ze zwyklymi.
  //
  // ⚠️ `?kanal=sklep_a` obejmuje TAKZE zamowienia indywidualne, i to jest decyzja, nie
  // przeoczenie: zamowienie indywidualne JEST zamowieniem sklepu A — stamtad przyszlo,
  // tam ma numer i tam wraca notatka o nadaniu. Wykluczenie go znaczyloby, ze dwa filtry
  // trzeba zsumowac, zeby zobaczyc wszystko z jednego sklepu — a nikt sie tego nie domysli.
  if (filtry?.kanal === 'indywidualne') {
    if (!k.indywidualne) return false;
  } else if (filtry?.kanal && k.sklep !== filtry.kanal) {
    return false;
  }
  // ⚠️ OBIE STRONY przez slownik (domain/metody-platnosci.js), nie porownanie surowych
  // napisow: „BLIK" i „Blik" to od 22.08 jeden filtr, a stara zakladka z surowa nazwa
  // („?platnosc=Przelew%20tradycyjny") dalej trafia, bo normalizacja sprowadza ja do tego
  // samego klucza, co nowy adres z pola wyboru.
  if (filtry?.platnosc
    && k.platnosc !== normalizujMetode(filtry.platnosc).klucz) return false;
  return true;
}

/** Pusty komplet filtrów NIE filtruje niczego — lista zostaje ta sama (bez kopiowania). */
export function filtrujFiltrami(zamowienia, filtry) {
  if (!saJakiesFiltry(filtry)) return zamowienia;
  return zamowienia.filter((z) => pasujeDoFiltrow(z, filtry));
}

/**
 * Adres listy z podanym kompletem filtrów, zachowujący zakładkę statusu i frazę.
 * Służy dwóm rzeczom naraz: skrótom („ostatnie 7 dni") i krzyżykowi przy chipie —
 * ten drugi to po prostu ten sam komplet z jedną wartością wyzerowaną.
 *
 * Kolejność parametrów jest STAŁA, żeby adres tego samego widoku wyglądał zawsze tak samo
 * (historia przeglądarki, zakładki, porównanie w teście).
 */
export function adresZFiltrami(filtry, { szukaj = null, status = null, wszystkie = false, poTerminie = false, strona = null, zaznacz = null } = {}) {
  const czesci = [];
  if (status) czesci.push(['status', status]);
  // „Po terminie" jest zakładką jak status/wszystkie (nawigacja, nie filtr) — dokładnie
  // jedna z nich może stać w adresie, dlatego drabinka else-if, nie osobny if. Kolejność
  // MUSI odpowiadać drabince trasy w GET / (szukaj > status > po_terminie > wszystkie),
  // inaczej ręcznie sklejony adres z oboma parametrami gubi zakładkę przy zdejmowaniu chipów.
  else if (poTerminie) czesci.push(['po_terminie', '1']);
  else if (wszystkie) czesci.push(['wszystkie', '1']);
  if (szukaj) czesci.push(['szukaj', szukaj]);
  for (const klucz of ['od', 'do', 'wysylka', 'platnosc', 'kanal']) {
    if (filtry?.[klucz]) czesci.push([klucz, filtry[klucz]]);
  }
  // Strona listy (PRZ-051) — za filtrami, bo należy do tego samego widoku; pierwsza nie
  // zostawia śladu w adresie, żeby „/" i „/?strona=1" nie były dwoma adresami jednej strony.
  const nrStrony = numerStrony(strona);
  if (nrStrony > 1) czesci.push(['strona', String(nrStrony)]);
  // „Zaznacz wszystkie" idzie TA SAMA droga, co filtry i fraza — zwyklym adresem, bez
  // JavaScriptu. Sklada sie go TUTAJ, a nie doklejajac `&zaznacz=1` przy linku, bo tylko
  // tutaj wiadomo, czy adres ma juz znak zapytania; doklejenie na piechote gubiloby
  // zawezenie listy przy pustym komplecie filtrow (adres „/" bez zapytania).
  if (zaznacz) czesci.push(['zaznacz', '1']);
  if (!czesci.length) return '/';
  // encodeURIComponent, nie URLSearchParams: ten drugi koduje spację jako „+", co w części
  // zapytania jest poprawne, ale nieczytelne w pasku adresu i w komunikacie dla człowieka.
  return `/?${czesci.map(([k, w]) => `${k}=${encodeURIComponent(w)}`).join('&')}`;
}

/**
 * Bariera adresu powrotu z paska akcji masowych. Wartość wraca ukrytym polem formularza,
 * czyli JEST DANYMI OD UŻYTKOWNIKA — a `Location` nie pyta o zdanie. Bez białej listy
 * pasek byłby otwartym przekierowaniem: `powrot=//obcy.host` w spreparowanym formularzu
 * odsyła operatora na cudzy serwer, w panelu, do którego loguje się on hasłem.
 *
 * Biała lista jest WĄSKA celowo — powrót z akcji masowej prowadzi zawsze na listę zamówień
 * (`/` albo `/?…`), więc wszystko inne (inny ekran panelu, obcy host, `javascript:`)
 * znaczy, że wartość nie pochodzi z naszego formularza. Śmieć nie jest błędem do pokazania:
 * operator ma wrócić na listę, tylko bez zawężenia. Ta sama zasada, co przy `wroc` na
 * karcie wzoru (przewodnik OMS, 4.67).
 */
export function bezpiecznyPowrotNaListe(surowy, definicje, etykiety = ETYKIETY) {
  kanalyWidoku(definicje);
  if (typeof surowy !== 'string' || !/^\/(\?|$)/.test(surowy) || surowy.includes('#')) return '/';
  if (surowy === '/') return '/';

  const parametry = new URLSearchParams(surowy.slice(2));
  const dozwolone = new Set([
    'status', 'wszystkie', 'po_terminie', 'szukaj',
    'od', 'do', 'wysylka', 'platnosc', 'kanal', 'zaznacz', 'strona',
  ]);
  for (const klucz of dozwolone) {
    if (parametry.getAll(klucz).length > 1) return '/';
  }

  const filtry = parsujFiltry(Object.fromEntries(
    [...parametry.entries()].filter(([klucz]) => dozwolone.has(klucz)),
  ), definicje);
  const status = parametry.get('status');
  // Czyste generatory odnośników nie mają bazy. Zachowują tylko bezpieczny format klucza
  // własnego; trasa listy sprawdza jego istnienie w aktualnej konfiguracji. Gdy caller
  // poda konfigurację, również tutaj wymagamy istniejącego klucza.
  const wlasny = etykiety === ETYKIETY && /^w_[a-z0-9_]+$/.test(status ?? '');
  return adresZFiltrami(filtry, {
    status: status && (Object.hasOwn(etykiety, status) || wlasny) ? status : null,
    wszystkie: parametry.get('wszystkie') === '1',
    poTerminie: parametry.get('po_terminie') === '1',
    szukaj: napis(parametry.get('szukaj')),
    // Powrót z karty wraca na TĘ stronę, z której operator kliknął (PRZ-051).
    strona: numerStrony(parametry.get('strona')),
  });
}
