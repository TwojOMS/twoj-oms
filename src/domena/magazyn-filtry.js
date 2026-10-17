import { wymagajListyKanalow } from './lista-kanalow.js';
import { PACZKOMAT_WARTOSCI } from './paczkomat.js';
import { groszeZKwoty } from './kwota.js';
import { zl } from './kwoty.js';

// WYSZUKIWARKA I FILTRY MAGAZYNU — warstwa czysta miedzy adresem HTTP a `db/magazyn.js`.
//
// ⚠️ TEN MODUL JEST SLOWNIKIEM I MUSI SIE ZGADZAC Z WARSTWA ZAPYTAN CO DO JEDNEJ WARTOSCI.
// `warunkiKart` w db/magazyn.js traktuje nieznana wartosc filtru jako `1 = 0`, czyli oddaje
// PUSTO — swiadomie, bo filtr, ktorego nie rozumiemy, nie ma prawa poszerzac zbioru tuz przed
// edycja hurtem. Skutek uboczny: pozycja wystawiona w interfejsie, a nieznana bazie, daje
// PUSTY EKRAN zamiast wyniku i wyglada jak „nie ma takich kart", a nie jak funkcja, ktorej
// nikt nie napisal. Dlatego kazda lista nizej jest przypieta testem do zachowania zapytania,
// a nie tylko do samej siebie (tests/oms/magazyn-filtry.test.js).
//
// ⚠️ FILTRY LACZA SIE Z FRAZA, A NIE KASUJA JEJ (niezmiennik 4.13b przewodnika). Ten
// niezmiennik zostal raz zlamany na liscie zamowien i objawial sie jako „przefiltrowana,
// ale ZUPELNIE INNA lista" — bo formularz GET wysyla wylacznie WLASNE pola. Stad
// `parametryUkryte` (formularze niosa nawzajem swoje wartosci) i `adresMagazynu` (kazdy
// odnosnik ekranu sklada sie z PELNEGO kompletu, a nie od zera).

// Listę kanałów magazynu przekazuje moduł z konfiguracji danej instancji.
// Ta sama kolejnosc jest kolejnoscia kolumn na ekranie (web/routes/magazyn.js) i lista
// wartosci filtru kanalu — trzecia kopia rozjechalaby sie po cichu: filtr oferowalby kanal,
// ktorego nie ma w kolumnach, albo kolumna stalaby bez mozliwosci zawezenia do niej.

// ⚠️⚠️ PIEC POZYCJI, DOKLADNIE TE, KTORE ZNA `warunkiKart`. Plan Zadania 10 proponowal
// `brak ∈ sku|wymiary|allegro` — wartosci `allegro` w db/magazyn.js NIE MA, a nieznana
// wartosc leci tam w `1 = 0`. Pozycja „bez oferty na Allegro" wystawiona w interfejsie
// oddawalaby PUSTA LISTE przy kazdym klknieciu. Braku po stronie Allegro nie ma tu wcale:
// zeby go policzyc, trzeba pytac o NIEOBECNOSC w kanale (`NOT EXISTS`), a takiego warunku
// warstwa zapytan nie zna. Dopisanie go jest zmiana w db/, nie w tym slowniku.
//
// ⚠️ CZTERY PIERWSZE TO BRAKI, PIATA JEST KAFLEM POSTEPU: `komplet` oddaje karty, ktorym
// NICZEGO nie brakuje — druga strona tej samej monety, liczona tym samym wyrazeniem
// (`LICZBA_BRAKOW_SQL` w db/magazyn.js). Stoi w tej samej liscie, bo jedzie tym samym polem
// adresu (`?brak=…`) i tym samym polem wyboru.
export const BRAKI_MAGAZYNU = Object.freeze(['sku', 'wymiary', 'kategoria', 'paczkomat', 'komplet']);

// Trzy stany paczkomatu (domain/paczkomat.js) plus nazwa trzeciego, jakiej uzywa zapytanie.
// ⚠️ Plan proponowal `tak|nie|brak`; baza zna `nieoznaczone`, a `brak` leci u niej w `1 = 0`.
export const PACZKOMAT_DO_FILTRA = Object.freeze([...PACZKOMAT_WARTOSCI, 'nieoznaczone']);

// Etykiety pol wyboru. Stoja TUTAJ, a nie w widoku, z tego samego powodu, co nazwy kanalow
// w domain/kanaly.js: druga mapa rozjechalaby sie z pierwsza przy pierwszej zmianie.
export const BRAKI_ETYKIETY = Object.freeze({
  sku: 'bez SKU',
  wymiary: 'bez wymiarów',
  kategoria: 'bez kategorii głównej',
  paczkomat: 'bez oznaczenia paczkomatu',
  // Nie „kompletne" — pole wyboru czyta sie jako „pokaz karty: …", a ta pozycja jako jedyna
  // nie opisuje braku. Dopowiedzenie odroznia ja od czterech powyzej jednym spojrzeniem.
  komplet: 'komplet — nic nie brakuje',
});

export const PACZKOMAT_ETYKIETY = Object.freeze({
  tak: 'tak',
  nie: 'nie',
  nieoznaczone: 'nieoznaczone',
});

// KOLEJNOSC PARAMETROW W ADRESIE. Stala, zeby ten sam widok mial zawsze ten sam adres
// (historia przegladarki, zakladki, porownanie w tescie) — ta sama zasada, co przy
// `adresZFiltrami` na liscie zamowien.
const POLA = Object.freeze(['fraza', 'kanal', 'kategoria', 'brak', 'paczkomat', 'cenaOd', 'cenaDo']);
const POLA_CENY = Object.freeze(['cenaOd', 'cenaDo']);

/**
 * Napis z adresu HTTP. Powtorzony parametr (`?fraza=a&fraza=b`) Fastify oddaje jako TABLICE
 * — a tablica zwiazana w LIKE albo w `=` konczy sie odmowa node:sqlite, czyli pieciusetka
 * skladana z paska adresu. Wszystko, co nie jest niepustym napisem, spada do `null`.
 */
function napis(surowy) {
  if (typeof surowy !== 'string') return null;
  const s = surowy.trim();
  return s || null;
}

/**
 * Wartosc z ZAMKNIETEJ listy. `Array.includes` (a nie `MAPA[x] ?? domyslne`), bo ta druga
 * postac oddaje funkcje z `Object.prototype` przy `?kanal=constructor` — realna pieciusetka
 * zlapana przy Zadaniu 4 na sortowaniu, a filtry czytaja z tego samego adresu.
 */
const zeSlownika = (surowy, slownik) => {
  const s = napis(surowy);
  return s !== null && slownik.includes(s) ? s : null;
};

/**
 * Cena z pola formularza → GROSZE. Pusto → `null` („nie zawezaj"), a NIE zero: zero jest
 * wartoscia i przepuszcza produkty za darmo oraz rodzicow wariantowych.
 *
 * ⚠️ Przeliczenie idzie przez `groszeZKwoty`, czyli TO SAMO, ktore zapisuje ceny do lustra —
 * druga kopia arytmetyki rozjechalaby granice filtru z zawartoscia kolumny o grosz w obie
 * strony (`Number('2.675') * 100 === 267.49999999999994`).
 *
 * ⚠️ Ale INACZEJ NIZ TAMTO odmawia: `groszeZKwoty` RZUCA na niezrozumialej kwocie i tak ma
 * zostac (to sa pieniadze idace do bazy). Tutaj kwota przychodzi z paska adresu, wiec
 * literowka ma pokazac liste bez zawezenia, a nie pieciusetke.
 */
function cena(surowa) {
  const s = napis(surowa);
  if (s === null) return null;
  try {
    // Przecinek dziesietny, bo tak sie kwote pisze po polsku i tak ja czlowiek wpisze w pole.
    return groszeZKwoty(s.replace(',', '.'), 'filtr ceny magazynu');
  } catch {
    return null;
  }
}

/**
 * Filtry z adresu. Wartosc nieznana albo w zlym formacie spada do `null` (czyli „bez
 * filtra"), nigdy nie leci dalej — ta sama zasada, co przy `parsujFiltry` listy zamowien.
 *
 * @returns {{fraza: string|null, kanal: string|null, kategoria: string|null,
 *            brak: string|null, paczkomat: string|null, cenaOd: number|null, cenaDo: number|null}}
 */
export function filtryZZapytania(query = {}, kanaly) {
  wymagajListyKanalow(kanaly);
  return {
    fraza: napis(query?.fraza),
    kanal: zeSlownika(query?.kanal, kanaly),
    // ⚠️ KATEGORIA NIE MA ZAMKNIETEJ LISTY i miec jej nie moze — nazwy kategorii doklada
    // SKLEP, bez pytania nas o zdanie (ta sama asymetria, co przy metodach platnosci na
    // liscie zamowien: kanaly dokladamy MY, bramki platnosci sklep). Nazwa nietrafiona po
    // prostu nie trafi w zadna karte, i to jest co innego niz wartosc spoza slownika.
    kategoria: napis(query?.kategoria),
    brak: zeSlownika(query?.brak, BRAKI_MAGAZYNU),
    paczkomat: zeSlownika(query?.paczkomat, PACZKOMAT_DO_FILTRA),
    cenaOd: cena(query?.cenaOd),
    cenaDo: cena(query?.cenaDo),
  };
}

/**
 * Czy cokolwiek zawęża liste — fraza wliczona.
 *
 * ⚠️ TO JEST PYTANIE, OD KTOREGO ZALEZY, CO MOWI PUSTA TABELA. „Nie ma tu jeszcze ani jednej
 * karty" przy aktywnym filtrze jest NIEPRAWDA i wyglada jak utrata danych: katalog ma ~1000
 * pozycji, a ekran twierdzi, ze jest pusty. Pusty wynik filtrowania to inny komunikat.
 *
 * `!= null` zamiast prawdziwosci: `cenaOd === 0` JEST filtrem („od 0 zl" ma sens i zawęża do
 * produktow z cena), a `0` jest falszywe.
 */
export function saJakiesFiltry(filtry) {
  return POLA.some((k) => filtry?.[k] !== null && filtry?.[k] !== undefined);
}

/** Wartosc pola w postaci, w jakiej stoi w adresie i w polu formularza. */
function wartoscWAdresie(klucz, filtry) {
  const w = filtry?.[klucz];
  if (w === null || w === undefined) return null;
  // ⚠️ CENY WRACAJA ZLOTOWKAMI. Filtry trzymamy w groszach (tego chce kolumna `cena_gr`),
  // a pole formularza mowi zlotowkami. Przepisanie surowej wartosci do ukrytego pola
  // zamienialoby „od 10 zl" w „od 1000 zl" przy pierwszym klknieciu w naglowek sortujacy
  // i w „od 100 000 zl" przy drugim — po cichu, bo obie postacie sa poprawnymi liczbami.
  return POLA_CENY.includes(klucz) ? zl(w) : String(w);
}

/**
 * Wartosci do przeniesienia UKRYTYMI POLAMI w formularzu GET.
 *
 * ⚠️ SEDNO NIEZMIENNIKA 4.13b. Formularz GET wysyla WYLACZNIE wlasne pola, wiec bez tego
 * klikniecie „Filtruj" gubiloby fraze, a wpisanie frazy gubiloby filtry — i czlowiek
 * dostawalby przefiltrowana, ale ZUPELNIE INNA liste niz ta, na ktora patrzyl.
 *
 * ⚠️ `pomin` NIE JEST OZDOBA. Formularz, ktory ma wlasne pole `kanal`, nie moze wyslac
 * `kanal` DRUGI RAZ ukrytym polem: Fastify oddaje wtedy tablice, parser slusznie odrzuca ja
 * do `null` i filtr znika dokladnie w tym formularzu, ktory sluzy do jego ustawiania.
 */
export function parametryUkryte(filtry, { pomin = [] } = {}) {
  const pary = [];
  for (const klucz of POLA) {
    if (pomin.includes(klucz)) continue;
    const value = wartoscWAdresie(klucz, filtry);
    // Pustych nie przenosimy — inaczej adres puchnie o parametry, ktore niczego nie znacza.
    if (value !== null) pary.push({ name: klucz, value });
  }
  return pary;
}

/**
 * Wartosci POL formularza — w postaci, ktora ma stanac w `value`.
 *
 * ⚠️ Liczy je domena, a nie widok: pole ceny mowi zlotowkami, a filtr zyje w groszach, wiec
 * `value="<%= filtry.cenaOd %>"` pokazywaloby „1000" tam, gdzie czlowiek wpisal „10" — i przy
 * pierwszym „Filtruj" ta setka utrwalilaby sie jako nowa wartosc filtru.
 *
 * Brak jako PUSTY NAPIS, nie `null`: „null" wypisany w `value` jest napisem jak kazdy inny
 * i zostalby w polu jako tresc do skasowania recznie.
 */
export function wartosciPol(filtry) {
  const wartosci = Object.create(null);
  for (const klucz of POLA) wartosci[klucz] = wartoscWAdresie(klucz, filtry) ?? '';
  return wartosci;
}

/**
 * Adres ekranu magazynu z PELNYM kompletem: fraza, filtry i sortowanie.
 *
 * ⚠️ KAZDY ODNOSNIK EKRANU MA SIE SKLADAC TUTAJ, a nie od zera. Naglowek sortujacy budowany
 * jako `/magazyn?sort=…&kier=…` gubi wszystko pozostale — czyli klikniecie w „Wymiary"
 * kasuje zawezenie, po ktorym wlasciciel wlasnie chcial zaznaczyc wszystko i ustawic pole
 * hurtem. To jest ten sam blad, ktory na liscie zamowien dawal „przefiltrowana, ale zupelnie
 * inna liste", i dlatego jest tu przypiety testem, a nie tylko zrobiony.
 *
 * `encodeURIComponent`, nie `URLSearchParams`: ten drugi koduje spacje jako „+", co w czesci
 * zapytania jest poprawne, ale nieczytelne w pasku adresu (ta sama decyzja, co w
 * `adresZFiltrami` listy zamowien).
 */
export function adresMagazynu(filtry, { sort, kier, zaznacz = false, widok } = {}) {
  const czesci = parametryUkryte(filtry).map((p) => [p.name, p.value]);
  if (sort) czesci.push(['sort', sort]);
  if (kier) czesci.push(['kier', kier]);
  // TRYB KOLUMN TABELI (`porzadki` domyslnie, `katalog` z cenami kanalow). Jedzie adresem,
  // bo panel nie ma JavaScriptu — przelacznik trybu to zwykly odnosnik, wiec musi sie
  // skladac TUTAJ, razem z zawezeniem i kolejnoscia.
  //
  // ⚠️ DOMYSLNY NIE WCHODZI DO ADRESU. „/magazyn" i „/magazyn?widok=porzadki" bylyby dwoma
  // adresami JEDNEJ rzeczy (historia przegladarki, zakladki, testy porownujace adresy) —
  // ta sama zasada, co przy pustych filtrach wyzej.
  //
  // ⚠️ RUCH TYLKO NA WARTOSC ZNANA, nigdy „cokolwiek przyszlo": biala lista stoi w trasie,
  // ale i ta funkcja nie ma prawa wpisac do adresu napisu, ktorego ekran nie zna.
  if (widok === 'katalog') czesci.push(['widok', 'katalog']);
  // „Zaznacz wszystkie" jedzie ADRESEM, tak samo jak filtry i kolejnosc — bo bez JavaScriptu
  // tylko adres potrafi zmienic stan calej listy (ten sam mechanizm, co na liscie zamowien).
  // ⚠️ SKLADA SIE GO TUTAJ, a nie doklejajac `&zaznacz=1` przy odnosniku: doklejenie na
  // piechote gubiloby zawezenie przy pustym komplecie filtrow (adres „/magazyn" bez znaku
  // zapytania), czyli czlowiek zaznaczylby CALY katalog zamiast 277 pozycji, ktore widzial.
  // ⚠️⚠️ ZAZNACZENIE NIE JEST FILTREM i nie ma prawa nim zostac: `parametryUkryte` go NIE
  // zna, wiec nie wchodzi ani do pol formularza filtrow, ani do zawezenia przenoszonego
  // do akcji hurtowych.
  if (zaznacz) czesci.push(['zaznacz', '1']);
  if (!czesci.length) return '/magazyn';
  return `/magazyn?${czesci.map(([k, w]) => `${k}=${encodeURIComponent(w)}`).join('&')}`;
}
