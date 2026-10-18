import { transport } from '../../integracje/transport.js';
import { bladOperatora } from '../../domena/bledy.js';
// Taryfa ShipX per zamowienie (sklep / Allegro / Allegro Smart) — patrz domain/usluga-inpost.js.
import { uslugaInpost } from '../../domena/usluga-inpost.js';
import { naTelefonInPost } from '../../domena/telefon.js';
import { PROG_ZAWIESZONEGO_NADANIA_MS } from '../../domena/przesylka-stan.js';
import { adresOdbiorcy } from '../../domena/adres-odbiorcy.js';

// Klient InPost ShipX (paczkomaty). KONTRAKT TEN SAM CO `kurierzy/dpd.js` — reszta panelu
// nie wie, ktory kurier jest podpiety (patrz kurierzy/index.js), wiec ten modul oddaje
// dokladnie te pola, ktorych uzywa services/nadanie.js: numer listu, dwie etykiety, powod
// awarii ZPL i surowa odpowiedz do zapisu w bazie. Rozni sie JEDNA rzecza, ktorej DPD nie ma:
// `shipmentId` — patrz komentarz przy nadaj().
//
// Ksztalt zadania NIE pochodzi z dokumentacji InPostu (siedzi na Confluence i nie da sie jej
// odczytac maszynowo), tylko z odwzorowania DZIESIECIU prawdziwych przesylek z zywego konta:
// docs/superpowers/notatki/2026-08-01-inpost-shipx-rozpoznanie.md.

// Gabaryt paczkomatu podaje sie SZABLONEM, nie wymiarami (zmierzone: `small` oddaje
// dimensions 380 x 640 x 80 mm, czyli 38 x 64 x 8 cm = gabaryt A).
export const SZABLONY_GABARYTU = { A: 'small', B: 'medium', C: 'large' };

// Sygnatury zawartosci etykiety — zmierzone na zywym koncie (rozpoznanie, sekcja „Etykieta").
// ZPL jest NATYWNY dla Zebry GK420t, wiec kolejka druku nie wymaga zadnej zmiany.
const SYGNATURY_ETYKIETY = { pdf: '%PDF', zpl: '^XA' };

// Twardy limit JEDNEGO zadania HTTP. Bez wlasnego sygnalu undici czeka na naglowki 300 000 ms,
// a przez ten czas wiersz przesylki stoi 'w_trakcie' i przegladarka operatora wisi na POST /nadaj.
export const LIMIT_ZADANIA_MS = 30 * 1000;

// Osobny, DUZO krotszy limit na jedno zapytanie o status przesylki — dokladnie ta sama
// decyzja i ten sam powod co LIMIT_ZAPYTANIA_STATUS_MS w dpd.js. Sledzenie jest JEDYNYM
// wywolaniem robionym SYNCHRONICZNIE przy renderowaniu karty zamowienia, a Fastify nie ma
// limitu trasy: gdyby jechalo na limicie nadania, jeden milczacy InPost zawiesilby karte
// na 30 s RAZY liczba paczek w zamowieniu. Nadanie moze czekac (operator wie, ze czeka na
// etykiete), otwarcie karty — nie.
export const LIMIT_ZAPYTANIA_STATUS_MS = 5000;

// ⚠️ TWORZENIE PRZESYLKI JEST PRAWDOPODOBNIE ASYNCHRONICZNE. Wlasciciel mierzy w Apilo
// „kilkanascie sekund" na etykiete paczkomatowa, podczas gdy DPD oddaje numer od razu.
// Nie da sie tego sprawdzic inaczej niz tworzac PRAWDZIWA przesylke (operacja nieodwracalna
// i platna), wiec kod dziala w OBU wariantach: numer w odpowiedzi POST -> gotowe, brak numeru
// -> odpytywanie. Okno odpytywania jest TWARDE: po nim oddajemy „przesylka istnieje, numeru
// jeszcze nie ma", a nie czekamy w nieskonczonosc — zadanie HTTP operatora nie ma prawa wisiec,
// a przesylki i tak nie zgubimy, bo niesiemy `shipmentId`.
export const LIMIT_ODPYTYWANIA_MS = 30 * 1000;
export const ODSTEP_ODPYTYWANIA_MS = 1000;

// Najdluzsze mozliwe nadanie: POST + cale okno odpytywania + ostatni GET, ktory moze byc
// jeszcze w locie, gdy okno sie zamyka + dwie etykiety.
const NAJDLUZSZE_NADANIE_MS = LIMIT_ODPYTYWANIA_MS + 4 * LIMIT_ZADANIA_MS;

// Straznik przy wczytaniu modulu — ten sam wzorzec i ten sam niezmiennik co w dpd.js:
// „przesylka starsza od progu" MUSI znaczyc „nic juz nie leci". Gdyby najdluzsze nadanie
// dosiegalo progu, panel moglby uznac ZYWE wywolanie za osierocone, operator odblokowalby
// je w trakcie, a InPost dostalby druga paczke do tego samego zamowienia. Panel ma wtedy
// NIE WSTAC, zamiast po cichu wrocic do tego wyscigu.
if (NAJDLUZSZE_NADANIE_MS >= PROG_ZAWIESZONEGO_NADANIA_MS) {
  throw new Error(
    'Limity zadan InPostu (z oknem odpytywania) musza sumowac sie do czasu KROTSZEGO niz prog '
    + 'zawieszonego nadania — inaczej „zawieszone" moze oznaczac zywe wywolanie, a odblokowanie '
    + 'da druga paczke.',
  );
}

const uspij = (ms) => new Promise((koniec) => { setTimeout(koniec, ms); });

// Stany przesylki po polsku. Zrodlem jest rozpoznanie na zywym koncie (sekcja „Stany
// przesylki”): `confirmed` → `ready_to_pickup` → `delivered`, plus `returned_to_sender`
// i dwa stany posrednie widziane w `tracking_details`.
//
// ⚠️ SLOWNIK JEST CELOWO NIEPELNY i to nie jest przeoczenie. Wpisujemy WYLACZNIE stany
// zmierzone na koncie — wszystko poza nimi wychodzi na karte jako stan nieznany (nizej),
// razem z surowym kodem. Dopisanie tu stanow „z pamieci" znaczyloby, ze panel tlumaczy
// na polski cos, czego nigdy nie widzial, i przy pierwszej pomylce mowi operatorowi
// o paczce nieprawde z pelna pewnoscia siebie.
export const OPISY_STANOW = {
  confirmed: 'Przesyłka zarejestrowana',
  adopted_at_source_branch: 'Przyjęta w oddziale nadawczym',
  sent_from_source_branch: 'Wysłana z oddziału nadawczego',
  // Zmierzony na PRODUKCJI (dwie przesylki z 08.2026 nosily „nieznany stan
  // out_for_delivery" w status_kuriera) — dopisany zgodnie z regula tego slownika:
  // wylacznie stany naprawde widziane na koncie.
  out_for_delivery: 'W doręczeniu',
  ready_to_pickup: 'Gotowa do odbioru w paczkomacie',
  delivered: 'Odebrana przez klienta',
  returned_to_sender: 'Zwrócona do nadawcy',
};

// ⚠️ NIEZNANY STAN NIE MOZE ANI ZNIKNAC, ANI UDAWAC ZNANEGO. InPost dolozy kiedys stan,
// ktorego dzis nie ma na koncie (awizo, zwrot w toku, paczka przeniesiona do innego
// automatu) — a karta zamowienia jest jedynym miejscem, w ktorym czlowiek to zobaczy.
// Ciche zmapowanie na „najblizszy znany" byloby najgorszym z mozliwych wyjsc: operator
// podjalby decyzje o paczce na podstawie zdania, ktorego kurier nigdy nie powiedzial.
function opisStanu(stan) {
  const kod = String(stan ?? '').trim();
  // Zdarzenie BEZ stanu zostaje z opisem `null` (czas sam w sobie jest informacja, a widok
  // pokaze „zdarzenie bez opisu") — ta sama swiadoma asymetria co w dpd.js. `null`, a NIE
  // `undefined`: undefined jest tym, czego node:sqlite nie potrafi zbindowac.
  if (!kod) return null;
  return OPISY_STANOW[kod] ?? `InPost: nieznany stan „${kod}”`;
}

// Znacznik czasu zdarzenia. Rozpoznanie mowi, ze KAZDY wpis `tracking_details` ma znacznik
// czasu, ale NIE PODAJE nazwy pola (dokumentacja ShipX siedzi na Confluence i nie da sie jej
// odczytac maszynowo, a odpytanie zywego API o strukture zdarzen nie wchodzi w gre przed
// pierwszym nadaniem pod nadzorem). Bierzemy wiec pierwsze pasujace z kilku prawdopodobnych
// nazw — a gdy nie ma zadnej, zdarzenie po prostu ODPADA (patrz nizej), bo czas wziety
// z powietrza bylby gorszy niz jego brak.
//
// ⚠️ ALE ODPADNIECIE WSZYSTKICH ZDARZEN NIE JEST JUZ „bezpiecznym trybem awarii" (tak stalo
// tu do 2026-08-04). Chybione zgadywanie nazwy pola znaczyloby, ze KAZDA paczka pokazuje
// „brak zdarzen" na zawsze, a nikt sie nie dowiaduje, ze sledzenie nie dziala. Dlatego
// statusPrzesylki() odmawia GLOSNO, gdy lista byla niepusta, a nie zostalo z niej nic.
// ⚠️ Nazwa do potwierdzenia przy pierwszym prawdziwym nadaniu.
const POLA_CZASU = ['datetime', 'date', 'created_at', 'time', 'timestamp'];

function czasZdarzenia(zdarzenie) {
  for (const pole of POLA_CZASU) {
    const wartosc = zdarzenie?.[pole];
    if (typeof wartosc === 'string' && wartosc.trim()) return wartosc.trim();
  }
  return null;
}

// Odpowiedzi bledow ShipX sa JSON-em, ale proxy po drodze potrafi oddac HTML albo pustke —
// wtedy zostaje sam tekst. Parser NIE MOZE rzucac: tekst i tak trafia do komunikatu i do bazy.
function parsujJson(tekst) {
  try {
    return JSON.parse(tekst);
  } catch {
    return null;
  }
}

// `details` ShipX zagniezdza sie do dwoch poziomow ({ receiver: { phone: ["is invalid"] } }).
// Splaszczamy je do jednej linii, bo operator ma zobaczyc POWOD odmowy, a nie „HTTP 400".
function splaszcz(wartosc) {
  if (Array.isArray(wartosc)) return wartosc.map(splaszcz).join(', ');
  if (wartosc && typeof wartosc === 'object') {
    return Object.entries(wartosc).map(([k, w]) => `${k}: ${splaszcz(w)}`).join(', ');
  }
  return String(wartosc);
}

/** @param {import('../../integracje/opcje.ts').OpcjeInpost} opcje */
export function createInpostClient({
  url, token, organizacja, nadawca, paczkomatNadawczy = null, fetchImpl, http = transport({ fetchImpl }),
}) {
  // Bez walidacji tutaj brak np. `nadawcy` wywala sie dopiero przy pierwszym nadaniu
  // niezrozumialym TypeError — zbyt pozno i zbyt niejasno na cos, co jest bledem
  // konfiguracji, nie danych zamowienia. Dokladnie jak w createDpdClient.
  const brak = [];
  if (!url) brak.push('url');
  if (!token) brak.push('token');
  if (!organizacja) brak.push('organizacja');
  // ⚠️ `config.nadawca` jest NULL-em, gdy panel wstal bez sekcji DPD (dzis to jedyne zrodlo
  // adresu firmy, patrz config.js). Klient InPostu ma wtedy ODMOWIC juz przy tworzeniu,
  // a nie nadac przesylke bez nadawcy. Sprawdzamy POLA, nie samo istnienie obiektu — obiekt
  // z pustymi stringami to wlasnie ta cicha awaria z lipca 2026, przez ktora kazda paczka
  // jechala z pusta ulica, a kurier i tak oddawal numer listu.
  if (!nadawca) brak.push('nadawca');
  else {
    for (const klucz of ['nazwa', 'ulica', 'kod', 'miasto']) {
      if (!String(nadawca[klucz] ?? '').trim()) brak.push(`nadawca.${klucz}`);
    }
  }
  if (brak.length) throw new Error(`createInpostClient: brak wymaganej konfiguracji: ${brak.join(', ')}.`);

  // ⚠️ TELEFON I E-MAIL NADAWCY SA WYMAGANE PRZEZ InPost, a przez DPD NIE — i to jest cala
  // historia usterki z 05.08.2026 (pierwsze prawdziwe nadanie do paczkomatu, zam. 28173).
  // Adres nadawcy powstal pod DPD, wiec `email` nie istnialo nawet w konfiguracji, a `phone`
  // jechalo warunkowo. Zywe API odpowiedzialo:
  //   „There are some validation errors. … sender: email: required, phone: required".
  //
  // ⚠️ BRAK TYCH POL NIE MOZE PRZEWROCIC USLUGI (decyzja wlasciciela 05.08). Zasada „polowiczna
  // konfiguracja wywala start" obowiazuje w tym repo, ale TUTAJ ustepuje mocniejszemu
  // argumentowi: DPD dziala bez tych pol, a panel obsluguje WSZYSTKIE zamowienia. Brak jednej
  // zmiennej po wdrozeniu znaczylby petle restartow kontenera i cala firme bez panelu — ta
  // klasa awarii wyszla juz raz, przy katalogu proform. Dlatego klient WSTAJE, a odmawia
  // dopiero `nadaj()`, wymieniajac brakujaca zmienna po nazwie.
  //
  // Format sprawdzamy JEDNAK przy starcie: numer wpisany bzdurnie ma sie wydac od razu,
  // a nie przy pierwszej spakowanej paczce.
  let telefonNadawcy = null;
  if (String(nadawca.phone ?? '').trim()) {
    try {
      telefonNadawcy = naTelefonInPost(nadawca.phone);
    } catch (e) {
      throw new Error(`createInpostClient: telefon nadawcy (DPD_NADAWCA_TELEFON) — ${e.message}`);
    }
  }
  const emailNadawcy = String(nadawca.email ?? '').trim();

  // ⚠️ TOKEN TO SEKRET. Komunikaty bledow i `odpowiedz_surowa` trafiaja do BAZY i do logu
  // zamowienia, wiec token nie ma prawa tam wyladowac — ani przez echo serwera, ani przez
  // komunikat sterownika sieci. Ta sama maszyneria co maskowanie loginu i hasla w dpd.js
  // (gdzie jej usuniecie przezylo mutacje i wyszlo dopiero w recenzji).
  const oczysc = (t) => (token ? String(t ?? '').split(token).join('***') : String(t ?? ''));

  // ⚠️ INPOST_URL MOZE MIEC KONCOWY UKOSNIK — konfiguracja go nie obcina (inaczej niz
  // SHOP_*_URL, patrz config.js). Sklejanie „${url}/shipments" dawaloby wtedy podwojny ukosnik
  // w sciezce, a to juz jest inny zasob i inne 404.
  const bazowy = String(url).replace(/\/+$/, '');
  const sciezka = (...czesci) => [bazowy, ...czesci.map((c) => String(c).replace(/^\/+|\/+$/g, ''))].join('/');

  function opisBledu({ dane, tekst, status }) {
    const czesci = [];
    const glowny = dane?.message ?? dane?.error;
    if (glowny) czesci.push(String(glowny));
    if (dane?.details && typeof dane.details === 'object') czesci.push(splaszcz(dane.details));
    // Brak czytelnego pola = pokazujemy poczatek tresci. Pusty komunikat („InPost odrzucil
    // przesylke: ") nie mowi operatorowi NICZEGO, a to jest jedyny slad, jaki dostanie.
    if (!czesci.length) czesci.push(String(tekst ?? '').trim().slice(0, 300) || `HTTP ${status}`);
    return oczysc(czesci.join('; '));
  }

  // Sygnal przerwania jest NARZUCONY, a nie parametrem: gdyby wolajacy mogl podac wlasny,
  // twardy limit znikalby po cichu, a straznik przy wczytaniu modulu tego nie wylapie
  // (pilnuje stalych, nie miejsca uzycia). Nowy sygnal na KAZDE zadanie — wspolny starzalby
  // sie razem z procesem i po pol godzinie pracy panelu przerywal kazde nadanie natychmiast.
  //
  // `limitMs` jest argumentem WEWNETRZNYM tego modulu (zadna funkcja oddana na zewnatrz go
  // nie przyjmuje), bo dwie sciezki maja rozne wymagania: nadanie moze czekac 30 s, a
  // sledzenie — jedyne wywolanie robione przy renderowaniu karty — nie ma prawa (patrz
  // LIMIT_ZAPYTANIA_STATUS_MS). Domyslna wartosc trzyma stare zachowanie nadania.
  async function wywolaj(adres, opcje = {}, limitMs = LIMIT_ZADANIA_MS) {
    let res;
    let tekst;
    try {
      res = await http(adres, {
        method: 'GET',
        ...opcje,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...opcje.headers,
        },
        signal: AbortSignal.timeout(limitMs),
      });
      // Odczyt CIALA musi byc w tym samym try co samo polaczenie: przerwanie po limicie,
      // reset polaczenia i urwany strumien rzucaja DOPIERO tutaj, a taki wyjatek poza try
      // szedlby w gore surowy — bez znacznika `dlaOperatora` i, co gorsza, bez oczysc().
      tekst = await res.text();
    } catch (e) {
      throw bladOperatora(`InPost nieosiągalny: ${oczysc(e.message)}`);
    }
    return { res, tekst, dane: parsujJson(tekst), status: res.status };
  }

  function szablonGabarytu(gabaryt) {
    const klucz = String(gabaryt ?? '').trim().toUpperCase();
    const szablon = SZABLONY_GABARYTU[klucz];
    // ⚠️ NIGDY CICHA DOMYSLKA. Paczka zgloszona w zlym gabarycie to paczka, ktorej automat
    // fizycznie nie przyjmie — a domyslne wymiary panelu (110 x 75 x 1 cm) nie mieszcza sie
    // w ZADNEJ skrytce. Brak gabarytu to blad wolajacego, nie powod do zgadywania.
    if (!szablon) {
      throw bladOperatora(
        `InPost: nieznany gabaryt „${gabaryt ?? ''}” — dozwolone są ${Object.keys(SZABLONY_GABARYTU).join(', ')}.`,
      );
    }
    return szablon;
  }

  function wagaWKg(surowa) {
    const liczba = Number(String(surowa ?? '').trim());
    if (!Number.isFinite(liczba) || liczba <= 0) {
      throw bladOperatora(`InPost: nie umiem odczytać wagi paczki: „${surowa ?? ''}”.`);
    }
    return liczba;
  }

  // Pobranie. Ta sama dyscyplina co w dpd.js, bo to te same pieniadze:
  //  - `null`/`undefined` = braku pobrania, klucza `cod` po prostu NIE MA w zadaniu;
  //  - '0.00' jest truthy jako STRING, wiec sprawdzamy kwote, nie prawdziwosc wartosci;
  //  - wartosci nie do odczytania (przecinek dziesietny, tekst z jednostka) RZUCAJA, zamiast
  //    po cichu pominac pobranie — cicha przedplata znaczy, ze nikt nie zainkasuje pieniedzy
  //    i nikt sie o tym nie dowie.
  //
  // ⚠️ POBRANIE JEDZIE WYLACZNIE NA PIERWSZEJ PACZCE. Kwota nalezy do ZAMOWIENIA, nie do
  // paczki: powtorzona na paczce nr 2 znaczy, ze klient zaplaci ja DRUGI RAZ.
  // ⚠️ `nadpisanie` (Z4) to kwota poprawiona na ekranie nadania — WARTOSC, nigdy obejscie
  // warunku „tylko paczka nr 1" ponizej. Brak nadpisania (wywolania spoza formularza,
  // nadanie zbiorcze) znaczy „kwota z zamowienia", dokladnie jak dotad.
  function kwotaPobrania(zamowienie, kolejnosc, nadpisanie) {
    const surowa = nadpisanie ?? zamowienie?.kwota_pobrania;
    if (kolejnosc !== 1 || surowa == null) return null;
    const kwota = Number(String(surowa).trim());
    if (!Number.isFinite(kwota)) {
      throw bladOperatora(`InPost: nie umiem odczytać kwoty pobrania: „${surowa}”.`);
    }
    return kwota > 0 ? kwota : null;
  }

  // Imie i nazwisko odbiorcy. ShipX chce ich OSOBNO, a panel trzyma jedno pole `nazwa` —
  // bo to ono jest edytowalne na ekranie nadania i to ono jest zrodlem prawdy.
  //
  // To zgadywanie jest DOPUSZCZALNE, w odroznieniu od zgadywania numeru domu (patrz
  // adresNadawcy nizej): oba czlony i tak drukuja sie na etykiecie OBOK SIEBIE, wiec zly
  // podzial „Anna Maria | Nowak" niczego nie psuje — paczka jedzie tam, gdzie miala.
  // Numer domu wyciety z ulicy psulby ADRES, czyli miejsce doreczenia.
  function podzielNazwe(nazwa) {
    const czlony = String(nazwa ?? '').trim().split(/\s+/).filter(Boolean);
    if (!czlony.length) return {};
    // Jednoczlonowa nazwa idzie w `last_name`: powtorzenie jej w obu polach wydrukowaloby
    // na etykiecie „Kowalski Kowalski".
    if (czlony.length === 1) return { last_name: czlony[0] };
    return { first_name: czlony.slice(0, -1).join(' '), last_name: czlony.at(-1) };
  }

  // ⚠️ ADRES NADAWCY — NIE ZGADUJEMY NUMERU DOMU. `config.nadawca.ulica` to JEDEN napis
  // („ul. 1 Maja 5"), a ShipX rozbija adres na `street` i `building_number`. Projekt podjal
  // juz raz swiadomie te sama decyzje (services/faktura.js: „Zgadywanie numeru z tekstu
  // psuloby 'Aleja 1 Maja 5' czesciej niz cokolwiek naprawialo"), wiec caly napis idzie
  // w `line1`, a `street`/`building_number` w ogole nie wyjezdzaja.
  //
  // ⚠️ DO POTWIERDZENIA PRZY PIERWSZYM PRAWDZIWYM NADANIU. Gdyby ShipX odmowil przyjecia
  // adresu w tej postaci, wlasciwym rozwiazaniem sa OSOBNE POLA W KONFIGURACJI
  // (DPD_NADAWCA_ULICA + numer), a nie parsowanie napisu.
  //
  // Kod pocztowy leci tak, jak stoi w konfiguracji („00-001”) — inaczej niz w DPD, gdzie
  // myslnik trzeba bylo wyciac, bo zywe API odrzucalo go jako NONEXISTING_POSTAL_CODE.
  // Dla ShipX nie mamy takiego pomiaru, a wszystkie przesylki na koncie maja kod z myslnikiem.
  function adresNadawcy() {
    // `phone` i `email` BEZWARUNKOWO — ich obecnosc gwarantuje odmowa w `nadaj()` wyzej,
    // wiec warunkowe doklejanie tylko udawaloby, ze przesylka bez nich ma sens. InPost
    // odrzuca takie zadanie i tak, tyle ze dopiero po sieci i mniej zrozumiale.
    return {
      company_name: nadawca.nazwa,
      phone: telefonNadawcy,
      email: emailNadawcy,
      address: {
        line1: nadawca.ulica,
        city: nadawca.miasto,
        post_code: nadawca.kod,
        country_code: nadawca.kraj || 'PL',
      },
    };
  }

  /**
   * Etykieta w zadanym formacie. `zpl` idzie na Zebre (natywnie), `pdf` do wgladu.
   *
   * ⚠️ WERYFIKUJEMY SYGNATURE ZAWARTOSCI, NIE STATUS HTTP. Przy inFakcie serwer potrafil
   * oddac 200 z czyms, co nie bylo dokumentem, i panel zapisywal na dysku plik, ktorego
   * nikt nie mogl otworzyc. Etykieta ma zaczynac sie od `%PDF` albo `^XA` — kropka.
   */
  async function pobierzEtykiete(shipmentId, format) {
    const klucz = String(format ?? '').trim().toLowerCase();
    const sygnatura = SYGNATURY_ETYKIETY[klucz];
    if (!sygnatura) {
      throw bladOperatora(
        `InPost: nieznany format etykiety „${format ?? ''}” — dozwolone są ${Object.keys(SYGNATURY_ETYKIETY).join(', ')}.`,
      );
    }

    let res;
    let bufor;
    try {
      res = await http(`${sciezka('shipments', shipmentId, 'label')}?format=${klucz}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
        signal: AbortSignal.timeout(LIMIT_ZADANIA_MS),
      });
      bufor = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      throw bladOperatora(`InPost nieosiągalny przy etykiecie ${klucz.toUpperCase()}: ${oczysc(e.message)}`);
    }

    if (bufor.subarray(0, sygnatura.length).toString('latin1') !== sygnatura) {
      // Poczatek tresci trafia do komunikatu: przy bledzie ShipX to JSON z powodem,
      // a bez niego operator wiedzialby tylko tyle, ze „cos nie jest etykieta".
      const poczatek = oczysc(bufor.subarray(0, 300).toString('utf8')).trim();
      throw bladOperatora(
        `InPost nie oddał etykiety ${klucz.toUpperCase()} (HTTP ${res.status}): ${poczatek || '(pusta odpowiedź)'}`,
      );
    }
    return bufor;
  }

  /**
   * Status przesylki dla karty zamowienia.
   *
   * KONTRAKT IDENTYCZNY JAK `dpd.statusPrzesylki` (kurierzy/dpd.js) — trasa karty wola
   * jedno albo drugie, nie wiedzac ktore: oddaje `{ opis, at }` NAJNOWSZEGO zdarzenia albo
   * `null`, gdy zdarzen nie ma. `null` NIE JEST AWARIA: swiezo utworzona przesylka po prostu
   * nie ma jeszcze historii, a panel ma to pokazac jako „brak zdarzen", nie jako blad.
   *
   * `null` znaczy jednak WYLACZNIE „lista byla pusta". Lista niepusta, z ktorej nic nie dalo
   * sie odczytac, konczy sie odmowa operatorska — patrz warunek przy `zdarzenia.length`.
   */
  async function statusPrzesylki(numerListu) {
    // Numer idzie do SCIEZKI, wiec musi byc zakodowany — inaczej numer ze znakiem '/' albo
    // '?' (dzis niespotykany, ale to zalozenie o cudzym formacie) pytalby o inny zasob.
    const { res, tekst, dane, status } = await wywolaj(
      sciezka('tracking', encodeURIComponent(String(numerListu ?? ''))),
      {},
      LIMIT_ZAPYTANIA_STATUS_MS,
    );

    if (!res.ok) {
      throw bladOperatora(`InPost: nie udało się sprawdzić statusu przesyłki: ${opisBledu({ dane, tekst, status })}`);
    }

    // ⚠️ HTTP 200 NIE ZNACZY SUKCES — sprawdzamy KSZTALT odpowiedzi, nie sam status. Proxy
    // po drodze potrafi oddac 200 z HTML-em albo pustka, a wtedy „brak `tracking_details`"
    // wygladaloby dokladnie tak samo, jak przesylka bez historii. Roznica jest zasadnicza:
    // pierwsze to awaria, ktora ma byc WIDOCZNA (kolumna bledu na karcie), drugie to
    // normalny stan. Odpowiedz musi wiec wygladac jak sledzenie przesylki.
    if (!dane || typeof dane !== 'object' || (dane.tracking_number == null && dane.status == null)) {
      throw bladOperatora(
        `InPost nie oddał statusu przesyłki: ${oczysc(String(tekst ?? '').trim().slice(0, 300)) || '(pusta odpowiedź)'}`,
      );
    }

    const szczegoly = Array.isArray(dane.tracking_details) ? dane.tracking_details : [];
    const zdarzenia = szczegoly
      .map((z) => ({ opis: opisStanu(z?.status), at: czasZdarzenia(z) }))
      // Zdarzenie bez czasu odpada: nie da sie go porownac z innymi (a najnowsze wybieramy
      // wlasnie po czasie) ani powiedziec operatorowi „kiedy". Zdarzenie bez stanu ZOSTAJE
      // — ta sama swiadoma asymetria co w dpd.js.
      .filter((z) => z.at && Number.isFinite(Date.parse(z.at)));

    // ⚠️ „NIE ROZUMIEM ZDARZEN" NIE MOZE WYGLADAC JAK „NIE MA ZDARZEN". Kilka linii wyzej
    // pilnujemy, zeby 200-z-HTML-em nie udawalo pustej historii — a tu jest ta sama pulapka
    // drugimi drzwiami: lista NIEPUSTA, z ktorej odpadly WSZYSTKIE wpisy, dawala do 2026-08-04
    // to samo `null`, co historia naprawde pusta.
    //
    // Boli akurat teraz, bo nazwa pola ze znacznikiem czasu jest ZGADNIETA (POLA_CZASU wyzej).
    // Gdyby zgadywanie bylo chybione, kazda paczkomatowa paczka pokazywalaby „brak zdarzen"
    // NA ZAWSZE, znacznik proby zapisywalby sie bez bledu i nikt by sie nie dowiedzial, ze
    // sledzenie nie dziala — bo wygladaloby to identycznie jak przesylka nadana przed chwila.
    // To jest sygnal POMIAROWY na pierwsze prawdziwe nadanie, wiec ma byc GLOSNY.
    if (!zdarzenia.length) {
      // Historia naprawde pusta to NIE awaria — swiezo utworzona przesylka nie ma jeszcze
      // czego pokazac. To rozroznienie jest cala tresc tego warunku.
      if (!szczegoly.length) return null;
      throw bladOperatora(
        `InPost oddał zdarzenia przesyłki (${szczegoly.length}), ale panel nie znalazł w nich `
        + `znacznika czasu — sprawdzane nazwy pól: ${POLA_CZASU.join(', ')}. Śledzenie paczkomatowe `
        + 'nie działa, dopóki ta nazwa nie zostanie poprawiona (kurierzy/inpost.js, POLA_CZASU).',
      );
    }

    // Najnowsze wybieramy PO WARTOSCI CZASU, a nie po kolejnosci w dokumencie ani tekstowo.
    // Inaczej niz w DPD (gdzie eventTime nie ma strefy i porownanie tekstowe jest jedynym
    // sensownym) InPost oddaje znaczniki Z PRZESUNIECIEM STREFY — a wtedy tekst i wartosc
    // to dwie rozne kolejnosci, np. '…T00:30+02:00' jest PO '…T23:35+02:00' z dnia
    // poprzedniego, ale tekstowo wypada przed nim.
    let najnowsze = zdarzenia[0];
    for (const z of zdarzenia) if (Date.parse(z.at) > Date.parse(najnowsze.at)) najnowsze = z;
    return najnowsze;
  }

  const numerZOdpowiedzi = (dane) => {
    const numer = dane?.tracking_number;
    return numer ? String(numer) : null;
  };

  /**
   * Dobiera numer przesylki (odpytywaniem, jesli trzeba) i obie etykiety.
   *
   * Wyodrebnione z nadaj(), bo Zadanie 6 potrzebuje DOKLADNIE tego pod przyciskiem
   * „Sprawdz ponownie": przesylka u kuriera juz istnieje, brakuje tylko numeru.
   */
  async function sprawdzPrzesylke(shipmentId, pierwsza = null) {
    const odpowiedzi = pierwsza ? [pierwsza.tekst] : [];
    let numer = numerZOdpowiedzi(pierwsza?.dane);

    // Odpytywanie: co sekunde, w TWARDYM oknie. Warunek liczy uplyw czasu, a nie liczbe
    // prob — nierowne opoznienia sieci nie moga wydluzyc czekania ponad okno.
    const koniec = Date.now() + LIMIT_ODPYTYWANIA_MS;
    while (!numer && Date.now() < koniec) {
      await uspij(ODSTEP_ODPYTYWANIA_MS);
      const g = await wywolaj(sciezka('shipments', shipmentId));
      odpowiedzi.push(g.tekst);
      // HTTP 200 NIE ZNACZY SUKCES — ale i odwrotnie: blad odpytywania NIE jest dowodem,
      // ze przesylki nie ma. Rzucamy glosno, a wolajacy (nadaj() nizej) dokleja `shipmentId`.
      if (!g.res.ok || !g.dane?.id) {
        throw bladOperatora(
          `InPost: nie udało się sprawdzić przesyłki: ${opisBledu(g)}`,
          { surowa: oczysc(odpowiedzi.join('\n---\n')) },
        );
      }
      numer = numerZOdpowiedzi(g.dane);
    }

    const surowa = oczysc(odpowiedzi.join('\n---\n'));

    // ⚠️ WYCZERPANE OKNO TO NIE JEST BLAD. Przesylka u kuriera ISTNIEJE, tylko numeru
    // jeszcze nie dostala. Oddajemy to jako wynik z `wTrakcieTworzenia`, a wolajacy
    // (Zadanie 6) zostawia wiersz 'w_trakcie' i pokazuje „Sprawdz ponownie". Wyjatek
    // w tym miejscu kazalby operatorowi szukac awarii, ktorej nie ma.
    if (!numer) {
      return {
        shipmentId,
        numerListu: null,
        wTrakcieTworzenia: true,
        etykietaPdf: null,
        etykietaZpl: null,
        zplBladOpis: null,
        surowa,
      };
    }

    // Etykieta PDF: jej awaria RZUCA (tak samo jak przy DPD) — ale wyjatek niesie juz numer
    // i identyfikator, wiec nadanie.js zapisze jedno i drugie.
    let etykietaPdf;
    try {
      etykietaPdf = await pobierzEtykiete(shipmentId, 'pdf');
    } catch (e) {
      e.numerListu = numer;
      e.shipmentId = shipmentId;
      e.surowa = oczysc(`${surowa}\n---\n${e.surowa ?? '(brak odpowiedzi na żądanie etykiety)'}`);
      throw e;
    }

    // Etykieta ZPL (Zebra GK420t przez czuwacza) — jej awaria NIE MOZE wywalic nadania:
    // przesylka u kuriera juz istnieje, a operator dostanie PDF i informacje „druku na
    // Zebrze nie bedzie". Dokladnie ta sama asymetria co w dpd.js.
    let etykietaZpl = null;
    let zplBladOpis = null;
    try {
      etykietaZpl = await pobierzEtykiete(shipmentId, 'zpl');
    } catch (e) {
      zplBladOpis = oczysc(e.message);
    }

    return { shipmentId, numerListu: numer, wTrakcieTworzenia: false, etykietaPdf, etykietaZpl, zplBladOpis, surowa };
  }

  /**
   * Nadanie przesylki do paczkomatu.
   *
   * `paczka` to `{ waga, gabaryt }` — dla InPostu NIE MA wymiarow, jest szablon skrytki.
   * `adres` i `punktOdbioru` wolajacy przekazuje JAWNIE (ekran nadania pozwala je poprawic);
   * fallback na dane zamowienia zostaje wylacznie dla wywolan spoza HTTP.
   */
  /** @param {import('../../core/kontrakty.ts').ZlecenieKuriera} zlecenie */
  async function nadaj({
    zamowienie, paczka, kolejnosc = 1, adres: adresPrzekazany, punktOdbioru: punktPrzekazany,
    // ⚠️ Nadpisanie kwoty pobrania z ekranu nadania (Z4) — spojnie z dpd.js. Nazwa
    // zmieniona przy destrukturyzacji, bo `kwotaPobrania` to funkcja w tym module (ta sama
    // pulapka, co `adres` w dpd.js: przeslonieta nazwa wywalilaby nadaj() na TypeError).
    kwotaPobrania: kwotaPrzekazana,
  }) {
    // ⚠️ Adres odbiorcy: od chwili, gdy ekran nadania pozwala operatorowi POPRAWIC adres,
    // TU nie wolno go przeliczac z `zamowienie` — to bylaby edycja POZORNA: operator
    // poprawilby literowke, zatwierdzil, a do kuriera pojechalby adres SPRZED poprawki.
    const odbiorca = adresPrzekazany ?? adresOdbiorcy(zamowienie);

    // Paczkomaty tej umowy sa krajowe. Zagraniczna przesylka ma odmowic GLOSNO, zanim
    // cokolwiek pojedzie do API — tak samo jak w dpd.js.
    if (odbiorca.kraj && odbiorca.kraj !== 'PL') {
      throw bladOperatora(`InPost: przesyłki zagraniczne (${odbiorca.kraj}) nie są obsługiwane w tym panelu.`);
    }

    // ⚠️ NADAWCA BEZ TELEFONU ALBO E-MAILA — odmowa PRZED wywolaniem, z nazwa zmiennej
    // srodowiskowej. InPost wymaga obu (`sender: email: required, phone: required`), DPD
    // zadnego — patrz komentarz przy `telefonNadawcy` wyzej. Komunikat ma nazywac ZMIENNA,
    // a nie „konfiguracje": operator czyta to na ekranie nadania i ma wiedziec, co dopisac
    // do `.env.oms`, bez czytania kodu.
    const brakNadawcy = [];
    if (!telefonNadawcy) brakNadawcy.push('DPD_NADAWCA_TELEFON');
    if (!emailNadawcy) brakNadawcy.push('DPD_NADAWCA_EMAIL');
    if (brakNadawcy.length) {
      throw bladOperatora(
        `InPost wymaga telefonu i e-maila NADAWCY, a w konfiguracji panelu ich nie ma: ${brakNadawcy.join(', ')}. `
        + 'Dopisz je do .env.oms i zrestartuj usługę — DPD działa bez nich, dlatego brakowało ich niezauważenie.',
      );
    }

    // Kod paczkomatu to ADRES tej przesylki. Bez niego nie ma dokad jej nadac — i lepiej
    // powiedziec to przed wywolaniem, niz utworzyc u kuriera przesylke donikad.
    const punkt = String(punktPrzekazany ?? zamowienie?.punkt_odbioru ?? '').trim().toUpperCase();
    if (!punkt) {
      throw bladOperatora('InPost: zamówienie nie ma kodu paczkomatu — nie wiadomo, dokąd ma jechać paczka.');
    }

    const template = szablonGabarytu(paczka?.gabaryt);
    const waga = wagaWKg(paczka?.waga);
    const telefon = naTelefonInPost(odbiorca.phone);
    const cod = kwotaPobrania(zamowienie, kolejnosc, kwotaPrzekazana);

    // Referencja: InPost NIE odsiewa po niej duplikatow (Apilo w ogole jej nie wypelnia),
    // wiec jedyna ochrona przed druga paczka zostaje indeks czesciowy w naszej bazie.
    // Wypelniamy ja mimo to — kosztuje nic, a pozwala odnalezc przesylke w panelu InPostu.
    // Sufiks „/N" dla kolejnych paczek, tak samo jak przy DPD.
    const reference = kolejnosc > 1 ? `${zamowienie.numer}/${kolejnosc}` : String(zamowienie.numer);

    // ⚠️⚠️ TARYFA DOBIERANA PER ZAMOWIENIE, NIE NA SZTYWNO (07.08.2026). Do tego dnia stalo
    // tu `inpost_locker_standard` wpisane wprost — poprawne, dopoki panel nadawal wylacznie
    // paczkomaty ZE SKLEPU. Pierwszy paczkomat z ALLEGRO pojechal przez to na taryfie
    // standardowej zamiast allegrowej (przesylka 6000000001, zam. 1126) i trzeba bylo ja
    // anulowac. Regula i pomiar: domain/usluga-inpost.js.
    const service = uslugaInpost(zamowienie);
    const cialo = {
      service,
      // `sending_method: any_point` wystepuje w 44/44 przesylkach na koncie, bez wyjatku —
      // wlasciciel nadaje w automacie, nie zamawia kuriera po odbior.
      sending_method: 'any_point',
      custom_attributes: {
        target_point: punkt,
        sending_method: 'any_point',
        // ⚠️ PACZKOMAT NADAWCZY — automat, W KTORYM WLASCICIEL ZOSTAWIA PACZKE. Apilo wypelnia
        // to pole na KAZDEJ allegrowej przesylce konta (`dropoff_point: KTY01M`), nasz panel
        // nie wypelnial go w ogole. NIEOBOWIAZKOWE: brak konfiguracji znaczy „nie wysylamy
        // pola", czyli DOKLADNIE dawne zachowanie — zamowienie nie ma prawa nie dac sie nadac
        // dlatego, ze ktos nie dopisal zmiennej srodowiskowej.
        ...(paczkomatNadawczy ? { dropoff_point: paczkomatNadawczy } : {}),
      },
      receiver: {
        ...podzielNazwe(odbiorca.nazwa),
        // Firma tylko wtedy, gdy naprawde jest: adresOdbiorcy() podstawia pod `company`
        // imie i nazwisko, gdy klient firmy nie podal (fallback wymuszony przez DPD),
        // a powtorzenie tego samego napisu w dwoch polach smieci etykiete.
        ...(odbiorca.company && odbiorca.company !== odbiorca.nazwa ? { company_name: odbiorca.company } : {}),
        ...(odbiorca.email ? { email: odbiorca.email } : {}),
        phone: telefon,
      },
      // Nadawce wysylamy JAWNIE, mimo ze organizacja ma wlasny adres: ten w InPoscie jest
      // NIEAKTUALNY (Lipowa 91 zamiast 1 Maja 5), a etykieta ma mowic prawde.
      sender: adresNadawcy(),
      parcels: [{ template, weight: { amount: waga, unit: 'kg' } }],
      reference,
      // ⚠️ KLUCZ `cod` ISTNIEJE WYLACZNIE PRZY POBRANIU. `cod: { amount: null }` to nie jest
      // „brak pobrania", tylko zepsute zadanie — i taka wlasnie roznica dzieli paczke
      // przedplacona od paczki, przy ktorej kurier ma zainkasowac pieniadze.
      ...(cod == null ? {} : { cod: { amount: cod, currency: 'PLN' } }),
    };

    const { res, tekst, dane, status } = await wywolaj(
      sciezka('organizations', organizacja, 'shipments'),
      { method: 'POST', body: JSON.stringify(cialo) },
    );

    // HTTP 200 NIE ZNACZY SUKCES — sprawdzamy KSZTALT odpowiedzi, nie sam status.
    if (!res.ok) {
      throw bladOperatora(`InPost odrzucił przesyłkę: ${opisBledu({ dane, tekst, status })}`, { surowa: oczysc(tekst) });
    }
    const shipmentId = dane?.id;
    if (!shipmentId) {
      // Najgorszy mozliwy przypadek: przesylka MOGLA powstac, a my nie wiemy, jak sie
      // nazywa. Surowa odpowiedz jest jedynym sladem — musi trafic do bazy w calosci.
      throw bladOperatora('InPost nie oddał identyfikatora przesyłki.', { surowa: oczysc(tekst) });
    }

    // ⚠️⚠️ POBRANIE MA WROCIC Z INPOSTU, A NIE TYLKO DO NIEGO POJECHAC (27.08.2026, zam. 1233).
    //
    // Do tego dnia panel sprawdzal wylacznie, co WYSLAL. Wystarczalo, dopoki pobranie
    // jezdzilo samym DPD — pierwsze allegrowe zamowienie na paczkomat ZA POBRANIEM odslonilo
    // dziure, bo umowa z InPostem na przesylki pobraniowe jest NIEPOTWIERDZONA (rozpoznanie
    // 01.08.2026: 0 przesylek z `cod` na 49, lista uslug organizacji bez wariantu pobraniowego).
    //
    // Tryb awarii jest CICHY i najdrozszy z mozliwych: InPost przyjmuje przesylke, ignoruje
    // pobranie, oddaje numer listu i etykiete. Panel meldowalby „nadane", operator wrzucilby
    // paczke do automatu, klient odebralby ja NIC NIE PLACAC — i nikt by sie nie dowiedzial,
    // bo po drodze nie ma ani jednego bledu. Tu jest jedyne miejsce, w ktorym to widac.
    //
    // Zmierzony ksztalt: przesylka BEZ pobrania niesie `cod: { amount: null, currency: null }`,
    // czyli pole istnieje zawsze, a `null` w nim znaczy „pobrania nie ma".
    //
    // ⚠️ RZUCAMY JUZ PO UTWORZENIU PRZESYLKI, wiec wyjatek MUSI niesc `shipmentId` — bez niego
    // nie da sie jej anulowac, a anulowanie jest jedyna sensowna reakcja na taki wynik.
    if (cod != null) {
      const oddane = dane?.cod?.amount;
      const grosze = (k) => Math.round(Number(k) * 100);
      if (oddane == null || !Number.isFinite(Number(oddane)) || grosze(oddane) !== grosze(cod)) {
        throw bladOperatora(
          `InPost przyjął przesyłkę, ale NIE POTWIERDZIŁ pobrania ${cod.toFixed(2)} zł `
          + `(oddał: ${oddane == null ? 'brak' : oddane}). Przesyłka u kuriera ISTNIEJE — `
          + 'nie wrzucaj paczki do automatu, tylko anuluj ją w Managerze Paczek, bo klient '
          + 'odebrałby ją nic nie płacąc. Sprawdź, czy umowa z InPostem obejmuje przesyłki pobraniowe.',
          // ⚠️ `pobranieNiepotwierdzone` KIERUJE WIERSZ NA 'do_wyjasnienia' (services/nadanie.js).
          // Bez tej flagi sam `shipmentId` wpychalby sprawe na 'w_trakcie' z przyciskiem
          // „Sprawdz ponownie" — a to klikniecie dobiera numer i etykiety, KONCZAC nadanie
          // z pominieciem tego straznika (`sprawdzPrzesylke` pobrania nie oglada). Byloby to
          // dokladnie to, przed czym stoi ten kod, tylko o jedno klikniecie dalej.
          // `numerListu` niesiemy, GDY JUZ JEST — to drugi slad prowadzacy do przesylki.
          {
            shipmentId,
            numerListu: numerZOdpowiedzi(dane),
            pobranieNiepotwierdzone: true,
            surowa: oczysc(tekst),
          },
        );
      }
    }

    // ⚠️ OD TEJ CHWILI PRZESYLKA U KURIERA ISTNIEJE. `shipmentId` jest cenniejszy niz numer,
    // niz etykieta i niz cokolwiek innego: bez niego panel nigdy jej nie dokonczy ani nie
    // odnajdzie. KAZDA sciezka wyjscia — takze blad odpytywania i takze awaria etykiety —
    // musi go wyniesc na zewnatrz. To ta sama lekcja co „numer listu jest cenniejszy niz
    // PDF" przy DPD.
    try {
      return await sprawdzPrzesylke(shipmentId, { tekst, dane });
    } catch (e) {
      e.shipmentId ??= shipmentId;
      e.surowa = oczysc(`${tekst}\n---\n${e.surowa ?? '(brak dalszej odpowiedzi)'}`);
      throw e;
    }
  }

  /**
   * PRZ-093.09 — „Sprawdź połączenie” na ekranie Ustawienia → Integracje → Kurier InPost.
   * Jedno `GET /organizations/{id}`: odczyt organizacji, NICZEGO nie nadaje i nie tworzy. To samo żądanie
   * zmierzono na żywym koncie przy rozpoznaniu taryf (domena/usluga-inpost.js) — odpowiedź niesie pole `services`.
   * Sukces wymaga tego pola i (gdy jest) zgodnego `id`: strona pośrednika z HTTP 200 ani cudza organizacja nie są
   * „połączenie działa”. Błędy idą przez opisBledu/oczysc — token nie trafia do komunikatu.
   */
  async function sprawdzPolaczenie() {
    const g = await wywolaj(sciezka('organizations', organizacja));
    if (g.status === 403 || g.status === 404) {
      throw bladOperatora(`InPost nie udostępnia organizacji ${organizacja} temu tokenowi (HTTP ${g.status}) — sprawdź numer organizacji i token: ${opisBledu(g)}`);
    }
    if (!g.res.ok) throw bladOperatora(`InPost odrzucił żądanie (HTTP ${g.status}): ${opisBledu(g)}`);
    if (!Array.isArray(g.dane?.services)) {
      throw bladOperatora('InPost odpowiedział, ale nie rozpoznaję odpowiedzi — sprawdź adres API.');
    }
    if (g.dane.id != null && String(g.dane.id) !== String(organizacja)) {
      throw bladOperatora(`InPost oddał organizację ${oczysc(g.dane.id)}, a wpisana jest ${organizacja} — sprawdź numer organizacji.`);
    }
    return { ok: true };
  }

  return { nadaj, sprawdzPrzesylke, pobierzEtykiete, statusPrzesylki, sprawdzPolaczenie };
}
