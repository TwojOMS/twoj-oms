import { bladOperatora } from '../../domena/bledy.js';

// Reszta modulu nie wie, ktory kurier jest podpiety. Dolozenie InPostu
// (sklep A, Etap 2) to nowy wpis w tej mapie.
//
// UWAGA `odbior_osobisty` CELOWO NIE MA TU WPISU. Brak wpisu to nie przeoczenie, tylko
// mechanizm odmowy: wybierzKuriera rzuca na nieznanej metodzie, wiec sprzedaz na miejscu
// nie ma jak wygenerowac paczki. Dopisanie jej tutaj = paczka do klienta, ktory stoi
// przy ladzie, za ktora zaplacimy i ktorej nie da sie cofnac.
//
// ⚠️ NIE MA TU JUZ `dpd_pobranie` (2026-08-01) i to nie jest przeoczenie: pobranie
// przestalo byc metoda wysylki, a stalo sie flaga obok niej. Ten sam kurier obsluguje
// paczke z inkasem i bez — roznica siedzi w kopercie (<cod> w kurierzy/dpd.js), a nie
// w tym, do kogo dzwonimy.
// ⚠️ `inpost_paczkomat` DOSTAJE WPIS DOPIERO TERAZ (Zadanie 6), mimo ze metoda istnieje
// w domenie od Zadania 3. Do tej chwili paczkomat byl metoda NIEOBSLUGIWANA — i to bylo
// poprawne: klient ShipX jeszcze nie istnial, wiec jedyna uczciwa odpowiedz panelu brzmiala
// „nie umiem tego nadac". Ten wpis jest CALYM przelacznikiem: od niego paczkomat idzie do
// kuriera `inpost` (bootstrap.js podpina go pod ta sama nazwa).
// ⚠️⚠️ `allegro_dpd` DOSTAJE WPIS 11.08.2026 — i to jest ta jedna linijka, ktora wlacza
// WYDAWANIE PIENIEDZY. Komentarz wyzej mowil, ze metody allegrowe wpisu miec nie moga;
// to bylo PRAWDZIWE i przestalo byc — tak samo, jak „ten klient wylacznie czyta" przestalo
// byc prawda w Planie B. Powod dawnego zakazu nie znika, zmienia sie ADRESAT: zakaz chronil
// przed nadaniem allegrowej paczki NASZA umowa DPD, a ten wpis prowadzi do kuriera
// `allegro_wza`, ktory kupuje przewoz NA UMOWIE ALLEGRO — ta sama usluga, ktora wybral
// kupujacy, wiec i z zachowanym Smart.
//
// ⚠️ `allegro_paczkomat`, `allegro_punkt`, `allegro_inne`, `allegro_kurier` wpisu DALEJ NIE
// MAJA i brak jest mechanizmem odmowy, nie przeoczeniem. Paczkomat i Kurier24 z Allegro to
// uslugi o `owner: CLIENT` (zmierzone 10.08.2026) — Allegro wystawia je na NASZEJ umowie
// InPostu, wiec nadanie ich przez WzA byloby drugim, platnym przewozem.
// ⚠️⚠️ METODY ALLEGROWE PROWADZA WYLACZNIE DO ADAPTERA WzA, NIGDY DO NASZEGO KURIERA.
// To rozroznienie jest cala ochrona przed drugim, platnym przewozem: WzA kupuje etykiete
// na umowie ALLEGRO (przesylka, ktora kupujacy ma juz oplacona), a `dpd`/`inpost` nadaja
// na NASZEJ. Trzy metody punktowe doszly 18.09.2026 razem z osmioma uslugami w `METODY_WZA`.
//
// ⛔ `allegro_paczkomat` TU NIE WCHODZI — nadajemy go sami (`NADAJEMY_SAMI`
// w domain/kurier-nadania.js), bo Allegro nie sprzedaje na niego etykiety.
/** @type {Record<string, 'dpd' | 'inpost' | 'allegro_wza'>} */
const DLA_METODY = {
  dpd: 'dpd',
  inpost_paczkomat: 'inpost',
  allegro_dpd: 'allegro_wza',
  allegro_punkt: 'allegro_wza',
  allegro_kurier: 'allegro_wza',
  allegro_inne: 'allegro_wza',
};

/**
 * Kurier dla przesylki nadanej POZA panelem (wpis reczny, routes/zamowienia.js).
 *
 * Rozni sie od `wybierzKuriera` dwiema rzeczami i obie sa celowe:
 *  - NIE wymaga skonfigurowanego klienta — panel niczego tu nie nada, tylko odnotowuje fakt;
 *  - NIE RZUCA na nieznanej metodzie, bo zamowienie „bez metody" jest tu przypadkiem
 *    NAJCZESTSZYM: wlasnie takie nadaje sie z reki.
 *
 * ⚠️ Do 2026-08-04 trasa wpisywala `kurier: 'dpd'` NA SZTYWNO. Odkad wiersz przesylki steruje
 * linkiem do sledzenia i wyborem uslugi statusu, taki wpis znaczyl, ze paczkomat nadany
 * w Managerze Paczek InPostu linkuje na tracktrace.dpd.com.pl i pyta DPD o numer InPostu.
 * Zapasowe 'dpd' zostaje WYLACZNIE dla metody nieznanej — zeby dzisiejsze zachowanie panelu
 * dla wszystkiego, czego nie umiemy nazwac, nie drgnelo.
 *
 * ⚠️ KANAL ALLEGRO MA WLASNA WARTOSC `'allegro'` (2026-08-04) — i to NIE JEST wpis
 * w `DLA_METODY`. Tamta mapa steruje NADAWANIEM i brak w niej metod allegrowych jest
 * mechanizmem odmowy, ktorego nie wolno tknac; tutaj chodzi wylacznie o ODNOTOWANIE faktu
 * o paczce, ktora juz jedzie. Bez tego warunku zapasowe 'dpd' braloby numer listu z Allegro
 * („AD…") i linkowalo go na tracktrace.dpd.com.pl, a petla odswiezania pytalaby DPD o CUDZA
 * przesylke — jeden do jednego usterka naprawiona 04.08.2026 przy paczkomatach. Reczny wpis
 * jest dostepny od chwili, gdy zamowienia Allegro pojawia sie na liscie, wiec ten warunek
 * musi stac razem z kanalem, a nie razem z przesylkami.
 *
 * `'allegro'` nie ma i nie ma miec KLIENTA w mapie kurierow: panel o te paczke nikogo nie
 * pyta, bo nadal jej nie my (brak klienta = brak odpytywania, i to jest POPRAWNA odpowiedz,
 * nie luka).
 *
 * ⚠️ WZORCA W `domain/tracking.js` TAKZE NIE MA — i tu historia jest kreta, wiec warto ja
 * znac. Zadanie 9 wzorzec dopisalo (adres z briefu, `moje-allegro/zakupy/…`), a recenzja
 * tego samego zadania go ZDJELA: nikt go nie otworzyl w przegladarce, a sciezka jest po
 * stronie KUPUJACEGO, nie sprzedajacego. Brak wzorca NIE jest tu ubytkiem — `lista-ikony.js`
 * robi `href: sledzenie ?? '/zamowienia/<id>'`, wiec ikona prowadzi wtedy do KARTY
 * ZAMOWIENIA, czyli do linku, ktory na pewno dziala. Wzorzec wroci dopiero po POMIARZE
 * (szczegoly, co zmierzyc, stoja w domain/tracking.js w miejscu po wpisie).
 */
export function kurierWpisuRecznego(metoda) {
  if (String(metoda ?? '').startsWith('allegro_')) return 'allegro';
  return DLA_METODY[metoda] ?? 'dpd';
}

/**
 * @param {string} metoda
 * @param {import('../../moduly/wysylka/kurierzy.ts').MapaKurierow} kurierzy
 */
export function wybierzKuriera(metoda, kurierzy) {
  const nazwa = DLA_METODY[metoda];
  if (!nazwa) throw bladOperatora(`Metoda „${metoda}” nie jest obsługiwana w tym panelu.`);
  const k = kurierzy?.[nazwa];
  if (!k) throw bladOperatora(`Kurier ${nazwa} nie jest skonfigurowany.`);
  return { nazwa, klient: k };
}
