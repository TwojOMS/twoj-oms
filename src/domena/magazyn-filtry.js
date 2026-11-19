import { wymagajListyKanalow } from './lista-kanalow.js';
import { PACZKOMAT_WARTOSCI } from './paczkomat.js';
import { groszeZKwoty } from './kwota.js';
import { zl } from './kwoty.js';

// WYSZUKIWARKA I FILTRY MAGAZYNU — warstwa czysta między adresem HTTP a `oms/db/magazyn.js`.
//
// ⚠️ TEN MODUŁ JEST SŁOWNIKIEM I MUSI SIĘ ZGADZAĆ Z WARSTWĄ ZAPYTAŃ CO DO JEDNEJ WARTOŚCI.
// `warunkiKart` w oms/db/magazyn.js traktuje nieznaną wartość filtru jako `1 = 0`, czyli oddaje
// PUSTO — świadomie, bo filtr, którego nie rozumiemy, nie ma prawa poszerzać zbioru tuż przed
// edycją hurtem. Skutek uboczny: pozycja wystawiona w interfejsie, a nieznana bazie, daje
// PUSTY EKRAN zamiast wyniku i wygląda jak „nie ma takich kart”, a nie jak funkcja, której
// nikt nie napisał. Dlatego każda lista niżej jest przypięta testem do zachowania zapytania,
// a nie tylko do samej siebie (tests/moduly/magazyn/magazyn-filtry.test.js).
//
// ⚠️ FILTRY ŁĄCZĄ SIĘ Z FRAZĄ, A NIE KASUJĄ JEJ (reguła: filtry nie kasują frazy). Ta
// reguła została raz złamana na liście zamówień i objawiała się jako „przefiltrowana,
// ale ZUPEŁNIE INNA lista” — bo formularz GET wysyła wyłącznie WŁASNE pola. Stąd
// `parametryUkryte` (formularze niosą nawzajem swoje wartości) i `adresMagazynu` (każdy
// odnośnik ekranu składa się z PEŁNEGO kompletu, a nie od zera).

// Listę kanałów magazynu przekazuje moduł z konfiguracji danej instancji.
// Ta sama kolejność jest kolejnością kolumn na ekranie i listą
// wartości filtru kanału — trzecia kopia rozjechałaby się po cichu: filtr oferowałby kanał,
// którego nie ma w kolumnach, albo kolumna stałaby bez możliwości zawężenia do niej.

// ⚠️⚠️ OSIEM POZYCJI, DOKŁADNIE TE, KTÓRE ZNA `warunkiKart`. Wartości `allegro`
// w oms/db/magazyn.js NIE MA, a nieznana wartość leci tam w `1 = 0`. Pozycja „bez oferty
// na Allegro” wystawiona w interfejsie oddawałaby PUSTĄ LISTĘ przy każdym kliknięciu.
// Braku po stronie Allegro nie ma tu wcale: żeby go policzyć, trzeba pytać o NIEOBECNOŚĆ
// w kanale (`NOT EXISTS`), a takiego warunku warstwa zapytań nie zna. Dopisanie go jest
// zmianą w oms/db/, nie w tym słowniku.
//
// ⚠️ OSTATNI JEST KAFLEM POSTĘPU: `komplet` oddaje karty, którym
// NICZEGO nie brakuje — druga strona tej samej monety, liczona tym samym wyrażeniem
// (`LICZBA_BRAKOW_SQL` w oms/db/magazyn.js). Stoi w tej samej liście, bo jedzie tym samym polem
// adresu (`?brak=…`) i tym samym polem wyboru.
//
// ⚠️ `cena_zakupu` jest filtrem, ale NIE brakiem kompletu: nie wchodzi do `LICZBA_BRAKOW_SQL`,
// więc karta bez ceny zakupu może być kompletna. Inaczej kafel postępu spadłby do zera w dniu,
// w którym panel zaczął znać ceny zakupu. „Bez ceny” = brak ceny obowiązującej DZIŚ.
export const BRAKI_MAGAZYNU = Object.freeze([
  'sku',
  'wymiary',
  'kategoria',
  'paczkomat',
  'zdjecie',
  'opis',
  'cena_zakupu',
  'komplet',
]);

// Trzy stany paczkomatu (domena/paczkomat.js) plus nazwa trzeciego, jakiej uzywa zapytanie.
// ⚠️ Nie `brak`: baza zna `nieoznaczone`, a `brak` leci u niej w `1 = 0`.
export const PACZKOMAT_DO_FILTRA = Object.freeze([...PACZKOMAT_WARTOSCI, 'nieoznaczone']);

// Etykiety pol wyboru. Stoja TUTAJ, a nie w widoku, z tego samego powodu, co nazwy kanalow
// w domena/kanaly.js: druga mapa rozjechalaby sie z pierwsza przy pierwszej zmianie.
export const BRAKI_ETYKIETY = Object.freeze({
  sku: 'bez SKU',
  wymiary: 'bez wymiarów',
  kategoria: 'bez kategorii głównej',
  paczkomat: 'bez oznaczenia paczkomatu',
  zdjecie: 'bez zdjęcia',
  opis: 'bez opisu',
  cena_zakupu: 'bez ceny zakupu',
  // Nie „kompletne" — pole wyboru czyta sie jako „pokaz karty: …", a ta pozycja jako jedyna
  // nie opisuje braku. Dopowiedzenie odroznia ja od brakow powyzej jednym spojrzeniem.
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
const POLA = Object.freeze([
  'fraza',
  'kanal',
  'kategoria',
  'marka',
  'brak',
  'stan',
  'paczkomat',
  'cenaOd',
  'cenaDo',
  'oferty',
]);
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
 * Wartość z ZAMKNIĘTEJ listy. `Array.includes` (a nie `MAPA[x] ?? domyslne`), bo ta druga
 * postać oddaje funkcję z `Object.prototype` przy `?kanal=constructor` — realna pięćsetka
 * złapana na sortowaniu, a filtry czytają z tego samego adresu.
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
 * Filtry z adresu. Nieznany filtr stanu zawęża do pustego zbioru, więc musi dotrzeć do zapytania.
 *
 * @returns {{fraza: string|null, kanal: string|null, kategoria: string|null, marka: string|null,
 *            brak: string|null, stan?: string|null, paczkomat: string|null, cenaOd: number|null, cenaDo: number|null}}
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
    // Marka jak kategoria — lista otwarta, nazwa nietrafiona nie trafi w kartę.
    marka: napis(query?.marka),
    brak: zeSlownika(query?.brak, BRAKI_MAGAZYNU),
    ...(query?.stan ? { stan: Array.isArray(query.stan) ? 'nieznany' : napis(query.stan) } : {}),
    paczkomat: zeSlownika(query?.paczkomat, PACZKOMAT_DO_FILTRA),
    cenaOd: cena(query?.cenaOd),
    cenaDo: cena(query?.cenaDo),
    ...(query?.oferty ? { oferty: zeSlownika(query.oferty, ['bez', 'z', 'problem']) } : {}),
  };
}

/**
 * Czy cokolwiek zawęża listę — fraza wliczona.
 *
 * ⚠️ TO JEST PYTANIE, OD KTÓREGO ZALEŻY, CO MÓWI PUSTA TABELA. „Nie ma tu jeszcze ani jednej
 * karty” przy aktywnym filtrze jest NIEPRAWDĄ i wygląda jak utrata danych: katalog ma setki
 * albo tysiące pozycji, a ekran twierdzi, że jest pusty. Pusty wynik filtrowania to inny komunikat.
 *
 * `!= null` zamiast prawdziwości: `cenaOd === 0` JEST filtrem („od 0 zł” ma sens i zawęża do
 * produktów z ceną), a `0` jest fałszywe.
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
 * Wartości do przeniesienia UKRYTYMI POLAMI w formularzu GET.
 *
 * ⚠️ SEDNO REGUŁY „filtry nie kasują frazy”. Formularz GET wysyła WYŁĄCZNIE własne pola, więc bez tego
 * kliknięcie „Filtruj” gubiłoby frazę, a wpisanie frazy gubiłoby filtry — i człowiek
 * dostawałby przefiltrowaną, ale ZUPEŁNIE INNĄ listę niż ta, na którą patrzył.
 *
 * ⚠️ `pomin` NIE JEST OZDOBĄ. Formularz, który ma własne pole `kanal`, nie może wysłać
 * `kanal` DRUGI RAZ ukrytym polem: Fastify oddaje wtedy tablicę, parser słusznie odrzuca ją
 * do `null` i filtr znika dokładnie w tym formularzu, który służy do jego ustawiania.
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
 * Adres ekranu magazynu z PEŁNYM kompletem: fraza, filtry i sortowanie.
 *
 * ⚠️ KAŻDY ODNOŚNIK EKRANU MA SIĘ SKŁADAĆ TUTAJ, a nie od zera. Nagłówek sortujący budowany
 * jako `/magazyn?sort=…&kier=…` gubi wszystko pozostałe — czyli kliknięcie w „Wymiary”
 * kasuje zawężenie, po którym sprzedawca właśnie chciał zaznaczyć wszystko i ustawić pole
 * hurtem. To jest ten sam błąd, który na liście zamówień dawał „przefiltrowaną, ale zupełnie
 * inną listę”, i dlatego jest tu przypięty testem, a nie tylko zrobiony.
 *
 * `encodeURIComponent`, nie `URLSearchParams`: ten drugi koduje spację jako „+”, co w części
 * zapytania jest poprawne, ale nieczytelne w pasku adresu (ta sama decyzja, co w
 * `adresZFiltrami` listy zamówień).
 */
export function adresMagazynu(filtry, { sort, kier, zaznacz = false, widok, wszystkie = false } = {}) {
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
  // „Zaznacz wszystkie” jedzie ADRESEM, tak samo jak filtry i kolejność — bo bez JavaScriptu
  // tylko adres potrafi zmienić stan całej listy (ten sam mechanizm, co na liście zamówień).
  // ⚠️ SKŁADA SIĘ GO TUTAJ, a nie doklejając `&zaznacz=1` przy odnośniku: doklejenie na
  // piechotę gubiłoby zawężenie przy pustym komplecie filtrów (adres „/magazyn” bez znaku
  // zapytania), czyli człowiek zaznaczyłby CAŁY katalog zamiast pozycji, które widział.
  // ⚠️⚠️ ZAZNACZENIE NIE JEST FILTREM i nie ma prawa nim zostać: `parametryUkryte` go NIE
  // zna, więc nie wchodzi ani do pól formularza filtrów, ani do zawężenia przenoszonego
  // do akcji hurtowych.
  if (zaznacz) czesci.push(['zaznacz', '1']);
  // „Pokaż wszystkie” to sposób oglądania listy (bez stron po 100), nie filtr — jedzie dalej przy zmianie
  // kolejności i zawężenia, bo inaczej każde kliknięcie wracałoby człowieka do pierwszej setki.
  if (wszystkie) czesci.push(['wszystkie', '1']);
  if (!czesci.length) return '/magazyn';
  return `/magazyn?${czesci.map(([k, w]) => `${k}=${encodeURIComponent(w)}`).join('&')}`;
}
