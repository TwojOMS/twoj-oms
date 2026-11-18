import { MAKS_PLIK, sprawdzNazwe } from '../../moduly/wiadomosci/zalaczniki.js';
import { transport } from '../../integracje/transport.js';
// Jedyne miejsce w OMS, ktore robi HTTP do Allegro.
//
// ⚠️ ZAPIS JEST BIAŁĄ LISTĄ, NIE ZAKAZEM: zamiast „ten klient wyłącznie czyta" stoi tu
// wyliczenie dozwolonych zapisów. Wolno DOKŁADNIE:
//   PUT  /order/checkout-forms/{id}/fulfillment              (status realizacji)
//   POST /order/checkout-forms/{id}/invoices                 (metadane faktury)
//   PUT  /order/checkout-forms/{id}/invoices/{invId}/file    (plik PDF)
//
// ⚠️ WOLNO TAKŻE CZTERY WYWOŁANIA „Wysyłam z Allegro" (`shipment-management`):
//   GET  /shipment-management/delivery-proposals/{orderId}
//   POST /shipment-management/shipments/create-commands        (KUPUJE PRZEWOZ)
//   GET  /shipment-management/shipments/create-commands/{cmd}
//   POST /shipment-management/label                            (binarny PDF)
//
// ⚠️ WOLNO TAKŻE JEDNO WYWOŁANIE CENTRUM WIADOMOŚCI:
//   POST /messaging/threads/{threadId}/messages                (WIADOMOSC DO KUPUJACEGO)
// To zapis NIEODWRACALNY — nie wydaje pieniedzy, ale po drugiej stronie jest czlowiek,
// ktory dostaje powiadomienie. Limit 2000 znakow sprawdzamy PRZED wyjsciem do sieci.
//
// ⚠️ `POST /order/checkout-forms/{id}/shipments` JEST DALEJ ZAKAZANE — i to NIE JEST to samo,
// co wywolania wyzej. Tamto DOPISUJE do zamowienia numer listu paczki nadanej GDZIE INDZIEJ,
// na NASZEJ umowie; te KUPUJA przewoz na umowie ALLEGRO, ta sama usluga, ktora wybral
// kupujacy. Dopisanie tamtej metody „przy okazji" byloby DRUGA, PLATNA przesylka do klienta,
// ktory swoja juz dostal.
// ⚠️ METODY ALLEGROWE MAJĄ WPIS W REJESTRZE KURIERÓW (dawna mapa `DLA_METODY`): `allegro_dpd`,
// `allegro_punkt`, `allegro_kurier` i `allegro_inne` prowadzą do kuriera `allegro_wza`
// (`metody` w domena/moduly-kurierow.ts, uzasadnienie w kurierzy/index.js). Bariera nie
// znikla, tylko przeniosla sie nizej: `domena/allegro-wysylka.js` przepuszcza WYLACZNIE
// uslugi o `owner: ALLEGRO`, a adapter przed zakupem pyta Allegro, czy paczki juz nie ma.
// ⚠️ Zmierzone: token Allegro NIESIE uprawnienie
// `allegro:api:shipments:write`, wiec Allegro nam tego NIE ODMOWI — biala lista
// w tests/oms/allegro-client-zapis.test.js jest JEDYNA istniejaca bariera i pilnuje,
// zeby to zdanie nie zostalo samym komentarzem.
//
// ⚠️ DO WYSTAWIANIA OFERT WOLNO TAKŻE:
//   POST  /sale/product-offers                                 (NOWA OFERTA — publiczna, gdy ACTIVE)
//   PATCH /sale/product-offers/{id}                            (zmiana oferty)
//   POST  upload.<host API>/sale/images                        (zdjecie; isAiCoCreated tylko przy AI)
//   PUT   /sale/offer-quantity-change-commands/{commandId}     (ilosc wielu ofert)
//   PUT   /sale/offer-price-change-commands/{commandId}        (cena wielu ofert)
//   PUT   /sale/offer-publication-commands/{commandId}         (zakończenie lub wznowienie ofert)
//   POST  /pricing/offer-fee-preview                           (prognoza prowizji, bez skutku)
// ⛔ METODY DELETE NIE MA I NIE BĘDZIE: ofertę się kończy (publication ENDED), nie kasuje.
// Test wywoluje KAZDA metode klienta i porownuje zbior zapisow z ta lista.

// ⚠️ Limit dlugosci wiadomosci bierzemy Z DOMENY, a nie z wlasnej stalej — ta sama liczba
// pilnuje formularza w /ustawienia i wyjscia do sieci. Dwie kopie rozjechalyby sie przy
// pierwszej zmianie po stronie Allegro, a rozjazd widac dopiero u kupujacego.
import { MAKS_ZNAKOW_WIADOMOSCI } from '../../domena/ustawienia-formulki.js';

export const LIMIT_STRONY = 100;

// Wersjonowany typ tresci Allegro. Zwykly `application/json` dostaje 406 — to nie jest
// ozdobnik, tylko warunek dzialania calego kanalu.
const AKCEPTUJEMY = 'application/vnd.allegro.public.v1+json';

// ⚠️⚠️ `/sale/issues` PRZYJMUJE WYŁĄCZNIE SWÓJ TYP BETA — zmierzone na żywym tokenie,
// trzy warianty:
//     application/vnd.allegro.public.v1+json  ->  406
//     application/vnd.allegro.beta.v1+json    ->  200
//     application/json                        ->  406
// Z innym typem odczyt dyskusji odbija się o 406 przy KAŻDYM przebiegu i nikt tego nie
// widzi: przebieg lapie wyjatek na kanal, a pusta tabela `allegro_sprawy` wyglada tak
// samo, gdy odczyt dziala i nie ma spraw, jak wtedy, gdy nie dziala wcale.
//
// ⚠️ TO JEST WYJATEK JEDNEGO ZASOBU, NIE NOWA DOMYSLNA. Reszta klienta chodzi na
// `public.v1` i ma tak zostac — `beta.v1` na zasobie stabilnym to proszenie sie o 406
// w druga strone.
const AKCEPTUJEMY_BETA = 'application/vnd.allegro.beta.v1+json';

// ⚠️ ALLEGRO WYMAGA STREFY W DATACH FILTRA, A KONFIGURACJA JEJ NIE MA.
//
// Wspolny `parsujDateOd()` (src/core/web/modul.ts) oddaje podloge jako `RRRR-MM-DDT00:00:00`
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
// DOMYŚLNE 300 000 ms, a serwer panelu stoi z `requestTimeout: 0` (core/aplikacja.ts) — czyli
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
//    naraz" (moduly/kanaly/services/poller.js), więc dłuższy limit nie mnoży połączeń.
//  - `pobierzPrzesylki` wola KARTA ZAMOWIENIA, synchronicznie, przy renderowaniu
//    (GET /zamowienia/:id, przed petla statusu kuriera). PO DRUGIEJ STRONIE SIEDZI CZLOWIEK
//    i patrzy w pusty ekran — a jedynym wyjsciem z odpytywania jest belka statusu stojaca
//    na TEJ WLASNIE karcie, wiec karta, ktora sie nie otwiera, jest stanem bez wyjscia
//    (reguła: każdy stan ma wyjście). Tu limit musi być krótki, dokładnie jak przy statusie kuriera.
//  - `pobierzOferte` woła UZUPEŁNIANIE ZDJĘĆ (moduly/kanaly/services/zdjecia-allegro.js), doczepione do
//    przebiegu pollera — w tle, bez człowieka, do LIMIT_OFERT_NA_PRZEBIEG ofert pod rząd — oraz przycisk
//    „Pobierz treść i zdjęcia ofert” w magazynie (moduly/magazyn/services/allegro-tresc-kart.js), który też
//    pyta o oferty po kolei, a człowiek czeka na wynik. Limit jest KRÓTKI, bo w obu ścieżkach mnoży się
//    przez liczbę ofert: przy 30 s jedna milcząca oferta przeciągałaby przebieg o pół minuty na sztukę.
//    W pollerze stawka jest wyłącznie ozdobna (miniatura); w przycisku oferta przerwana limitem dostaje
//    `tresc_blad` i zostaje niepobrana do następnego kliknięcia.
//  - `pobierzOferty` woła ODCZYT MAGAZYNU (moduly/magazyn/services/magazyn-sync.js), uruchamiany PRZYCISKIEM,
//    oraz przejęcie stanów (moduly/magazyn/services/przejecie-stanow.js).
//    Limit stoi POSRODKU i to jest decyzja: czlowiek czeka na wynik, ale nie na pusty ekran
//    — a przede wszystkim limit MNOŻY SIĘ przez liczbę stron. Pollerowe 30 s znaczyloby najgorszy przypadek liczony w minutach, a piec sekund
//    umialoby uciac zdrowy, tylko wolny odczyt calego katalogu i nie wczytac ANI JEDNEJ
//    oferty — bo kontrola kompletnosci (nizej) i tak odrzuca odczyt uciety.
export const LIMIT_ZAPYTANIA_ZAMOWIEN_MS = 30 * 1000;
export const LIMIT_ZAPYTANIA_PRZESYLEK_MS = 5000;
export const LIMIT_ZAPYTANIA_OFERTY_MS = 5000;
export const LIMIT_ZAPYTANIA_OFERT_MS = 10 * 1000;
// Odczyt kategorii i jej parametrów (raz na kategorię; słownik parametrów waży do ok. 1 MB).
export const LIMIT_ZAPYTANIA_KATEGORII_MS = 10 * 1000;

// ⚠️ WARTOŚĆ ZMIERZONA, NIE WZIĘTA Z DOKUMENTACJI: `GET /sale/offers?limit=1000&offset=0` → 200
// w sandboxie i na żywych kontach (kilkaset ofert w jednej odpowiedzi, setki KB, pół sekundy),
// `limit=1001` → 400. Przy limicie 20 katalog kilkuset ofert to kilkadziesiąt zapytań na przebieg
// pętli, przy 1000 — jedno. Sufit stron nadal z `totalCount`.
export const LIMIT_STRONY_OFERT = 1000;

// Twarda granica przebiegow: konto zglaszajace absurdalny `totalCount` (albo oddajace
// w kolko pelna strone) zapetliloby odczyt na godziny — przycisk „Odswiez", ktory nigdy nie
// wraca. 200 stron po `LIMIT_STRONY_OFERT` to zapas o rzędy wielkości ponad zwykły katalog.
export const MAKS_STRON_OFERT = 200;

// Limity wywołań wystawiania ofert. Zapis oferty i zdjęcia dostają
// 30 s jak faktura: Allegro waliduje ofertę synchronicznie i bywa wolne, a timeout zapisu
// to wynik NIEPEWNY (dalej rozstrzyga odczyt po sygnaturze, nie drugi POST).
export const LIMIT_ZAPISU_OFERTY_MS = 30 * 1000;
export const LIMIT_OPERACJI_MS = 10 * 1000;
export const LIMIT_ZDJECIA_MS = 30 * 1000;
export const LIMIT_KOMENDY_MS = 30 * 1000;
export const LIMIT_SLOWNIKOW_MS = 10 * 1000;
// Komenda zmiany ilości/ceny obejmuje najwyżej tyle ofert (dokumentacja Allegro).
export const MAKS_OFERT_KOMENDY = 1000;
const TYPY_ZDJEC = ['image/jpeg', 'image/png', 'image/webp'];

// Centrum wiadomości. Allegro pozwala na max 20 watkow na strone — to nie jest
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
// w tle — z czuwacza, bez człowieka po drugiej stronie. Piec sekund umialoby uciac
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
    'Limit zapytania o przesyłki (ścieżka karty, człowiek czeka) nie może być dłuższy niż limit ' +
      'pobierania zamówień w tle.',
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
    // Biała lista opisu: bez nagłówków, reszty ciała i parametrów zapytania (reguła: sekrety nie wychodzą).
    // ⚠️ Biała lista NAZW pól nie wystarcza: Allegro potrafi odbić token albo nagłówek
    // autoryzacji WEWNĄTRZ `message`. Maskujemy więc wartość tokenu tego żądania i każde
    // `Bearer …` — PRZED ucięciem do 300 znaków, inaczej zostałby początek tokenu.
    const ukryj = (s) => (token ? s.split(token).join('[ukryto]') : s).replace(/Bearer\s+\S+/gi, '[ukryto]');
    let dopisek = '';
    let bledy = [];
    try {
      const body = await r.json();
      if (Array.isArray(body?.errors)) {
        const tekst = (wartosc) => (typeof wartosc === 'string' ? ukryj(wartosc.trim()) : '');
        const opisy = ukryj(
          body.errors
            .slice(0, 3)
            .map((error) => {
              const opis = tekst(error?.userMessage) || tekst(error?.message);
              const path = tekst(error?.path);
              return opis ? opis + (path ? ` (${path})` : '') : '';
            })
            .filter(Boolean)
            .join('; '),
        );
        if (opisy) dopisek = ': ' + opisy.slice(0, 298);
        // Kody i `metadata` (np. PARAMETER_MISMATCH → productId, parameterId) dla pętli ofert.
        // Tylko proste wartości metadata, każda maskowana i ucięta — jak opis.
        const prosta = (w) => (typeof w === 'string' || typeof w === 'number' ? ukryj(String(w)).slice(0, 100) : null);
        bledy = body.errors.slice(0, 3).map((error) => ({
          kod: typeof error?.code === 'string' ? ukryj(error.code).slice(0, 100) : null,
          metadata: Object.fromEntries(
            Object.entries(error?.metadata && typeof error.metadata === 'object' ? error.metadata : {})
              .slice(0, 10)
              .map(([k, w]) => [k.slice(0, 50), prosta(w)])
              .filter(([, w]) => w !== null),
          ),
        }));
      }
    } catch {
      /* Brak JSON lub błąd odczytu zostawia dawny komunikat. */
    }
    const blad = new Error(`Allegro: HTTP ${r.status} przy ${sciezka.split('?')[0]}${dopisek}`);
    blad.status = r.status;
    blad.bledy = bledy;
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
  async function get(sciezka, limitMs, akceptuj = AKCEPTUJEMY, { zRetryAfter = false, jezyk = null } = {}) {
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
      // spowodują ZABLOKOWANIE KLUCZA API; Allegro odrzuca je automatycznie.
      // Wartosc idzie Z KONFIGURACJI (`ALLEGRO_USER_AGENT`, walidowana przy starcie
      // w src/core/web/modul.ts), bo Allegro trzyma ja na bialej liscie i pozwala zmieniac
      // wylacznie numer wersji — a wersja bedzie rosla bez wydawania panelu.
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: akceptuj,
        'User-Agent': ustawienia.userAgent,
        ...(jezyk ? { 'Accept-Language': jezyk } : {}),
      },
      // Nowy sygnal na KAZDE zadanie (ta sama zasada, co w dpd.js): wspolny starzalby sie
      // razem z procesem i po pierwszych 30 s zycia panelu przerywal kazde zapytanie
      // natychmiast. Sygnal jest NARZUCONY przez `get`, a nie brany z opcji wolajacego —
      // inaczej twardy limit dalby sie zgubic po cichu w jednym miejscu uzycia.
      signal: AbortSignal.timeout(limitMs),
    });
    // Kod HTTP, ścieżka bez parametrów i ograniczony opis z białej listy bladHttp.
    // Komunikat ląduje w bazie i na ekranie (reguła: sekrety nie wychodzą).
    if (!r.ok) throw await bladHttp(r, sciezka, token);
    const body = await r.json();
    if (!zRetryAfter) return body;
    const retryAfter = r.headers?.get?.('Retry-After');
    return /^[1-9]\d*$/.test(String(retryAfter ?? '')) ? { ...body, retryAfterS: Number(retryAfter) } : body;
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
    // Ten sam ograniczony opis co w GET — biała lista bladHttp (reguła: sekrety nie wychodzą).
    if (!r.ok) throw await bladHttp(r, sciezka, token);
    // 204 i puste cialo sa przy PUT normalne — `json()` rzucilby na nich SyntaxError,
    // czyli udana zmiana statusu wygladalaby jak awaria kanalu.
    return r.json().catch(() => null);
  }

  // Zapis, po którym liczy się NIE TYLKO ciało — `202` niesie adres operacji
  // w `Location` i `Retry-After`, a `303` (przy `redirect: 'manual'`) znaczy „gotowe".
  // `wyslijJson` zostaje bez zmian: kilkanaście wywołań czeka tam wyłącznie na ciało.
  // `cialo === undefined` = bez ciała i bez Content-Type (odczyt stanu operacji).
  async function wyslijJsonPelne(sciezka, metoda, cialo, limitMs, { redirect } = {}) {
    const token = await tokeny.waznyToken();
    const headers = { Authorization: `Bearer ${token}`, Accept: AKCEPTUJEMY, 'User-Agent': ustawienia.userAgent };
    if (cialo !== undefined) headers['Content-Type'] = AKCEPTUJEMY;
    const r = await http(`${ustawienia.api}${sciezka}`, {
      method: metoda,
      headers,
      ...(cialo !== undefined ? { body: JSON.stringify(cialo) } : {}),
      ...(redirect ? { redirect } : {}),
      signal: AbortSignal.timeout(limitMs),
    });
    // Przy `redirect: 'manual'` 3xx jest ODPOWIEDZIĄ, nie awarią (303 = operacja zakończona).
    const przekierowanie = redirect === 'manual' && r.status >= 300 && r.status < 400;
    if (!r.ok && !przekierowanie) throw await bladHttp(r, sciezka, token);
    const retryAfter = r.headers?.get?.('Retry-After');
    let dane = null;
    try {
      dane = await r.json();
    } catch {
      /* 202/303 bywają bez ciała */
    }
    return {
      status: r.status,
      location: r.headers?.get?.('Location') ?? null,
      retryAfterS: /^[1-9]\d*$/.test(String(retryAfter ?? '')) ? Number(retryAfter) : null,
      dane,
    };
  }

  async function pobierzMojeKonto() {
    const d = await get('/me', LIMIT_ZAPYTANIA_STATUSU_MS);
    if (
      typeof d?.id !== 'string' ||
      !/^\d{1,32}$/.test(d.id) ||
      typeof d?.login !== 'string' ||
      !d.login ||
      d.login.length > 128
    )
      throw new Error('Allegro nie zwróciło tożsamości konta.');
    return { id: d.id, login: d.login };
  }
  async function sprawdzZakresZamowien({ odUtc }) {
    const p = new URLSearchParams({
      limit: '1',
      offset: '0',
      'lineItems.boughtAt.gte': naDateAllegro(odUtc, 'podłoga'),
      sort: 'lineItems.boughtAt',
    });
    const d = await get(`/order/checkout-forms?${p}`, LIMIT_ZAPYTANIA_ZAMOWIEN_MS);
    if (!Array.isArray(d?.checkoutForms) || !Number.isSafeInteger(d.totalCount) || d.totalCount < 0)
      throw new Error('Allegro nie potwierdziło liczby zamówień w zakresie.');
    return d.totalCount;
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
      // GALAZ PODLOGI — PIERWSZY PRZEBIEG, przy rocznej historii zwykle kilka stron po 100 zamówień.
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
    // odróżnienia od złej konfiguracji. Tę samą kontrolę ma klient Woo.
    if (!Array.isArray(d?.checkoutForms))
      throw new Error('Allegro nie oddało listy zamówień (checkoutForms nie jest tablicą)');
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
   * Allegro WYCOFAŁO i oddaje 403 „This resource is no longer supported" — zmierzone na
   * żywym koncie. Zamiana sciezki „na krotsza" wyciszylaby miniatury w calosci,
   * i to cicho: brak zdjecia jest tu stanem normalnym, wiec nikt by tego nie zauwazyl.
   *
   * Oddajemy CALA odpowiedz, a nie sam adres: wyciagniecie zdjecia to regula domenowa
   * (domena/miniatury.js: zdjecieOferty) i ma dac sie sprawdzic bez dotykania HTTP.
   * Wymaga uprawnienia `allegro:api:sale:offers:read`.
   */
  async function pobierzOferte(ofertaId) {
    return get(`/sale/product-offers/${encodeURIComponent(ofertaId)}`, LIMIT_ZAPYTANIA_OFERTY_MS);
  }

  /**
   * Kategoria Allegro: `{ id, name, parent: { id } | null, leaf, options }` (zmierzone).
   * Ścieżkę od korzenia składa wołający, idąc po `parent.id`. Tylko odczyt; odmowę (401/403)
   * wołający pomija po `blad.status` — bez nowego wpisu w WYMAGANE_UPRAWNIENIA.
   */
  async function pobierzKategorie(kategoriaId) {
    return get(`/sale/categories/${encodeURIComponent(kategoriaId)}`, LIMIT_ZAPYTANIA_KATEGORII_MS);
  }

  /**
   * Opisy parametrów kategorii: `{ parameters: [{ id, name, type, unit, options: { describesProduct },
   * dictionary, restrictions }] }`. Słownik marek potrafi ważyć ok. 1 MB — przycina go `opisKategorii`
   * (domena/tresc-oferty-allegro.js), zanim cokolwiek trafi do bazy.
   */
  async function pobierzParametryKategorii(kategoriaId) {
    return get(`/sale/categories/${encodeURIComponent(kategoriaId)}/parameters`, LIMIT_ZAPYTANIA_KATEGORII_MS);
  }

  /**
   * WSZYSTKIE oferty tego konta — do lustra magazynu (`produkty_sklepowe`).
   *
   * ⚠️ BEZ ARGUMENTU KANAŁU — nie `pobierzOferty(kanal)`. Klient JEST już per-kanał: dostaje
   * `ustawienia` i `tokeny` jednego konta przy tworzeniu (moduly/kanaly/services/kompozycja-kanalow.ts,
   * `klienciKanalow`). Parametr `kanal` sugerowalby, ze jedna instancja obsluguje oba konta,
   * i pierwsze wywolanie z „drugim" kanalem po cichu przeczytaloby katalog pierwszego.
   * Kanał dokleja WOŁAJĄCY (moduly/magazyn/services/magazyn-sync.js), z klucza mapy — i tam sprawdza go biala lista
   * w `domena/allegro-oferta.js`.
   *
   * ⚠️ `GET /sale/offers` (LISTA) działa — zmierzone, HTTP 200. To NIE JEST ten
   * sam zasob, co wycofane `GET /sale/offers/{id}` (403 „no longer supported"); szczegoly
   * jednej oferty ida przez `/sale/product-offers/{id}` w `pobierzOferte` wyzej.
   *
   * ⚠️ NIE DOCIAGAMY GALERII. Lista niesie wylacznie `primaryImage` i to wystarcza:
   * pełna galeria kosztowałaby osobne wywołanie na każdą ofertę (setki), a zdjęcia do karty produktu
   * bierzemy ze sklepu, gdzie Woo oddaje komplet w tym samym zapytaniu.
   *
   * ⚠️ ŻADNYCH FILTRÓW W ZAPYTANIU. Zmierzone: literówka w nazwie parametru
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
        throw new Error(
          `Allegro: odczyt ofert przekroczył ${MAKS_STRON_OFERT} stron — przerywam, żeby się nie zapętlić.`,
        );
      }
      // Parametry ida z KAZDYM zadaniem, nie tylko z pierwszym.
      const p = new URLSearchParams({
        limit: String(LIMIT_STRONY_OFERT),
        offset: String(strona * LIMIT_STRONY_OFERT),
      });
      const d = await get(`/sale/offers?${p}`, LIMIT_ZAPYTANIA_OFERT_MS);
      // ⚠️ 200 z cialem nie-tablica NIE MOZE oddawac []: „konto nie ma ofert" byloby wtedy nie
      // do odróżnienia od złej konfiguracji, a odczyt magazynu oznaczyłby CAŁY katalog kanału
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
    } while (partia.length === LIMIT_STRONY_OFERT && (zapowiedziano === null || wszystkie.length < zapowiedziano));

    // ⚠️ Ucięty odczyt WYGLĄDA JAK SUKCES, a potem odczyt magazynu oznacza brakujące oferty jako
    // `zniknal_at` — czyli jest nieodrozninalny od „konto stracilo pol katalogu". Wiecej niz
    // zapowiedziano przepuszczamy bez slowa: oferta wystawiona w trakcie odczytu dokłada sie
    // do liczby i nic przez to nie ginie.
    if (zapowiedziano !== null && wszystkie.length < zapowiedziano) {
      throw new Error(
        `Odczyt ofert urwał się: Allegro zapowiedziało ${zapowiedziano} ofert, a zebraliśmy ${wszystkie.length}. Nie oddaję niepełnej listy, bo brakujące oferty wyglądałyby jak wycofane ze sprzedaży.`,
      );
    }
    return wszystkie;
  }

  // ===== Wystawianie ofert: zapis, odczyt, słowniki konta =====

  const wymagaj = (warunek, komunikat) => {
    if (!warunek) throw new Error(`Allegro: ${komunikat}`);
  };
  const tekstNiepusty = (w) => typeof w === 'string' && w.trim() !== '';
  const obiekt = (w) => w !== null && typeof w === 'object' && !Array.isArray(w);

  // Wynik zapisu oferty. Przy 202 Allegro oddaje id w ciele, ale ciało bywa puste — wtedy
  // id jest w adresie operacji (`/sale/product-offers/{id}/operations/{op}`).
  function wynikZapisuOferty(w) {
    const sciezka = w.location ? new URL(w.location, ustawienia.api).pathname : '';
    const zAdresu = /^\/sale\/product-offers\/([^/?#]+)\/operations\//.exec(sciezka);
    const ofertaId = w.dane?.id != null ? String(w.dane.id) : zAdresu ? decodeURIComponent(zAdresu[1]) : null;
    return {
      status: w.status,
      ofertaId,
      operacja: w.status === 202 ? w.location : null,
      retryAfterS: w.retryAfterS,
      dane: w.dane,
    };
  }

  /** `POST /sale/product-offers` — nowa oferta (201 gotowa, 202 w toku: patrz `stanOperacji`). */
  async function utworzOferte(cialo) {
    wymagaj(obiekt(cialo), 'oferty nie da się wystawić bez ciała-obiektu.');
    return wynikZapisuOferty(await wyslijJsonPelne('/sale/product-offers', 'POST', cialo, LIMIT_ZAPISU_OFERTY_MS));
  }

  /** `PATCH /sale/product-offers/{id}` — zmiana istniejącej oferty. */
  async function edytujOferte(ofertaId, zmiany) {
    wymagaj(tekstNiepusty(ofertaId), 'edycja oferty wymaga jej identyfikatora.');
    wymagaj(obiekt(zmiany), 'edycja oferty wymaga zmian jako obiektu.');
    return wynikZapisuOferty(
      await wyslijJsonPelne(
        `/sale/product-offers/${encodeURIComponent(ofertaId)}`,
        'PATCH',
        zmiany,
        LIMIT_ZAPISU_OFERTY_MS,
      ),
    );
  }

  /**
   * Stan operacji z `Location` po 202. `202` = w toku, `303` = gotowe (`location` wskazuje ofertę).
   * ⚠️ Adres przychodzi z odpowiedzi — idziemy tam wyłącznie na host API i wyłącznie na
   * ścieżkę operacji oferty, inaczej token poleciałby tam, gdzie wskaże nagłówek.
   */
  async function stanOperacji(adres) {
    wymagaj(tekstNiepusty(adres), 'brak adresu operacji.');
    const api = new URL(ustawienia.api);
    const u = new URL(adres, api);
    wymagaj(u.origin === api.origin, 'adres operacji spoza hosta API — nie wysyłam tam tokenu.');
    wymagaj(
      /^\/sale\/product-offers\/[^/?#]+\/operations\/[^/?#]+$/.test(u.pathname),
      'to nie jest adres operacji oferty.',
    );
    const w = await wyslijJsonPelne(u.pathname, 'GET', undefined, LIMIT_OPERACJI_MS, { redirect: 'manual' });
    return { ...w, wToku: w.status === 202, gotowe: w.status === 303 };
  }

  /**
   * Wszystkie oferty konta od `offset`, stroną `LIMIT_STRONY_OFERT`. Sufit stron liczony
   * z `totalCount` pierwszej odpowiedzi (+1), nie stały — 4500 ofert to 225 stron, a stałe
   * 200 ucięłoby katalog. Strona krótsza niż limit kończy odczyt zawsze (absurdalny
   * `totalCount` nie trzyma pętli), a niepełny odczyt wobec zapowiedzi jest GŁOŚNY — tak
   * samo jak w `pobierzOferty`.
   */
  async function ofertyKonta({ offset = 0 } = {}) {
    wymagaj(Number.isSafeInteger(offset) && offset >= 0, 'offset ofert musi być liczbą całkowitą ≥ 0.');
    const oferty = [];
    let zapowiedziano = null;
    let sufit = MAKS_STRON_OFERT;
    let strona = 0;
    let partia;
    do {
      if (strona >= sufit)
        throw new Error(`Allegro: odczyt ofert przekroczył ${sufit} stron — przerywam, żeby się nie zapętlić.`);
      const p = new URLSearchParams({
        limit: String(LIMIT_STRONY_OFERT),
        offset: String(offset + strona * LIMIT_STRONY_OFERT),
      });
      const d = await get(`/sale/offers?${p}`, LIMIT_ZAPYTANIA_OFERT_MS);
      if (!Array.isArray(d?.offers)) throw new Error('Allegro nie oddało listy ofert (offers nie jest tablicą)');
      partia = d.offers;
      oferty.push(...partia);
      if (strona === 0) {
        const total = Number(d.totalCount);
        if (Number.isFinite(total) && total >= 0) {
          zapowiedziano = total;
          sufit = Math.ceil(Math.max(0, total - offset) / LIMIT_STRONY_OFERT) + 1;
        }
      }
      strona += 1;
    } while (
      partia.length === LIMIT_STRONY_OFERT &&
      (zapowiedziano === null || offset + oferty.length < zapowiedziano)
    );
    if (zapowiedziano !== null && offset + oferty.length < zapowiedziano) {
      throw new Error(
        `Odczyt ofert urwał się: Allegro zapowiedziało ${zapowiedziano} ofert, a zebraliśmy ${offset + oferty.length}. Nie oddaję niepełnej listy.`,
      );
    }
    return { oferty, razem: zapowiedziano };
  }

  /**
   * Oferty o danej sygnaturze (`external.id`). ⚠️ Filtr po stronie Allegro bywa ignorowany
   * (wtedy wraca cała lista) — odfiltrowujemy sami, inaczej obca oferta wyglądałaby jak
   * „już wystawiona" i odczyt po sygnaturze uznałby zapis za udany.
   */
  async function ofertyPoSygnaturze(sygnatura) {
    wymagaj(tekstNiepusty(sygnatura), 'pusta sygnatura oferty.');
    const p = new URLSearchParams({ 'external.id': sygnatura, limit: String(LIMIT_STRONY_OFERT) });
    const d = await get(`/sale/offers?${p}`, LIMIT_ZAPYTANIA_OFERT_MS);
    if (!Array.isArray(d?.offers)) throw new Error('Allegro nie oddało listy ofert (offers nie jest tablicą)');
    // Wynik służy do decyzji „ponów POST albo nie”. Lista, która wygląda na niefiltrowaną (obca sygnatura)
    // albo ma więcej niż jedną stronę, nie dowodzi, że naszej oferty nie ma — to „nie wiadomo”, nie zero.
    if (d.offers.some((o) => o?.external?.id !== sygnatura)) {
      throw new Error('Allegro zignorowało filtr external.id — nie wiadomo, czy oferta z tą sygnaturą istnieje.');
    }
    if (Number(d.totalCount ?? d.offers.length) > d.offers.length) {
      throw new Error('Allegro oddało więcej niż jedną stronę ofert z tą sygnaturą — nie wiadomo, która jest nasza.');
    }
    return d.offers;
  }

  /**
   * Produkty katalogu Allegro po EAN (`phrase=<EAN>&mode=GTIN`).
   * ⚠️ `Accept-Language: pl-PL` jest warunkiem działania: bez niego fetch wysyła „*”, a Allegro odpowiada 422
   * `UnsupportedLanguageInAcceptLanguageHeader` (zmierzone na sandboksie) — każda karta z EAN kończyłaby się błędem.
   */
  async function szukajProduktow(ean) {
    wymagaj(typeof ean === 'string' && /^\d{8,14}$/.test(ean), 'EAN musi mieć 8–14 cyfr.');
    const d = await get(
      `/sale/products?${new URLSearchParams({ phrase: ean, mode: 'GTIN' })}`,
      LIMIT_SLOWNIKOW_MS,
      AKCEPTUJEMY,
      { jezyk: 'pl-PL' },
    );
    if (!Array.isArray(d?.products)) throw new Error('Allegro nie oddało listy produktów (products nie jest tablicą)');
    return d.products;
  }

  // Host uploadu z hosta API (`api.` → `upload.`), bez osobnej zmiennej env. Nie zgadujemy:
  // host bez `api.` to odmowa, a nie upload w nieznane miejsce.
  function originUploadu() {
    const u = new URL(ustawienia.api);
    wymagaj(u.hostname.startsWith('api.'), 'nie umiem wyliczyć hosta uploadu (host API nie zaczyna się od „api.").');
    u.hostname = `upload.${u.hostname.slice('api.'.length)}`;
    return u.origin;
  }

  /** `POST upload.<host>/sale/images` — bajty zdjęcia; `isAiCoCreated=true` WYŁĄCZNIE przy `ai`. */
  async function wgrajZdjecie(bajty, typ, { ai = false } = {}) {
    wymagaj(bajty instanceof Uint8Array && bajty.length > 0, 'puste zdjęcie — nie wysyłam.');
    wymagaj(TYPY_ZDJEC.includes(typ), `typ zdjęcia „${typ}" spoza listy (${TYPY_ZDJEC.join(', ')}).`);
    const sciezka = '/sale/images';
    const zapytanie = ai ? '?isAiCoCreated=true' : '';
    const token = await tokeny.waznyToken();
    const r = await http(`${originUploadu()}${sciezka}${zapytanie}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: AKCEPTUJEMY,
        'Content-Type': typ,
        'User-Agent': ustawienia.userAgent,
      },
      body: bajty,
      signal: AbortSignal.timeout(LIMIT_ZDJECIA_MS),
    });
    if (!r.ok) throw await bladHttp(r, sciezka, token);
    const d = await r.json().catch(() => null);
    if (!tekstNiepusty(d?.location)) throw new Error('Allegro nie oddało adresu wgranego zdjęcia');
    return { location: d.location, expiresAt: d.expiresAt ?? null };
  }

  // Komenda ilości/ceny: commandId z rezerwacji (klucz idempotencji), 1–1000 ofert, JEDNA
  // wartość dla wszystkich (Allegro przyjmuje jedną modyfikację na komendę).
  function sprawdzKomende(commandId, pozycje, pole, poprawna) {
    wymagaj(tekstNiepusty(commandId), 'komendy nie wolno wysyłać bez commandId (klucz idempotencji).');
    wymagaj(
      Array.isArray(pozycje) && pozycje.length >= 1 && pozycje.length <= MAKS_OFERT_KOMENDY,
      `komenda obejmuje od 1 do ${MAKS_OFERT_KOMENDY} ofert.`,
    );
    for (const p of pozycje) {
      wymagaj(tekstNiepusty(p?.ofertaId), 'pozycja komendy bez identyfikatora oferty.');
      wymagaj(poprawna(p[pole]), `niepoprawna wartość „${pole}" w komendzie.`);
    }
    wymagaj(new Set(pozycje.map((p) => p.ofertaId)).size === pozycje.length, 'oferta powtórzona w komendzie.');
    wymagaj(new Set(pozycje.map((p) => p[pole])).size === 1, 'jedna komenda = jedna wartość dla wszystkich ofert.');
    return [{ offers: pozycje.map((p) => ({ id: p.ofertaId })), type: 'CONTAINS_OFFERS' }];
  }

  /** `PUT /sale/offer-quantity-change-commands/{commandId}` — stała ilość dla ofert. */
  async function komendaIlosci(commandId, pozycje) {
    const offerCriteria = sprawdzKomende(commandId, pozycje, 'ilosc', (v) => Number.isSafeInteger(v) && v >= 0);
    return wyslijJson(
      `/sale/offer-quantity-change-commands/${encodeURIComponent(commandId)}`,
      'PUT',
      { modification: { changeType: 'FIXED', value: pozycje[0].ilosc }, offerCriteria },
      LIMIT_KOMENDY_MS,
    );
  }

  /** `PUT /sale/offer-price-change-commands/{commandId}` — stała cena „zł.gr" PLN. */
  async function komendaCeny(commandId, pozycje) {
    const offerCriteria = sprawdzKomende(
      commandId,
      pozycje,
      'cena',
      (v) => typeof v === 'string' && /^\d+\.\d{2}$/.test(v) && Number(v) > 0,
    );
    return wyslijJson(
      `/sale/offer-price-change-commands/${encodeURIComponent(commandId)}`,
      'PUT',
      { modification: { type: 'FIXED_PRICE', price: { amount: pozycje[0].cena, currency: 'PLN' } }, offerCriteria },
      LIMIT_KOMENDY_MS,
    );
  }

  /** Zakończenie lub wznowienie ofert z kluczem idempotencji. */
  async function komendaPublikacji(commandId, ofertyIds, akcja) {
    wymagaj(Array.isArray(ofertyIds), 'wymagana lista ofert.');
    wymagaj(tekstNiepusty(commandId), 'komendy nie wolno wysyłać bez commandId (klucz idempotencji).');
    wymagaj(
      ofertyIds.length >= 1 && ofertyIds.length <= MAKS_OFERT_KOMENDY,
      `komenda obejmuje od 1 do ${MAKS_OFERT_KOMENDY} ofert.`,
    );
    wymagaj(akcja === 'END' || akcja === 'ACTIVATE', 'niepoprawna akcja publikacji.');
    wymagaj(ofertyIds.every(tekstNiepusty), 'pozycja komendy bez identyfikatora oferty.');
    wymagaj(new Set(ofertyIds).size === ofertyIds.length, 'oferta powtórzona w komendzie.');
    const offerCriteria = [{ offers: ofertyIds.map((id) => ({ id })), type: 'CONTAINS_OFFERS' }];
    return wyslijJson(
      `/sale/offer-publication-commands/${encodeURIComponent(commandId)}`,
      'PUT',
      { publication: { action: akcja }, offerCriteria },
      LIMIT_KOMENDY_MS,
    );
  }

  const ZASOB_KOMENDY = {
    ilosc: 'offer-quantity-change-commands',
    cena: 'offer-price-change-commands',
    publikacja: 'offer-publication-commands',
  };
  /** Wynik komendy per oferta: `GET /sale/<komenda>/{commandId}/tasks`. */
  async function wynikKomendy(rodzaj, commandId) {
    wymagaj(Object.hasOwn(ZASOB_KOMENDY, rodzaj), `nieznany rodzaj komendy „${rodzaj}" (ilosc|cena|publikacja).`);
    wymagaj(tekstNiepusty(commandId), 'brak commandId komendy do odczytu.');
    const p = new URLSearchParams({ limit: String(MAKS_OFERT_KOMENDY), offset: '0' });
    const d = await get(
      `/sale/${ZASOB_KOMENDY[rodzaj]}/${encodeURIComponent(commandId)}/tasks?${p}`,
      LIMIT_OPERACJI_MS,
    );
    if (!Array.isArray(d?.tasks)) throw new Error('Allegro nie oddało wyniku komendy (tasks nie jest tablicą)');
    return d.tasks;
  }

  // Słowniki konta: 200 bez oczekiwanej listy to błąd, nie „konto nie ma cenników" —
  // pusty formularz wystawiania wyglądałby jak prawdziwy stan konta.
  async function slownik(sciezka, pole) {
    const d = await get(sciezka, LIMIT_SLOWNIKOW_MS);
    if (!Array.isArray(d?.[pole])) throw new Error(`Allegro nie oddało listy ${pole} (${sciezka.split('?')[0]})`);
    return d[pole];
  }
  const pobierzCenniki = () => slownik('/sale/shipping-rates', 'shippingRates');
  const pobierzZwroty = () => slownik('/after-sales-service-conditions/return-policies', 'returnPolicies');
  const pobierzReklamacje = () => slownik('/after-sales-service-conditions/implied-warranties', 'impliedWarranties');
  const pobierzGwarancje = () => slownik('/after-sales-service-conditions/warranties', 'warranties');
  const pobierzProducentow = () => slownik('/sale/responsible-producers', 'responsibleProducers');
  const pobierzOsobyOdpowiedzialne = () => slownik('/sale/responsible-persons', 'responsiblePersons');

  async function dopasujKategorie(nazwa) {
    wymagaj(tekstNiepusty(nazwa), 'dopasowanie kategorii wymaga nazwy.');
    return slownik(`/sale/matching-categories?${new URLSearchParams({ name: nazwa })}`, 'matchingCategories');
  }

  async function ustawieniaPodatku(kategoriaId) {
    wymagaj(tekstNiepusty(kategoriaId), 'ustawienia podatku wymagają kategorii.');
    const d = await get(
      `/sale/tax-settings?${new URLSearchParams({ 'category.id': kategoriaId })}`,
      LIMIT_SLOWNIKOW_MS,
    );
    if (!obiekt(d)) throw new Error('Allegro nie oddało ustawień podatku');
    return d;
  }

  /**
   * Prognoza prowizji: `POST /pricing/offer-fee-preview` — POST bez skutku po stronie Allegro.
   * Zmierzone na sandboksie: bez `publication` i `parameters` Allegro odpowiada 422 „Can't parse value of:
   * offer.publication”; z pustymi wartościami 200. Pola podane przez wołającego mają pierwszeństwo.
   */
  async function podgladOplat(oferta) {
    wymagaj(obiekt(oferta), 'podgląd opłat wymaga oferty jako obiektu.');
    const offer = { publication: {}, parameters: [], ...oferta };
    const d = await wyslijJson('/pricing/offer-fee-preview', 'POST', { offer }, LIMIT_SLOWNIKOW_MS);
    if (!obiekt(d)) throw new Error('Allegro nie oddało podglądu opłat');
    return d;
  }

  /** Opłaty wystawionej oferty: `GET /pricing/offer-quotes?offer.id=`. */
  async function oplatyOferty(ofertaId) {
    wymagaj(tekstNiepusty(ofertaId), 'opłaty oferty wymagają jej identyfikatora.');
    const d = await get(`/pricing/offer-quotes?${new URLSearchParams({ 'offer.id': ofertaId })}`, LIMIT_SLOWNIKOW_MS);
    if (!obiekt(d)) throw new Error('Allegro nie oddało opłat oferty');
    return d;
  }

  /**
   * Stan realizacji zamowienia — SWIEZO, tuz przed decyzja o wyslaniu statusu.
   *
   * ⚠️ NIE DA SIĘ TEGO WZIĄĆ Z NASZEJ BAZY. Zmierzone: Allegro **nie podbija
   * `updatedAt` przy zmianie `fulfillment.status`** (co drugie sprawdzone zamówienie miało u nas
   * `PROCESSING`, a w Allegro `SENT`, przy identycznym `updatedAt`). Poller filtruje po `updatedAt.gte`,
   * wiec takiego zamowienia nie odczyta ponownie NIGDY — kolumna `status_realizacji` jest
   * nieaktualna na zawsze i decyzja oparta na niej cofa kupujacemu status.
   *
   * Limit KROTKI: to wywolanie idzie z trasy, przy ktorej czeka czlowiek (zapisal wlasnie
   * „wyslane"), a nieudany odczyt niczego nie psuje — regula po prostu odmawia wysylki
   * i zostawia slad do ponowienia.
   */
  async function pobierzStanRealizacji(idZamowienia) {
    const d = await get(`/order/checkout-forms/${encodeURIComponent(idZamowienia)}`, LIMIT_ZAPYTANIA_STATUSU_MS);
    // ⚠️ `null` (Allegro nie ma statusu) MUSI dac sie odroznic od awarii — dlatego brak pola
    // oddajemy jako `null`, a awaria RZUCA. `domena/allegro-status.js` czyta `undefined` jako
    // „NIE PYTALISMY" i odmawia wysylki, wiec oddanie stad `undefined` uciszyloby kanal.
    return d?.fulfillment?.status ?? null;
  }

  async function ustawStatusRealizacji(idZamowienia, status) {
    // ⚠️ ODMOWA PRZED WYJSCIEM DO SIECI. Wartosc spoza listy to nasz blad, nie blad Allegro —
    // a 400 z Allegro powiedzialoby „HTTP 400", nie „ten status nie istnieje". Lista jest
    // pelna lista z dokumentacji, celowo szersza niz to, co wysylamy (PROCESSING/SENT):
    // klient ma odmawiac literowce, a nie decydowac za `domena/allegro-status.js`.
    const DOZWOLONE = ['NEW', 'PROCESSING', 'READY_FOR_SHIPMENT', 'SENT', 'READY_FOR_PICKUP', 'PICKED_UP'];
    if (!DOZWOLONE.includes(status)) {
      throw new Error(`Allegro: „${status}" nie jest statusem realizacji (dozwolone: ${DOZWOLONE.join(', ')})`);
    }
    // ⚠️ NIE WYSYLAMY `checkoutForm.revision`. Allegro daje ten parametr jako blokade
    // optymistyczna (409 przy nieaktualnej wersji), ale nasza kopia zamowienia jest stara
    // nawet o dwie minuty (przebieg pollera), a wlasciciel klika w panelu Allegro rownolegle.
    // Konflikt oznaczalby falszywa sprawe na pasku przy zamowieniu, z ktorym wszystko jest
    // w porzadku. Przed wyslaniem czegos niepotrzebnego broni `domena/allegro-status.js`
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
   * Zmierzone na kilku zamówieniach z dwóch kont: ścieżka istnieje i jest routowana (sciezki
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
    const sciezka =
      `/order/checkout-forms/${encodeURIComponent(idZamowienia)}` + `/invoices/${encodeURIComponent(invoiceId)}/file`;
    const r = await http(`${ustawienia.api}${sciezka}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        // `Accept` zostaje WERSJONOWANY: odpowiedz na ten PUT niesie stan weryfikacji pliku
        // i przychodzi JSON-em Allegro.
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
    // ⚠️ Do komunikatu idzie kod HTTP i ścieżka — NIGDY token ani ciało odpowiedzi (reguła: sekrety nie wychodzą).
    if (!r.ok) throw new Error(`Allegro: HTTP ${r.status} przy ${sciezka}`);
    // Puste cialo nie jest awaria — stan weryfikacji jest bonusem, a nie warunkiem powodzenia.
    return r.json().catch(() => null);
  }

  // ─── WYSYLAM Z ALLEGRO (WzA) ────────────────────────────────────────────────────────────
  //
  // ⚠️ TE CZTERY WYWOLANIA WYDAJA PIENIADZE. `utworzPrzesylke` kupuje PRAWDZIWY przewoz
  // u prawdziwego przewoznika, na umowie Allegro. Nie ma trybu probnego ani sandboxa,
  // a kupionej etykiety nie cofa sie kliknieciem. Reszta modulu tego nie wola sama —
  // droga prowadzi przez `domena/allegro-wysylka.js` (bariera) i `kurierzy/allegro-wza.js`.
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
      'POST',
      { shipmentIds, readyDate, address },
      LIMIT_PODJAZDU_MS,
    );
  }

  /**
   * Jedna próba zlecenia dla UUID zapisanego wcześniej przez usługę.
   * Po timeout/5xx odczytujemy stan tego samego commandId, nigdy nie ponawiamy POST-u.
   */
  async function zlecPodjazd({ commandId, input } = {}) {
    if (!commandId) throw new Error('Allegro: podjazdu nie wolno zlecać bez commandId.');
    sprawdzPrzesylkiPodjazdu(input?.shipmentIds);
    if (!input?.pickupTime?.date) throw new Error('Allegro: podjazd wymaga pickupTime z datą.');
    // Sama data (godzinę ustala przewoźnik) albo pełne okno — nigdy połowa okna.
    if ((input.pickupTime.minTime != null) !== (input.pickupTime.maxTime != null)) {
      throw new Error('Allegro: pickupTime wymaga obu godzin (minTime i maxTime) albo żadnej.');
    }
    if (!input?.address) throw new Error('Allegro: podjazd wymaga address.');
    for (const pole of ['pickupDateProposalId', 'proposalItems']) {
      if (Object.hasOwn(input, pole))
        throw new Error(`Allegro: wycofane pole podjazdu ${pole} nie może zostać wysłane.`);
    }
    return wyslijJson('/shipment-management/pickups/create-commands', 'POST', { commandId, input }, LIMIT_PODJAZDU_MS);
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
   * w zamówieniu (zmierzone), więc nasza kopia bywa nieświeża Z DEFINICJI. Ta
   * wartość decyduje o tym, KTÓRĄ USŁUGĘ kupujemy — czyli o pieniądzach i o Smart kupującego.
   *
   * `null` (Allegro nie podało metody) MUSI dać się odróżnić od awarii: brak pola oddajemy
   * jako `null`, a awaria RZUCA. Bariera w `domena/allegro-wysylka.js` czyta `null` jako
   * odmowę, więc ciche zamienienie awarii w `null` dałoby odmowę zamiast krzyku.
   */
  async function pobierzMetodeDostawy(idZamowienia) {
    const d = await get(`/order/checkout-forms/${encodeURIComponent(idZamowienia)}`, LIMIT_ZAPYTANIA_STATUSU_MS);
    return d?.delivery?.method?.id ?? null;
  }

  async function utworzPrzesylke({ commandId, input } = {}) {
    // ⚠️ `commandId` JEST KLUCZEM IDEMPOTENCJI ALLEGRO i musi przyjsc Z REZERWACJI W BAZIE.
    // Wylosowany tutaj znaczylby, ze ponowienie po zerwanym polaczeniu kupuje DRUGI przewoz.
    // Panel Allegro takiej osłony nie ma — da się w nim kupić dwie etykiety do jednego
    // zamówienia. Rzucamy PRZED wyjsciem do sieci: 400 od Allegro tez byloby glosne,
    // ale mowiloby „HTTP 400", a nie „ktos zapomnial klucza idempotencji".
    if (!commandId)
      throw new Error('Allegro: przesyłki nie wolno tworzyć bez commandId (klucz idempotencji z rezerwacji).');

    // ⚠️ POMINIETE `deliveryMethodId` ZNACZY, ZE USLUGE DOBIERA ALLEGRO, A NIE MY.
    // Dokumentacja twierdzi, ze bierze sie wtedy z zamowienia, ale `delivery-proposals`
    // oddaje to pole jako `null` (zmierzone) i NIE ZMIERZYLIŚMY, co robi Allegro
    // przy braku. Zla usluga to utrata Smart u kupujacego i przewoz, ktorego nikt nie
    // zamawial — wiec pole jest tu OBOWIAZKOWE, a wartosc pochodzi z zywego odczytu
    // zamowienia (`domena/allegro-wysylka.js`), nigdy z podpowiedzi i nigdy z bazy.
    if (!input?.deliveryMethodId) {
      throw new Error('Allegro: przesyłki nie wolno tworzyć bez deliveryMethodId — usługę wybieramy my, nie Allegro.');
    }

    return wyslijJson(
      '/shipment-management/shipments/create-commands',
      'POST',
      { commandId, input },
      LIMIT_WYSYLKI_PRZESYLKI_MS,
    );
  }

  /**
   * Gotowa przesylka — i JEDYNE miejsce, w ktorym jest NUMER LISTU.
   *
   * ⚠️ ZMIERZONE NA PRAWDZIWEJ PACZCE. Odpowiedź komendy tworzenia
   * niesie WYLACZNIE `{commandId, status, errors, shipmentId}` — numeru listu tam NIE MA
   * i nie pojawi sie nigdy. Trzeba pojsc po niego tutaj: `packages[].waybill` (numer
   * allegrowy „AD…") oraz `packages[].transportingInfo[].carrierWaybill` (numer u DPD).
   * Założenie, że numer przyjdzie razem ze statusem, jest błędne.
   */
  async function pobierzPrzesylkeWza(shipmentId) {
    return get(`/shipment-management/shipments/${encodeURIComponent(shipmentId)}`, LIMIT_ZAPYTANIA_PRZESYLEK_MS);
  }

  /**
   * HISTORIA ZDARZEN PRZEWOZU — dziala TAKZE dla przesylek, ktorych panel nie nadawal
   * (Allegro Punkt, Allegro One). Zmierzone sondą.
   *
   * ⚠️ `Accept-Language: pl-PL` NIE JEST OZDOBNIKIEM. Bez tego naglowka `description`
   * przychodzi PO ANGIELSKU („Parcel has been delivered") i trafia prosto na ekran karty
   * oraz do zakladki przesylek. Klasyfikacji to nie ruszy — etap liczy sie z maszynowego
   * `code` (domena/etap-przesylki.js) — ale operator zobaczylby angielski opis obok
   * polskich zdarzen DPD i InPostu.
   *
   * ⚠️ ZŁY `carrierId` NIE ODDAJE BŁĘDU. Przepytano wszystkie (kilkadziesiąt) identyfikatory
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
    // Kod HTTP i ścieżka bez numeru — komunikat ląduje w bazie i na ekranie (reguła: sekrety nie wychodzą).
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
    // ⚠️ Do komunikatu idzie kod HTTP i ścieżka — NIGDY token ani ciało (reguła: sekrety nie wychodzą).
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
  // ⚠️ Limit bierzemy z `domena/ustawienia-formulki.js`, a nie z wlasnej stalej — ta sama
  // liczba pilnuje formularza w Ustawieniach i wyjscia do sieci. Dwie kopie rozjechalyby sie
  // przy pierwszej zmianie po stronie Allegro.
  async function deklarujZalacznikWiadomosci(nazwa, rozmiar) {
    sprawdzNazwe(nazwa);
    if (!Number.isInteger(rozmiar) || rozmiar < 1 || rozmiar > MAKS_PLIK)
      throw Error('Allegro: rozmiar załącznika musi mieścić się w 5 MiB.');
    const wynik = await wyslijJson('/messaging/message-attachments', 'POST', { filename: nazwa, size: rozmiar }, 30000);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(wynik?.id || ''))
      throw Error('Allegro nie zwróciło identyfikatora deklaracji załącznika.');
    return wynik;
  }
  async function wgrajZalacznikWiadomosci(id, bajty, mime) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id || '')) throw Error('Nieprawidłowy identyfikator załącznika.');
    if (!Buffer.isBuffer(bajty) || !bajty.length || bajty.length > MAKS_PLIK)
      throw Error('Nieprawidłowy rozmiar załącznika.');
    if (!['application/pdf', 'image/png', 'image/gif', 'image/bmp', 'image/tiff', 'image/jpeg'].includes(mime))
      throw Error('Nieobsługiwany format załącznika.');
    const sciezka = '/messaging/message-attachments/' + encodeURIComponent(id);
    const token = await tokeny.waznyToken();
    // No automatic retry: an interrupted upload has an uncertain remote outcome.
    const r = await http(ustawienia.api + sciezka, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: AKCEPTUJEMY,
        'Content-Type': mime,
        'User-Agent': ustawienia.userAgent,
      },
      body: bajty,
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw await bladHttp(r, sciezka, token);
    const wynik = await r.json();
    if (wynik?.id !== id) throw Error('Allegro nie potwierdziło identyfikatora wgranego załącznika.');
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
      'POST',
      { text: tresc, ...(zalaczniki.length ? { attachments: zalaczniki.map((id) => ({ id })) } : {}) },
      LIMIT_WYSYLKI_WIADOMOSCI_MS,
    );
  }

  // Dyskusje i reklamacje. ⚠️⚠️ RUSZTOWANIE TYMCZASOWE: `/sale/disputes` Allegro usunęło,
  // a te sprawy przechodzą do Centrum wiadomości jako wątki POST_PURCHASE_ISSUE i mają być
  // obsługiwane WYŁĄCZNIE przez `/messaging`. Gdy to nastąpi, ta metoda ma ZNIKNĄĆ razem
  // z moduly/wiadomosci/services/dyskusje.js, a nie zostac „na wszelki wypadek".
  //
  // ⚠️ KSZTAŁT ODPOWIEDZI — ZMIERZONY na żywym koncie, nie założony. Odpowiedz ma
  // DOKLADNIE JEDNO pole najwyzszego poziomu: `issues` (tablica). Nazwa kolekcji byla wczesniej
  // zgadnieta i trafiona.
  //
  // ⚠️⚠️ `totalCount` NIE ISTNIEJE w tej odpowiedzi, wiec `razem` jest ZAWSZE `null`. Dzis nic
  // na nim nie stoi (moduly/wiadomosci/services/dyskusje.js czyta wyłącznie pierwszą stronę), ale ktokolwiek
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
    pobierzMojeKonto,
    sprawdzZakresZamowien,
    pobierzZamowienia,
    pobierzPrzesylki,
    pobierzOferte,
    pobierzOferty,
    pobierzKategorie,
    pobierzParametryKategorii,
    pobierzStanRealizacji,
    ustawStatusRealizacji,
    pobierzFakturyZamowienia,
    zglosFakture,
    wyslijPlikFaktury,
    pobierzPropozycjeWysylki,
    pobierzMetodeDostawy,
    utworzPrzesylke,
    stanTworzeniaPrzesylki,
    pobierzPrzesylkeWza,
    pobierzEtykieteWza,
    pobierzSledzenie,
    pobierzPropozycjePodjazdu,
    zlecPodjazd,
    stanZleceniaPodjazdu,
    pobierzPodjazd,
    pobierzWatki,
    pobierzWiadomosci,
    wyslijWiadomosc,
    deklarujZalacznikWiadomosci,
    wgrajZalacznikWiadomosci,
    pobierzSprawy,
    // Wystawianie ofert (zapisy w nagłówku pliku; bez kasowania).
    utworzOferte,
    edytujOferte,
    stanOperacji,
    ofertyKonta,
    ofertyPoSygnaturze,
    szukajProduktow,
    wgrajZdjecie,
    komendaIlosci,
    komendaCeny,
    komendaPublikacji,
    wynikKomendy,
    pobierzCenniki,
    pobierzZwroty,
    pobierzReklamacje,
    pobierzGwarancje,
    pobierzProducentow,
    pobierzOsobyOdpowiedzialne,
    ustawieniaPodatku,
    dopasujKategorie,
    podgladOplat,
    oplatyOferty,
  };
}
