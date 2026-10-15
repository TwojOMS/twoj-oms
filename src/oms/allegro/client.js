import { MAKS_PLIK, sprawdzNazwe } from '../../moduly/wiadomosci/zalaczniki.js';
import { transport } from '../../integracje/transport.js';
// Jedyne miejsce w OMS, ktore robi HTTP do Allegro.
//
// ⚠️ ZAPIS JEST BIALA LISTA, NIE ZAKAZEM (zmiana z Planu B, 05.08.2026). Do 05.08 stalo tu
// „ten klient wylacznie czyta" i pilnowal tego test — Plan B otwiera zapis, wiec zakaz
// zamienia sie w wyliczenie. Wolno DOKLADNIE:
//   PUT  /order/checkout-forms/{id}/fulfillment              (status realizacji)
//   POST /order/checkout-forms/{id}/invoices                 (metadane faktury)
//   PUT  /order/checkout-forms/{id}/invoices/{invId}/file    (plik PDF)
//
// ⚠️ OD 11.08.2026 WOLNO TAKZE CZTERY WYWOLANIA „Wysylam z Allegro" (`shipment-management`):
//   GET  /shipment-management/delivery-proposals/{orderId}
//   POST /shipment-management/shipments/create-commands        (KUPUJE PRZEWOZ)
//   GET  /shipment-management/shipments/create-commands/{cmd}
//   POST /shipment-management/label                            (binarny PDF)
//
// ⚠️ OD 28.08.2026 WOLNO TAKZE JEDNO WYWOLANIE CENTRUM WIADOMOSCI:
//   POST /messaging/threads/{threadId}/messages                (WIADOMOSC DO KUPUJACEGO)
// To zapis NIEODWRACALNY — nie wydaje pieniedzy, ale po drugiej stronie jest czlowiek,
// ktory dostaje powiadomienie. Limit 2000 znakow sprawdzamy PRZED wyjsciem do sieci.
//
// ⚠️ `POST /order/checkout-forms/{id}/shipments` JEST DALEJ ZAKAZANE — i to NIE JEST to samo,
// co wywolania wyzej. Tamto DOPISUJE do zamowienia numer listu paczki nadanej GDZIE INDZIEJ,
// na NASZEJ umowie; te KUPUJA przewoz na umowie ALLEGRO, ta sama usluga, ktora wybral
// kupujacy. Dopisanie tamtej metody „przy okazji" byloby DRUGA, PLATNA przesylka do klienta,
// ktory swoja juz dostal.
// ⚠️ ZDANIE „metody allegrowe nie maja wpisu w DLA_METODY" BYLO PRAWDZIWE DO 11.08.2026 —
// dzis `allegro_dpd` prowadzi tam do kuriera `allegro_wza` (kurierzy/index.js). Bariera nie
// znikla, tylko przeniosla sie nizej: `domain/allegro-wysylka.js` przepuszcza WYLACZNIE
// uslugi o `owner: ALLEGRO`, a adapter przed zakupem pyta Allegro, czy paczki juz nie ma.
// ⚠️ Zmierzone 05.08.2026: token Allegro NIESIE uprawnienie
// `allegro:api:shipments:write`, wiec Allegro nam tego NIE ODMOWI — biala lista
// w tests/oms/allegro-client-zapis.test.js jest JEDYNA istniejaca bariera i pilnuje,
// zeby to zdanie nie zostalo samym komentarzem.

// ⚠️ Limit dlugosci wiadomosci bierzemy Z DOMENY, a nie z wlasnej stalej — ta sama liczba
// pilnuje formularza w /ustawienia i wyjscia do sieci. Dwie kopie rozjechalyby sie przy
// pierwszej zmianie po stronie Allegro, a rozjazd widac dopiero u kupujacego.
import { MAKS_ZNAKOW_WIADOMOSCI } from '../../domena/ustawienia-formulki.js';

export const LIMIT_STRONY = 100;

// Wersjonowany typ tresci Allegro. Zwykly `application/json` dostaje 406 — to nie jest
// ozdobnik, tylko warunek dzialania calego kanalu.
const AKCEPTUJEMY = 'application/vnd.allegro.public.v1+json';

// ⚠️⚠️ `/sale/issues` PRZYJMUJE WYLACZNIE SWOJ TYP BETA — zmierzone na produkcji
// 28.08.2026 na zywym tokenie, trzy warianty:
//     application/vnd.allegro.public.v1+json  ->  406
//     application/vnd.allegro.beta.v1+json    ->  200
//     application/json                        ->  406
// Do tego dnia odczyt dyskusji odbijal sie o 406 przy KAZDYM przebiegu i nikt tego nie
// widzial: przebieg lapie wyjatek na kanal, a pusta tabela `allegro_sprawy` wyglada tak
// samo, gdy odczyt dziala i nie ma spraw, jak wtedy, gdy nie dziala wcale.
//
// ⚠️ TO JEST WYJATEK JEDNEGO ZASOBU, NIE NOWA DOMYSLNA. Reszta klienta chodzi na
// `public.v1` i ma tak zostac — `beta.v1` na zasobie stabilnym to proszenie sie o 406
// w druga strone.
const AKCEPTUJEMY_BETA = 'application/vnd.allegro.beta.v1+json';

// ⚠️ ALLEGRO WYMAGA STREFY W DATACH FILTRA, A KONFIGURACJA JEJ NIE MA.
//
// Wspolny `parsujDateOd()` (src/oms/config.js) oddaje podloge jako `RRRR-MM-DDT00:00:00`
// — bez `Z` — bo w takiej postaci bierze ja WooCommerce (razem z `dates_are_gmt=true`).
// Allegro filtruje po polach `format: date-time`, czyli po RFC 3339, gdzie przesuniecie
// strefy jest obowiazkowe. Ta sama wartosc wyslana wprost to 400 na KAZDE zapytanie, czyli
// kanal, ktory milczy w calosci — a „brak nowych zamowien" wyglada wtedy identycznie jak
// spokojny dzien. Dlatego doklejamy `Z` TUTAJ, a nie zmieniamy `parsujDateOd()`: tam
// wartosc jest wspolna dla sklepow i przestawienie jej ruszyloby kanal, ktory dziala.
//
// Interpretacja UTC jest tym, co `parsujDateOd()` naprawde ma na mysli — buduje date przez
// `Date.UTC(...)`. Nie zgadujemy wiec strefy, tylko zapisujemy jawnie to, co juz jest.
//
// Wartosc, ktora ma juz `Z` albo `+02:00` (kursor pochodzi z `updatedAt` Allegro, czyli
// zawsze z UTC), przechodzi ZNAK W ZNAK. Przesuniecie kursora o cokolwiek to zgubione
// zamowienia — poprawianie go byloby gorsze niz zostawienie.
const WZOR_DATY = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?))?(Z|[+-]\d{2}:?\d{2})?$/;

// ⚠️ TWARDE LIMITY CZASU NA JEDNO ZADANIE. Bez wlasnego sygnalu undici czeka na naglowki
// DOMYSLNE 300 000 ms, a serwer panelu stoi z `requestTimeout: 0` (web/server.js) — czyli
// zawieszona sesja TCP do Allegro nie ma w calym panelu ZADNEGO ogranicznika. Ten sam
// wzorzec i to samo uzasadnienie, co LIMIT_ZAPYTANIA_STATUS_MS w kurierzy/dpd.js
// i kurierzy/inpost.js. Stale, a nie liczby wklejone w wywolanie, zeby dalo sie je
// zmierzyc testem i zeby uzasadnienie stalo przy wartosci.
//
// DWIE STALE, BO DWIE SCIEZKI MAJA ROZNA CIERPLIWOSC — i to jest decyzja, nie symetria
// dla samej symetrii:
//
//  - `pobierzZamowienia` wola WYLACZNIE POLLER, w tle, co dwie minuty. Nikt na to nie
//    patrzy, a strona to 100 zamowien z pozycjami, czyli setki kilobajtow JSON-a: piec
//    sekund realnie umialoby uciac zdrowa, tylko wolna odpowiedz i wyciszyc caly kanal.
//    Przebieg i tak nie moze sie nawarstwic — poller ma wlasna blokade „jeden przebieg
//    naraz" (services/poller.js), wiec dluzszy limit nie mnozy polaczen.
//  - `pobierzPrzesylki` wola KARTA ZAMOWIENIA, synchronicznie, przy renderowaniu
//    (GET /zamowienia/:id, przed petla statusu kuriera). PO DRUGIEJ STRONIE SIEDZI CZLOWIEK
//    i patrzy w pusty ekran — a jedynym wyjsciem z odpytywania jest belka statusu stojaca
//    na TEJ WLASNIE karcie, wiec karta, ktora sie nie otwiera, jest stanem bez wyjscia
//    (PRZEWODNIK.md 4.9). Tu limit musi byc krotki, dokladnie jak przy statusie kuriera.
//  - `pobierzOferte` wola UZUPELNIANIE ZDJEC (services/zdjecia-allegro.js), doczepione do
//    przebiegu pollera — czyli TEZ W TLE i tez bez czlowieka po drugiej stronie. Limit jest
//    mimo to KROTKI, i to nie jest niekonsekwencja: jeden przebieg pyta o wiele ofert POD RZAD
//    (LIMIT_OFERT_NA_PRZEBIEG), wiec limit mnozy sie przez ich liczbe. Przy 30 s jedna
//    milczaca oferta potrafilaby przeciagnac uzupelnianie przez kilka tyknien zegara naraz —
//    a stawka jest tu wylacznie OZDOBNA (miniatura), wiec cierpliwosc ma byc mala.
//  - `pobierzOferty` wola ODCZYT MAGAZYNU (services/magazyn-sync.js), uruchamiany PRZYCISKIEM.
//    Limit stoi POSRODKU i to jest decyzja: czlowiek czeka na wynik, ale nie na pusty ekran
//    — a przede wszystkim limit MNOZY SIE przez liczbe stron (23 przy 447 ofertach i limicie
//    20). Pollerowe 30 s znaczyloby najgorszy przypadek liczony w minutach, a piec sekund
//    umialoby uciac zdrowy, tylko wolny odczyt calego katalogu i nie wczytac ANI JEDNEJ
//    oferty — bo kontrola kompletnosci (nizej) i tak odrzuca odczyt uciety.
export const LIMIT_ZAPYTANIA_ZAMOWIEN_MS = 30 * 1000;
export const LIMIT_ZAPYTANIA_PRZESYLEK_MS = 5000;
export const LIMIT_ZAPYTANIA_OFERTY_MS = 5000;
export const LIMIT_ZAPYTANIA_OFERT_MS = 10 * 1000;

// ⚠️ WARTOSC ZMIERZONA, NIE WZIETA Z DOKUMENTACJI. Rozpoznanie (2026-08-06) potwierdzilo
// HTTP 200 na `GET /sale/offers?limit=20&offset=0` — i to jest JEDYNY limit, o ktorym wiemy,
// ze to konto go przyjmuje. Dokumentacja obiecuje wiecej, ale ten sam zasob juz raz zachowal
// sie inaczej, niz obiecywala (`GET /sale/offers/{id}` oddaje dzis 403), a podniesienie
// limitu bez pomiaru konczy sie 400 na KAZDE zapytanie, czyli odczytem magazynu, ktory
// milczy w calosci. 447 ofert to przy tej wartosci 23 zadania — odczyt idzie z przycisku,
// raz na jakis czas, wiec cena jest zadna.
export const LIMIT_STRONY_OFERT = 20;

// Twarda granica przebiegow: konto zglaszajace absurdalny `totalCount` (albo oddajace
// w kolko pelna strone) zapetliloby odczyt na godziny — przycisk „Odswiez", ktory nigdy nie
// wraca. 200 stron to 4000 ofert, czyli prawie dziewieciokrotnosc dzisiejszych 447.
export const MAKS_STRON_OFERT = 200;

// Centrum wiadomosci (2026-08-28). Allegro pozwala na max 20 watkow na strone — to nie jest
// nasz wybor, tylko sufit zasobu.
export const LIMIT_STRONY_WATKOW = 20;

// ⚠️ ILE STRON WATKOW MAKSYMALNIE. Ten sam bezpiecznik, co MAKS_STRON_OFERT: bledna
// odpowiedz Allegro (np. w kolko pelna strona) zapetlilaby przebieg na godziny. 50 stron
// to 1000 watkow — przy „bardzo malej" liczbie wiadomosci to zapas rzedu lat.
export const MAKS_STRON_WATKOW = 50;

// Odczyt watkow i wiadomosci chodzi Z POLLERA, w tle, bez czlowieka po drugiej stronie —
// wiec limit hojniejszy niz przy statusie realizacji (tam czeka operator przy karcie).
export const LIMIT_ZAPYTANIA_WIADOMOSCI_MS = 15 * 1000;

// ⚠️ HOJNY LIMIT, i to swiadomie — jak przy `utworzPrzesylke`. Wyslanie wiadomosci jest
// NIEODWRACALNE: przerwanie po 5 s nie „oszczedza czasu", tylko robi stan, w ktorym nie
// wiadomo, czy kupujacy ja dostal. A powtorka nie jest darmowa — to druga wiadomosc
// u czlowieka.
export const LIMIT_WYSYLKI_WIADOMOSCI_MS = 20 * 1000;

// ⚠️ `/sale/issues` pozwala na `limit` do 100 — inaczej niz `/messaging/threads` (20). To dwa
// rozne zasoby i dwa rozne sufity; sklejenie ich w jedna stala urwaloby strone spraw albo
// dostaloby 400 na watkach.
export const LIMIT_STRONY_SPRAW = 100;

// Odczyt i zapis statusu realizacji (obie strony jednej decyzji, wiec jedna stala).
// KROTKI limit, bo po drugiej stronie SIEDZI CZLOWIEK: wywolanie idzie z trasy, ktora wlasnie
// zapisala „wyslane" i czeka na przeladowanie karty. Nieudane wyslanie NIE cofa decyzji
// operatora — zostawia slad (`sync_woo_blad`) i przycisk „Wyslij ponownie" — wiec cierpliwosc
// moze byc mala.
export const LIMIT_ZAPYTANIA_STATUSU_MS = 5000;

// Zgloszenie faktury i wyslanie jej pliku. Limit DLUZSZY niz przy statusie, i to jest decyzja,
// nie niedopatrzenie: to jedyne wywolanie tego klienta, ktore niesie ZALACZNIK (PDF), a chodzi
// w tle — z czuwacza (Zadanie 12), bez czlowieka po drugiej stronie. Piec sekund umialoby uciac
// zdrowa, tylko wolna wysylke, a powtorka nie jest darmowa: Allegro przyjmuje do 10 faktur na
// zamowienie, wiec kazde ponowienie ryzykuje DRUGI dokument u kupujacego.
export const LIMIT_WYSYLKI_FAKTURY_MS = 30 * 1000;

// ⚠️ HOJNE LIMITY, i to swiadomie. Oba wywolania sa NIEODWRACALNE albo dotycza czegos, co
// juz kosztowalo: `utworzPrzesylke` kupuje przewoz, a `pobierzEtykieteWza` siega po plik do
// paczki, ktora juz istnieje. Przerwanie ich po 5 s nie „oszczedza czasu czlowieka" — robi
// stan, w ktorym nie wiadomo, czy przewoz powstal. Lepiej, zeby czlowiek poczekal.
export const LIMIT_WYSYLKI_PRZESYLKI_MS = 30 * 1000;
export const LIMIT_ETYKIETY_MS = 30 * 1000;
// Podjazd jest nieodwracalną komendą, podobnie jak kupno przewozu. Timeout nie oznacza,
// że Allegro nic nie zrobiło, dlatego czekamy rozsądnie długo i po błędzie odczytujemy
// ten sam commandId zamiast ponawiać POST.
export const LIMIT_PODJAZDU_MS = 30 * 1000;

// ⚠️ DWIE WARTOSCI W DOKUMENTACJI ALLEGRO: raz 2 MB (allegro-api#4130), raz 3 MB (tutorial).
// Bierzemy OSTRZEJSZA. Nasze PDF-y z inFaktu waza ~50 KB, wiec w praktyce to bez znaczenia —
// ale odmowa PRZED wyjsciem do sieci mowi „plik ma 4 MB", a odbicie od Allegro powiedzialoby
// „HTTP 413" albo, gorzej, nic.
export const MAKS_ROZMIAR_FAKTURY_B = 2 * 1024 * 1024;

// Straznik przy wczytaniu modulu, ten sam wzorzec co w dpd.js/inpost.js. Podniesienie
// limitu karty ponad limit pollera znaczyloby, ze sciezka OGLADANA PRZEZ CZLOWIEKA czeka
// dluzej niz robota w tle — czyli dokladnie odwrotnie, niz uzasadnia komentarz wyzej.
// Panel ma wtedy NIE WSTAC, zamiast po cichu zawieszac karty.
if (LIMIT_ZAPYTANIA_PRZESYLEK_MS > LIMIT_ZAPYTANIA_ZAMOWIEN_MS) {
  throw new Error(
    'Limit zapytania o przesyłki (ścieżka karty, człowiek czeka) nie może być dłuższy niż limit '
    + 'pobierania zamówień (poller, w tle).',
  );
}

function naDateAllegro(wartosc, nazwa) {
  const dopasowanie = WZOR_DATY.exec(String(wartosc).trim());
  // Rzucamy PRZED wyjsciem do sieci. Wyslanie smiecia dalo by 400 z Allegro, czyli tez
  // glosno — ale komunikat mowilby „HTTP 400", a nie „ta data jest do niczego".
  if (!dopasowanie) throw new Error(`Allegro: ${nazwa} nie jest datą ISO 8601 ("${wartosc}")`);
  const [, dzien, czas, strefa] = dopasowanie;
  return `${dzien}T${czas ?? '00:00:00'}${strefa ?? 'Z'}`;
}

export function createAllegroClient({ ustawienia, tokeny, fetchImpl, http = transport({ fetchImpl }) }) {
  async function bladHttp(r, sciezka, token) {
    // Biała lista opisu: bez nagłówków, reszty ciała i parametrów zapytania (4.10).
    // ⚠️ Biała lista NAZW pól nie wystarcza: Allegro potrafi odbić token albo nagłówek
    // autoryzacji WEWNĄTRZ `message`. Maskujemy więc wartość tokenu tego żądania i każde
    // `Bearer …` — PRZED ucięciem do 300 znaków, inaczej zostałby początek tokenu.
    const ukryj = (s) => (token ? s.split(token).join('[ukryto]') : s).replace(/Bearer\s+\S+/gi, '[ukryto]');
    let dopisek = '';
    try {
      const body = await r.json();
      if (Array.isArray(body?.errors)) {
        const tekst = (wartosc) => typeof wartosc === 'string' ? ukryj(wartosc.trim()) : '';
        const opisy = ukryj(body.errors.slice(0, 3).map((error) => {
          const opis = tekst(error?.userMessage) || tekst(error?.message);
          const path = tekst(error?.path);
          return opis ? opis + (path ? ` (${path})` : '') : '';
        }).filter(Boolean).join('; '));
        if (opisy) dopisek = ': ' + opisy.slice(0, 298);
      }
    } catch { /* Brak JSON lub błąd odczytu zostawia dawny komunikat. */ }
    const blad = new Error(`Allegro: HTTP ${r.status} przy ${sciezka.split('?')[0]}${dopisek}`);
    blad.status = r.status;
    // Nie śpimy ani nie ponawiamy tutaj. `Retry-After` jest wskazówką dla usługi
    // wznawiającej odczyt istniejącej komendy, nigdy poleceniem do drugiego POST-u.
    const retryAfter = r.headers?.get?.('Retry-After');
    if (/^[1-9]\d*$/.test(String(retryAfter ?? ''))) blad.retryAfterS = Number(retryAfter);
    return blad;
  }

  // `limitMs` jest OBOWIAZKOWY i CELOWO bez wartosci domyslnej: nowa sciezka odczytu ma
  // podjac decyzje „w tle czy pod okiem czlowieka", a nie odziedziczyc ja po cichu.
  // Wywolanie bez limitu wywala sie natychmiast na `AbortSignal.timeout(undefined)` —
  // glosno i przy pierwszym uruchomieniu, a nie dopiero przy milczacym Allegro.
  // ⚠️ `akceptuj` Z WARTOSCIA DOMYSLNA — dopisanie parametru nie ma prawa cicho zmienic
  // naglowka na kilkunastu istniejacych wywolaniach. Podaje go WYLACZNIE ten, kto musi.
  async function get(sciezka, limitMs, akceptuj = AKCEPTUJEMY, { zRetryAfter = false } = {}) {
    // Token bierzemy PRZY KAZDYM ZADANIU, nie raz na zycie klienta: przebieg pollera chodzi
    // po wielu stronach i potrafi przekroczyc waznosc tokenu w polowie. `waznyToken()` samo
    // pilnuje terminu i odswieza.
    const token = await tokeny.waznyToken();
    const r = await http(`${ustawienia.api}${sciezka}`, {
      // `method` jawnie, mimo ze `fetch` i tak domyslnie GET-uje: TA funkcja ma wylacznie
      // czytac i ma to byc widoczne w miejscu, gdzie ktos bylby sklonny dopisac `PUT`.
      // Zapis idzie osobna droga (`wyslijJson` nizej) — celowo, zeby `get` dalo sie czytac
      // jako „to nie moze nic zmienic".
      method: 'GET',
      // ⚠️ `User-Agent` JEST WARUNKIEM DZIALANIA KANALU, nie ozdobnikiem — tak samo jak
      // `Accept` wyzej. Allegro pisze wprost, ze wywolania bez prawidlowego naglowka
      // spowoduja ZABLOKOWANIE KLUCZA API, a po 30.06.2026 odrzuca je automatycznie.
      // Wartosc idzie Z KONFIGURACJI (`ALLEGRO_USER_AGENT`, walidowana przy starcie
      // w src/oms/config.js), bo Allegro trzyma ja na bialej liscie i pozwala zmieniac
      // wylacznie numer wersji — a wersja bedzie rosla bez wydawania panelu.
      headers: { Authorization: `Bearer ${token}`, Accept: akceptuj, 'User-Agent': ustawienia.userAgent },
      // Nowy sygnal na KAZDE zadanie (ta sama zasada, co w dpd.js): wspolny starzalby sie
      // razem z procesem i po pierwszych 30 s zycia panelu przerywal kazde zapytanie
      // natychmiast. Sygnal jest NARZUCONY przez `get`, a nie brany z opcji wolajacego —
      // inaczej twardy limit dalby sie zgubic po cichu w jednym miejscu uzycia.
      signal: AbortSignal.timeout(limitMs),
    });
    // Kod HTTP, ścieżka bez parametrów i ograniczony opis z białej listy bladHttp.
    // Komunikat ląduje w bazie i na ekranie (niezmiennik 4.10).
    if (!r.ok) throw await bladHttp(r, sciezka, token);
    const body = await r.json();
    if (!zRetryAfter) return body;
    const retryAfter = r.headers?.get?.('Retry-After');
    return /^[1-9]\d*$/.test(String(retryAfter ?? ''))
      ? { ...body, retryAfterS: Number(retryAfter) } : body;
  }

  // Zapis JSON-em. Osobno od `get`, a nie przez dorzucenie `method` do tamtej funkcji:
  // `get` jest czytana jako „to nie moze nic zmienic" i ma taka zostac.
  async function wyslijJson(sciezka, metoda, cialo, limitMs) {
    const token = await tokeny.waznyToken();
    const r = await http(`${ustawienia.api}${sciezka}`, {
      method: metoda,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: AKCEPTUJEMY,
        // Allegro odbija zapis bez wersjonowanego Content-Type — tak samo jak odczyt bez Accept.
        'Content-Type': AKCEPTUJEMY,
        // ⚠️ TEN SAM WARUNEK CO PRZY ODCZYCIE, i tak samo nieozdobny: Allegro pisze wprost,
        // ze wywolania bez prawidlowego `User-Agent` spowoduja ZABLOKOWANIE KLUCZA API.
        // Wartosc idzie Z KONFIGURACJI (`ALLEGRO_USER_AGENT`), nigdy ze stalej w module.
        'User-Agent': ustawienia.userAgent,
      },
      body: JSON.stringify(cialo),
      signal: AbortSignal.timeout(limitMs),
    });
    // Ten sam ograniczony opis co w GET — biała lista bladHttp (niezmiennik 4.10).
    if (!r.ok) throw await bladHttp(r, sciezka, token);
    // 204 i puste cialo sa przy PUT normalne — `json()` rzucilby na nich SyntaxError,
    // czyli udana zmiana statusu wygladalaby jak awaria kanalu.
    return r.json().catch(() => null);
  }

  async function pobierzZamowienia({ od, kursor, strona }) {
    // Bez tego `(undefined - 1) * 100` daje `offset=NaN` — zapytanie leci, Allegro odpowiada
    // czymkolwiek, a poller myli to z koncem listy.
    if (!Number.isInteger(strona) || strona < 1) {
      throw new Error(`Allegro: strona musi być liczbą całkowitą od 1, dostałem "${strona}"`);
    }
    const p = new URLSearchParams({ limit: String(LIMIT_STRONY), offset: String((strona - 1) * LIMIT_STRONY) });
    // ⚠️ KURSOR ALBO PODLOGA, NIGDY OBA NARAZ.
    // Kursor rzadzi, gdy jest — podloga ma glos wylacznie przy PIERWSZYM przebiegu, inaczej
    // cofalaby okno do zamowien juz przeczytanych (ta sama zasada, co w pollerze).
    // Wyslanie obu naraz nie jest „ostroznoscia": Allegro zlaczyloby je koniunkcja, wiec
    // stare zamowienie, ktore WLASNIE sie zmienilo (oplata, anulowanie, reklamacja),
    // wypadloby z okna przez podloge po dacie ZLOZENIA i nie wrocilo nigdy.
    //
    // ⚠️ SORTOWANIE JEST ROZNE W OBU GALEZIACH I TO NIE JEST NIEDOROBKA. Kto zechce je
    // „uspojnic", wprowadzi utrate zamowien — uzasadnienie przy kazdej galezi nizej.
    if (kursor) {
      // GALAZ KURSORA — BEZ `sort`, czyli domyslne Allegro („najnowsze pierwsze").
      //
      // Kusi, zeby dolozyc tu `sort=updatedAt` rosnaco „dla symetrii" z galezia podlogi.
      // NIE WOLNO: sortujemy wtedy rosnaco po polu, po ktorym JEDNOCZESNIE filtrujemy,
      // a to zamienia rzadkie DUPLIKATY na rzadkie POMINIECIA.
      // - dzis (malejaco, bez sortu): zamowienie zmienione w trakcie przebiegu wskakuje
      //   na poczatek listy i moze przyjsc drugi raz. To nie boli — zapis jest upsertem
      //   po `(sklep, zrodlo_id)`, wiec drugi odczyt nadpisuje ten sam wiersz.
      // - po zmianie (rosnaco): rekord z JUZ PRZECZYTANEGO prefiksu, zmodyfikowany w trakcie
      //   przebiegu, ucieka na koniec listy, wszystko za nim przesuwa sie o jedna pozycje
      //   w dol, a rekord stojacy na granicy strony wpada w obszar juz przeczytany —
      //   i nie zobaczymy go NIGDY. Zgubione zamowienie zamiast zdublowanego.
      p.set('updatedAt.gte', naDateAllegro(kursor, 'kursor'));
    } else if (od) {
      // GALAZ PODLOGI — PIERWSZY PRZEBIEG, potencjalnie 8 stron (776 zamowien / 100).
      // Tu `sort` jest KONIECZNY: klucz sortowania (`lineItems.boughtAt`, data ZLOZENIA)
      // jest NIEZMIENNY, wiec zamowienia dochodzace w trakcie przebiegu dopisuja sie ZA
      // oknem, ktore juz czytamy, i nie przesuwaja stron przeczytanych wczesniej.
      // Stronicowanie po `offset` staje sie przez to dowodliwie stabilne — inaczej niz
      // przy domyslnym „najnowsze pierwsze", gdzie kazde nowe zamowienie wpadajace miedzy
      // strona 1 a 2 przesuwa cala liste o jeden i jedno zamowienie wypada bez sladu.
      p.set('lineItems.boughtAt.gte', naDateAllegro(od, 'podłoga (parametr `od`)'));
      p.set('sort', 'lineItems.boughtAt');
    }

    const d = await get(`/order/checkout-forms?${p}`, LIMIT_ZAPYTANIA_ZAMOWIEN_MS);
    // ⚠️ 200 z cialem nie-tablica NIE MOZE oddawac []: „brak zamowien" byloby wtedy nie do
    // odroznienia od zlej konfiguracji. Ten sam blad zlapala recenzja Etapu 1 przy Woo.
    if (!Array.isArray(d?.checkoutForms)) throw new Error('Allegro nie oddało listy zamówień (checkoutForms nie jest tablicą)');
    // `Math.max(1, …)` nie jest kosmetyka: poller ma petle `do … while (strona <= stron)`,
    // wiec zero stron nie wywala przebiegu — po prostu cicho udaje, ze wszystko przeczytano.
    return { zamowienia: d.checkoutForms, stron: Math.max(1, Math.ceil((Number(d.totalCount) || 0) / LIMIT_STRONY)) };
  }

  async function pobierzPrzesylki(idZamowienia) {
    // ⚠️ LIMIT KARTY, nie limit pollera. To wywolanie jest robione SYNCHRONICZNIE przy
    // renderowaniu karty zamowienia, wiec kazda sekunda limitu to sekunda pustego ekranu.
    const d = await get(
      `/order/checkout-forms/${encodeURIComponent(idZamowienia)}/shipments`,
      LIMIT_ZAPYTANIA_PRZESYLEK_MS,
    );
    // ⚠️ SWIADOMA ASYMETRIA wobec zamowien wyzej. Tam pusta lista jest nie do odroznienia od
    // zlej konfiguracji CALEGO kanalu, wiec musi wywalic przebieg. Tu brak listy to stan
    // NORMALNY — zamowienie jeszcze niewyslane zadnej przesylki nie ma — i kosztuje najwyzej
    // brak linku do sledzenia na jednej karcie.
    return Array.isArray(d?.shipments) ? d.shipments : [];
  }

  /**
   * Jedna OFERTA — wylacznie po to, zeby dobrac jej zdjecie glowne (`images[0]`).
   *
   * ⚠️ `/sale/product-offers/{offerId}`, NIGDY `/sale/offers/{offerId}`. Ten drugi zasob
   * Allegro WYCOFALO i oddaje 403 „This resource is no longer supported" — zmierzone na
   * zywym koncie 05.08.2026. Zamiana sciezki „na krotsza" wyciszylaby miniatury w calosci,
   * i to cicho: brak zdjecia jest tu stanem normalnym, wiec nikt by tego nie zauwazyl.
   *
   * Oddajemy CALA odpowiedz, a nie sam adres: wyciagniecie zdjecia to regula domenowa
   * (domain/miniatury.js: zdjecieOferty) i ma dac sie sprawdzic bez dotykania HTTP.
   * Wymaga uprawnienia `allegro:api:sale:offers:read` — nadanego i przewiazanego (05.08.2026).
   */
  async function pobierzOferte(ofertaId) {
    return get(`/sale/product-offers/${encodeURIComponent(ofertaId)}`, LIMIT_ZAPYTANIA_OFERTY_MS);
  }

  /**
   * WSZYSTKIE oferty tego konta — do lustra magazynu (`produkty_sklepowe`).
   *
   * ⚠️ BEZ ARGUMENTU KANALU, mimo ze plan zapowiadal `pobierzOferty(kanal)`. Klient JEST juz
   * per-kanal: dostaje `ustawienia` i `tokeny` jednego konta przy tworzeniu (bootstrap.js,
   * `klienciKanalow`). Parametr `kanal` sugerowalby, ze jedna instancja obsluguje oba konta,
   * i pierwsze wywolanie z „drugim" kanalem po cichu przeczytaloby katalog pierwszego.
   * Kanal dokleja WOLAJACY (Zadanie 7), z klucza mapy — i tam sprawdza go biala lista
   * w `domain/allegro-oferta.js`.
   *
   * ⚠️ `GET /sale/offers` (LISTA) dziala — zmierzone 2026-08-06, HTTP 200. To NIE JEST ten
   * sam zasob, co wycofane `GET /sale/offers/{id}` (403 „no longer supported"); szczegoly
   * jednej oferty ida przez `/sale/product-offers/{id}` w `pobierzOferte` wyzej.
   *
   * ⚠️ NIE DOCIAGAMY GALERII. Lista niesie wylacznie `primaryImage` i to wystarcza:
   * pelna galeria kosztowalaby 447 osobnych wywolan, a zdjecia do folderu wzoru (Etap 2)
   * bierzemy ze sklepu, gdzie Woo oddaje komplet w tym samym zapytaniu.
   *
   * ⚠️ ZADNYCH FILTROW W ZAPYTANIU. Zmierzone 2026-08-04: literowka w nazwie parametru
   * filtrujacego jest przez Allegro CICHO IGNOROWANA i oddaje pelen zbior — filtr, ktory nie
   * dziala, wyglada tu dokladnie tak samo jak filtr, ktory dziala. Chcemy i tak wszystkie
   * oferty (stan publikacji zapisujemy, zamiast odsiewac), wiec nie ma czego wysylac.
   */
  async function pobierzOferty() {
    const wszystkie = [];
    let strona = 0;
    // Ile ofert Allegro ZAPOWIEDZIALO w PIERWSZEJ odpowiedzi. Wziecie tej liczby z ostatniej
    // strony skasowaloby kontrole dokladnie w scenariuszu, przed ktorym ma bronic: gdy
    // `totalCount` przestaje przychodzic w trakcie odczytu.
    let zapowiedziano = null;
    let partia;
    do {
      if (strona >= MAKS_STRON_OFERT) {
        throw new Error(`Allegro: odczyt ofert przekroczył ${MAKS_STRON_OFERT} stron — przerywam, żeby się nie zapętlić.`);
      }
      // Parametry ida z KAZDYM zadaniem, nie tylko z pierwszym.
      const p = new URLSearchParams({
        limit: String(LIMIT_STRONY_OFERT),
        offset: String(strona * LIMIT_STRONY_OFERT),
      });
      const d = await get(`/sale/offers?${p}`, LIMIT_ZAPYTANIA_OFERT_MS);
      // ⚠️ 200 z cialem nie-tablica NIE MOZE oddawac []: „konto nie ma ofert" byloby wtedy nie
      // do odroznienia od zlej konfiguracji, a Zadanie 7 oznaczyloby CALY katalog kanalu
      // jako znikniety. Ta sama kontrola, co przy zamowieniach i przy produktach Woo.
      if (!Array.isArray(d?.offers)) throw new Error('Allegro nie oddało listy ofert (offers nie jest tablicą)');
      partia = d.offers;
      wszystkie.push(...partia);
      if (strona === 0) {
        const total = Number(d.totalCount);
        zapowiedziano = Number.isFinite(total) && total > 0 ? total : null;
      }
      strona += 1;
      // DWA WARUNKI STOPU I OBA SA POTRZEBNE:
      //  - strona KROTSZA niz limit konczy odczyt, cokolwiek mowi `totalCount`. Inaczej
      //    zawyzona (albo zwyczajnie nieaktualna) liczba trzymalaby petle az do twardej
      //    granicy, czyli 200 zadan po nic. Niekompletnosc wychodzi nizej, GLOSNO.
      //  - `totalCount` konczy odczyt takze wtedy, gdy strony sa pelne az do konca —
      //    bez tego ostatnia, dokladnie pelna strona kazalaby zapytac jeszcze raz.
    } while (
      partia.length === LIMIT_STRONY_OFERT
      && (zapowiedziano === null || wszystkie.length < zapowiedziano)
    );

    // ⚠️ Uciety odczyt WYGLADA JAK SUKCES, a potem Zadanie 7 oznacza brakujace oferty jako
    // `zniknal_at` — czyli jest nieodrozninalny od „konto stracilo pol katalogu". Wiecej niz
    // zapowiedziano przepuszczamy bez slowa: oferta wystawiona w trakcie odczytu dokłada sie
    // do liczby i nic przez to nie ginie.
    if (zapowiedziano !== null && wszystkie.length < zapowiedziano) {
      throw new Error(`Odczyt ofert urwał się: Allegro zapowiedziało ${zapowiedziano} ofert, a zebraliśmy ${wszystkie.length}. Nie oddaję niepełnej listy, bo brakujące oferty wyglądałyby jak wycofane ze sprzedaży.`);
    }
    return wszystkie;
  }

  /**
   * Stan realizacji zamowienia — SWIEZO, tuz przed decyzja o wyslaniu statusu.
   *
   * ⚠️ NIE DA SIE TEGO WZIAC Z NASZEJ BAZY. Zmierzone 05.08.2026: Allegro **nie podbija
   * `updatedAt` przy zmianie `fulfillment.status`** (5 z 10 zamowien mialo u nas `PROCESSING`,
   * a w Allegro `SENT`, przy identycznym `updatedAt`). Poller filtruje po `updatedAt.gte`,
   * wiec takiego zamowienia nie odczyta ponownie NIGDY — kolumna `status_realizacji` jest
   * nieaktualna na zawsze i decyzja oparta na niej cofa kupujacemu status.
   *
   * Limit KROTKI: to wywolanie idzie z trasy, przy ktorej czeka czlowiek (zapisal wlasnie
   * „wyslane"), a nieudany odczyt niczego nie psuje — regula po prostu odmawia wysylki
   * i zostawia slad do ponowienia.
   */
  async function pobierzStanRealizacji(idZamowienia) {
    const d = await get(
      `/order/checkout-forms/${encodeURIComponent(idZamowienia)}`,
      LIMIT_ZAPYTANIA_STATUSU_MS,
    );
    // ⚠️ `null` (Allegro nie ma statusu) MUSI dac sie odroznic od awarii — dlatego brak pola
    // oddajemy jako `null`, a awaria RZUCA. `domain/allegro-status.js` czyta `undefined` jako
    // „NIE PYTALISMY" i odmawia wysylki, wiec oddanie stad `undefined` uciszyloby kanal.
    return d?.fulfillment?.status ?? null;
  }

  async function ustawStatusRealizacji(idZamowienia, status) {
    // ⚠️ ODMOWA PRZED WYJSCIEM DO SIECI. Wartosc spoza listy to nasz blad, nie blad Allegro —
    // a 400 z Allegro powiedzialoby „HTTP 400", nie „ten status nie istnieje". Lista jest
    // pelna lista z dokumentacji, celowo szersza niz to, co wysylamy (PROCESSING/SENT):
    // klient ma odmawiac literowce, a nie decydowac za `domain/allegro-status.js`.
    const DOZWOLONE = ['NEW', 'PROCESSING', 'READY_FOR_SHIPMENT', 'SENT', 'READY_FOR_PICKUP', 'PICKED_UP'];
    if (!DOZWOLONE.includes(status)) {
      throw new Error(`Allegro: „${status}" nie jest statusem realizacji (dozwolone: ${DOZWOLONE.join(', ')})`);
    }
    // ⚠️ NIE WYSYLAMY `checkoutForm.revision`. Allegro daje ten parametr jako blokade
    // optymistyczna (409 przy nieaktualnej wersji), ale nasza kopia zamowienia jest stara
    // nawet o dwie minuty (przebieg pollera), a wlasciciel klika w panelu Allegro rownolegle.
    // Konflikt oznaczalby falszywa sprawe na pasku przy zamowieniu, z ktorym wszystko jest
    // w porzadku. Przed wyslaniem czegos niepotrzebnego broni `domain/allegro-status.js`
    // (pomija stan, ktory w Allegro juz jest) — i to jest wlasciwe miejsce tej ochrony,
    // po stronie decyzji, a nie po stronie transportu.
    await wyslijJson(
      `/order/checkout-forms/${encodeURIComponent(idZamowienia)}/fulfillment`,
      'PUT',
      { status },
      LIMIT_ZAPYTANIA_STATUSU_MS,
    );
  }

  /**
   * Faktury juz zgloszone przy zamowieniu — ODCZYT NAJLEPSZEJ WOLI.
   *
   * ⚠️ TEN ZASOB ODDAJE DZIS `400` NA KAZDE NASZE ZAMOWIENIE i nie jest to nasza literowka.
   * Zmierzone 05.08.2026 na czterech zamowieniach z obu kont (notatka
   * `2026-08-05-allegro-zapis-rozpoznanie.md` §2): sciezka istnieje i jest routowana (sciezki
   * zmyslone daja 404 „Feature unavailable"), naglowek jest wlasciwy (`beta.v1` i zwykly JSON
   * daja 406), token dobry (`…/shipments` oddaje 200), a `400` powstaje PRZED sprawdzeniem
   * identyfikatora — smiec w miejscu id daje to samo 400, podczas gdy zasob nadrzedny oddaje
   * na tym samym smieciu 422 z komunikatem walidacji.
   *
   * Zostaja dwie hipotezy, nierozroznialne bez pierwszej prawdziwej faktury: albo GET nie jest
   * wspierany mimo obecnosci w dokumentacji, albo `400` znaczy „to zamowienie nie ma ZADNEJ
   * faktury" (a nasze wszystkie jej nie maja, tak samo jak zamowienie o zmyslonym id).
   *
   * Dlatego `400` czytamy JAK PUSTA LISTE, a nie jak awarie: rzucenie tutaj wywalaloby wysylke
   * faktury — czyli funkcje, ktora dziala — z powodu odczytu, ktory jest jedynie pomocniczy.
   *
   * ⚠️ KAZDY INNY BLAD (401, 403, zerwana siec, limit czasu) RZUCA. Cisza przy nich znaczylaby
   * „nie ma faktur" tam, gdzie prawda brzmi „nie wiem" — a na tej odpowiedzi stoi (pomocniczo)
   * ochrona przed drugim dokumentem u kupujacego. Pewnym bezpiecznikiem jest lokalna kolumna
   * `allegro_invoice_id`; ta lista dokłada sie do niego, gdy dziala — nie zamiast niego.
   *
   * Limit KROTKI (jak przy przesylkach): to odczyt pomocniczy, a jego niepowodzenie i tak
   * konczy sie decyzja podjeta bez niego.
   */
  async function pobierzFakturyZamowienia(idZamowienia) {
    const sciezka = `/order/checkout-forms/${encodeURIComponent(idZamowienia)}/invoices`;
    let d;
    try {
      d = await get(sciezka, LIMIT_ZAPYTANIA_PRZESYLEK_MS);
    } catch (e) {
      // Ulaskawiamy DOKLADNIE JEDEN, ZMIERZONY kod odpowiedzi — nie „kazdy blad odczytu".
      if (String(e?.message).includes(`HTTP 400 przy ${sciezka}`)) return [];
      throw e;
    }
    return Array.isArray(d?.invoices) ? d.invoices : [];
  }

  /**
   * Zgloszenie METADANYCH faktury. Sam plik idzie osobnym zadaniem (`wyslijPlikFaktury`),
   * bo Allegro rozbija to na dwa kroki: najpierw dostajemy identyfikator, potem pod niego
   * wkladamy PDF.
   */
  async function zglosFakture(idZamowienia, { nazwaPliku, numerFaktury } = {}) {
    // ⚠️ ODMOWA PRZED WYJSCIEM DO SIECI, ten sam wzorzec co przy statusie realizacji.
    // `JSON.stringify` zamienilby `undefined` w brak pola, wiec literowka w nazwie argumentu
    // poleciala by do Allegro jako poprawne zadanie z pustymi metadanymi.
    if (!nazwaPliku) throw new Error('Allegro: zgłoszenie faktury wymaga nazwy pliku');
    // ⚠️ `invoiceNumber` jest w API OPCJONALNY, a my PODAJEMY GO ZAWSZE (spec §8.4 pkt 4):
    // bez niego kupujacy nie polaczy dokumentu z nasza ksiegowoscia, a Allegro o brak
    // nie upomni sie ani slowem.
    if (!numerFaktury) throw new Error('Allegro: zgłoszenie faktury wymaga numeru faktury');
    const d = await wyslijJson(
      `/order/checkout-forms/${encodeURIComponent(idZamowienia)}/invoices`,
      'POST',
      // Nazwy pol wprost z dokumentacji: `file.name` wymagane, `invoiceNumber` opcjonalne.
      { file: { name: nazwaPliku }, invoiceNumber: numerFaktury },
      LIMIT_WYSYLKI_FAKTURY_MS,
    );
    // ⚠️ BEZ IDENTYFIKATORA NIE MA JAK DOSLAC PLIKU ANI ROZPOZNAC, ZE POST JUZ BYL.
    // Allegro przyjmuje DO 10 FAKTUR na zamowienie, wiec ponowienie po cichej odpowiedzi
    // narastaloby duplikatami u kupujacego. Pusta odpowiedz ma byc glosna.
    if (!d?.id) throw new Error('Allegro nie oddało identyfikatora zgłoszonej faktury');
    return d;
  }

  /**
   * Plik PDF pod wczesniej zgloszona fakture. JEDYNE wywolanie w tym module, ktore niesie
   * bajty zamiast JSON-a — dlatego idzie wlasnym `fetchImpl`, a nie przez `wyslijJson`.
   */
  async function wyslijPlikFaktury(idZamowienia, invoiceId, bajty) {
    // ⚠️ OBIE ODMOWY PRZED WYJSCIEM DO SIECI. Sygnatura `%PDF` to ta sama kontrola, ktora stoi
    // przy pobraniu z inFaktu (infakt/client.js): jesli tamten oddal JSON z bledem, tutaj
    // wychodzi to na jaw ZANIM kupujacy dostanie plik, ktorego nie otworzy.
    if (!Buffer.isBuffer(bajty) || bajty.subarray(0, 4).toString() !== '%PDF') {
      throw new Error('Do Allegro idzie wyłącznie PDF (bajty) — to, co dostałem, nim nie jest.');
    }
    // Porownanie na liczbach calkowitych; MB tylko w komunikacie, dla czlowieka.
    if (bajty.length > MAKS_ROZMIAR_FAKTURY_B) {
      throw new Error(`Plik faktury ma ${(bajty.length / 1024 / 1024).toFixed(2)} MB, a limit Allegro to 2 MB.`);
    }
    const token = await tokeny.waznyToken();
    const sciezka = `/order/checkout-forms/${encodeURIComponent(idZamowienia)}`
      + `/invoices/${encodeURIComponent(invoiceId)}/file`;
    const r = await http(`${ustawienia.api}${sciezka}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        // `Accept` zostaje WERSJONOWANY: odpowiedz na ten PUT niesie stan weryfikacji pliku
        // (Zadanie 10) i przychodzi JSON-em Allegro.
        Accept: AKCEPTUJEMY,
        // ⚠️ TU `application/pdf`, NIE typ wersjonowany Allegro — to jedyne wywolanie w calym
        // module, ktore niesie plik, a nie JSON. Wersjonowany typ znaczylby „to jest JSON
        // Allegro" i tresc zostalaby odrzucona.
        'Content-Type': 'application/pdf',
        // ⚠️ TEN SAM WARUNEK CO WSZEDZIE: brak `User-Agent` grozi zablokowaniem klucza API.
        'User-Agent': ustawienia.userAgent,
      },
      body: bajty,
      signal: AbortSignal.timeout(LIMIT_WYSYLKI_FAKTURY_MS),
    });
    // ⚠️ Do komunikatu idzie kod HTTP i sciezka — NIGDY token ani cialo odpowiedzi (4.10).
    if (!r.ok) throw new Error(`Allegro: HTTP ${r.status} przy ${sciezka}`);
    // Puste cialo nie jest awaria — stan weryfikacji jest bonusem, a nie warunkiem powodzenia.
    return r.json().catch(() => null);
  }

  // ─── WYSYLAM Z ALLEGRO (WzA) ────────────────────────────────────────────────────────────
  //
  // ⚠️ TE CZTERY WYWOLANIA WYDAJA PIENIADZE. `utworzPrzesylke` kupuje PRAWDZIWY przewoz
  // u prawdziwego przewoznika, na umowie Allegro. Nie ma trybu probnego ani sandboxa,
  // a kupionej etykiety nie cofa sie kliknieciem. Reszta modulu tego nie wola sama —
  // droga prowadzi przez `domain/allegro-wysylka.js` (bariera) i `kurierzy/allegro-wza.js`.
  //
  // ⚠️ To NIE JEST zdjecie zakazu `POST /order/checkout-forms/{id}/shipments` z naglowka
  // pliku. Tamta droga DOPISUJE do zamowienia numer listu paczki nadanej GDZIE INDZIEJ,
  // na NASZEJ umowie — i dalej znaczylaby druga, platna przesylke. Ta droga KUPUJE przewoz
  // u Allegro. Zakaz zostaje, razem ze swoim testem.

  function sprawdzPrzesylkiPodjazdu(shipmentIds) {
    if (!Array.isArray(shipmentIds) || shipmentIds.length === 0) {
      throw new Error('Allegro: podjazdu nie można obsłużyć bez ani jednej przesyłki.');
    }
    if (shipmentIds.length > 100 || new Set(shipmentIds).size !== shipmentIds.length) {
      throw new Error('Allegro: podjazd może zawierać najwyżej 100 różnych przesyłek.');
    }
  }

  /** POST odczytuje propozycje dla dokładnego zestawu przesyłek i adresu nadawcy. */
  async function pobierzPropozycjePodjazdu({ shipmentIds, readyDate, address } = {}) {
    sprawdzPrzesylkiPodjazdu(shipmentIds);
    if (!readyDate) throw new Error('Allegro: propozycje podjazdu wymagają readyDate.');
    if (!address) throw new Error('Allegro: propozycje podjazdu wymagają address.');
    return wyslijJson(
      '/shipment-management/pickup-proposals',
      'POST', { shipmentIds, readyDate, address }, LIMIT_PODJAZDU_MS,
    );
  }

  /**
   * Jedna próba zlecenia dla UUID zapisanego wcześniej przez usługę.
   * Po timeout/5xx odczytujemy stan tego samego commandId, nigdy nie ponawiamy POST-u.
   */
  async function zlecPodjazd({ commandId, input } = {}) {
    if (!commandId) throw new Error('Allegro: podjazdu nie wolno zlecać bez commandId.');
    sprawdzPrzesylkiPodjazdu(input?.shipmentIds);
    if (!input?.pickupTime) throw new Error('Allegro: podjazd wymaga pickupTime.');
    if (!input?.address) throw new Error('Allegro: podjazd wymaga address.');
    for (const pole of ['pickupDateProposalId', 'proposalItems']) {
      if (Object.hasOwn(input, pole)) throw new Error(`Allegro: wycofane pole podjazdu ${pole} nie może zostać wysłane.`);
    }
    return wyslijJson(
      '/shipment-management/pickups/create-commands',
      'POST', { commandId, input }, LIMIT_PODJAZDU_MS,
    );
  }

  async function stanZleceniaPodjazdu(commandId) {
    if (!commandId) throw new Error('Allegro: brak commandId podjazdu do odczytu.');
    return get(
      `/shipment-management/pickups/create-commands/${encodeURIComponent(commandId)}`,
      LIMIT_PODJAZDU_MS,
      AKCEPTUJEMY,
      { zRetryAfter: true },
    );
  }

  async function pobierzPodjazd(pickupId) {
    if (!pickupId) throw new Error('Allegro: brak pickupId podjazdu do odczytu.');
    return get(`/shipment-management/pickups/${encodeURIComponent(pickupId)}`, LIMIT_PODJAZDU_MS);
  }

  /** Podpowiedz Allegro dla zamowienia: nadawca, odbiorca (z MASKOWANYM mailem), paczki. */
  async function pobierzPropozycjeWysylki(idZamowienia) {
    // Limit karty, nie pollera: czlowiek czeka przed kliknieciem „Nadaj paczkę".
    return get(
      `/shipment-management/delivery-proposals/${encodeURIComponent(idZamowienia)}`,
      LIMIT_ZAPYTANIA_PRZESYLEK_MS,
    );
  }

  /**
   * ŻYWA metoda dostawy zamówienia — `delivery.method.id` prosto z Allegro.
   *
   * ⚠️ Osobne wywołanie, a nie odczyt kolumny: Allegro NIE PODBIJA `updatedAt` przy zmianach
   * w zamówieniu (zmierzone 05.08.2026), więc nasza kopia bywa nieświeża Z DEFINICJI. Ta
   * wartość decyduje o tym, KTÓRĄ USŁUGĘ kupujemy — czyli o pieniądzach i o Smart kupującego.
   *
   * `null` (Allegro nie podało metody) MUSI dać się odróżnić od awarii: brak pola oddajemy
   * jako `null`, a awaria RZUCA. Bariera w `domain/allegro-wysylka.js` czyta `null` jako
   * odmowę, więc ciche zamienienie awarii w `null` dałoby odmowę zamiast krzyku.
   */
  async function pobierzMetodeDostawy(idZamowienia) {
    const d = await get(`/order/checkout-forms/${encodeURIComponent(idZamowienia)}`, LIMIT_ZAPYTANIA_STATUSU_MS);
    return d?.delivery?.method?.id ?? null;
  }

  async function utworzPrzesylke({ commandId, input } = {}) {
    // ⚠️ `commandId` JEST KLUCZEM IDEMPOTENCJI ALLEGRO i musi przyjsc Z REZERWACJI W BAZIE.
    // Wylosowany tutaj znaczylby, ze ponowienie po zerwanym polaczeniu kupuje DRUGI przewoz.
    // Panel Allegro takiej oslony nie ma — 10.08.2026 wlasciciel kupil tak dwie etykiety do
    // jednego zamowienia. Rzucamy PRZED wyjsciem do sieci: 400 od Allegro tez byloby glosne,
    // ale mowiloby „HTTP 400", a nie „ktos zapomnial klucza idempotencji".
    if (!commandId) throw new Error('Allegro: przesyłki nie wolno tworzyć bez commandId (klucz idempotencji z rezerwacji).');

    // ⚠️ POMINIETE `deliveryMethodId` ZNACZY, ZE USLUGE DOBIERA ALLEGRO, A NIE MY.
    // Dokumentacja twierdzi, ze bierze sie wtedy z zamowienia, ale `delivery-proposals`
    // oddaje to pole jako `null` (zmierzone 10.08.2026) i NIE ZMIERZYLISMY, co robi Allegro
    // przy braku. Zla usluga to utrata Smart u kupujacego i przewoz, ktorego nikt nie
    // zamawial — wiec pole jest tu OBOWIAZKOWE, a wartosc pochodzi z zywego odczytu
    // zamowienia (`domain/allegro-wysylka.js`), nigdy z podpowiedzi i nigdy z bazy.
    if (!input?.deliveryMethodId) {
      throw new Error('Allegro: przesyłki nie wolno tworzyć bez deliveryMethodId — usługę wybieramy my, nie Allegro.');
    }

    return wyslijJson('/shipment-management/shipments/create-commands', 'POST', { commandId, input }, LIMIT_WYSYLKI_PRZESYLKI_MS);
  }

  /**
   * Gotowa przesylka — i JEDYNE miejsce, w ktorym jest NUMER LISTU.
   *
   * ⚠️ ZMIERZONE 11.08.2026 NA PIERWSZEJ PRAWDZIWEJ PACZCE. Odpowiedz komendy tworzenia
   * niesie WYLACZNIE `{commandId, status, errors, shipmentId}` — numeru listu tam NIE MA
   * i nie pojawi sie nigdy. Trzeba pojsc po niego tutaj: `packages[].waybill` (numer
   * allegrowy „AD…") oraz `packages[].transportingInfo[].carrierWaybill` (numer u DPD).
   * Zalozenie, ze numer przyjdzie razem ze statusem, kosztowalo jedno wdrozenie.
   */
  async function pobierzPrzesylkeWza(shipmentId) {
    return get(`/shipment-management/shipments/${encodeURIComponent(shipmentId)}`, LIMIT_ZAPYTANIA_PRZESYLEK_MS);
  }

  /**
   * HISTORIA ZDARZEN PRZEWOZU — dziala TAKZE dla przesylek, ktorych panel nie nadawal
   * (Allegro Punkt, Allegro One). Zmierzone sonda 25.08.2026.
   *
   * ⚠️ `Accept-Language: pl-PL` NIE JEST OZDOBNIKIEM. Bez tego naglowka `description`
   * przychodzi PO ANGIELSKU („Parcel has been delivered") i trafia prosto na ekran karty
   * oraz do zakladki przesylek. Klasyfikacji to nie ruszy — etap liczy sie z maszynowego
   * `code` (domain/etap-przesylki.js) — ale operator zobaczylby angielski opis obok
   * polskich zdarzen DPD i InPostu.
   *
   * ⚠️ ZLY `carrierId` NIE ODDAJE BLEDU. Przepytano 25.08 wszystkie 74 identyfikatory
   * z `GET /order/carriers`: kazdy oddaje HTTP 200, a tresc ma wylacznie ten wlasciwy —
   * reszta `trackingDetails: null`. Dlatego identyfikator MUSI pochodzic z odpowiedzi
   * Allegro (`przesylki.carrier_allegro`), a nie z naszej stalej. Na tym poleglo zgloszenie
   * allegro/allegro-api#10064, gdzie podstawiono UUID uslugi dostawy i dostano pustke.
   *
   * Zasob przyjmuje do 20 numerow naraz; pytamy o jeden, bo petla czuwacza jest per paczka
   * i wolumen kanalu Allegro jest maly. Hurt to optymalizacja na pozniej, nie brak.
   */
  async function pobierzSledzenie(carrierId, waybill) {
    const token = await tokeny.waznyToken();
    const sciezka = `/order/carriers/${encodeURIComponent(carrierId)}/tracking?waybill=${encodeURIComponent(waybill)}`;
    const r = await http(`${ustawienia.api}${sciezka}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: AKCEPTUJEMY,
        'Accept-Language': 'pl-PL',
        'User-Agent': ustawienia.userAgent,
      },
      signal: AbortSignal.timeout(LIMIT_ZAPYTANIA_STATUSU_MS),
    });
    // Kod HTTP i sciezka bez numeru — komunikat laduje w bazie i na ekranie (niezmiennik 4.10).
    if (!r.ok) throw new Error(`Allegro: HTTP ${r.status} przy /order/carriers/{carrierId}/tracking`);
    return r.json();
  }

  /** Tworzenie jest ASYNCHRONICZNE — stad przychodzi `shipmentId`, ale NIE numer listu. */
  async function stanTworzeniaPrzesylki(commandId) {
    return get(
      `/shipment-management/shipments/create-commands/${encodeURIComponent(commandId)}`,
      LIMIT_ZAPYTANIA_PRZESYLEK_MS,
    );
  }

  async function pobierzEtykieteWza(shipmentIds, format = 'PDF') {
    // Pusta lista to nie „etykieta bez paczek", tylko blad wolajacego — i wolno go zlapac
    // bez pytania Allegro o zdanie.
    if (!Array.isArray(shipmentIds) || !shipmentIds.length) {
      throw new Error('Allegro: etykiety nie ma po co pobierać bez ani jednej przesyłki.');
    }
    const token = await tokeny.waznyToken();
    const sciezka = '/shipment-management/label';
    const r = await http(`${ustawienia.api}${sciezka}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        // ⚠️ TU `application/octet-stream`, a nie typ wersjonowany: odpowiedzia jest BINARNY
        // PDF albo ZPL, a nie JSON Allegro. Drugie takie miejsce w module po pliku faktury.
        Accept: 'application/octet-stream',
        'Content-Type': AKCEPTUJEMY,
        'User-Agent': ustawienia.userAgent,
      },
      body: JSON.stringify(format === 'ZPL' ? { shipmentIds } : { shipmentIds, pageSize: 'A4' }),
      signal: AbortSignal.timeout(LIMIT_ETYKIETY_MS),
    });
    // ⚠️ Do komunikatu idzie kod HTTP i sciezka — NIGDY token ani cialo (4.10).
    if (!r.ok) throw new Error(`Allegro: HTTP ${r.status} przy ${sciezka}`);
    // ⚠️ `arrayBuffer`, NIGDY `json()` ani `text()`: tekstowe odczytanie PDF-u zepsuloby
    // plik po cichu — etykieta wygladalaby na pobrana, a wydruk bylby smieciem.
    return Buffer.from(await r.arrayBuffer());
  }

  // ─── CENTRUM WIADOMOSCI ─────────────────────────────────────────────────────────────────

  // ⚠️ KOLEJNOSC WATKOW NIE JEST ZAGWARANTOWANA. Dokumentacja Allegro podaje przy
  // GET /messaging/threads wylacznie `limit` i `offset` — ani slowa o sortowaniu. Dlatego
  // ten klient oddaje strone TAK JAK PRZYSZLA, a rozstrzyganie „co jest nowe" nalezy do
  // pollera i idzie po `lastMessageDateTime`, nigdy po pozycji na liscie.
  async function pobierzWatki({ offset = 0 } = {}) {
    const d = await get(
      `/messaging/threads?limit=${LIMIT_STRONY_WATKOW}&offset=${offset}`,
      LIMIT_ZAPYTANIA_WIADOMOSCI_MS,
    );
    return {
      watki: Array.isArray(d?.threads) ? d.threads : [],
      // ⚠️ `null`, a NIE 0, gdy Allegro nie poda liczby. Zero znaczyloby „nie ma watkow"
      // i zatrzymaloby stronicowanie po pierwszej stronie — czyli cicha slepota na reszte.
      razem: Number.isFinite(Number(d?.totalCount)) ? Number(d.totalCount) : null,
    };
  }

  async function pobierzWiadomosci(threadId, { offset = 0 } = {}) {
    // ⚠️ `encodeURIComponent` — identyfikator idzie do SCIEZKI. Bez tego znak `/` w id
    // rozbilby adres na inny zasob i pytalibysmy o cudzy watek albo dostali 404.
    const d = await get(
      `/messaging/threads/${encodeURIComponent(threadId)}/messages?limit=${LIMIT_STRONY_WATKOW}&offset=${offset}`,
      LIMIT_ZAPYTANIA_WIADOMOSCI_MS,
    );
    return { wiadomosci: Array.isArray(d?.messages) ? d.messages : [] };
  }

  // ⚠️⚠️ WYWOLANIE NIEODWRACALNE — po drugiej stronie jest czlowiek, ktory dostaje
  // powiadomienie. Walidacja idzie PRZED wyjsciem do sieci z dwoch powodow:
  //   • przekroczenie limitu Allegro odbilo by jako „HTTP 400", a z tego komunikatu nikt nie
  //     wyczyta, ze formulka jest za dluga — a poprawia ja w Ustawieniach, nie w kodzie;
  //   • pusty tekst Allegro moze PRZYJAC, i wtedy kupujacy dostaje pusta wiadomosc od firmy.
  //
  // ⚠️ Limit bierzemy z `domain/ustawienia-formulki.js`, a nie z wlasnej stalej — ta sama
  // liczba pilnuje formularza w Ustawieniach i wyjscia do sieci. Dwie kopie rozjechalyby sie
  // przy pierwszej zmianie po stronie Allegro.
  async function deklarujZalacznikWiadomosci(nazwa, rozmiar) {
    sprawdzNazwe(nazwa);
    if(!Number.isInteger(rozmiar)||rozmiar<1||rozmiar>MAKS_PLIK)throw Error('Allegro: rozmiar załącznika musi mieścić się w 5 MiB.');
    const wynik=await wyslijJson('/messaging/message-attachments','POST',{filename:nazwa,size:rozmiar},30000);
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(wynik?.id||''))throw Error('Allegro nie zwróciło identyfikatora deklaracji załącznika.');
    return wynik;
  }
  async function wgrajZalacznikWiadomosci(id, bajty, mime) {
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(id||''))throw Error('Nieprawidłowy identyfikator załącznika.');
    if(!Buffer.isBuffer(bajty)||!bajty.length||bajty.length>MAKS_PLIK)throw Error('Nieprawidłowy rozmiar załącznika.');
    if(!['application/pdf','image/png','image/gif','image/bmp','image/tiff','image/jpeg'].includes(mime))throw Error('Nieobsługiwany format załącznika.');
    const sciezka='/messaging/message-attachments/'+encodeURIComponent(id);
    const token=await tokeny.waznyToken();
    // No automatic retry: an interrupted upload has an uncertain remote outcome.
    const r=await http(ustawienia.api+sciezka,{method:'PUT',headers:{Authorization:'Bearer '+token,Accept:AKCEPTUJEMY,'Content-Type':mime,'User-Agent':ustawienia.userAgent},body:bajty,signal:AbortSignal.timeout(30000)});
    if(!r.ok)throw await bladHttp(r,sciezka,token);
    const wynik=await r.json();
    if(wynik?.id!==id)throw Error('Allegro nie potwierdziło identyfikatora wgranego załącznika.');
    return wynik;
  }
  async function wyslijWiadomosc(threadId, tekst, zalaczniki = []) {
    const tresc = String(tekst ?? '');
    if (tresc.trim() === '') throw new Error('Allegro: pusta wiadomość — nie wysyłam.');
    if (tresc.length > MAKS_ZNAKOW_WIADOMOSCI) {
      throw new Error(`Allegro: wiadomość ma ${tresc.length} znaków, limit to ${MAKS_ZNAKOW_WIADOMOSCI}.`);
    }
    return wyslijJson(
      `/messaging/threads/${encodeURIComponent(threadId)}/messages`,
      'POST', { text: tresc, ...(zalaczniki.length ? {attachments:zalaczniki.map(id=>({id}))} : {}) }, LIMIT_WYSYLKI_WIADOMOSCI_MS,
    );
  }

  // Dyskusje i reklamacje. ⚠️⚠️ RUSZTOWANIE NA DWA MIESIACE: `/sale/disputes` Allegro usunelo
  // 07.01.2026, a od 28.10.2026 te sprawy wchodza do Centrum wiadomosci jako watki
  // POST_PURCHASE_ISSUE i maja byc obslugiwane WYLACZNIE przez `/messaging`. Gdy to nastapi,
  // ta metoda ma ZNIKNAC razem z services/dyskusje.js, a nie zostac „na wszelki wypadek".
  //
  // ⚠️ KSZTALT ODPOWIEDZI — ZMIERZONY 28.08.2026 na produkcji, nie zalozony. Odpowiedz ma
  // DOKLADNIE JEDNO pole najwyzszego poziomu: `issues` (tablica). Nazwa kolekcji byla wczesniej
  // zgadnieta i trafiona.
  //
  // ⚠️⚠️ `totalCount` NIE ISTNIEJE w tej odpowiedzi, wiec `razem` jest ZAWSZE `null`. Dzis nic
  // na nim nie stoi (services/dyskusje.js czyta wylacznie pierwsza strone), ale ktokolwiek
  // dopisze tu stronicowanie, NIE MA NA CZYM oprzec warunku konca — musi liczyc dlugosc strony.
  async function pobierzSprawy({ offset = 0 } = {}) {
    const d = await get(
      `/sale/issues?limit=${LIMIT_STRONY_SPRAW}&offset=${offset}`,
      LIMIT_ZAPYTANIA_WIADOMOSCI_MS,
      AKCEPTUJEMY_BETA,
    );
    return {
      sprawy: Array.isArray(d?.issues) ? d.issues : [],
      razem: Number.isFinite(Number(d?.totalCount)) ? Number(d.totalCount) : null,
    };
  }

  return {
    // ⚠️ `pobierzOferte` (JEDNA oferta, `/sale/product-offers/{id}`, miniatura pozycji)
    // i `pobierzOferty` (CALA lista, `/sale/offers`, lustro magazynu) roznia sie jedna
    // litera i strzelaja w DWA ROZNE zasoby. Stoja obok siebie celowo — para widoczna
    // w jednym miejscu jest mniej grozna niz dwie nazwy rozrzucone po module.
    pobierzZamowienia, pobierzPrzesylki, pobierzOferte, pobierzOferty, pobierzStanRealizacji,
    ustawStatusRealizacji, pobierzFakturyZamowienia, zglosFakture, wyslijPlikFaktury,
    pobierzPropozycjeWysylki, pobierzMetodeDostawy, utworzPrzesylke, stanTworzeniaPrzesylki,
    pobierzPrzesylkeWza, pobierzEtykieteWza, pobierzSledzenie,
    pobierzPropozycjePodjazdu, zlecPodjazd, stanZleceniaPodjazdu, pobierzPodjazd,
    pobierzWatki, pobierzWiadomosci, wyslijWiadomosc, deklarujZalacznikWiadomosci, wgrajZalacznikWiadomosci, pobierzSprawy,
  };
}
