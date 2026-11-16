import { transport } from '../../integracje/transport.js';
import { ukryjIdentyfikatoryHttp } from '../../core/http.ts';
import { bladOperatora } from '../../domena/bledy.js';
import { PROG_ZAWIESZONEJ_FAKTURY_MS } from '../../domena/faktura-stan.js';

// inFakt przyjmuje symbol słownika; kontrakt programu niesie tekst przyczyny.
export const symbolPowoduKorekty = (powod) => (powod === 'mistake' || powod === 'other' ? powod : 'other');

// Panel NIGDY nie liczy VAT-u i nie generuje dokumentu — przekazuje pozycje, inFakt
// wystawia fakture.
//
// ⚠️⚠️ WYSTAWIENIE FAKTURY NIGDY JEJ NIE WYSYLA DO KSeF: `wystaw()` nizej nie zna parametru
// `send_to_ksef`, nie wola zadnego zasobu KSeF i tak ma zostac. Wystawienie i wysyłka to
// DWIE OSOBNE DECYZJE CZŁOWIEKA: między nimi pomyłkę da się jeszcze skasować w inFakcie,
// dopóki dokument nie trafił do KSeF i nie jest nieodwracalny. Zlanie ich w jedną kasuje
// tę możliwość.
//
// Sama wysyłka mieszka w `wyslijDokumentDoKsef` na końcu tego pliku — jedyne miejsce
// w tym kliencie, które wysyła. Woła ją WYŁĄCZNIE moduly/faktury/services/wysylka-ksef.js: z trasy
// zatwierdzenia po ekranie podglądu albo z automatu KSeF o godzinie z Ustawień (services/ksef-automat.js),
// który podglądu nie ma i dlatego wysyła tylko to, co wysłałby przycisk.
// Szczegóły i zakaz wołania jej skądkolwiek indziej — w komentarzu przy tej funkcji.

// Twardy limit JEDNEGO zadania do inFaktu. Jego jedynym powodem istnienia jest
// utrzymanie niezmiennika: "rezerwacja starsza od progu" MUSI znaczyc "nic nie leci".
//
// Bez tego limitu niezmiennik nie zachodzil, tylko WYNIKAL ZE ZBIEGU dwoch niezaleznych
// stalych: undici czeka na naglowki domyslnie 300 000 ms, czyli DOKLADNIE tyle, ile
// PROG_ZAWIESZONEJ_FAKTURY_MS. Wystarczylo, zeby wywolanie dociagnelo do granicy, i
// wiszace wystawianie czytalo sie jako osierocone -> operator odblokowywal zamowienie
// w trakcie ZYWEGO wystawiania -> drugie klikniecie = DWA dokumenty w inFakcie (a jesli
// nikt tego nie złapie przed wysyłką — oba pojadą do KSeF).
export const LIMIT_ZADANIA_MS = 60 * 1000;

// ⚠️⚠️ inFakt IGNORUJE `limit` — zmierzone dla wartości
// 10, 25, 50, 100 i 200: ZA KAŻDYM RAZEM `count: 10`, choć `total_count` było większe. Strona ma
// dziesięć wierszy i nie da się jej powiększyć. Dlatego paginacja mieszka TUTAJ, wewnątrz
// klienta, a nie u wołającego: kod, który weźmie pierwszą stronę, pokaże „cały miesiąc"
// jako pierwsze 10 faktur — bez błędu i bez ostrzeżenia.
export const STRONA_INFAKTU = 10;

// ⚠️ SUFIT, żeby zapytanie o zbyt szeroki zakres nie zamieniło się w przelot po całym
// archiwum. 60 stron = 600 dokumentów. Po przekroczeniu ODMAWIAMY:
// cicha część wyniku wygląda dokładnie tak samo jak komplet.
export const SUFIT_STRON = 60;

// Zmierzone: 20 żądań równolegle w 237 ms, zero HTTP 429 i żadnych nagłówków rate-limit.
// Sześć to zapas na wypadek, gdyby inFakt zaczął dławić — nie odpowiedź na zmierzony problem.
export const ROWNOLEGLE_STRON = 6;

// ⚠️ NAJDLUZSZE MOZLIWE POBRANIE JEDNEJ LISTY — LICZONE Z PRAWDZIWYCH STALYCH, a nie opisane
// w komentarzu. `wszystkieStrony` bierze najpierw stronę zerową, a resztę partiami po
// `ROWNOLEGLE_STRON`, więc SEKWENCYJNYCH rund jest `1 + ceil((SUFIT_STRON - 1) / ROWNOLEGLE_STRON)`
// i każda ma własny `LIMIT_ZADANIA_MS`. Równoległość WEWNĄTRZ partii czasu nie sumuje.
//
// Ta liczba jest składnikiem strażnika czasu przebiegu czuwacza archiwum sprzedaży
// (moduly/faktury/services/czuwacz-archiwum-sprzedazy.js → strażnik startu w moduly/faktury/modul.ts):
// podniesienie sufitu stron albo obniżenie równoległości ma POŁOŻYĆ PANEL PRZY STARCIE, a nie po cichu rozjechać zegar.
export const NAJDLUZSZA_LISTA_MS = (1 + Math.ceil((SUFIT_STRON - 1) / ROWNOLEGLE_STRON)) * LIMIT_ZADANIA_MS;

// Straznik przy wczytaniu modulu: gdyby ktos kiedys podniosl limit albo obnizyl prog,
// panel ma nie wstac, zamiast po cichu wrocic do tego wyscigu.
if (LIMIT_ZADANIA_MS >= PROG_ZAWIESZONEJ_FAKTURY_MS) {
  throw new Error(
    'Limit żądania do inFaktu musi być krótszy od progu zawieszonej faktury — inaczej '
    + '„zawieszona" może oznaczać żywe wywołanie, a odblokowanie da drugą fakturę w inFakcie.',
  );
}

// Format bledu inFaktu: `error` to ZAWSZE ten sam ogolnik ("Wadliwy zasob. Popraw bledy
// i sprobuj ponownie."), a cala uzyteczna tresc siedzi w mapie `errors` (pole -> komunikaty).
// Klient czytajacy tylko `error` pokaze operatorowi ogolnik i zgubi jedyna informacje,
// ktora pozwala cokolwiek naprawic.
function powod(dane, status) {
  const z = dane?.errors;
  if (z && typeof z === 'object') {
    const tresci = Object.values(z).flat().filter(Boolean);
    if (tresci.length) return tresci.join('; ');
  }
  return dane?.error || dane?.message || `bez szczegółów (HTTP ${status})`;
}

export function createInfaktClient({ apiKey, fetchImpl, http = transport({ fetchImpl, limitCzasuMs: LIMIT_ZADANIA_MS }), baseUrl = 'https://api.infakt.pl/api' }) {
  // Ta sama funkcja dla testu połączenia i wszystkich pozostałych metod. Krótki/pusty
  // klucz nie może zamazać zwykłych słów; URL może nieść klucz w postaci kodowanej.
  const bezKlucza = (tekst) => {
    let wynik = String(tekst);
    const klucz = String(apiKey ?? '');
    if (klucz.length >= 8) {
      for (const forma of new Set([klucz, encodeURIComponent(klucz)])) {
        wynik = wynik.split(forma).join('[klucz API]');
      }
    }
    return wynik;
  };

  // Kopia zachowuje rodzaj błędu, status i znacznik operatora, ale nie zostawia
  // surowego stack/cause/body. Limit ucina cały ogon, nie oddaje oryginalnego cause.
  function bezpiecznyBlad(blad, glebokosc = 0, odwiedzone = new WeakMap()) {
    if (typeof blad === 'string') return bezKlucza(blad);
    if (!blad || typeof blad !== 'object') return blad;
    if (odwiedzone.has(blad)) return odwiedzone.get(blad);
    if (glebokosc >= 8) return '[pominięto dalsze szczegóły błędu]';
    // DOMException ma name/message/code na prototypie, a ich gettery wymagają
    // wewnętrznego stanu. Sam prototyp daje martwą kopię. Takie błędy spłaszczamy
    // do Error i odczytujemy odziedziczone metadane z działającego oryginału.
    const wymagaZwyklegoBledu = blad instanceof DOMException
      || (!Object.hasOwn(blad, 'message') && typeof blad.message === 'string');
    const kopia = wymagaZwyklegoBledu ? new Error(bezKlucza(blad.message))
      : Array.isArray(blad) ? [] : Object.create(Object.getPrototypeOf(blad));
    odwiedzone.set(blad, kopia);
    const nazwy = Reflect.ownKeys(blad);
    if (wymagaZwyklegoBledu) {
      for (const nazwa of ['name', 'code', 'stack']) {
        if (nazwa in blad && !nazwy.includes(nazwa)) nazwy.push(nazwa);
      }
    }
    for (const nazwa of nazwy) {
      const opis = Object.getOwnPropertyDescriptor(blad, nazwa);
      // Node 24 udostępnia stack przez getter. Odczytujemy go przed kopiowaniem,
      // żeby zachować stos, ale nie getter zamykający w sobie oryginalną treść.
      let wartosc;
      try { wartosc = blad[nazwa]; }
      catch { wartosc = '[pominięto nieczytelne szczegóły błędu]'; }
      Object.defineProperty(kopia, nazwa, {
        enumerable: opis?.enumerable ?? false, configurable: opis?.configurable ?? true, writable: true,
        value: bezpiecznyBlad(wartosc, glebokosc + 1, odwiedzone),
      });
    }
    return kopia;
  }
  // Komunikaty NIE zawieraja klucza API — trafiaja do bazy i do logu.
  //
  // Kazdy blad stad jest OTAGOWANY jako przeznaczony dla operatora (bladOperatora): tresc
  // z `errors` inFaktu ("Prosze podac nazwe firmy") to jedyna informacja, ktora pozwala
  // cokolwiek naprawic, wiec ma dojsc na ekran w calosci. Blad sterownika bazy czy
  // TypeError z naszego kodu tego znacznika nie ma i trasa go odfiltruje.
  //
  // `status` niesiemy dalej, bo to po nim usluga rozpoznaje awarie JEDNOZNACZNA (4xx —
  // dokumentu na pewno nie ma, wolno ponowic) od niejednoznacznej.
  async function zapytaj(sciezka, opcje, coRobimy) {
    let res;
    try {
      res = await http(`${baseUrl}${sciezka}`, {
        ...opcje,
        // Bez tego zwis moglby dociagnac do progu "zawieszonej" rezerwacji — patrz LIMIT_ZADANIA_MS.
        // Sygnal jest NARZUCONY, a nie domyslny: gdyby wolajacy mogl podac wlasny, twardy limit
        // znikalby po cichu, a straznik przy wczytaniu modulu tego nie wylapie (pilnuje stalych,
        // nie miejsca uzycia). Nowy sygnal na KAZDE zadanie — wspolny starzalby sie razem
        // z procesem i po godzinie pracy panelu przerywal kazde wywolanie natychmiast.
        signal: AbortSignal.timeout(LIMIT_ZADANIA_MS),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-inFakt-ApiKey': apiKey },
      });
    } catch (e) {
      // Zerwane polaczenie NIE dostaje statusu: zadanie moglo dojsc i zostac przetworzone,
      // wiec nie wiadomo, czy dokument w inFakcie powstal — sytuacja niejednoznaczna.
      throw bladOperatora(`inFakt nieosiągalny: ${ukryjIdentyfikatoryHttp(`${baseUrl}${sciezka}`, e.message)}`);
    }
    let dane = null;
    try { dane = await res.json(); } catch { dane = null; }
    if (!res.ok) {
      throw bladOperatora(`inFakt odrzucił ${coRobimy} (${res.status}): ${ukryjIdentyfikatoryHttp(`${baseUrl}${sciezka}`, powod(dane, res.status))}`, { status: res.status });
    }
    return dane;
  }

  /**
   * Adres JEDNEJ strony listy. `filtry` to surowe klucze zapytania inFaktu (np. kwotowe),
   * `order` to sortowanie — oba opcjonalne, żeby lista nieopłaconych jechała TĄ SAMĄ
   * paginacją co listy dat, zamiast dorabiać sobie drugą pętlę po stronach.
   *
   * ⚠️ PUŁAPKA SORTOWANIA: inFakt oddaje HTTP 200 na `order` z NIEISTNIEJĄCYM polem —
   * zmierzone: `order=nie_ma_takiego asc` odpowiada normalnie i zwraca ten sam
   * pierwszy wiersz, co zapytanie bez sortowania. Literówka w nazwie pola NIE wywali się,
   * tylko po cichu zmieni kolejność: na ekranie nieopłaconych znaczyłoby to „najstarszy dług"
   * pokazany gdzieś w środku listy. Każdą nazwę pola tutaj trzeba sprawdzić na żywym API.
   *
   * ⚠️ Spację w wartości `order` `URLSearchParams` koduje jako `+` i TAK MA ZOSTAĆ: zmierzone,
   * `order=payment_date+asc` i `order=payment_date%20asc` dają IDENTYCZNY wynik.
   * Nie ma tu czego podmieniać po stronie klienta.
   */
  function adres(zasob, {
    od, do: doDaty, pole = 'invoice_date', order, filtry,
  }, offset) {
    const p = new URLSearchParams();
    p.set('offset', String(offset));
    if (od) p.set(`q[${pole}_gteq]`, od);
    if (doDaty) p.set(`q[${pole}_lteq]`, doDaty);
    for (const [klucz, wartosc] of Object.entries(filtry ?? {})) p.set(klucz, wartosc);
    if (order) p.set('order', order);
    return `/v3/${zasob}.json?${p.toString()}`;
  }

  // `sufitStron` per wywołanie może sufit WYŁĄCZNIE ZAWĘZIĆ (Math.min niżej) — krok luk
  // KSeF w czuwaczu ma ciaśniejszy budżet czasu niż ekran, a poluzowanie
  // z zewnątrz otwierałoby z powrotem przelot po archiwum, przed którym broni stała.
  async function wszystkieStrony(zasob, zakres, rodzaj, { sufitStron = SUFIT_STRON } = {}) {
    const sufit = Math.min(Number(sufitStron) || SUFIT_STRON, SUFIT_STRON);
    const pierwsza = await zapytaj(adres(zasob, zakres, 0), { method: 'GET' }, 'listę dokumentów');
    // ⚠️ CELOWO bez `?? 0`: ten domyślnik właśnie tu zacierał brak `total_count` (zamieniał
    // `undefined` w poprawną liczbę 0), więc strażnik niżej nigdy by go nie złapał.
    const razem = Number(pierwsza?.metainfo?.total_count);
    // ⚠️ NIEUFNOŚĆ WOBEC `total_count` — bez tego strażnika NaN CICHO OMIJA sufit niżej
    // (`NaN > SUFIT_STRON` jest fałszem) i zeruje pętlę stron (`s < NaN` też), więc funkcja
    // oddawałaby PIERWSZĄ STRONĘ jako komplet. To ta sama awaria, przed którą broni cały ten
    // moduł — „cały miesiąc" jako pierwsze 10 faktur — tyle że wpuszczona przez zepsutą odpowiedź
    // zamiast przez ignorowany `limit`. Milczenie jest tu gorsze niż odmowa.
    if (!Number.isFinite(razem) || razem < 0) {
      throw bladOperatora(
        'inFakt nie podał, ile dokumentów jest w tym zakresie — panel nie pokaże listy, '
        + 'której nie umie policzyć. Spróbuj ponownie za chwilę.',
      );
    }
    const stron = Math.ceil(razem / STRONA_INFAKTU);
    if (stron > sufit) {
      throw bladOperatora(
        `Ten zakres obejmuje ${razem} dokumentów, a panel pobiera najwyżej `
        + `${sufit * STRONA_INFAKTU}. Zawęź zakres — niepełna lista wyglądałaby tak samo jak pełna.`,
      );
    }
    const wiersze = [...(pierwsza?.entities ?? [])];
    const offsety = [];
    for (let s = 1; s < stron; s += 1) offsety.push(s * STRONA_INFAKTU);
    for (let i = 0; i < offsety.length; i += ROWNOLEGLE_STRON) {
      const partia = offsety.slice(i, i + ROWNOLEGLE_STRON);
      const odp = await Promise.all(partia.map(
        (o) => zapytaj(adres(zasob, zakres, o), { method: 'GET' }, 'listę dokumentów'),
      ));
      for (const d of odp) wiersze.push(...(d?.entities ?? []));
    }
    return wiersze.map((w) => ({ ...w, rodzaj }));
  }

  const listaFaktur = (zakres, opts) => wszystkieStrony('invoices', zakres, 'vat', opts);

  // ⚠️ Korekty NIE SĄ fakturami w API inFaktu — mieszkają pod własnym zasobem
  // `/v3/corrective_invoices.json`. Paginacja i sufit są te same, więc jedziemy tą samą
  // `wszystkieStrony`; druga pętla po stronach byłaby drugim miejscem do zepsucia.
  const listaKorekt = (zakres) => wszystkieStrony('corrective_invoices', zakres, 'korekta');

  async function pobierzKorekte(uuid) {
    const dane = await zapytaj(`/v3/corrective_invoices/${encodeURIComponent(uuid)}.json`, { method: 'GET' }, 'odczyt korekty');
    return { uuid: dane?.uuid ?? uuid, number: dane?.number,
      corrected_invoice_number: dane?.corrected_invoice_number, invoice_date: dane?.invoice_date, rodzaj: 'korekta',
      ksef_number: dane?.ksef_number ?? null, ksef_status: dane?.ksef_data?.status ?? null,
      ksef_opis: typeof dane?.ksef_data?.status_description === 'string' ? dane.ksef_data.status_description.slice(0, 300) : null,
      status: dane?.status ?? null, gross_price: dane?.gross_price ?? null };
  }

  /**
   * Dokumenty, za które klient jeszcze nie zapłacił — CAŁA historia, nie miesiąc.
   *
   * ⚠️⚠️ TO ZAPYTANIE TYLKO ZAWĘŻA — NIE ROZSTRZYGA. Kto zalega, mówi `czekaNaPrzelew`
   * (domena/lista-faktur.js), a `nieoplacone()` w moduly/faktury/services/faktury-widok.js przepuszcza przez
   * nią każdy wiersz stąd. Nazwa tej funkcji obiecuje więcej, niż jej wynik znaczy, i to jest
   * świadome: sam filtr serwerowy oddaje NADZBIÓR.
   *
   * ⚠️ `q[left_to_pay_gt]=0` ODDAJE TEŻ DOKUMENTY JUŻ OPŁACONE — pomiar po statusie pokazał,
   * że prawie cały wynik ma `status: paid`. Sprawdzanie wyniku samym `left_to_pay > 0` jako
   * definicją „nieopłaconej" to rozumowanie w kółko i tego błędu nie wykryje.
   *
   * Oznaczenie zapłaty w inFakcie ustawia `status` i `paid_date`, a `left_to_pay` ZOSTAWIA —
   * ta sama pułapka, co przy `/paid.json` (domena/termin-platnosci.js). Filtr zostaje w URL-u,
   * bo tanio ucina archiwum do małego nadzbioru; osąd zszedł piętro wyżej, gdzie widać go
   * w testach.
   *
   * ⚠️ DRUGIEGO `q[...]` TU NIE DOKŁADAĆ (kuszące: `q[status_not_eq]=paid` zbiłoby kilka stron do
   * jednej). Nieznany klucz ransacka nie wywala się, tylko ROZSZERZA zapytanie do całego
   * archiwum, a `not_eq` na kolumnie z NULL-em po cichu gubi wiersze. Na ekranie długów obie
   * awarie kończą się liczbą, której nikt nie ma jak zakwestionować — a kilka stron to ułamek sekundy.
   *
   * ⚠️ JEDNA ŚCIEŻKA PAGINACJI — ta sama `wszystkieStrony`, co listy dat. Własna pętla po
   * stronach bez strażnika `total_count` kończyłaby się po pierwszej stronie przy brakującym
   * `total_count`, a przekroczenie sufitu wychodziłoby cichym `break` — ekran długów pokazałby
   * pierwszą stronę jako komplet, ZANIŻONY dług klientów bez śladu błędu.
   * `wszystkieStrony` w obu przypadkach ODMAWIA i tak ma być: na tym ekranie milczenie
   * kosztuje więcej niż odmowa. Druga pętla po stronach to zarazem drugie miejsce do
   * zepsucia — nie odtwarzać jej tutaj.
   */
  const listaNieoplaconych = () => wszystkieStrony(
    'invoices',
    { filtry: { 'q[left_to_pay_gt]': '0' }, order: 'payment_date asc' },
    'vat',
  );

  /**
   * Ilu dokumentow ma DOKLADNIE ten numer — straznik duplikatu wlasnej serii WDT
   * (moduly/faktury/services/wdt-faktury.js) przed wystawieniem z polem `number`.
   *
   * `q[number_eq]` ZWERYFIKOWANE na żywym koncie: znany numer → total_count 1,
   * zmyslony → 0. To wazne, bo NIEZNANY klucz ransacka nie wywala sie, tylko ROZSZERZA
   * zapytanie do calego archiwum — ten klucz dziala i wolno na nim polegac.
   *
   * ⚠️ Brak `total_count` to ODMOWA, nie zero: straznik, ktory na zepsutej odpowiedzi
   * mowi „numer wolny", przepuszcza dokladnie ten duplikat, przed ktorym ma bronic.
   */
  async function iluMaNumer(numer) {
    const sciezka = `/v3/invoices.json?q%5Bnumber_eq%5D=${encodeURIComponent(String(numer ?? ''))}`;
    const dane = await zapytaj(sciezka, { method: 'GET' }, 'sprawdzenie numeru dokumentu');
    const ile = Number(dane?.metainfo?.total_count);
    if (!Number.isFinite(ile) || ile < 0) {
      throw bladOperatora(
        'inFakt nie podał, ile dokumentów ma ten numer — strażnik duplikatu serii WDT '
        + 'nie ma jak rozstrzygnąć. Spróbuj ponownie za chwilę.',
      );
    }
    return ile;
  }

  // Szukamy WYLACZNIE przez q[nip_eq]. Zwykle ?q= oddaje pustke bez bledu.
  async function znajdzKlientaPoNip(nip) {
    if (!nip) return null;
    const sciezka = `/v3/clients.json?q%5Bnip_eq%5D=${encodeURIComponent(nip)}`;
    const dane = await zapytaj(sciezka, { method: 'GET' }, 'wyszukanie klienta');
    const wpisy = dane?.entities ?? [];
    const ile = dane?.metainfo?.total_count ?? wpisy.length;
    // Kartoteka zakładana latami ma setki wpisów, więc duplikat po NIP-ie jest realny.
    // Branie entities[0] wybieraloby nabywcę faktury LOSOWO (kolejnosc ustala inFakt), a zly
    // nabywca na wystawionej fakturze to klopot niezaleznie od KSeF: w inFakcie faktury sie
    // nie edytuje, tylko kasuje i wystawia od nowa — a jeśli zdąży pojechać do
    // KSeF, zostaje juz tylko KOREKTA. Niech rozstrzygnie czlowiek.
    if (ile > 1) {
      throw bladOperatora(
        `W kartotece inFaktu jest ${ile} wpisów z NIP-em ${nip} — panel nie zgadnie, który jest nabywcą. `
        + 'Usuń duplikat w inFakcie albo wystaw tę fakturę ręcznie.',
      );
    }
    return wpisy[0]?.id ?? null;
  }

  async function zalozKlienta(dane) {
    const odp = await zapytaj('/v3/clients.json', {
      method: 'POST',
      body: JSON.stringify({ client: dane }),
    }, 'założenie klienta');
    return odp?.id ?? null;
  }

  async function wystaw(payload) {
    const dane = await zapytaj('/v3/invoices.json', {
      method: 'POST',
      // KOPERTA: dokumentacja API pokazuje `{"invoice": { ... }}`, nie pola plasko. To byla
      // nierozstrzygnieta watpliwosc ("plaskie i opakowane daja identyczny blad walidacji"
      // przy proznej probie) — kopertujemy zgodnie z dokumentacja, nie ze zgadywaniem.
      body: JSON.stringify({ invoice: payload }),
    }, 'fakturę');
    // `ksef_data` (NIE `ksef_status` — tego pola to API w ogole nie zwraca) jest, wedlug
    // dokumentacji, PUSTE, dopoki dokument nie pojdzie do KSeF. Wystawienie faktury SAMO Z
    // SIEBIE jej nie wysyla — wysylka to osobna, swiadoma decyzja czlowieka przez
    // `wyslijDokumentDoKsef` nizej, nigdy skutek uboczny tego wywolania. Dlatego NIC tu na tym polu
    // nie sprawdzamy ani nie blokujemy — zapisujemy wiernie to, co inFakt oddal, a jego brak
    // nie jest bledem. Trafia do kolumny `faktury.ksef_status`, ktora mimo nazwy trzyma
    // WEWNĘTRZNY stan panelu ('w_toku' / 'do_wyjasnienia').
    return { uuid: dane?.uuid ?? null, numer: dane?.number ?? null, ksefStatus: dane?.ksef_data ?? null };
  }

  /**
   * KOREKTA — zasob ASYNCHRONICZNY, inaczej niz faktura (`/v3/invoices.json`, synchroniczna).
   *
   * ⚠️⚠️ `201` NIE ZNACZY „WYSTAWIONO" — I NIE ZNACZY NAWET „TRESC BYLA POPRAWNA". Zmierzone
   * na żywym koncie: `POST` z PUSTYM cialem `{}` dostal `201 „Zlecenie przyjete"`,
   * a dokument NIE POWSTAL (liczba korekt na koncie bez zmian). Walidacja odbywa sie w tle,
   * juz po odpowiedzi, i jej wynik NIE WRACA ta droga.
   *
   * Konsekwencja: kod uznajacy `201` za sukces twierdzilby, ze korekta istnieje, przy KAZDEJ
   * odrzuconej tresci. Dowodem istnienia dokumentu jest WYLACZNIE odczyt (`doczytaj`
   * w moduly/zwroty/services/korekta.js).
   *
   * ⚠️ KOREKTA TO OSOBNY ZASOB — ten sam uuid pod `/invoices/` oddaje 404,
   * stąd `pobierzPdfKorekty` niżej.
   */
  async function wystawKorekte(payload) {
    const dane = await zapytaj('/v3/async/corrective_invoices.json', {
      method: 'POST',
      body: JSON.stringify({ corrective_invoice: {
        ...payload, correction_reason: symbolPowoduKorekty(payload.correction_reason),
      } }),
    }, 'wystawienie korekty');
    return {
      referencja: dane?.invoice_task_reference_number ?? null,
      uuid: dane?.uuid ?? null,
      numer: dane?.number ?? null,
    };
  }

  /** Status zadania jest odrębny od HTTP przyjęcia zlecenia. */
  async function statusKorekty(referencja) {
    const nieznany = { stan: 'nieznany', uuid: null, bledy: [] };
    if (!referencja) return nieznany;
    let dane;
    try {
      dane = await zapytaj(`/v3/async/corrective_invoices/status/${encodeURIComponent(referencja)}.json`, { method: 'GET' }, 'odczyt statusu korekty');
    } catch (e) {
      if (e?.status === 404) return nieznany;
      throw e;
    }
    const nazwy = {
      client_id: 'klient', correction_reason: 'powód korekty', services: 'pozycje', sale_type: 'rodzaj sprzedaży',
      corrected_invoice_number: 'numer faktury korygowanej',
      corrected_invoice_date: 'data faktury korygowanej', base: 'dokument',
    };
    const bledy = Object.entries(dane?.invoice_errors ?? {}).flatMap(([pole, wartosc]) => {
      const komunikaty = (Array.isArray(wartosc) ? wartosc : [wartosc])
        .filter((k) => typeof k === 'string' && k.trim());
      return komunikaty.length ? [{ pole: Object.hasOwn(nazwy, pole) ? nazwy[pole] : pole, komunikaty }] : [];
    });
    const kod = dane?.processing_code;
    if (kod === 422 || (kod >= 400 && kod < 500 && bledy.length)) return { stan: 'odrzucona', uuid: null, bledy };
    if ((kod === 200 || kod === 201) && dane?.invoice_uuid) return { stan: 'wystawiona', uuid: dane.invoice_uuid, bledy: [] };
    if ([100, 120, 140].includes(kod)) return { stan: 'w_toku', uuid: null, bledy: [] };
    return nieznany;
  }

  /**
   * PDF dokumentu — do wydruku i do dysku.
   *
   * `zasob` jest parametrem, bo KOREKTA TO OSOBNY ZASÓB (`corrective_invoices`) — ten sam
   * uuid pod `/invoices/` oddaje 404. Reszta zachowania jest
   * wspólna dla obu dokumentów i celowo istnieje TYLKO RAZ.
   *
   * ⚠️ NIE przez `zapytaj`: tamta funkcja parsuje odpowiedź jako JSON, więc na dokumencie
   * oddałaby `null` i zgubiła treść. Tu potrzebne są SUROWE BAJTY.
   *
   * Ścieżka sprawdzona na żywym dokumencie (nie z dokumentacji): `.pdf` na końcu adresu
   * daje 406 „wybierz rozszerzenie .json", a `/pdf.json` BEZ `document_type` daje 422.
   * Poprawne jest `/pdf.json?document_type=original`. Dopuszczalne typy to `original`,
   * `copy` i `duplicate` — `original_and_copy` z dokumentacji API inFakt ODRZUCA.
   *
   * Odpowiedź weryfikujemy nagłówkiem ORAZ sygnaturą pliku: inFakt na błąd oddaje JSON
   * ze statusem 200 tylko wtedy, gdy coś pójdzie zupełnie nie tak, ale zapisanie takiego
   * ciała jako `.pdf` dałoby plik, który otwiera się dopiero u operatora przy drukarce.
   */
  async function pobierzPdfZasobu(zasob, uuid, typDokumentu = 'original') {
    // „Dokument", a nie „faktura": tędy jadą też KOREKTY (`pobierzPdfKorekty`), a operator
    // czytający „ta faktura" przy pustej korekcie szukałby błędu nie tam, gdzie jest.
    if (!uuid) throw bladOperatora('Ten dokument nie ma numeru w inFakcie.');
    const sciezka = `/v3/${zasob}/${encodeURIComponent(uuid)}/pdf.json`
      + `?document_type=${encodeURIComponent(typDokumentu)}`;
    let res;
    try {
      res = await http(`${baseUrl}${sciezka}`, {
        method: 'GET',
        signal: AbortSignal.timeout(LIMIT_ZADANIA_MS),
        headers: { 'X-inFakt-ApiKey': apiKey },
      });
    } catch (e) {
      throw bladOperatora(`inFakt nieosiągalny: ${e.message}`);
    }
    if (!res.ok) {
      let dane = null;
      try { dane = JSON.parse(Buffer.from(await res.arrayBuffer()).toString()); } catch { dane = null; }
      throw bladOperatora(`inFakt odrzucił pobranie PDF (${res.status}): ${powod(dane, res.status)}`, { status: res.status });
    }
    const bajty = Buffer.from(await res.arrayBuffer());
    if (bajty.subarray(0, 4).toString() !== '%PDF') {
      throw bladOperatora('inFakt oddał coś, co nie jest PDF-em — dokumentu nie zapisano.');
    }
    return bajty;
  }

  // Sygnatura BEZ ZMIAN — woła ją wiele modułów (m.in. `moduly/faktury/services/faktura.js` i `faktura-allegro.js`).
  const pobierzPdf = (uuid, typ) => pobierzPdfZasobu('invoices', uuid, typ);

  // ⚠️ KOREKTA TO OSOBNY ZASÓB — ten sam uuid pod /invoices/ oddaje 404.
  const pobierzPdfKorekty = (uuid, typ = 'original') => pobierzPdfZasobu('corrective_invoices', uuid, typ);

  /**
   * Oznaczenie WYSTAWIONEJ faktury jako opłaconej — WYŁĄCZNIE po to, żeby jej wewnętrzny
   * `status` w inFakcie przestał mówić „nieopłacona".
   *
   * ⚠️ TO NIE MA NIC WSPÓLNEGO Z KSeF (patrz nagłówek pliku). To osobny zasób i nic tu
   * nie wysyła do KSeF — wysyłka w tym kliencie mieszka wyłącznie w `wyslijDokumentDoKsef`.
   *
   * ⚠️ ZAKRES: to zmienia STATUS, a nie treść dokumentu. Kwota zapłaty jedzie na dokument
   * polem `paid_price` przy TWORZENIU (domena/termin-platnosci.js) i to działa — dokument
   * dla klienta drukuje „Zapłacono: 123,00 / Pozostało: 0,00". Zmierzone: ten zasób `left_to_pay` ani
   * `paid_price` NIE RUSZA. Dlatego są potrzebne OBA wywołania i żadne nie zastępuje drugiego:
   * tamto mówi prawdę KLIENTOWI, to mówi ją LIŚCIE FAKTUR W inFAKCIE.
   *
   * ⚠️ OPERACJA JEST ASYNCHRONICZNA. `201` znaczy „przyjęto zlecenie", a nie „oznaczono" —
   * inFakt oddaje referencję zadania (`invoice_task_reference_number`, `processing_code: 100`)
   * i przetwarza je w tle. Niczego tu nie odpytujemy w pętli i nikomu nie obiecujemy,
   * że status już się zmienił.
   *
   * `paid_date` jest w dokumentacji OPCJONALNA, ale musi być „nie wcześniejsza niż data
   * wystawienia" — datę wybiera USŁUGA (moduly/faktury/services/faktura.js), bo tylko ona zna obie daty.
   * Jej brak znaczy BRAK POLA, nigdy `undefined`.
   *
   * ⚠️ Ścieżka `/v3/async/invoices/{uuid}/paid.json` pochodzi z dokumentacji, ale została
   * POTWIERDZONA na żywym API (zwraca 201 i referencję zadania, a status faktury zmienia się
   * na `paid`). Mimo to wołający MUSI traktować awarię jako
   * nieszkodliwą — patrz moduly/faktury/services/faktura.js.
   */
  async function oznaczZaplacona(uuid, { paidDate } = {}) {
    if (!uuid) throw bladOperatora('Ta faktura nie ma numeru dokumentu w inFakcie.');
    const dane = await zapytaj(`/v3/async/invoices/${encodeURIComponent(uuid)}/paid.json`, {
      method: 'POST',
      // BEZ koperty — inaczej niż `wystaw`. Dokumentacja opisuje `paid_date` jako parametr
      // samego wywołania, a nie pole faktury; koperty `{ invoice: ... }` nie ma tu czego opakować,
      // bo dokument już istnieje i nie jest przedmiotem tego żądania.
      body: JSON.stringify(paidDate ? { paid_date: paidDate } : {}),
    }, 'oznaczenie faktury jako zapłaconej');
    // Pusta odpowiedź NIE jest awarią: `zapytaj` oddaje wtedy `null` (nie rzuca), a zlecenie
    // i tak zostało przyjęte — status 2xx jest jedyną informacją, którą tu mamy.
    return { referencja: dane?.invoice_task_reference_number ?? null };
  }

  /**
   * Pojedyncza faktura — pierwotnie WYŁĄCZNIE po to, żeby dowiedzieć się, czy dokument jest
   * już w KSeF (`numer`/`ksefNumer`, czytane przez czuwaczKsef i ksef-doczytanie).
   *
   * ⚠️ TO JEST ODCZYT I MA NIM ZOSTAĆ. Wysyłka do KSeF idzie wyłącznie przez
   * `wyslijDokumentDoKsef` (patrz nagłówek pliku). Ta metoda tylko pyta, czy dokument już jest w KSeF.
   *
   * Kształt pola `ksef_number` zmierzony: wypełnione dla dokumentów wysłanych do KSeF,
   * a PDF niesie ten numer w pierwszej linii dokumentu.
   *
   * ⚠️⚠️ DRUGI ODBIORCA (moduly/zwroty/services/korekta.js): pola SUROWE z API, pod nazwami
   * takimi, jakich używa sam inFakt (`number`, `invoice_date`, `uuid`, `services`) — nie
   * tłumaczone na polski jak `numer`/`ksefNumer` wyżej. Korekta odnosi się do stanu faktury
   * „TERAZ" w inFakcie (mogła zostać poprawiona ręcznie), więc `services` stąd — a nie
   * z pozycji zamówienia w naszej bazie — idzie do `paryKorekty` (domena/korekta-pozycje.js).
   * Nazwy pól `services` są te same, co przy WYSTAWIANIU faktury (`domena/pozycje-faktury.js`:
   * `name`, `quantity`, `gross_price`, `tax_symbol`) — echo tego, co panel sam wysłał.
   */
  async function pobierzFakture(uuid) {
    if (!uuid) throw bladOperatora('Ta faktura nie ma numeru dokumentu w inFakcie.');
    const dane = await zapytaj(`/v3/invoices/${encodeURIComponent(uuid)}.json`, { method: 'GET' }, 'odczyt faktury');
    return {
      numer: dane?.number ?? null,
      // Pusty string sprowadzamy do `null` — patrz test. `|| null` jest tu CELOWE zamiast `?? null`.
      ksefNumer: dane?.ksef_number || null,
      number: dane?.number ?? null,
      invoice_date: dane?.invoice_date ?? null,
      uuid: dane?.uuid ?? uuid,
      services: dane?.services ?? [],
      client_id: dane?.client_id,
      client_company_name: dane?.client_company_name,
      client_first_name: dane?.client_first_name,
      client_last_name: dane?.client_last_name,
      client_street: dane?.client_street,
      client_street_number: dane?.client_street_number,
      client_flat_number: dane?.client_flat_number,
      client_city: dane?.client_city,
      client_post_code: dane?.client_post_code,
      client_tax_code: dane?.client_tax_code,
      client_country: dane?.client_country,
      // ⚠️ POTRZEBNE SKANOWI POBRAŃ (moduly/wysylka/services/oznaczanie-pobran.js), a nie czuwaczowi KSeF.
      // `status` — żeby dokument oznaczony ręcznie w inFakcie wypadł z kandydatów zamiast
      // dostać drugie zlecenie (zmierzone: dokument pobraniowy bywa naraz `delivery` i `paid`).
      // `left_to_pay` — żeby rozstrzygał `stanZaplaty`, ta sama reguła co wszędzie indziej,
      // a nie drugi warunek dopisany na miejscu.
      status: dane?.status ?? null,
      left_to_pay: dane?.left_to_pay ?? null,
      gross_price: dane?.gross_price ?? null,
    };
  }

  // ⚠️⚠️ TU STAŁ `statusKsef(uuid)` — `GET /v3/ksef2/documents/{uuid}/status.json`, oddający
  // `status` ('sent' → 'success' albo 'error') i `status_description`. Usunięty
  // i to jest DECYZJA, a nie sprzątanie z lenistwa. Metoda była
  // zbudowana i otestowana, ale NIE MIAŁA ANI JEDNEGO WOŁAJĄCEGO: czuwacz czyta numer przez
  // `pobierzFakture`, więc do dziś nie odróżnia „przyjęte, czeka" od „organ ODRZUCIŁ".
  //
  // Dlaczego nie została WPIĘTA do czuwacza, choć to właśnie ta informacja jest tam potrzebna:
  //
  //  1. NIE MA GDZIE ZAPISAĆ ODPOWIEDZI. `faktury.ksef_status` znaczy co innego (rezerwacja:
  //     'w_toku'/'do_wyjasnienia'/'sent'), a odrzucenie przez organ to nowy fakt — potrzebna
  //     jest własna kolumna razem z `status_description`. Bez niej wiedza wylądowałaby
  //     wyłącznie w logu, czyli nie zmieniłaby ani jednej blokady na karcie.
  //  2. BUDŻET CZASU PRZEBIEGU BY PĘKŁ. Drugie wywołanie na wiersz to drugie 60 s w najgorszym
  //     przypadku: `najdluzszyPrzebiegMs(limity)` (moduly/faktury/services/czuwacz-ksef.js) urósłby z 54 min 10 s do
  //     ~104 min, czyli PONAD odstęp między tyknięciami zegara — a strażnik startu w moduly/faktury/modul.ts
  //     odmawia wtedy startu panelu. Wpięcie „przy okazji" położyłoby panel przy starcie.
  //
  // CO MA SIĘ STAĆ, GDY TA WIEDZA BĘDZIE POTRZEBNA: osobne zadanie — kolumna na status i opis,
  // przeliczony budżet przebiegu (albo pytanie o status TYLKO dla dokumentów, które panel sam
  // wysłał i które czekają dłużej niż dobę), i dopiero wtedy metoda wraca. Adres i kształt pola
  // są zmierzone i zapisane tutaj, więc odtworzenie jej to kilka linii.

  /**
   * ⚠️⚠️ JEDYNE MIEJSCE W TYM KLIENCIE, KTÓRE WYSYŁA DOKUMENT DO KSeF — i operacja jest
   * NIEODWRACALNA. Dokumentu w KSeF nie da się skasować, zostaje wyłącznie korekta.
   *
   * Wolno ją wywołać WYŁĄCZNIE z moduly/faktury/services/wysylka-ksef.js — z trasy zatwierdzenia po ekranie
   * podglądu albo z automatu KSeF (services/ksef-automat.js, ta sama bariera `coWolnoWyslac`), zawsze po
   * ponownym przeliczeniu zbioru. NIGDY z pollera, NIGDY z czuwacza, NIGDY
   * jako skutek uboczny wystawienia faktury — `wystaw()` wyżej dalej nie zna `send_to_ksef`
   * i znać nie ma.
   *
   * ⚠️⚠️ WYSYŁKA JEST PER DOKUMENT. Wywołanie WSADOWE (`POST /v3/ksef2/documents/send.json`
   * z `{uuids: [...]}`, „jedno zgłoszenie, cała partia, wszystko albo nic") nie istnieje —
   * taki zasób oddaje 404 przy każdej próbie.
   *
   * Zmierzone sondą na żywym API (wyłącznie zmyślone identyfikatory, żaden prawdziwy dokument
   * nie mógł pojechać):
   *   `POST /v3/ksef/documents/{uuid}/send.json`   → 410 „API KSeF 1.0 zostało wyłączone"
   *   `POST /v3/ksef2/documents/send.json`         → 404 z ROUTERA (HTML)
   *   `POST /v3/ksef2/documents/{uuid}/send.json`  → 404 JSON-owy = TRASA ISTNIEJE, handler
   *                                                   szukał dokumentu i go nie znalazł
   *   `GET  /v3/ksef2/documents/{uuid}/status.json`→ 404 JSON-owy = trasa istnieje
   * Rozróżnienie jest twarde: literówka w KTÓRYMKOLWIEK segmencie (`wyslij` zamiast `send`,
   * `dokumenty` zamiast `documents`, `invoices` zamiast `documents`) daje 404 z routera, a
   * `GET`/`DELETE` na tej samej ścieżce też — czyli ta trasa jest POST-only i naprawdę istnieje.
   *
   * ⚠️⚠️ CO Z TEGO WYNIKA DLA WOŁAJĄCEGO: „wszystko albo nic" NIE OBOWIĄZUJE. Każdy dokument
   * idzie osobnym żądaniem, więc CZĘŚCIOWY SUKCES jest przypadkiem normalnym — jedna odmowa
   * nie mówi nic o pozostałych i nie wolno na jej podstawie zwalniać cudzych rezerwacji.
   * Pętla i podział wyniku siedzą w moduly/faktury/services/wysylka-ksef.js.
   *
   * ⚠️ ODPOWIEDŹ ZNACZY „PRZYJĘTO ZLECENIE", A NIE „JEST W KSeF". Zmierzone na prawdziwym
   * dokumencie: od `request_created_at` do `request_finished_at` minęło ok. siedemdziesięciu
   * sekund. Numer pojawia się dopiero potem; woła o niego czuwacz.
   *
   * ⚠️⚠️ NIEZWERYFIKOWANE: czy `send.json` odpowiada OD RAZU (zlecenie przyjęte), czy BLOKUJE
   * na czas całego zadania (siedemdziesiąt sekund wyżej). Nie sprawdzimy tego bez wysłania
   * prawdziwego dokumentu. Jeśli blokuje: `LIMIT_ZADANIA_MS` (60 s) przerwie połączenie
   * WCZEŚNIEJ, niż zadanie się skończy, a `zapytaj` zamieni to na „inFakt nieosiągalny" — BEZ
   * statusu — dokładnie tak samo, jak przy prawdziwej awarii sieci. W tej chwili dokument może
   * już być NIEODWRACALNIE w KSeF. Dlatego tego wywołania NIE WOLNO nigdy ponawiać
   * automatycznie: timeout tutaj znaczy „nie wiadomo", nie „nie wyszło".
   *
   * ⚠️ ISTNIEJE TAKŻE `GET /v3/ksef2/documents/{uuid}/status.json` (potwierdzone tą samą sondą)
   * i to jest właściwe miejsce, żeby kiedyś rozstrzygnąć „przyjęte" od „zarejestrowane".
   * Dziś numer KSeF dociąga czuwacz z listy faktur i to działa, więc nowego zasobu tu NIE
   * dokładamy — ale gdy przyjdzie po niego sięgnąć, adres jest zmierzony, nie zgadnięty.
   */
  async function wyslijDokumentDoKsef(uuid) {
    // ⚠️ JEDEN DOKUMENT NA WYWOLANIE — identyfikator idzie SCIEZKA, nie cialem zadania.
    // Sama niepustosc stringa to za malo: `'   '` przechodzi przez `filter(Boolean)`,
    // a wstawione do sciezki daje adres, ktory niczego nie znaczy.
    const czysty = String(uuid ?? '').trim();
    // ⚠️ `status: 400` JEST TU CELOWY, MIMO ZE ZADNE ZADANIE HTTP NIE POSZLO. Regula
    // zwolnienia rezerwacji (`jednoznacznaOdmowa` w moduly/faktury/services/wysylka-ksef.js) rozpoznaje
    // jednoznacznosc WYLACZNIE po statusie 4xx — a to jest odmowa NAJBARDZIEJ jednoznaczna
    // z mozliwych: do inFaktu nie poszlo NIC, wiec dokumentu u organu na pewno nie ma. Bez
    // tego tagu ta odmowa wygladalaby jak zerwane polaczenie (brak `status`) i trzymalaby
    // rezerwacje NA ZAWSZE za wywolanie, ktore nigdy nie opuscilo panelu.
    if (!czysty) {
      throw bladOperatora('Nie ma czego wysłać do KSeF — pusty identyfikator dokumentu.', { status: 400 });
    }
    // ⚠️ BEZ CIALA ZADANIA. Zmierzone sondą: `POST` na te sciezke BEZ ciala
    // dochodzi do handlera (zmyslony uuid oddaje JSON-owe 404 „Zasob ktorego szukasz nie
    // zostal znaleziony", a nie 400 o brakujacym ladunku). Pusta koperta `{}` bylaby wiec
    // zgadywaniem ksztaltu, ktorego nikt nie potrzebuje.
    const odpowiedz = await zapytaj(
      `/v3/ksef2/documents/${encodeURIComponent(czysty)}/send.json`,
      { method: 'POST' },
      'wysyłkę do KSeF',
    );
    // ⚠️ ODPOWIEDZ ODDAJEMY SUROWA, BEZ INTERPRETACJI. Zasob jest NIEODWRACALNY, wiec
    // probnego telefonu nie bylo i nie bedzie — pierwsza nadzorowana wysylka pokaze, co tam
    // naprawde przychodzi, i DOPIERO WTEDY wolno zbudowac na tym jakiekolwiek zdanie
    // na ekranie. Do tego czasu zaden ekran nie ma prawa udawac, ze cokolwiek zestawil.
    return { odpowiedzInfaktu: odpowiedz ?? null };
  }

  /**
   * „Sprawdź połączenie” na ekranie Ustawienia → Integracje → inFakt.
   * Jedno `GET /v3/invoices.json?offset=0` — to samo żądanie, którym zaczyna się każda lista faktur
   * (`wszystkieStrony`). Tylko odczyt: niczego nie wystawia ani nie wysyła do KSeF,
   * wynik nie niesie danych faktur.
   * Sukces wymaga liczbowego `metainfo.total_count` — strona pośrednika z HTTP 200 to nie „połączenie działa”.
   * ⚠️ Klucz API zastępowany w komunikacie: ten trafia na ekran, a inFakt mógłby odbić klucz w treści błędu.
   */
  async function sprawdzPolaczenie() {
    let dane;
    try {
      dane = await zapytaj(adres('invoices', {}, 0), { method: 'GET' }, 'sprawdzenie połączenia');
    } catch (e) {
      if (e?.status === 401 || e?.status === 403) {
        throw bladOperatora(`inFakt nie przyjął klucza API (HTTP ${e.status}) — sprawdź, czy klucz jest skopiowany w całości `
          + `i aktywny w inFakcie (Ustawienia → API). Odpowiedź inFaktu: ${e.message}`, { status: e.status });
      }
      throw bladOperatora(e?.message ?? 'inFakt nieosiągalny', e?.status ? { status: e.status } : {});
    }
    const ile = Number(dane?.metainfo?.total_count);
    if (!Number.isFinite(ile) || ile < 0) {
      throw bladOperatora('inFakt odpowiedział, ale nie rozpoznaję odpowiedzi — to nie wygląda na API inFaktu.');
    }
    return { ok: true };
  }

  // Jedno wyjście: każda metoda dodana do obiektu automatycznie dostaje maskowanie,
  // także dla PDF (osobny transport) i błędów serializacji przed żądaniem HTTP.
  return Object.fromEntries(Object.entries({
    znajdzKlientaPoNip, zalozKlienta, wystaw, oznaczZaplacona, pobierzPdf, pobierzFakture,
    listaFaktur, listaKorekt, listaNieoplaconych, pobierzPdfKorekty, wyslijDokumentDoKsef,
    wystawKorekte, statusKorekty, pobierzKorekte, iluMaNumer, sprawdzPolaczenie,
  }).map(([nazwa, metoda]) => [nazwa, async (...args) => {
    try { return await metoda(...args); }
    catch (e) { throw bezpiecznyBlad(e); }
  }]));
}

/** Nazwy metod klienta — pośrednik „inFakt z Ustawień” (moduly/faktury/infakt-ustawien.ts) wystawia te same. */
export const METODY_INFAKTU = Object.freeze([
  'znajdzKlientaPoNip', 'zalozKlienta', 'wystaw', 'oznaczZaplacona', 'pobierzPdf', 'pobierzFakture',
  'listaFaktur', 'listaKorekt', 'listaNieoplaconych', 'pobierzPdfKorekty', 'wyslijDokumentDoKsef',
  'wystawKorekte', 'statusKorekty', 'pobierzKorekte', 'iluMaNumer', 'sprawdzPolaczenie',
]);
