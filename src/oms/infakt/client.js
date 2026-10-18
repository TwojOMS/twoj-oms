import { transport } from '../../integracje/transport.js';
import { ukryjIdentyfikatoryHttp } from '../../core/http.ts';
import { bladOperatora } from '../../domena/bledy.js';
import { PROG_ZAWIESZONEJ_FAKTURY_MS } from '../../domena/faktura-stan.js';

// Panel NIGDY nie liczy VAT-u i nie generuje dokumentu — przekazuje pozycje, inFakt
// wystawia fakture.
//
// ⚠️⚠️ WYSTAWIENIE FAKTURY NIGDY JEJ NIE WYSYLA DO KSeF: `wystaw()` nizej nie zna parametru
// `send_to_ksef`, nie wola zadnego zasobu KSeF i tak ma zostac. Wlasciciel wystawia faktury
// w ciagu dnia, a wysyla je zbiorczo dopiero wieczorem — to SWIADOMA decyzja, zeby pomylke
// dalo sie skasowac w inFakcie, dopoki dokument jeszcze nie jest nieodwracalny. Wystawienie
// i wysylka to DWIE OSOBNE DECYZJE CZLOWIEKA i zlanie ich w jedna kasuje te mozliwosc.
//
// Sama wysylka mieszka w `wyslijDokumentDoKsef` na koncu tego pliku (od 06.08.2026, na zadanie
// wlasciciela: zbiorcza wysylka z panelu zamiast klikania w inFakcie) — jedyne miejsce
// w panelu, ktore wysyla. Ma byc wolane WYLACZNIE z trasy zatwierdzenia po ekranie podgladu.
// Szczegoly i zakaz wolania jej skadkolwiek indziej — w komentarzu przy tej funkcji.

// Twardy limit JEDNEGO zadania do inFaktu. Jego jedynym powodem istnienia jest
// utrzymanie niezmiennika: "rezerwacja starsza od progu" MUSI znaczyc "nic nie leci".
//
// Bez tego limitu niezmiennik nie zachodzil, tylko WYNIKAL ZE ZBIEGU dwoch niezaleznych
// stalych: undici czeka na naglowki domyslnie 300 000 ms, czyli DOKLADNIE tyle, ile
// PROG_ZAWIESZONEJ_FAKTURY_MS. Wystarczylo, zeby wywolanie dociagnelo do granicy, i
// wiszace wystawianie czytalo sie jako osierocone -> operator odblokowywal zamowienie
// w trakcie ZYWEGO wystawiania -> drugie klikniecie = DWA dokumenty w inFakcie (a jesli
// nikt tego nie zlapie przed wieczorna zbiorcza wysylka — oba pojada do KSeF).
export const LIMIT_ZADANIA_MS = 60 * 1000;

// ⚠️⚠️ inFakt IGNORUJE `limit` — zmierzone 06.08.2026 na produkcyjnym koncie dla wartości
// 10, 25, 50, 100 i 200: ZA KAŻDYM RAZEM `count: 10` przy `total_count: 64`. Strona ma
// dziesięć wierszy i nie da się jej powiększyć. Dlatego paginacja mieszka TUTAJ, wewnątrz
// klienta, a nie u wołającego: kod, który weźmie pierwszą stronę, pokaże „cały czerwiec"
// jako 10 z 64 faktur — bez błędu i bez ostrzeżenia.
export const STRONA_INFAKTU = 10;

// ⚠️ SUFIT, żeby zapytanie o zbyt szeroki zakres nie zamieniło się w przelot po całym
// archiwum. 60 stron = 600 dokumentów = dwa lata sprzedaży. Po przekroczeniu ODMAWIAMY:
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
// (services/czuwacz-archiwum-sprzedazy.js → bootstrap.js): podniesienie sufitu stron albo
// obniżenie równoległości ma POŁOŻYĆ PANEL PRZY STARCIE, a nie po cichu rozjechać nocny zegar.
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
   * zmierzone 06.08.2026, `order=nie_ma_takiego asc` odpowiada normalnie i zwraca ten sam
   * pierwszy wiersz, co zapytanie bez sortowania. Literówka w nazwie pola NIE wywali się,
   * tylko po cichu zmieni kolejność: na ekranie nieopłaconych znaczyłoby to „najstarszy dług"
   * pokazany gdzieś w środku listy. Każdą nazwę pola tutaj trzeba sprawdzić na żywym API.
   *
   * ⚠️ Spację w wartości `order` `URLSearchParams` koduje jako `+` i TAK MA ZOSTAĆ: zmierzone
   * 06.08.2026, `order=payment_date+asc` i `order=payment_date%20asc` dają IDENTYCZNY wynik.
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
  // KSeF w czuwaczu (2026-08-29) ma ciaśniejszy budżet czasu niż ekran, a poluzowanie
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
    // moduł — „cały czerwiec" jako 10 z 64 — tyle że wpuszczona przez zepsutą odpowiedź
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

  /**
   * Dokumenty, za które klient jeszcze nie zapłacił — CAŁA historia, nie miesiąc.
   *
   * ⚠️⚠️ TO ZAPYTANIE TYLKO ZAWĘŻA — NIE ROZSTRZYGA. Kto zalega, mówi `czekaNaPrzelew`
   * (domain/lista-faktur.js), a `nieoplacone()` w services/faktury-widok.js przepuszcza przez
   * nią każdy wiersz stąd. Nazwa tej funkcji obiecuje więcej, niż jej wynik znaczy, i to jest
   * świadome: sam filtr serwerowy oddaje NADZBIÓR.
   *
   * ⚠️ SPROSTOWANIE DO POPRZEDNIEJ WERSJI TEGO DOCBLOCKA — i to ona wprowadziła w błąd cały
   * ekran. Stało tu, że `q[left_to_pay_gt]=0` daje „65 dokumentów i ani jednego już opłaconego",
   * a filtr po statusie przepuszcza zapłacone. Drugie zdanie jest prawdziwe, pierwsze nie było:
   * pomiar 06.08.2026 sprawdzał tylko, czy wynik zgadza się SAM ZE SOBĄ (`left_to_pay > 0` jako
   * definicja „nieopłaconej"), i to jest rozumowanie w kółko. Pomiar 10.08.2026 na tym samym
   * koncie, tym razem po statusie:
   *
   *   q[left_to_pay_gt]=0                 → 67 dokumentów:  status paid=65, sent=2
   *   q[left_to_pay_gt]=0 & status!=paid  → 2  (numery, które wskazał właściciel)
   *
   * Oznaczenie zapłaty w inFakcie ustawia `status` i `paid_date`, a `left_to_pay` ZOSTAWIA —
   * ta sama pułapka, co przy `/paid.json` (domain/termin-platnosci.js). Filtr zostaje w URL-u,
   * bo tanio ucina archiwum z 329 dokumentów do 67; osąd zszedł piętro wyżej, gdzie widać go
   * w testach.
   *
   * ⚠️ DRUGIEGO `q[...]` TU NIE DOKŁADAĆ (kuszące: `q[status_not_eq]=paid` zbiłoby 7 stron do
   * jednej). Nieznany klucz ransacka nie wywala się, tylko ROZSZERZA zapytanie do całego
   * archiwum, a `not_eq` na kolumnie z NULL-em po cichu gubi wiersze. Na ekranie długów obie
   * awarie kończą się liczbą, której nikt nie ma jak zakwestionować — a siedem stron to ~0,4 s.
   *
   * ⚠️ JEDNA ŚCIEŻKA PAGINACJI — ta sama `wszystkieStrony`, co listy dat. Wcześniej stała
   * tu WŁASNA pętla po stronach i to ona była błędem: brała kres z `total_count` bez
   * strażnika, więc brakujące albo nieliczbowe `total_count` kończyło ją po pierwszej
   * stronie, a przekroczenie sufitu wychodziło cichym `break`. W obu razach ekran długów
   * pokazywał 10 z 65 dokumentów jako komplet — ZANIŻONY dług klientów bez śladu błędu.
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
   * (services/faktura.js) przed wystawieniem z polem `number`.
   *
   * `q[number_eq]` ZWERYFIKOWANE na zywym koncie 26.08.2026: znany numer → total_count 1,
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
    // Kartoteka ma ~275 wpisow zakladanych latami, wiec duplikat po NIP-ie jest realny.
    // Branie entities[0] wybieraloby nabywcę faktury LOSOWO (kolejnosc ustala inFakt), a zly
    // nabywca na wystawionej fakturze to klopot niezaleznie od KSeF: w inFakcie faktury sie
    // nie edytuje, tylko kasuje i wystawia od nowa — a jesli zdazy pojechac wieczorem do
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
    // WEWNETRZNY stan panelu ('w_toku' / 'do_wyjasnienia') — patrz komentarz przy tej
    // kolumnie w schema.sql.
    return { uuid: dane?.uuid ?? null, numer: dane?.number ?? null, ksefStatus: dane?.ksef_data ?? null };
  }

  /**
   * KOREKTA — zasob ASYNCHRONICZNY, inaczej niz faktura (`/v3/invoices.json`, synchroniczna).
   *
   * ⚠️⚠️ `201` NIE ZNACZY „WYSTAWIONO" — I NIE ZNACZY NAWET „TRESC BYLA POPRAWNA". Zmierzone
   * 2026-08-14 na zywym koncie: `POST` z PUSTYM cialem `{}` dostal `201 „Zlecenie przyjete"`,
   * a dokument NIE POWSTAL (liczba korekt na koncie bez zmian). Walidacja odbywa sie w tle,
   * juz po odpowiedzi, i jej wynik NIE WRACA ta droga.
   *
   * Konsekwencja: kod uznajacy `201` za sukces twierdzilby, ze korekta istnieje, przy KAZDEJ
   * odrzuconej tresci. Dowodem istnienia dokumentu jest WYLACZNIE odczyt (`doczytaj`
   * w services/korekta.js) — patrz notatka `2026-08-14-oms-zwroty-pomiar.md`.
   *
   * ⚠️ KOREKTA TO OSOBNY ZASOB — ten sam uuid pod `/invoices/` oddaje 404 (sprawdzone
   * 2026-08-01), stad `pobierzPdfKorekty` nizej.
   */
  async function wystawKorekte(payload) {
    const dane = await zapytaj('/v3/async/corrective_invoices.json', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, 'wystawienie korekty');
    return {
      referencja: dane?.invoice_task_reference_number ?? null,
      uuid: dane?.uuid ?? null,
      numer: dane?.number ?? null,
    };
  }

  /**
   * PDF dokumentu — do wydruku i do dysku.
   *
   * `zasob` jest parametrem, bo KOREKTA TO OSOBNY ZASÓB (`corrective_invoices`) — ten sam
   * uuid pod `/invoices/` oddaje 404 (sprawdzone 2026-08-01). Reszta zachowania jest
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

  // Sygnatura BEZ ZMIAN — wołają to `services/faktura.js` i `services/faktura-allegro.js`.
  const pobierzPdf = (uuid, typ) => pobierzPdfZasobu('invoices', uuid, typ);

  // ⚠️ KOREKTA TO OSOBNY ZASÓB — ten sam uuid pod /invoices/ oddaje 404 (sprawdzone 2026-08-01).
  const pobierzPdfKorekty = (uuid, typ = 'original') => pobierzPdfZasobu('corrective_invoices', uuid, typ);

  /**
   * Oznaczenie WYSTAWIONEJ faktury jako opłaconej — WYŁĄCZNIE po to, żeby jej wewnętrzny
   * `status` w inFakcie przestał mówić „nieopłacona".
   *
   * ⚠️ TO NIE MA NIC WSPÓLNEGO Z KSeF (patrz nagłówek pliku). To osobny zasób, a panel dalej
   * NIE WYSYŁA dokumentów do KSeF ani tu, ani nigdzie indziej.
   *
   * ⚠️ ZAKRES: to zmienia STATUS, a nie treść dokumentu. Kwota zapłaty jedzie na dokument
   * polem `paid_price` przy TWORZENIU (domain/termin-platnosci.js) i to działa — dokument
   * dla klienta drukuje „Zapłacono: 123,00 / Pozostało: 0,00". Zmierzone 2026-08-04 (notatka
   * `2026-08-04-infakt-daty-i-oplacenie-rozpoznanie.md`): ten zasób `left_to_pay` ani
   * `paid_price` NIE RUSZA. Dlatego są potrzebne OBA wywołania i żadne nie zastępuje drugiego:
   * tamto mówi prawdę KLIENTOWI, to mówi ją LIŚCIE FAKTUR W inFAKCIE.
   *
   * ⚠️ OPERACJA JEST ASYNCHRONICZNA. `201` znaczy „przyjęto zlecenie", a nie „oznaczono" —
   * inFakt oddaje referencję zadania (`invoice_task_reference_number`, `processing_code: 100`)
   * i przetwarza je w tle. Niczego tu nie odpytujemy w pętli i nikomu nie obiecujemy,
   * że status już się zmienił.
   *
   * `paid_date` jest w dokumentacji OPCJONALNA, ale musi być „nie wcześniejsza niż data
   * wystawienia" — datę wybiera USŁUGA (services/faktura.js), bo tylko ona zna obie daty.
   * Jej brak znaczy BRAK POLA, nigdy `undefined`.
   *
   * ⚠️ Ścieżka `/v3/async/invoices/{uuid}/paid.json` pochodzi z dokumentacji, ale została
   * POTWIERDZONA na żywym API 2026-08-04 (ta sama notatka: „Zwraca 201 i referencję zadania
   * […] status faktury zmienia się na `paid`"). Mimo to wołający MUSI traktować awarię jako
   * nieszkodliwą — patrz services/faktura.js.
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
   * ⚠️ TO JEST ODCZYT I MA NIM ZOSTAĆ. Panel nie wysyła do KSeF (patrz nagłówek pliku):
   * właściciel robi to sam, w ciągu dnia. Ta metoda tylko pyta, czy już zrobił.
   *
   * Kształt pola `ksef_number` zmierzony 05.08.2026 (notatka
   * `2026-08-05-allegro-zapis-rozpoznanie.md`): wypełnione dla dokumentów wysłanych do KSeF,
   * a PDF niesie ten numer w pierwszej linii dokumentu.
   *
   * ⚠️⚠️ DRUGI ODBIORCA OD ZADANIA 8 (services/korekta.js): pola SUROWE z API, pod nazwami
   * takimi, jakich używa sam inFakt (`number`, `invoice_date`, `uuid`, `services`) — nie
   * tłumaczone na polski jak `numer`/`ksefNumer` wyżej. Korekta odnosi się do stanu faktury
   * „TERAZ" w inFakcie (mogła zostać poprawiona ręcznie), więc `services` stąd — a nie
   * z pozycji zamówienia w naszej bazie — idzie do `paryKorekty` (domain/korekta-pozycje.js).
   * Nazwy pól `services` są te same, co przy WYSTAWIANIU faktury (`domain/pozycje-faktury.js`:
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
      // ⚠️ POTRZEBNE SKANOWI POBRAŃ (services/oznaczanie-pobran.js), a nie czuwaczowi KSeF.
      // `status` — żeby dokument oznaczony ręcznie w inFakcie wypadł z kandydatów zamiast
      // dostać drugie zlecenie (pomiar 28.08: `18/08/2026` jest `delivery` I `paid`).
      // `left_to_pay` — żeby rozstrzygał `stanZaplaty`, ta sama reguła co wszędzie indziej,
      // a nie drugi warunek dopisany na miejscu.
      status: dane?.status ?? null,
      left_to_pay: dane?.left_to_pay ?? null,
    };
  }

  // ⚠️⚠️ TU STAŁ `statusKsef(uuid)` — `GET /v3/ksef2/documents/{uuid}/status.json`, oddający
  // `status` ('sent' → 'success' albo 'error') i `status_description`. USUNIĘTY 06.08.2026
  // (recenzja całości, M1) i to jest DECYZJA, a nie sprzątanie z lenistwa. Metoda była
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
  //     przypadku: `NAJDLUZSZY_PRZEBIEG_MS` (services/czuwacz-ksef.js) urósłby z 54 min 10 s do
  //     ~104 min, czyli PONAD odstęp między tyknięciami zegara — a bootstrap.js odmawia wtedy
  //     startu panelu. Wpięcie „przy okazji" położyłoby panel przy starcie.
  //
  // CO MA SIĘ STAĆ, GDY TA WIEDZA BĘDZIE POTRZEBNA: osobne zadanie — kolumna na status i opis,
  // przeliczony budżet przebiegu (albo pytanie o status TYLKO dla dokumentów, które panel sam
  // wysłał i które czekają dłużej niż dobę), i dopiero wtedy metoda wraca. Adres i kształt pola
  // są zmierzone i zapisane tutaj, więc odtworzenie jej to kilka linii.

  /**
   * ⚠️⚠️ JEDYNE MIEJSCE W CAŁYM PANELU, KTÓRE WYSYŁA DOKUMENT DO KSeF — i operacja jest
   * NIEODWRACALNA. Dokumentu w KSeF nie da się skasować, zostaje wyłącznie korekta.
   *
   * Wolno ją wywołać WYŁĄCZNIE z trasy zatwierdzenia (services/wysylka-ksef.js), po ekranie
   * podglądu i po ponownym przeliczeniu zbioru. NIGDY z pollera, NIGDY z czuwacza, NIGDY
   * jako skutek uboczny wystawienia faktury — `wystaw()` wyżej dalej nie zna `send_to_ksef`
   * i znać nie ma.
   *
   * ⚠️⚠️ WYSYŁKA JEST PER DOKUMENT — TO SPROSTOWANIE, NIE DROBIAZG (07.08.2026). Do tego dnia
   * stało tu wywołanie WSADOWE (`POST /v3/ksef2/documents/send.json` z `{uuids: [...]}`),
   * zbudowane na hipotezie „jedno zgłoszenie, cała partia, wszystko albo nic". Hipoteza była
   * w tym pliku opisana jako niezweryfikowana — i okazała się BŁĘDNA: taki zasób nie istnieje,
   * a panel dostawał 404 przy każdej próbie („wysyłka FV do KSeF nie działa", zgłoszenie
   * właściciela).
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
   * Pętla i podział wyniku siedzą w services/wysylka-ksef.js.
   *
   * ⚠️ ODPOWIEDŹ ZNACZY „PRZYJĘTO ZLECENIE", A NIE „JEST W KSeF". Zmierzone na prawdziwym
   * dokumencie: `request_created_at` 13:27:05, `request_finished_at` 13:28:15 — siedemdziesiąt
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
    // zwolnienia rezerwacji (`jednoznacznaOdmowa` w services/wysylka-ksef.js) rozpoznaje
    // jednoznacznosc WYLACZNIE po statusie 4xx — a to jest odmowa NAJBARDZIEJ jednoznaczna
    // z mozliwych: do inFaktu nie poszlo NIC, wiec dokumentu u organu na pewno nie ma. Bez
    // tego tagu ta odmowa wygladalaby jak zerwane polaczenie (brak `status`) i trzymalaby
    // rezerwacje NA ZAWSZE za wywolanie, ktore nigdy nie opuscilo panelu.
    if (!czysty) {
      throw bladOperatora('Nie ma czego wysłać do KSeF — pusty identyfikator dokumentu.', { status: 400 });
    }
    // ⚠️ BEZ CIALA ZADANIA. Zmierzone sonda 07.08.2026: `POST` na te sciezke BEZ ciala
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
   * PRZ-093.10 — „Sprawdź połączenie” na ekranie Ustawienia → Integracje → inFakt.
   * Jedno `GET /v3/invoices.json?offset=0` — to samo żądanie, którym zaczyna się każda lista faktur
   * (`wszystkieStrony`, zmierzone 06.08.2026). Tylko odczyt: niczego nie wystawia ani nie wysyła do KSeF,
   * wynik nie niesie danych faktur.
   * Sukces wymaga liczbowego `metainfo.total_count` — strona pośrednika z HTTP 200 to nie „połączenie działa”.
   * ⚠️ Klucz API zastępowany w komunikacie: ten trafia na ekran, a inFakt mógłby odbić klucz w treści błędu.
   */
  async function sprawdzPolaczenie() {
    const bezKlucza = (tekst) => (apiKey ? String(tekst).split(String(apiKey)).join('[klucz API]') : String(tekst));
    let dane;
    try {
      dane = await zapytaj(adres('invoices', {}, 0), { method: 'GET' }, 'sprawdzenie połączenia');
    } catch (e) {
      if (e?.status === 401 || e?.status === 403) {
        throw bladOperatora(`inFakt nie przyjął klucza API (HTTP ${e.status}) — sprawdź, czy klucz jest skopiowany w całości `
          + `i aktywny w inFakcie (Ustawienia → API). Odpowiedź inFaktu: ${bezKlucza(e.message)}`, { status: e.status });
      }
      throw bladOperatora(bezKlucza(e?.message ?? 'inFakt nieosiągalny'), e?.status ? { status: e.status } : {});
    }
    const ile = Number(dane?.metainfo?.total_count);
    if (!Number.isFinite(ile) || ile < 0) {
      throw bladOperatora('inFakt odpowiedział, ale nie rozpoznaję odpowiedzi — to nie wygląda na API inFaktu.');
    }
    return { ok: true };
  }

  return {
    znajdzKlientaPoNip, zalozKlienta, wystaw, oznaczZaplacona, pobierzPdf, pobierzFakture,
    listaFaktur, listaKorekt, listaNieoplaconych, pobierzPdfKorekty, wyslijDokumentDoKsef,
    wystawKorekte, iluMaNumer, sprawdzPolaczenie,
  };
}

/** Nazwy metod klienta — pośrednik „inFakt z Ustawień” (moduly/faktury/infakt-ustawien.ts) wystawia te same. */
export const METODY_INFAKTU = Object.freeze([
  'znajdzKlientaPoNip', 'zalozKlienta', 'wystaw', 'oznaczZaplacona', 'pobierzPdf', 'pobierzFakture',
  'listaFaktur', 'listaKorekt', 'listaNieoplaconych', 'pobierzPdfKorekty', 'wyslijDokumentDoKsef',
  'wystawKorekte', 'iluMaNumer', 'sprawdzPolaczenie',
]);
