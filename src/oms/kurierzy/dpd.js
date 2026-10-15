import { transport } from '../../integracje/transport.js';
import { bladOperatora } from '../../domena/bledy.js';
import { PROG_ZAWIESZONEGO_NADANIA_MS } from '../../domena/przesylka-stan.js';
import { adresOdbiorcy } from '../../domena/adres-odbiorcy.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// DPD odrzuca kod z myślnikiem: '00-001' -> NONEXISTING_POSTAL_CODE, '00001' -> OK.
// Woo oddaje ZAWSZE z myślnikiem, więc bez tego nadanie padałoby na każdym zamówieniu.
const kodPocztowy = (k) => String(k ?? '').replace(/\D/g, '');

// Dwa wywołania SOAP nie uzasadniają nowej zależności npm. Kopertę składamy stringiem,
// a odpowiedź czytamy po nazwie pola — surowa odpowiedź i tak trafia do bazy, więc
// pomyłka w parserze jest odwracalna.
// UWAGA: dopasowanie jest WRAŻLIWE NA WIELKOŚĆ LITER, i tak ma być — V10 odpowiada
// PascalCase'em (<Waybill>), a V4 camelCase'em (<waybill>). Jeden "uniwersalny"
// czytnik pól nie odróżniłby sesji od paczki i cicho oddawałby nie to pole.
function pole(xml, nazwa) {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${nazwa}>([\\s\\S]*?)</(?:\\w+:)?${nazwa}>`));
  return m ? m[1].trim() : null;
}

function pola(xml, nazwa) {
  const re = new RegExp(`<(?:\\w+:)?${nazwa}>([\\s\\S]*?)</(?:\\w+:)?${nazwa}>`, 'g');
  return [...xml.matchAll(re)].map((m) => m[1].trim());
}

// Zdarzenia czytamy BLOKAMI <eventsList>, nie dwiema niezaleznymi listami pol.
//
// JAXB po stronie DPD POMIJA pola null CALKOWICIE: pusty string oddaje jako
// <country></country>, ale brakujacej wartosci nie ma w dokumencie w ogole. Zbieranie
// wszystkich <description> i wszystkich <eventTime> osobno i parowanie ich PO INDEKSIE
// rozjezdza sie przy PIERWSZYM zdarzeniu, ktoremu brakuje ktoregos z tych pol:
//  - brak <description>: tablica opisow jest krotsza, indeks najnowszego czasu wskazuje
//    poza nia -> `undefined` -> node:sqlite rzuca „Provided value cannot be bound",
//    blad ginie w try/catch odpornosci trasy i status zostaje pusty NA ZAWSZE;
//  - brak <eventTime>: gorzej, bo cicho — karta pokazuje opis JEDNEGO zdarzenia
//    z czasem INNEGO i nikt sie nie orientuje.
// Wewnatrz bloku oba pola naleza na pewno do tego samego zdarzenia.
function zdarzenia(xml) {
  const bloki = xml.match(/<(?:\w+:)?eventsList>[\s\S]*?<\/(?:\w+:)?eventsList>/g) ?? [];
  return bloki
    .map((blok) => ({ opis: pole(blok, 'description'), at: pole(blok, 'eventTime') }))
    // Zdarzenie bez czasu odrzucamy: nie da sie go porownac z innymi (a najnowsze
    // wybieramy wlasnie po czasie) ani powiedziec operatorowi „kiedy". Zdarzenie bez
    // opisu zostaje — czas sam w sobie jest informacja, a widok poradzi sobie z pustym
    // opisem. To swiadoma asymetria, nie przeoczenie.
    .filter((z) => z.at);
}

// Twardy limit na zapytanie o status przesylki. Obowiazuje TYLKO usluge zdarzen (nie
// nadania): to jedyne wywolanie robione SYNCHRONICZNIE przy renderowaniu karty zamowienia,
// wiec zawieszone polaczenie do DPD zawiesiloby razem z soba widok. Bez wlasnego sygnalu
// undici czeka na naglowki 300 000 ms, a Fastify nie ma limitu trasy — karta wisialaby
// piec minut przy KAZDYM otwarciu. Wyeksportowane, zeby test mogl to sprawdzic.
export const LIMIT_ZAPYTANIA_STATUS_MS = 5000;

// Twardy limit JEDNEGO zadania uslugi NADAN (V10 i V4). Nadanie bylo ostatnim wywolaniem
// zewnetrznym panelu BEZ jakiegokolwiek limitu: soapZdarzen mial 5 s, klient inFaktu 60 s,
// a tu undici czekal na naglowki domyslne 300 000 ms. Przez ten czas wiersz przesylki stoi
// 'w_trakcie', przegladarka operatora wisi na POST /nadaj, a po drodze mija sie z progiem
// zawieszonego nadania.
export const LIMIT_NADANIA_MS = 60 * 1000;

// Nadanie to TRZY zadania po kolei: generatePackagesNumbersV10 (numer listu), potem DWA
// wywolania generateSpedLabelsV4 — PDF (etykieta „ludzka") i ZPL (Zebra GK420t na
// komputerze produkcyjnym, patrz etykieta() nizej i deploy/drukarka/czuwacz-etykiet.ps1).
// Caly przebieg moze wiec trwac do TRZECH limitow.
const ZADANIA_NADANIA = 3;

// Straznik przy wczytaniu modulu — ten sam wzorzec i ten sam niezmiennik co przy inFakcie:
// „przesylka starsza od progu" MUSI znaczyc „nic juz nie leci". Gdyby limit (albo suma
// limitow) dosiegnal progu, panel moglby uznac ZYWE nadanie za osierocone, operator
// odblokowalby je w trakcie, a DPD dostaloby druga paczke do tego samego zamowienia.
// Panel ma wtedy NIE WSTAC, zamiast po cichu wrocic do tego wyscigu.
if (ZADANIA_NADANIA * LIMIT_NADANIA_MS >= PROG_ZAWIESZONEGO_NADANIA_MS) {
  throw new Error(
    'Limity żądań nadania do DPD muszą sumować się do czasu KRÓTSZEGO niż próg zawieszonego '
    + 'nadania — inaczej „zawieszone" może oznaczać żywe wywołanie, a odblokowanie da drugą paczkę.',
  );
}

/** @param {import('../../integracje/opcje.ts').OpcjeDpd} opcje */
export function createDpdClient({ url, login, haslo, fid, nadawca, infoUrl, channel, fetchImpl, http = transport({ fetchImpl, limitCzasuMs: LIMIT_NADANIA_MS }) }) {
  // Bez walidacji tu brak np. `nadawcy` wywala się dopiero przy pierwszym nadaniu
  // niezrozumiałym `TypeError: Cannot read properties of undefined` — zbyt późno
  // i zbyt niejasno na coś, co jest błędem konfiguracji, nie danych zamówienia.
  const brak = [];
  if (!url) brak.push('url');
  if (!login) brak.push('login');
  if (!haslo) brak.push('haslo');
  if (!fid) brak.push('fid');
  // Samo `if (!nadawca)` przepuszczalo obiekt z PUSTYMI polami — a wtedy kazda paczka
  // jedzie z pusta ulica, kodem i miastem nadawcy i nikt sie nie orientuje, bo DPD
  // i tak zwraca numer listu. Sprawdzamy wiec pola, nie samo istnienie obiektu.
  if (!nadawca) brak.push('nadawca');
  else for (const klucz of ['nazwa', 'ulica', 'kod', 'miasto']) {
    if (!String(nadawca[klucz] ?? '').trim()) brak.push(`nadawca.${klucz}`);
  }
  if (brak.length) throw new Error(`createDpdClient: brak wymaganej konfiguracji: ${brak.join(', ')}.`);

  // faultstring DPD niesie login ("Login failed for login: 27821601 ...").
  // Komunikat trafia do bazy i do logu, więc poświadczenia (login, hasło, FID, kanał)
  // wycinamy, powód zostawiamy. Puste/nieustawione poświadczenie pomijamy — String.split('')
  // na pustym stringu tnie tekst na pojedyncze znaki i rozsypuje cały komunikat.
  // `channel` dochodzi tu razem ze statusPrzesylki (Zadanie 13): usługa zdarzeń autoryzuje
  // się kanałem, nie masterFid-em, więc bez niego na liście kanał wyciekałby do logu.
  const maskuj = (t, wartosc) => (wartosc ? t.split(wartosc).join('***') : t);
  const oczysc = (t) => [login, haslo, fid, channel].reduce((acc, w) => maskuj(acc, w), String(t ?? ''));

  const adres = (a) => `<company>${esc(a.company ?? a.nazwa)}</company><name>${esc(a.name ?? a.nazwa)}</name>`
    + `<address>${esc(a.address ?? a.ulica)}</address><city>${esc(a.city ?? a.miasto)}</city>`
    + `<postalCode>${kodPocztowy(a.postalCode ?? a.kod)}</postalCode>`
    + `<countryCode>${esc(a.countryCode ?? a.kraj ?? 'PL')}</countryCode>`
    + (a.phone ? `<phone>${esc(a.phone)}</phone>` : '')
    + (a.email ? `<email>${esc(a.email)}</email>` : '');

  // DPDServices i DPDInfoServices to DWIE OSOBNE usługi pod dwoma adresami, z dwoma
  // różnymi namespace'ami (patrz notatka z Zadania 8) — koperta jest jedynym, co mają
  // wspólnego, więc tylko tyle wydzielamy. Adres i namespace zostają parametrami wołania,
  // nie stałymi w środku — inaczej statusPrzesylki (usługa zdarzeń) po cichu pytałoby
  // usługę nadań.
  function koperta(namespace, cialo) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:dpd="${namespace}">
  <soapenv:Body>${cialo}</soapenv:Body>
</soapenv:Envelope>`;
  }

  async function wywolajSoap(adres, namespace, cialo, dodatkoweOpcje = {}) {
    let res;
    let tekst;
    try {
      // SOAPAction jest PUSTY dla wszystkich operacji (potwierdzone w WSDL) — dla obu usług.
      res = await http(adres, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml;charset=UTF-8', SOAPAction: '""' },
        body: koperta(namespace, cialo),
        ...dodatkoweOpcje,
      });
      // Odczyt CIALA odpowiedzi musi byc w tym samym try co samo polaczenie. Przerwanie po
      // limicie czasu, reset polaczenia albo urwany strumien rzucaja DOPIERO tutaj — a taki
      // wyjatek poza try szedl w gore surowy: bez znacznika `dlaOperatora` (wiec dla czlowieka
      // jako bezuzyteczne „blad techniczny panelu") i, co gorsza, bez oczysc(), wiec
      // z poswiadczeniami, gdyby niosl je komunikat sterownika.
      tekst = await res.text();
    } catch (e) {
      throw bladOperatora(`DPD nieosiągalne: ${oczysc(e.message)}`);
    }
    const fault = pole(tekst, 'faultstring');
    if (fault) throw bladOperatora(`DPD odrzuciło żądanie: ${oczysc(fault)}`);
    if (!res.ok) throw bladOperatora(`DPD odpowiedziało ${res.status}`);
    return tekst;
  }

  // Usluga nadan (DPDServices). Sygnal jest NARZUCONY, a nie parametrem: gdyby wolajacy mogl
  // podac wlasny, twardy limit znikalby po cichu, a straznik przy wczytaniu modulu tego nie
  // wylapie (pilnuje stalych, nie miejsca uzycia). Nowy sygnal na KAZDE zadanie — wspolny
  // starzalby sie razem z procesem i po godzinie pracy panelu przerywal kazde nadanie natychmiast.
  async function soap(cialo) {
    return wywolajSoap(url, 'http://dpdservices.dpd.com.pl/', cialo, {
      signal: AbortSignal.timeout(LIMIT_NADANIA_MS),
    });
  }

  // Usługa zdarzeń (DPDInfoServices) — osobny adres, osobny namespace i jako JEDYNA
  // twardy limit czasu (patrz LIMIT_ZAPYTANIA_STATUS_MS nad fabryką).
  async function soapZdarzen(cialo) {
    if (!infoUrl || !channel) {
      throw bladOperatora('DPD: brak konfiguracji usługi zdarzeń (infoUrl/kanał).');
    }
    return wywolajSoap(infoUrl, 'http://events.dpdinfoservices.dpd.com.pl/', cialo, {
      signal: AbortSignal.timeout(LIMIT_ZAPYTANIA_STATUS_MS),
    });
  }

  // Wolno użyć WYŁĄCZNIE getEventsForWaybillV1. Rodzina getEventsForCustomerV* czyta
  // kolejkę WSPÓLNĄ dla całego konta DPD i wymaga potwierdzania zdarzeń
  // (markEventsAsProcessedV1) — gdybyśmy potwierdzali je u siebie, Apilo mogłoby ich
  // nigdy nie zobaczyć. To jedyne miejsce w całej integracji, gdzie wspólne dane DPD dla
  // Apilo i panelu naprawdę kolidują (patrz notatka z Zadania 8).
  async function statusPrzesylki(numerListu) {
    // authDataV1 usługi zdarzeń ma channel (NIE masterFid) — ta sama nazwa elementu co
    // w usłudze nadań, inna zawartość. Pomylenie daje INCORRECT_LOGIN_OR_PASSWORD.
    const cialo = `<dpd:getEventsForWaybillV1>
      <waybill>${esc(numerListu)}</waybill>
      <eventsSelectType>ALL</eventsSelectType>
      <language>PL</language>
      <authDataV1><channel>${esc(channel)}</channel><login>${esc(login)}</login><password>${esc(haslo)}</password></authDataV1>
    </dpd:getEventsForWaybillV1>`;

    const odp = await soapZdarzen(cialo);

    // Świeżo zarejestrowana przesyłka oddaje HTTP 200 z pustą listą zdarzeń — to NIE jest
    // awaria, tylko brak historii. Panel ma to pokazać jako „brak zdarzeń", nie błąd.
    const lista = zdarzenia(odp);
    if (!lista.length) return null;

    // ⚠️ ZDARZENIA-NOTYFIKACJE POMIJAMY PRZY WYBORZE (zmierzone na produkcji 23.08):
    // „Powiadomienie mail"/„Powiadomienie SMS" to wpis o wyslaniu wiadomosci do odbiorcy,
    // nie o paczce — a bywa NAJNOWSZY w historii i przykrywal faktyczne „Przesyłka
    // doręczona" (24 z 62 nadanych paczek pokazywaly notyfikacje jako status). Gdy poza
    // notyfikacjami nie ma NICZEGO, oddajemy najnowsza notyfikacje — lepsza niz falszywe
    // „brak zdarzen".
    const fizyczne = lista.filter((z) => !/^powiadomienie (mail|sms)/i.test(String(z.opis ?? '').trim()));
    const kandydaci = fizyczne.length ? fizyczne : lista;

    // Najnowsze zdarzenie wybieramy po eventTime, NIE po kolejności w dokumencie —
    // DPD nie obiecuje sortowania listy zdarzeń. Porównanie tekstowe wystarcza, bo
    // eventTime jest ISO-podobny i stałej długości; NIE parsujemy go na Date, bo DPD
    // oddaje go BEZ STREFY ('2026-07-29T20:07:14.918') i wynik zależałby od strefy hosta.
    let najnowsze = kandydaci[0];
    for (const z of kandydaci) if (z.at > najnowsze.at) najnowsze = z;
    return { ...najnowsze, historia: lista };
  }

  // `kolejnosc` to numer paczki W RAMACH zamowienia (1, 2, 3...) — patrz kolumna
  // `przesylki.kolejnosc`. Domyslne 1 znaczy „jedyna/pierwsza paczka" i daje DOKLADNIE
  // te koperte, ktora ten klient wysylal przed dopuszczeniem wielu paczek.
  // UWAGA na nazwę parametru: funkcja `adres()` (wyżej, w tym samym module) buduje
  // fragment XML-a z obiektu adresu — nazwanie parametru `adres` przesłoniłoby ją
  // wewnątrz nadaj() i nadaj() przestałoby dać się wywołać (TypeError: adres is not
  // a function). Stąd `adresPrzekazany`, mimo że na zewnątrz woła się go `adres`.
  // ⚠️ `kwotaPobrania` (Z4): kwota POPRAWIONA na ekranie nadania, wzorem `adres` wyzej.
  // Opcjonalna — wywolania spoza formularza (nadanie zbiorcze, testy, zadania wsadowe) jej
  // nie podaja i wtedy zrodlem zostaje `zamowienie.kwota_pobrania`, dokladnie jak dotad.
  // Nadpisanie wchodzi jako WARTOSC i NIGDY jako obejscie warunku „tylko paczka nr 1"
  // nizej — patrz komentarz przy nim.
  // ⚠️ `pobranieNaTejPaczce` (04.09.2026): CZY pobranie ma wyjechać na TEJ paczce. Domyślnie
  // `kolejnosc === 1`, czyli DOKŁADNIE dawne zachowanie — każdy wołający, który tego nie
  // poda (nadanie zbiorcze, testy, zadania wsadowe), dostaje to samo, co przed tą zmianą.
  // Jawne `true` przy paczce N > 1 to DECYZJA OPERATORA, opisana przy warunku niżej.
  /** @param {import('../../core/kontrakty.ts').ZlecenieKuriera} zlecenie */
  async function nadaj({
    zamowienie, paczka, kolejnosc = 1, adres: adresPrzekazany, kwotaPobrania: kwotaPrzekazana,
    pobranieNaTejPaczce = kolejnosc === 1,
  }) {
    // ⚠️ Adres odbiorcy: od chwili, gdy ekran nadania (GET/POST /zamowienia/:id/nadaj)
    // pozwala operatorowi POPRAWIĆ adres w formularzu, TU nie wolno go już przeliczać
    // z `zamowienie` — to byłoby dokładnie tą edycją POZORNĄ, przed którą ekran nadania
    // ma chronić: operator poprawiłby literówkę w mieście, zatwierdziłby, a do DPD
    // pojechałby adres SPRZED poprawki. `adres` wołający MUSI przekazać jawnie
    // (services/nadanie.js — parsujAdresOdbiorcy() z formularza, JEDYNA prawdziwa droga
    // do DPD) i to WŁAŚNIE ON, nie zamówienie, jest tu źródłem prawdy.
    //
    // Fallback na adresOdbiorcy(zamowienie) zostaje WYŁĄCZNIE dla wywołań spoza ekranu
    // nadania (bezpośrednie testy tego klienta, przyszłe zadania wsadowe) — prawdziwe
    // nadanie z panelu (jedyne miejsce, które generuje realny, nieodwracalny list
    // przewozowy) zawsze przechodzi przez nadanie.js i zawsze przekazuje adres jawnie.
    const odbiorca = adresPrzekazany ?? adresOdbiorcy(zamowienie);

    // kodPocztowy() (niżej, w adres()) wycina KAŻDY znak nie-cyfrowy — dla brytyjskiego
    // 'SW1A 1AA' zostawi '11', a sessionType jest zaszyty na DOMESTIC. Zamiast nadać
    // zagraniczną paczkę z okaleczonym adresem, odmawiamy jawnie: obsługujemy tylko
    // przesyłki krajowe. Normalizację kraju (trim + uppercase, puste -> 'PL') robi już
    // adresOdbiorcy — tu tylko na niej polegamy, żeby nie mieć dwóch kopii tej reguły.
    if (odbiorca.kraj !== 'PL') {
      // Komunikat trafia do operatora jako czysty tekst, nie do XML-a — esc() (encodowanie
      // XML-owe) tutaj tylko zaśmieciłoby komunikat (np. '&' -> '&amp;').
      throw bladOperatora(`DPD: przesyłki zagraniczne (${odbiorca.kraj}) nie są obsługiwane w tym panelu.`);
    }

    // Pobranie: <cod> ma amount jako STRING z kropką i własną walutą. Sprawdzenie samej
    // prawdziwości ('0.00' jest truthy jako string!) wysłałoby COD na zero złotych —
    // to pieniądze, więc liczy się wyłącznie kwota większa od zera.
    // Wartość, której nie da się odczytać jako liczby (przecinek dziesiętny, tekst z
    // jednostką...) MA RZUCAĆ czytelnym błędem, a nie po cichu pominąć <cod> — cichy
    // pominiecie wysłałoby paczkę jako przedpłaconą, kurier nie inkasowałby pobrania i
    // nikt by się nie dowiedział. Brak pobrania (null/undefined) to inna sytuacja —
    // wtedy po prostu nie ma <cod>. Wartość poprawną przycinamy z białych znaków, żeby
    // nie przepuszczać ich wprost do DPD.
    //
    // ⚠️ POBRANIE JEDZIE NA JEDNEJ PACZCE — DOMYSLNIE PIERWSZEJ. Kwota pobrania nalezy do
    // ZAMOWIENIA, nie do paczki: powtorzenie jej na paczce nr 2 znaczy, ze kurier
    // zainkasuje ja od klienta DRUGI RAZ — i to sa prawdziwe pieniadze prawdziwego
    // klienta, a nie zapis w naszej bazie. Warunek jest tutaj, a nie u wolajacego,
    // bo tylko tu widac cala koperte i tylko tu da sie zagwarantowac, ze <cod> nie
    // wyjedzie inna droga.
    //
    // ⚠️⚠️ WYJATEK OD 04.09.2026 (decyzja wlasciciela, zamowienie 1385): paczka N > 1 bywa
    // ZAMIENNIKIEM pierwszej, a nie dosylka OBOK niej. Klient domawia towar telefonicznie po
    // wydrukowaniu etykiety, etykieta idzie do kosza i paczka nr 1 NIGDY nie pojedzie —
    // wygasnie u DPD. Ponowne nadanie jako paczka nr 1 jest niemozliwe (DPD zna juz gola
    // referencje: DUPLICATED_PARCEL_SEARCH_KEY), wiec zamiennik MUSI byc paczka nr 2 — a bez
    // pobrania kurier nie zainkasowalby ani zlotowki. „Wyjechala jedna paczka" i „to jest
    // paczka numer 1" to dwa ROZNE zdania i tylko pierwsze rzadzi pieniedzmi.
    //
    // Panel NIE UMIE tego rozstrzygnac sam: nie ma skad wiedziec, ze etykieta wyladowala
    // w koszu. Wie to wylacznie czlowiek, wiec decyzja przychodzi Z ZEWNATRZ, jest domyslnie
    // WYLACZONA i zostaje w logu (services/nadanie.js) — to jedyne miejsce, w ktorym po
    // miesiacu widac, ile kurier mial zainkasowac i z czyjej decyzji.
    // ⚠️ Nadpisanie z ekranu nadania (Z4) jest WARTOSCIA, nie obejsciem warunku ponizej:
    // podmienia WYLACZNIE to, ile kurier ma zainkasowac, a nie to, CZY <cod> w ogole
    // wyjedzie. Odmowa dla kwoty pustej, zerowej i nieczytelnej pada wczesniej, w trasie
    // POST (domain/pobranie-nadania.js) — tutaj zostaja te same straznikami, co dotad,
    // bo ta funkcja musi bronic sie takze przed wolajacym spoza formularza.
    const surowaKwotaPobrania = kwotaPrzekazana ?? zamowienie.kwota_pobrania;
    let cod = '';
    if (pobranieNaTejPaczce && surowaKwotaPobrania != null) {
      const przycietaKwota = String(surowaKwotaPobrania).trim();
      const kwotaPobrania = Number(przycietaKwota);
      if (!Number.isFinite(kwotaPobrania)) {
        throw bladOperatora(`DPD: nie umiem odczytać kwoty pobrania: "${surowaKwotaPobrania}".`);
      }
      if (kwotaPobrania > 0) {
        cod = `<cod><amount>${esc(przycietaKwota)}</amount><currency>PLN</currency></cod>`;
      }
    }

    // Referencja paczki. DPD odrzuca jej POWTORZENIE (DUPLICATED_PARCEL_SEARCH_KEY) i to
    // jest druga, niezalezna od bazy siatka chroniaca przed paczka, ktorej nikt nie chcial.
    // Dopuszczenie wielu paczek nie ma prawa jej rozbroic — wiec zamiast wysylac ten sam
    // numer zamowienia dwa razy, kazda kolejna paczka dostaje wlasny sufiks „/N".
    //
    // Paczka nr 1 leci z GOLYM numerem zamowienia, dokladnie jak dotad: zamowienia juz
    // nadane, reklamacje i wyszukiwanie po referencji w panelu DPD nie moga sie rozjechac
    // przez zmiane, ktora ich nie dotyczy.
    //
    // Sufiks idzie do WSZYSTKICH trzech pol referencji, a nie tylko do tego przy paczce:
    // ktore z nich DPD bierze za klucz wyszukiwania, wiemy wylacznie z zachowania serwera,
    // a rozjazd miedzy nimi znaczylby etykiete opisana numerem innej paczki.
    const referencja = kolejnosc > 1 ? `${zamowienie.numer}/${kolejnosc}` : zamowienie.numer;

    // Kolejnosc elementow wg sekwencji XSD: parcels, payerType, receiver, ref1, reference,
    // sender, services. Serwer okazal sie tolerancyjny, ale trzymamy sie kontraktu.
    const cialoNumery = `<dpd:generatePackagesNumbersV10>
      <openUMLFeV13><packages>
        <parcels><reference>${esc(referencja)}</reference><weight>${esc(paczka.waga)}</weight><sizeX>${esc(paczka.dlugosc)}</sizeX><sizeY>${esc(paczka.szerokosc)}</sizeY><sizeZ>${esc(paczka.wysokosc)}</sizeZ></parcels>
        <payerType>SENDER</payerType>
        <receiver>${adres(odbiorca)}</receiver>
        <ref1>${esc(referencja)}</ref1>
        <reference>${esc(referencja)}</reference>
        <sender><fid>${esc(fid)}</fid>${adres(nadawca)}</sender>
        <services>${cod}</services>
      </packages></openUMLFeV13>
      <pkgNumsGenerationPolicyV1>ALL_OR_NOTHING</pkgNumsGenerationPolicyV1>
      <langCode>PL</langCode>
      <authDataV1><login>${esc(login)}</login><masterFid>${esc(fid)}</masterFid><password>${esc(haslo)}</password></authDataV1>
    </dpd:generatePackagesNumbersV10>`;

    const odpNumery = await soap(cialoNumery);

    // HTTP 200 NIE OZNACZA SUKCESU. <Status> wystepuje na TRZECH poziomach: sesji, paczki
    // i przesyłki (parcel) — sesja moze byc OK, a konkretna paczka DUPLICATED_WAYBILL, i
    // bez sprawdzenia KAZDEGO poziomu zapisalibysmy numer, ktory DPD juz odrzucil.
    const zleStatusy = pola(odpNumery, 'Status').filter((s) => s !== 'OK');
    if (zleStatusy.length) {
      // Sam <Status> MUSI trafic do komunikatu, a <Info> tylko go uzupelnia.
      // Powod: przy powtorzonej referencji DPD oddaje Status=DUPLICATED_PARCEL_SEARCH_KEY,
      // pusta <Packages/> i ANI JEDNEGO <Info> (fikstura v10-duplikat.xml) — klient
      // sklejajacy wylacznie <Info> pokazalby operatorowi pusty komunikat i zgubil
      // jedyna uzyteczna informacje o tym, co sie stalo.
      const statusy = [...new Set(zleStatusy)].join('; ');
      const powody = pola(odpNumery, 'Info');
      const opis = powody.length ? `${statusy}: ${powody.join('; ')}` : statusy;
      throw bladOperatora(`DPD odrzuciło paczkę: ${oczysc(opis)}`, { surowa: oczysc(odpNumery) });
    }
    const numerListu = pole(odpNumery, 'Waybill');
    const sessionId = pole(odpNumery, 'SessionId');
    if (!numerListu || !sessionId) {
      // Wyjatek nie moze zgubic surowej odpowiedzi: to jedyny slad, gdy parsowanie
      // zawiodlo mimo Status=OK (np. zmiana struktury odpowiedzi po stronie DPD).
      throw bladOperatora('DPD nie oddało numeru listu przewozowego.', { surowa: oczysc(odpNumery) });
    }

    // OD TEGO MIEJSCA NUMER LISTU JUZ ISTNIEJE PO STRONIE DPD.
    // Ponowienie z ta sama referencja zostanie odrzucone (DUPLICATED_PARCEL_SEARCH_KEY),
    // wiec drugiej szansy na odczytanie tego numeru NIE BEDZIE. Kazdy pozniejszy wyjatek
    // musi go wyniesc na zewnatrz razem z odpowiedzia V10 — bo to V10, nie V4, zawiera
    // <Waybill>. Bez tego numer ginie i zamowienia nie da sie juz nadac z panelu.
    try {
      return await etykieta({ numerListu, sessionId, odpNumery });
    } catch (e) {
      e.numerListu = numerListu;
      e.surowa = oczysc(`${odpNumery}\n---\n${e.surowa ?? '(brak odpowiedzi na żądanie etykiety)'}`);
      throw e;
    }
  }

  // Kopertę generateSpedLabelsV4 wołamy DWA razy — raz po PDF, raz po ZPL — z DOKŁADNIE
  // tą samą sesją i tym samym payloadem poza formatem wyjściowym. Wydzielone do funkcji,
  // żeby te dwa wywołania nie mogły się po cichu rozjechać (np. przy przyszłej zmianie
  // outputLabelType).
  function cialoEtykietyV4(sessionId, format, pageFormat) {
    return `<dpd:generateSpedLabelsV4>
      <dpdServicesParamsV1>
        <policy>STOP_ON_FIRST_ERROR</policy>
        <session><sessionId>${esc(sessionId)}</sessionId><sessionType>DOMESTIC</sessionType></session>
      </dpdServicesParamsV1>
      <outputDocFormatV1>${format}</outputDocFormatV1>
      <outputDocPageFormatV1>${pageFormat}</outputDocPageFormatV1>
      <outputLabelType>BIC3</outputLabelType>
      <authDataV1><login>${esc(login)}</login><masterFid>${esc(fid)}</masterFid><password>${esc(haslo)}</password></authDataV1>
    </dpd:generateSpedLabelsV4>`;
  }

  async function etykieta({ sessionId, numerListu, odpNumery }) {
    // ⚠️ `LBL_PRINTER`, NIE `A4` (zmiana 2026-07-31 na prośbę właściciela). DPD w formacie
    // A4 wkleja etykietę w róg pustej strony — na drukarce etykiet (Zebra 100×150 mm) trzeba
    // ją wtedy przycinać albo skalować, a wydruk wychodzi przesunięty. `LBL_PRINTER` daje PDF
    // o rozmiarze SAMEJ etykiety, czyli „na całą stronę", i tak samo dobrze drukuje się
    // na zwykłej drukarce.
    //
    // To jest ten sam format strony, o który prosimy przy ZPL-u niżej — różni się wyłącznie
    // typem dokumentu. Etykiety pobrane WCZEŚNIEJ zostają na dysku takie, jakie były (A4):
    // panel niczego nie przegenerowuje, bo DPD odmawia powtórnego nadania tej samej paczki.
    const odpEtykieta = await soap(cialoEtykietyV4(sessionId, 'PDF', 'LBL_PRINTER'));

    // V4 odpowiada camelCase'em i tez potrafi oddac 200 z bledem.
    const zle = pola(odpEtykieta, 'status').filter((s) => s !== 'OK');
    if (zle.length) {
      throw bladOperatora(`DPD nie wystawiło etykiety: ${oczysc([...new Set(zle)].join('; '))}`, { surowa: oczysc(odpEtykieta) });
    }
    const base64 = pole(odpEtykieta, 'documentData');
    if (!base64) {
      throw bladOperatora('DPD nie oddało etykiety.', { surowa: oczysc(odpEtykieta) });
    }

    // Drugie żądanie: ta sama etykieta w ZPL, dla Zebry GK420t na komputerze produkcyjnym
    // (kolejka druku, patrz deploy/drukarka/czuwacz-etykiet.ps1). W TYM MIEJSCU numer listu
    // JUŻ ISTNIEJE po stronie DPD (patrz komentarz w nadaj() niżej) — nieudane pobranie ZPL
    // NIE MOŻE więc wywalić całego nadania, dokładnie tak samo, jak nie wywala go awaria
    // zapisu pliku PDF na dysk (services/nadanie.js). Operator dostaje PDF i fakt „druku
    // na Zebrze nie będzie" (zapisany przez nadanie.js), a nie wyjątek blokujący cały
    // wiersz na 'do_wyjaśnienia' z powodu drukarki, która nikogo jeszcze nie obchodzi.
    let etykietaZpl = null;
    let zplBladOpis = null;
    try {
      const odpZpl = await soap(cialoEtykietyV4(sessionId, 'ZPL', 'LBL_PRINTER'));
      const zleZpl = pola(odpZpl, 'status').filter((s) => s !== 'OK');
      if (zleZpl.length) {
        throw bladOperatora(`DPD nie wystawiło etykiety ZPL: ${oczysc([...new Set(zleZpl)].join('; '))}`);
      }
      const base64Zpl = pole(odpZpl, 'documentData');
      if (!base64Zpl) throw bladOperatora('DPD nie oddało etykiety ZPL.');
      etykietaZpl = Buffer.from(base64Zpl, 'base64');
    } catch (e) {
      zplBladOpis = oczysc(e.message);
    }

    return {
      numerListu,
      etykietaPdf: Buffer.from(base64, 'base64'),
      etykietaZpl,
      zplBladOpis,
      surowa: oczysc(`${odpNumery}\n---\n${odpEtykieta}`),
    };
  }

  return { nadaj, statusPrzesylki };
}
