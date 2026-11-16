import { grosze } from './suma-pozycji.js';
import { bladOperatora } from './bledy.js';
import { oczyscNazweDostawy } from './allegro-dostawa.js';
import { bezEtykietyNip } from './dane-faktury.js';

//
// Zmierzone na prawdziwych zamówieniach — zgadza się na każdym z próbki:
//   Σ(price × quantity) + delivery.cost + Σ surcharges == summary.totalToPay
//
// ⚠️ `price` to CENA JEDNOSTKOWA BRUTTO, inaczej niż `line_items[].total` w WooCommerce,
// które jest SUMĄ LINII i BEZ VAT-u. Pomyłka w tę stronę zaniżyłaby fakturę o VAT i o całą
// resztę sztuk, a bariera arytmetyczna zablokowałaby wystawienie — deterministycznie,
// czyli operator klikałby w kółko ten sam komunikat.

// Kwoty od Allegro są NAPISAMI („99.00"). Liczymy na groszach jako liczbach całkowitych:
// float po dwóch dodawaniach przestaje się zgadzać z barierą co do grosza.
//
// ⚠️ ZERO ZA NIEPARSOWALNĄ KWOTĘ JEST WYJĄTKIEM O WĄSKIM ZAKRESIE i wolno go użyć WYŁĄCZNIE
// tam, gdzie brak kwoty jest normalnym stanem zamówienia: `delivery.cost` (darmowa dostawa)
// i `surcharges` (dopłata to rzadkość). Dla kwoty zamówienia I DLA CENY POZYCJI obowiązuje
// reguła ODWROTNA — patrz `groszeWymagane` niżej.
//
// ⚠️ CENA POZYCJI JEST WARTOŚCIĄ WYMAGANĄ. Gdyby nieparsowalna cena pozycji schodziła po cichu
// do zera, lądowałaby na karcie jako `0,00 zł` — nie jako brak danych, tylko jako FAKT, którego
// nikt nie ma powodu kwestionować. Odmowa zamiast zera, z trzech powodów:
//   1. reguła tego pliku: zero wolno tam, gdzie „brak kwoty" jest normalnym stanem
//      zamówienia. Oferta BEZ CENY nie jest normalnym stanem — w zmierzonych zamówieniach
//      cenę miała każda pozycja. To nie jest „darmowa pozycja", tylko dana nie do odczytania;
//   2. zero kłamie w DWÓCH miejscach naraz: na karcie (kwota, którą czyta człowiek) i w sumie
//      pozycji, która karmi barierę arytmetyczną faktury. Faktury i tak nie da się wtedy
//      wystawić (suma pozycji < kwota zamówienia), ale odmowa mówi o niezgodności sum, a nie
//      o prawdziwej przyczynie — operator klika w kółko przy pozycji, która wygląda poprawnie;
//   3. odmowa nie jest kosztowna: rzut z mapowania pomija JEDNO zamówienie z zapisanym
//      powodem i przesuwa kursor (services/poller.js), zamiast zatrzymywać cały kanał.
//      Bez tej izolacji w pollerze ten wybór byłby nie do przyjęcia.
//
// ⚠️ CENA TEJ DECYZJI, wprost: pominiętego zamówienia panel NIE POKAŻE, a kursor przez nie
// przeskoczy, więc samo z siebie NIE WRÓCI (wróci dopiero, gdy Allegro je zmodyfikuje).
// Powód stoi w `stan_pollera.ostatni_blad` i na pasku listy zamówień. Przy tym kanale koszt
// jest znośny: paczkę Allegro da się nadać także w panelu Allegro, więc brak zamówienia
// w OMS-ie nie zatrzymuje wysyłki — zabiera fakturę i widok, a nie paczkę.
export const groszeZKwoty = (k) => {
  const n = Number(k?.amount ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

// Kwota, ktora MUSI byc liczba. To jest `grosze` z domena/suma-pozycji.js — DOKLADNIE ta sama
// funkcja, ktora steruje bariera arytmetyczna faktury, z tym samym uzasadnieniem: „pusta
// /nieliczbowa kwota ma RZUCIC, a nie zamienic sie w NaN". Wlasna kopia tej reguly tutaj
// rozjechalaby sie z bariera przy pierwszej zmianie po ktorejkolwiek stronie.
//
// ⚠️ POWOD, DLA KTOREGO `summary.totalToPay` NIE MOZE PO CICHU ZOSTAC ZEREM: ta jedna liczba
// karmi NARAZ `kwota_brutto` i `kwota_pobrania`. Fakture na 0,00 zl zablokuje bariera
// (deterministycznie, wiec ktos to zauwazy), ale „pobranie 0,00 zl" NIE JEST przez nic
// sprawdzane — operator przeczyta je na karcie i na ekranie nadania jako FAKT i dokladnie
// tyle zainkasuje kurier. To sa pieniadze klienta, wiec kanal ma tu ODMOWIC, a nie zgadnac.
const groszeWymagane = (k, opis) => grosze(k?.amount, opis);

const zGroszy = (g) => (g / 100).toFixed(2);

// Netto z brutta TA SAMA arytmetyka, co na podsumowaniu VAT proformy
// (domena/podsumowanie-vat.js): round(bruttoGr * 100 / (100 + stawka)), na groszach
// jako liczbach calkowitych. Dzielenie przez „1,23" wpisane wprost dawaloby te sama
// liczbe przy 23%, ale rozjechaloby sie przy kazdej innej stawce — a stawka jest tu DANA
// (`lineItems[].tax.rate`), nie stala.
const nettoZBruttaGr = (bruttoGr, stawka) => Math.round((bruttoGr * 100) / (100 + stawka));

const STAWKA_DOMYSLNA = 23;
const stawkaLinii = (li) => Number(li?.tax?.rate ?? STAWKA_DOMYSLNA) || STAWKA_DOMYSLNA;

// Metoda platnosci to pole, ktore oglada WYLACZNIE czlowiek (tabela wplat na karcie, filtr
// listy) — tak samo jak `payment_method_title` ze sklepu, a nie identyfikator 'p24'/'bacs'.
// Surowe `ONLINE` / `CASH_ON_DELIVERY` przeszloby do widoku jako techniczny krzyk, a filtr
// listy pokazywalby dwa slowniki naraz. Nieznany rodzaj pokazujemy SUROWO: lepiej, zeby
// operator zobaczyl nowa wartosc Allegro, niz zeby zniknela pod „inna".
const PLATNOSCI = {
  ONLINE: 'Allegro (płatność online)',
  CASH_ON_DELIVERY: 'Za pobraniem',
};

const tekstAlboNull = (v) => {
  const s = String(v ?? '').trim();
  return s || null;
};

// ⚠️ ADRES W MODELU PANELU, A NIE W KSZTALCIE ALLEGRO — i to jest cala tresc tej funkcji.
//
// Panel czyta adresy JEDNYM kompletem kluczy (Woo `billing`/`shipping`): `first_name`,
// `last_name`, `company`, `address_1`, `address_2`, `postcode`, `city`, `country`.
// Robia to domena/adres-odbiorcy.js i domena/dane-faktury.js, czyli karta, ekran nadania
// i nabywca wysylany do inFaktu. Wpisanie tam surowego obiektu Allegro
// (`street`/`zipCode`/`company: {name, taxId}`) NIE WYWALA NICZEGO — po prostu wszystkie te
// pola robia sie puste, a `company` staje sie OBIEKTEM, ktory na fakturze wyladowalby jako
// nazwa nabywcy. Dokument bez ulicy i kodu pocztowego jest zly, a KSeF-u sie nie kasuje,
// tylko koryguje. Zmierzone na fikstrze: `daneFaktury` oddawalo `firma` jako `{name, ids,
// vatPayerStatus, taxId}` i `ulica: null`.
//
// ⚠️ `buyer.address` uzywa klucza `postCode`, a `delivery.address` i `invoice.address` —
// `zipCode`. Czytanie jednego kluczem drugiego daje adres bez kodu pocztowego.
//
// ⚠️ PUSTA KOPERTA TO BRAK ADRESU, A NIE ADRES PUSTY — i dlatego ta funkcja oddaje `null`
// takze wtedy, gdy blok OD ALLEGRO PRZYSZEDL, ale nie niesie juz zadnego pola adresowego.
//
// Allegro udostepnia dane osobowe kupujacego przez OGRANICZONY CZAS, a anonimizacja
// w serwisach polega zwykle na ZEROWANIU POL, nie na usunieciu struktury. Po wygasnieciu
// dostaniemy wiec nie `undefined`, tylko koperte `{street: null, city: null, zipCode: null}`.
// Zapis (db/zamowienia.js) nie nadpisuje adresu WYLACZNIE wartoscia `null` — czyli to TUTAJ
// musi zapasc decyzja, ze taka koperta znaczy „brak danych", inaczej poller skasowalby
// zapisany adres zamowienia czekajacego na wysylke, i to w ciagu dwoch minut.
//
// ⚠️ DLACZEGO TA DECYZJA MIESZKA W MAPOWANIU, A NIE W ZAPISIE. Zapis jest WSPOLNY dla
// wszystkich kanalow — jada nim zywe sklepy (sklep A, sklep B), na ktorych panel
// naprawde nadaje DPD i InPost. „Co znaczy pusty adres" jest wiedza KANALU i tylko tutaj
// wiadomo, ze:
//   * `country` to NASZ domysl ('PL'), a nie dana Allegro — dla WooCommerce `country` jest
//     prawdziwa dana sklepu, wiec ta sama regula w zapisie klamalaby o sklepach;
//   * `email` i `phone` sa doklejane PO adresie, z `buyer` i `delivery` (patrz klientAllegro
//     i dostawaAllegro), wiec blok NIGDY nie sklada sie z samego adresu. Reguly liczacej pola
//     GOTOWEGO bloku nie da sie napisac poprawnie: mail posrednika („…@allegromail.pl") ma
//     najwieksza szanse przezyc anonimizacje i sam jeden przepuscilby kasowanie adresu.
//
// `country` jest z liczenia WYLACZONE takze dlatego, ze sam kraj NIE JEST adresem: nie
// wskazuje zadnego miejsca i nie przechodzi przez `brakujacePolaAdresu` (ulica, kod, miasto).
// Wliczony czynilby KAZDA pusta koperte „niepusta" i cala ochrona byla by dekoracja.
//
// Odwrotna granica jest rownie wazna: JEDNO niepuste pole bloku (choćby samo miasto) znaczy
// DANA i caly blok schodzi do panelu. To nie jest zamrozenie adresu.
//
// ⚠️ IMIĘ, NAZWISKO I FIRMA LICZĄ SIĘ JAKO TREŚĆ, choć nie są adresem POCZTOWYM — i to jest
// wybór, nie przeoczenie. Nie wiemy, czy przy przesyłce do paczkomatu (spora część zamówień)
// `delivery.address` w ogóle niesie ulicę i miasto; gdyby nie niosła, reguła
// licząca WYŁĄCZNIE ulicę/kod/miasto oddawałaby `null` przy KAŻDEJ synchronizacji i panel
// nie zapisałby nazwiska odbiorcy ANI RAZU — awaria na ruchu normalnym, a nie na wygaśnięciu.
// Ryzyko odwrotne — Allegro kasuje adres, ale przez chwile oddaje jeszcze samo nazwisko —
// zostaje otwarte i jest tu nazwane wprost. Jest mniejsze (nazwisko to dana osobowa, wiec
// wygasa RAZEM z adresem, inaczej niz mail posrednika) i odwracalne: operator ma „Przywroc
// dane ze sklepu" i pelna tresc w `surowe_json`. Brak nazwiska odbiorcy na paczce jest za to
// nieodwracalny w druga strone — kurier nie ma komu wydac przesylki.
function adresPanelu(a, { imie = null, nazwisko = null, firma = null } = {}) {
  if (!a) return null;
  const blok = {
    first_name: tekstAlboNull(imie ?? a.firstName),
    last_name: tekstAlboNull(nazwisko ?? a.lastName),
    company: tekstAlboNull(firma ?? a.companyName),
    // Allegro trzyma numer domu W ULICY (jedno pole `street`), wiec `address_2` zostaje
    // puste — `sklejUlice` w domena/dane-reczne.js zlozy z tego dokladnie `street`.
    address_1: tekstAlboNull(a.street),
    address_2: null,
    postcode: tekstAlboNull(a.zipCode ?? a.postCode),
    city: tekstAlboNull(a.city),
    country: tekstAlboNull(a.countryCode) ?? 'PL',
  };
  const { country, ...odAllegro } = blok;
  if (Object.values(odAllegro).every((pole) => pole === null)) return null;
  return blok;
}

// Nabywca (blok `klient`, odpowiednik Woo `billing`).
//
// ⚠️ ADRES BIERZEMY BLOKIEM, NIE POLE PO POLU. `invoice.address` jest na części zamówień,
// przy pozostałych nabywca to kupujący — ale gdy Allegro poda adres faktury NIEPELNY,
// brakujace pola maja zostac PUSTE, a nie doklejone z adresu kupujacego. Sklejony adres
// wyglada na poprawny i nikt go nie zakwestionuje, a dokument idzie pod miejsce, ktore
// nigdy nie istnialo. Ta sama zasada, co przy `nettoIPodatekLinii` w domena/mapowanie.js:
// fallback dziala PARAMI, nie polami.
//
// WYJATKI OD REGULY BLOKU sa TRZY i wszystkie swiadome:
//  1. `email` — `invoice.address` nie zawiera go w ogole, wiec jedynym zrodlem jest `buyer`.
//  2. `phone` — jak wyzej, plus pierwszenstwo dla numeru z bloku dostawy (patrz nizej).
//  3. `imie`/`nazwisko` — gdy `invoice.address` nie ma `naturalPerson` (na fikstrze zawsze
//     `null`), nazwa osoby schodzi na `buyer`. To NIE lamie reguly „adres blokiem": imie
//     i nazwisko nie sa czescia adresu pocztowego, wiec zlozenie ich z ulica z drugiego
//     bloku nie tworzy miejsca, ktore nie istnieje — a bez tego faktura osoby prywatnej
//     wyszlaby bez nabywcy. Ulica, kod i miasto dalej ida WYLACZNIE parami z jednego bloku.
function klientAllegro(surowe) {
  const buyer = surowe?.buyer ?? null;
  const inv = surowe?.invoice?.address ?? null;
  const podstawa = inv
    ? adresPanelu(inv, {
      imie: inv?.naturalPerson?.firstName ?? buyer?.firstName ?? null,
      nazwisko: inv?.naturalPerson?.lastName ?? buyer?.lastName ?? null,
      firma: inv?.company?.name ?? null,
    })
    : adresPanelu(buyer?.address, {
      imie: buyer?.firstName ?? null,
      nazwisko: buyer?.lastName ?? null,
      firma: buyer?.companyName ?? null,
    });
  // ⚠️ TO JEDNO `return null` JEST CALA OCHRONA ADRESU NABYWCY. Ponizej doklejamy `email`
  // i `phone` z `buyer`/`delivery`, a mail posrednika („…@allegromail.pl") ma najwieksza
  // szanse przezyc wygasniecie danych. Gdyby pusta koperta szla dalej, do bazy poszedlby
  // blok „sam email" — dla zapisu zwykla tresc — i skasowalby zapisany adres.
  if (!podstawa) return null;
  return {
    ...podstawa,
    // Mail kupującego jest zawsze niepusty i jest to adres pośrednika
    // („…@allegromail.pl"), a nie prywatny mail klienta.
    email: tekstAlboNull(buyer?.email),
    // Login kupującego na Allegro — lista zamówień pokazuje go pod imieniem i nazwiskiem.
    // Dodatkowy klucz bloku, nie osobna kolumna: czyta go wyłącznie lista, a poller i tak przepisuje blok
    // przy każdej synchronizacji. ⚠️ Dotyczy zamówień zapisanych OD tej zmiany — starsze go nie mają.
    // Blok z loginem powstaje tylko wtedy, gdy jest adres (`return null` wyżej): sam login nie zastąpi adresu.
    login: tekstAlboNull(buyer?.login),
    // ⚠️ TELEFON DO PACZKI JEST W BLOKU DOSTAWY, A CZYTANY JEST STAD — i dlatego sklejamy go
    // WLASNIE TUTAJ, a nie w adres-odbiorcy.js.
    //
    // `surowyAdres` (domena/adres-odbiorcy.js) — jedyny czytelnik telefonu dla karty, ekranu
    // nadania, wyszukiwarki i obu klientow kurierskich — bierze `phone` WYLACZNIE z bloku
    // `klient`. Numer wpisany do `dostawa.phone` nie ma dzis ANI JEDNEGO czytelnika, wiec
    // przy `buyer.phoneNumber = null` karta pokazywala pusty telefon, choc Allegro podalo go
    // w `delivery.address.phoneNumber`. InPost bez telefonu nie wysle SMS-a z kodem do
    // paczkomatu, a paczkomaty to spora część zamówień.
    //
    // ⚠️ POPRAWKA NIE MOZE ISC DO `surowyAdres`, bo ta funkcja obsluguje TAKZE WooCommerce:
    // blok `dostawa` sklepu to `surowe.shipping` przepisany SUROWO (domena/mapowanie.js),
    // a WooCommerce od 5.6 potrafi wypelnic `shipping.phone` innym numerem niz `billing`.
    // Zmiana pierwszenstwa tam po cichu podmienilaby numer na etykietach DPD dla zywego
    // kanalu sklepowego — bez zadnego pomiaru, ze nowy jest lepszy. Zamowienie zakladane
    // recznie stoi na tej samej zasadzie: `parsujNoweZamowienie` CELOWO wpisuje telefon
    // tylko do bloku `klient`.
    //
    // Kolejnosc: numer podany DO PRZESYLKI wygrywa z numerem z profilu kupujacego, bo to
    // jego kurier ma wybrac; `buyer.phoneNumber` zostaje jako zapasowy.
    phone: tekstAlboNull(surowe?.delivery?.address?.phoneNumber) ?? tekstAlboNull(buyer?.phoneNumber),
  };
}

// Adres dostawy. ⚠️ CELOWO BEZ fallbacku na adres kupujacego: paczka jedzie tam, gdzie
// kazal ja wyslac klient, a podstawienie adresu z profilu w miejsce brakujacego adresu
// dostawy to przesylka wyslana pod adres, ktorego nikt nie wskazal. Brak adresu ma zostac
// brakiem — ekran nadania mowi o tym wprost (brakujacePolaAdresu).
function dostawaAllegro(surowe) {
  const a = surowe?.delivery?.address ?? null;
  if (!a) return null;
  // ⚠️ SAM TELEFON TO NIE ADRES. Gdy koperta dostawy przyjdzie wyzerowana, `adresPanelu`
  // odda `null` — i wtedy CALY blok ma byc `null`, mimo ze `phoneNumber` z tej samej koperty
  // moze jeszcze zyc. Inaczej do bazy poszedlby obiekt `{phone: '600…'}` bez ulicy, kodu
  // i miasta, ktory dla zapisu jest zwykla trescia i skasowalby zapisany adres przesylki.
  const blok = adresPanelu(a);
  if (!blok) return null;
  // `phone` zostaje w bloku RAZEM z kopia w `klient.phone` (patrz klientAllegro): blok ma
  // odwzorowywac to, co przyszlo od Allegro — tak samo jak `dostawa` sklepu odwzorowuje
  // `shipping`, ktore telefon niesc moze. Czytelnikiem jest dzis `klient.phone`.
  return { ...blok, phone: tekstAlboNull(a.phoneNumber) };
}

// Opis punktu odbioru — to, co czlowiek ma przeczytac na karcie („Paczkomat przy sklepie,
// Rynek 1, Zabrze"). Samo `name` bywa POWTORZENIEM kodu („ZBR05M"), wiec jako opis nie mowi
// nic ponad to, co juz stoi obok w `punkt_odbioru`.
function opisPunktu(p) {
  if (!p) return null;
  const czesci = [p.description, p.address?.street, p.address?.city].map(tekstAlboNull).filter(Boolean);
  return czesci.length ? czesci.join(', ') : tekstAlboNull(p.name);
}

/**
 * Formularz zakupowy Allegro → model panelu (te same klucze, co `mapujZamowienie`).
 *
 * `metodaZId` jest WSTRZYKNIETA ZALEZNOSCIA (domena/allegro-dostawa.js): mapowanie nie ma
 * prawa znac slownika metod, bo slownik sie zmienia, a ta regula nie.
 */
export function mapujZamowienieAllegro(surowe, { metodaZId }) {
  // ⚠️ `?? {}` i `?? 'nieznana'` nie są ostrożnością na wyrost: metod dostawy jest wiele
  // i przybywają, więc słownik NIGDY nie będzie kompletny, a `metoda_wysylki` jest kolumną
  // NOT NULL. `undefined` wiązane do node:sqlite kończy się wywalonym zapisem albo — gorzej —
  // ciszą. Nieznana metoda nie ma prawa zatrzymać całego kanału.
  // ⚠️ BIERZEMY TEŻ `etykieta`. To pełna nazwa usługi („Allegro One Box, One Kurier"),
  // którą Allegro podaje w `delivery.method.name`; bez niej panel pokazywałby zamiast niej
  // kubełek („Allegro punkt / automat").
  // ⚠️ Nazwa NIE STERUJE NICZYM — decyduje `metoda`, liczona po `delivery.method.id`.
  const { metoda, etykieta } = metodaZId(surowe?.delivery?.method?.id, surowe?.delivery?.method?.name) ?? {};
  // ⚠️ POBRANIE Z PLATNOSCI, NIGDY Z NAZWY DOSTAWY. Nazwa jest tekstem — dokladnie ta
  // pomylka czekala na sklep A, gdzie „Kurier DPD pobranie" byl zbudowany na
  // `local_pickup`, a potraktowanie tego doslownie znaczy towar oddany za darmo.
  const pobranie = surowe?.payment?.type === 'CASH_ON_DELIVERY' ? 1 : 0;
  // ⚠️ RZUCA na nieparsowalnej/pustej kwocie — uzasadnienie przy `groszeWymagane`.
  const razem = groszeWymagane(surowe?.summary?.totalToPay, `kwota zamówienia Allegro ${surowe?.id ?? ''}`.trim());
  // ⚠️ Pobranie na 0,00 zl to sprzecznosc, a nie zamowienie: kurier ma od kogos zainkasowac
  // pieniadze, ktorych nikt nie okreslil. Zero na karcie wyglada jak PRAWDA („nic nie
  // pobieramy") i nikt go nie zakwestionuje, wiec ta sciezka ma sie zatrzymac tutaj.
  if (pobranie && razem <= 0) {
    throw bladOperatora(`Zamówienie za pobraniem bez kwoty do pobrania: ${surowe?.id ?? '(bez id)'}.`);
  }
  const dostawa = groszeZKwoty(surowe?.delivery?.cost);
  const firma = surowe?.invoice?.address?.company ?? null;
  const stawkaDostawy = stawkaLinii(surowe?.lineItems?.[0]);
  const platnosc = surowe?.payment?.type ?? null;

  return {
    zrodlo_id: surowe?.id ?? null,
    numer: surowe?.id != null ? String(surowe.id) : null,
    klient: klientAllegro(surowe),
    dostawa: dostawaAllegro(surowe),
    metoda_wysylki: metoda ?? 'nieznana',
    // ⚠️ NAZWA WPROST OD ALLEGRO, słownik dopiero jako zapasowa.
    // Dla znanych uslug te dwie WARTOSCI SIE ROZNIA, i to na korzysc Allegro:
    //   slownik „Allegro One Box"    → Allegro „Allegro One Box, One Kurier"
    //   slownik „Allegro One Kurier" → Allegro „Allegro One Kurier - dostawa jutro"
    //   slownik „Allegro Kurier DPD" → Allegro „Allegro Kurier DPD pobranie" (wariant COD)
    // Nazwa od Allegro jest tym, co kupujacy naprawde wybral, i SAMA SIE UTRZYMUJE: nowa
    // usluga dostaje poprawna nazwe bez dopisywania slownika. Slownik zostaje odwrotem na
    // zamowienia, w ktorych `delivery.method.name` jest puste.
    metoda_wysylki_nazwa: oczyscNazweDostawy(surowe?.delivery?.method?.name) ?? oczyscNazweDostawy(etykieta),
    pobranie,
    // Za pobraniem kurier inkasuje CALOSC zamowienia.
    kwota_pobrania: pobranie ? zGroszy(razem) : null,
    // Kod automatu/punktu przychodzi gotowy (tylko przy dostawie do punktu).
    punkt_odbioru: surowe?.delivery?.pickupPoint?.id ?? null,
    punkt_odbioru_opis: opisPunktu(surowe?.delivery?.pickupPoint),
    chce_fakture: surowe?.invoice?.required ? 1 : 0,
    // Bez etykiety „NIP” wpisanej przez kupującego (inFakt odrzuca taki NIP błędem 422).
    nip: bezEtykietyNip(firma?.taxId),
    kwota_brutto: zGroszy(razem),
    koszt_dostawy_brutto: zGroszy(dostawa),
    // ⚠️ Netto dostawy liczymy ze stawki VAT pozycji, bo Allegro netta dostawy nie podaje.
    // To NIE jest złamanie zasady „netto wprost ze źródła" — do inFaktu
    // i tak idzie BRUTTO, a ta wartość służy WYŁĄCZNIE kolumnie „netto" na karcie.
    koszt_dostawy_netto: zGroszy(nettoZBruttaGr(dostawa, stawkaDostawy)),
    // ⚠️ Status ZAMOWIENIA idzie BEZ walidacji wobec listy z dokumentacji: `CANCELLED`
    // wystepuje na zywym koncie takze jako `fulfillment.status`, choc dokumentacja go tam
    // nie wymienia. Parser, ktory sie na tym wywala, zatrzymalby caly kanal z powodu
    // wartosci, ktorej Allegro nie musialo z nami uzgadniac.
    status_woo: surowe?.status ?? null,
    // ⚠️ STATUS REALIZACJI, ODDZIELNIE OD STATUSU ZAMÓWIENIA WYŻEJ. Trafia do kolumny `status_realizacji`
    // dla diagnostyki — żadna reguła dziś z niej nie czyta: `statusDlaAllegro` (`domena/allegro-status.js`)
    // dostaje stan ze świeżego odczytu, żeby NIE WYSŁAĆ do Allegro stanu, który tam już jest, i nie cofnąć
    // `SENT` ustawionego ręcznie w panelu Allegro z powrotem na `PROCESSING`.
    //
    // Wartość idzie SUROWA i bez walidacji, z tego samego powodu co `status_woo`: `CANCELLED`
    // występuje na żywym koncie jako `fulfillment.status`, choć dokumentacja go tam nie
    // wymienia. Parser, który się na tym wywala, zatrzymałby cały kanał.
    status_realizacji: surowe?.fulfillment?.status ?? null,
    metoda_platnosci: platnosc ? (PLATNOSCI[platnosc] ?? platnosc) : null,
    // Wplata: przy platnosci online Allegro rozlicza sie z kupujacym, wiec zamowienie
    // przychodzi oplacone. Przy pobraniu pieniedzy jeszcze NIE MA — inkasuje kurier.
    // ⚠️ Warunek na pobraniu jest wazniejszy, niz wyglada: Allegro potrafi wypelnic
    // `payment.finishedAt` takze przy pobraniu (rozliczenie prowizji), a data wplaty przy
    // pobraniu znaczy „pieniadze sa" — czyli znika ostrzezenie przed nadaniem paczki
    // do zamowienia, za ktore nikt jeszcze nie zaplacil.
    oplacone_at: pobranie ? null : (surowe?.payment?.finishedAt ?? null),
    anulowane: surowe?.status === 'CANCELLED' ? 1 : 0,
    utworzone_at: surowe?.lineItems?.[0]?.boughtAt ?? null,
    uwagi: surowe?.messageToSeller || null,
    indywidualne: 0,
    pozycje: pozycjeAllegro(surowe),
  };
}

/**
 * Identyfikator OFERTY z linii formularza zakupowego — albo `null`.
 *
 * ⚠️ WYCIAGNIETE DO OSOBNEJ, EKSPORTOWANEJ FUNKCJI, bo czytelnikow jest DWOCH: mapowanie
 * (nizej) i przeliczenie wsteczne dla wierszy sprzed kolumny `pozycje.oferta_id`
 * (`uzupelnijOfertaIdPozycji` w oms/db/uzupelnienia-zamowien.js). Druga kopia tej reguły
 * rozjechałaby się z pierwszą przy pierwszej zmianie kształtu odpowiedzi Allegro — dokładnie
 * ten sam powód, dla którego oms/db/uzupelnienia-zamowien.js importuje `bruttoLinii`
 * i `cenaJednostkowaNetto` z domena/mapowanie.js, zamiast liczyć je u siebie.
 *
 * ⚠️ ZAWSZE NAPIS. Allegro przysyła `offer.id` jako napis dziesięciocyfrowy („1234567890")
 * i taki ma dojechać do bazy — kolumna jest TEXT właśnie po to, żeby po drodze nie zamienił
 * się w liczbę. `String()` stoi tu, a nie przy zapisie, bo to mapowanie odpowiada za kształt
 * modelu panelu.
 */
export function ofertaLinii(li) {
  const id = String(li?.offer?.id ?? '').trim();
  return id || null;
}

function pozycjeAllegro(surowe) {
  const pozycje = (surowe?.lineItems ?? []).map((li) => {
    const ilosc = Number(li.quantity) || 1;
    // ⚠️ CENA POZYCJI MUSI BYĆ LICZBĄ — zero po cichu dałoby `0,00 zł` na karcie jako
    // FAKT i zaniżoną sumę pozycji, czyli fakturę nie do wystawienia z powodu, którego
    // w komunikacie bariery nie widać. Uzasadnienie w calosci — przy `groszeZKwoty` wyzej.
    // Opis niesie nazwe oferty i identyfikator zamowienia, bo to jedyne, po czym czlowiek
    // odnajdzie te pozycje w panelu Allegro po przeczytaniu powodu pominiecia.
    const jednostkowoGr = groszeWymagane(
      li?.price,
      `cena pozycji „${li?.offer?.name ?? '(bez nazwy)'}" w zamówieniu Allegro ${surowe?.id ?? '(bez id)'}`,
    );
    const liniaGr = jednostkowoGr * ilosc;
    const stawka = stawkaLinii(li);
    return {
      zrodlo_id: li.id ?? null,
      nazwa: li?.offer?.name ?? '(bez nazwy)',
      // ⚠️ `offer.external` bywa NULL — wtedy SKU sprzedawcy nie przychodzi z Allegro.
      // Kolumna zostaje wtedy pusta świadomie.
      sku: li?.offer?.external?.id ?? null,
      ilosc,
      cena_brutto: zGroszy(jednostkowoGr),
      cena_netto: zGroszy(nettoZBruttaGr(jednostkowoGr, stawka)),
      brutto_linii: zGroszy(liniaGr),
      netto_linii: zGroszy(nettoZBruttaGr(liniaGr, stawka)),
      vat: String(stawka),
      // ⚠️ FORMULARZ ZAKUPOWY ZDJĘCIA NIE NIESIE, więc przy zapisie NIE MA CZEGO WPISAĆ —
      // i to zostaje NULL-em na zawsze, także przy miniaturach. Adres dopytujemy osobno
      // (`GET /sale/product-offers/{offerId}`) i trzymamy w pamięci podręcznej kluczowanej
      // OFERTĄ (`zdjecia_ofert`), bo poller kasuje i wstawia pozycje przy każdej synchronizacji
      // (reguła: dane ręczne obok danych sklepu) — adres wpisany tutaj przepadałby za każdym
      // razem, a panel pytałby Allegro o to samo setki razy na dobę. Doklejenie adresu
      // do pozycji robi ODCZYT (oms/db/zamowienia.js), nie mapowanie.
      zdjecie_url: null,
      // ⚠️ `produkt_id` ZOSTAJE PUSTE i to nie jest miejsce na identyfikator oferty. Ta
      // kolumna znaczy „produkt W SKLEPIE" (Woo `product_id`), jest typu INTEGER i wchodzi
      // do adresu `?post_type=product&p=…`, ktory dla Allegro nie ma sensu. Identyfikator
      // oferty jedzie WŁASNĄ kolumną TEXT — `oferta_id` niżej.
      produkt_id: null,
      oferta_id: ofertaLinii(li),
    };
  });

  // ⚠️ DOPLATY (`surcharges`) SA CZESCIA `summary.totalToPay`, a nie ma ich w `lineItems` —
  // dokladnie tak samo jak kosztu dostawy w WooCommerce. Pominiete znaczylyby sume pozycji
  // MNIEJSZA od kwoty zamowienia, czyli bariere arytmetyczna faktury zamknieta na glucho:
  // pierwsza doplata w kanale = pierwsza faktura, ktorej nie da sie wystawic, i odmowa
  // deterministyczna (ponowienie nie pomaga).
  //
  // Dopłata to rzadkość i tej ścieżki nie potwierdził żaden zmierzony przypadek — dlatego jest
  // napisana tak, żeby pomyłka w jej założeniu też była BEZPIECZNA: gdyby dopłata jednak
  // NIE wchodziła do `totalToPay`, suma pozycji przerośnie kwotę zamówienia i bariera
  // zablokuje wystawienie. Żaden wariant nie daje faktury na złą kwotę — daje albo
  // poprawną, albo żadną.
  const doplataGr = (surowe?.surcharges ?? []).reduce((s, d) => s + groszeZKwoty(d?.amount), 0);
  if (doplataGr > 0) {
    const stawka = stawkaLinii(surowe?.lineItems?.[0]);
    pozycje.push({
      zrodlo_id: 'doplata',
      nazwa: 'Dopłata (Allegro)',
      sku: null,
      ilosc: 1,
      cena_brutto: zGroszy(doplataGr),
      cena_netto: zGroszy(nettoZBruttaGr(doplataGr, stawka)),
      brutto_linii: zGroszy(doplataGr),
      netto_linii: zGroszy(nettoZBruttaGr(doplataGr, stawka)),
      vat: String(stawka),
      zdjecie_url: null,
      produkt_id: null,
      // ⚠️ Dopłata NIE JEST ofertą, więc nie ma dokąd prowadzić. Wiersz dopłaty niesie
      // `zrodlo_id: 'doplata'` i to NIE jest identyfikator oferty — nie wolno go tu
      // podstawiać. Brak linku jest lepszy niż link donikąd (ta sama zasada co
      // w `adresSledzenia`, domena/przewoznik-przesylki.js).
      oferta_id: null,
    });
  }
  return pozycje;
}
