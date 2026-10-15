import { transport } from '../../integracje/transport.js';
import { kluczZCertyfikatu, zaszyfrujToken } from './szyfrowanie.js';
import { bladOperatora } from '../../domena/bledy.js';

// Klient KSeF v2 — CZESC UWIERZYTELNIAJACA.
//
// ⚠️⚠️ TEN MODUL WYLACZNIE CZYTA Z KSeF. Nie ma tu i nie ma prawa sie pojawic zadne
// wywolanie `POST /sessions/*` ani nic innego, co WYSYLA fakture. Wysylka mieszka
// w `services/wysylka-ksef.js` (przez inFakt) i tam zostaje. Dopisujac do tej fabryki
// kolejne metody (`pobierzMetadane`, `pobierzXml`) trzymamy sie tej granicy.
//
// ⚠️⚠️ CALY TEN PLIK OBRACA POSWIADCZENIAMI: token KSeF (wsad), token operacji, access
// token i refresh token. Zadne z nich NIE MA PRAWA trafic do komunikatu bledu, do logu
// ani na ekran (niezmiennik 4.10). Dlatego `blad()` nizej sklada tresc WYLACZNIE
// z odpowiedzi serwera i nie widzi domkniecia fabryki.

// Twardy limit JEDNEGO zadania. Sygnal jest NARZUCONY, a nie domyslny — wolajacy nie ma
// jak go po cichu skasowac (ta sama regula, co w kliencie inFaktu).
export const LIMIT_ZADANIA_MS = 60 * 1000;

export const BAZA_DOMYSLNA = 'https://api.ksef.mf.gov.pl/v2';

// ⚠️⚠️ DOMYSLNY `pageSize` W KSeF TO DZIESIEC. Zapytanie bez jawnego rozmiaru strony odda
// 10 faktur z czterdziestu — BEZ BLEDU, bez ostrzezenia, z poprawnie wygladajaca tabela.
// To ta sama mina, co ignorowany `limit` w kliencie inFaktu (patrz komentarz przy
// `STRONA_INFAKTU` w infakt/client.js) — tam serwer i tak wraca do 10 mimo zadania,
// tutaj serwer POSLUCHA, tylko trzeba go poprosic. Rozmiar strony ma JEDNO miejsce w
// kodzie i jest maksymalny z dokumentacji API (KSeF v2 dopuszcza do 250).
export const ROZMIAR_STRONY = 250;

// Status 100 znaczy „operacja w toku" — pytamy dalej. Kazdy inny konczy czekanie.
const STATUS_W_TOKU = 100;
const ODSTEP_PYTANIA_MS = 2000;
export const NAJWIECEJ_PYTAN = 30;

// ⚠️ NAJDLUZSZY MOZLIWY CZAS ODPYTYWANIA, a nie sama suma przerw. Kazde z 30 pytan ma
// WLASNY limit 60 s, wiec „czekamy 60 s" (tak stalo w komunikacie odmowy) zanizalo prawde
// trzydziestokrotnie. Miedzy pytaniami jest 29 przerw, a nie 30 — po ostatnim pytaniu nie
// ma juz na co czekac. Komunikat dla operatora liczy sie STAD, zeby nie klamal po zmianie
// ktorejkolwiek z tych stalych.
// ⚠️ EKSPORTOWANE, bo `bootstrap.js` liczy z tego straznik czasu przebiegu czuwacza kosztow
// (services/czuwacz-kosztow.js: NAJDLUZSZY_PRZEBIEG_KOSZTOW_MS). Przepisana kopia tej
// arytmetyki rozjechalaby sie z oryginalem przy pierwszej zmianie ktorejkolwiek ze stalych,
// i to po cichu — a od tej liczby zalezy, czy panel w ogole wstanie.
export const NAJDLUZSZE_ODPYTYWANIE_MS = NAJWIECEJ_PYTAN * LIMIT_ZADANIA_MS
  + (NAJWIECEJ_PYTAN - 1) * ODSTEP_PYTANIA_MS;

export function createKsefClient({
  token,
  nip,
  fetchImpl, http = transport({ fetchImpl, limitCzasuMs: LIMIT_ZADANIA_MS }),
  baseUrl = BAZA_DOMYSLNA,
  spij = (ms) => new Promise((r) => { setTimeout(r, ms); }),
}) {
  // ⚠️ `token` TO POSWIADCZENIE. Nie trafia do komunikatu bledu, do logu ani na ekran
  // (niezmiennik 4.10) — dlatego `blad()` sklada tresc WYLACZNIE z odpowiedzi serwera.
  // `traceId` z problem-details jest tu jedyna rzecza, po ktorej da sie cokolwiek
  // odszukac po stronie MF, wiec niesiemy go zawsze, gdy przyszedl.
  //
  // ⚠️ KAZDY blad tego modulu jest OTAGOWANY jako przeznaczony dla operatora
  // (`bladOperatora`, tak samo jak w kliencie inFaktu) — i to nie jest kosmetyka:
  // `komunikatDlaOperatora()` zamienia KAZDY nieotagowany blad na „blad techniczny panelu",
  // wiec bez tego znacznika starannie napisane zdania nizej („odbioru tokenow nie probowano",
  // „jednorazowy odbior zostal zuzyty") nigdy nie doszlyby do czlowieka przy panelu. Tresci
  // sklada sie tu WYLACZNIE z odpowiedzi serwera i ze stalych, wiec nie ma czego ukrywac.
  function blad(gdzie, res, dane) {
    const status = res?.status;
    const szczegol = dane?.detail || dane?.title || '';
    const trace = dane?.traceId ? ` (traceId ${dane.traceId})` : '';
    return bladOperatora(
      `KSeF odmówił przy ${gdzie}: HTTP ${status}${szczegol ? ` — ${szczegol}` : ''}${trace}`,
      { status, ...(status === 429 ? { retryAfterS: czasPonowienia(res, szczegol) } : {}) },
    );
  }

  /**
   * ⚠️⚠️ ILE SEKUND CZEKAC PO HTTP 429 — JEDYNA LICZBA, KTORA ZAMIENIA ODMOWE Z LIMITU
   * W PRZERWE ZAMIAST W AWARIE (ksef/limit.js).
   *
   * KSeF ogranicza pobieranie do 16 zadan na minute (zmierzone na produkcji 2026-09-02) i mowi
   * o tym DWOMA drogami, z ktorych zadna nie jest pewna: naglowkiem `Retry-After` albo zdaniem
   * w tresci odmowy („Sprobuj ponownie po 54 sekundach"). Naglowek ma pierwszenstwo, bo jest
   * standardem HTTP; tresc jest odczytem awaryjnym — na produkcji przyszla WLASNIE ona.
   *
   * ⚠️ ZNACZNIK NIESIEMY WYLACZNIE PRZY 429. Czas ponowienia dopisany do 404 albo 500 kazalby
   * wolajacemu czekac minute na odmowie, ktora nigdy sie sama nie naprawi.
   *
   * ⚠️ BRAK ODPOWIEDZI TO `null`, A NIE ZGADYWANIE — domyslne 60 s stoi w JEDNYM miejscu
   * (ksef/limit.js), zeby dwie domyslne wartosci nie rozjechaly sie po cichu.
   */
  function czasPonowienia(res, tresc) {
    // Atrapy `fetch` w testach czesto nie maja `headers` — a odczyt naglowka nie ma prawa
    // zamienic czytelnej odmowy KSeF-u w TypeError bez znacznika `dlaOperatora`.
    const zNaglowka = Number(res?.headers?.get?.('retry-after'));
    if (zNaglowka > 0) return zNaglowka;
    const zTresci = /po (\d+) sekund/.exec(tresc || '');
    return zTresci ? Number(zTresci[1]) : null;
  }

  /**
   * Jedno zadanie do KSeF. Ta funkcja jest WSPOLNA dla calego klienta — kolejne metody
   * odczytowe (metadane, XML) maja jechac przez nia, a nie dorabiac sobie drugiej sciezki
   * HTTP. Drugie miejsce skladajace naglowki to drugie miejsce, w ktorym da sie zgubic
   * `X-Error-Format` albo limit czasu.
   *
   * `bearer` jest PARAMETREM, a nie stala fabryki, bo w tej sekwencji zmienia sie trzy razy:
   * pierwsze dwa zadania nie maja zadnego, stan i redeem jada TOKENEM OPERACJI, a odswiezanie
   * refresh tokenem. Podstawienie tu tokena KSeF byloby cicha awaria uwierzytelnienia.
   */
  async function zapytaj(sciezka, {
    metoda = 'GET', bearer = null, cialo = null, gdzie,
  }) {
    let res;
    try {
      res = await http(`${baseUrl}${sciezka}`, {
        method: metoda,
        // Nowy sygnal na KAZDE zadanie — wspolny starzalby sie razem z procesem i po
        // godzinie pracy panelu przerywal kazde wywolanie natychmiast.
        signal: AbortSignal.timeout(LIMIT_ZADANIA_MS),
        headers: {
          'Content-Type': 'application/json',
          // ⚠️ BEZ TEGO NAGLOWKA diagnostyka opiera sie na tekscie komunikatu zamiast
          // na `traceId`. Ma go niesc KAZDE zadanie tego modulu — dlatego stoi tutaj,
          // a nie u wolajacego.
          'X-Error-Format': 'problem-details',
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        ...(cialo ? { body: JSON.stringify(cialo) } : {}),
      });
    } catch (e) {
      // Zerwane polaczenie NIE dostaje statusu: zadanie moglo dojsc i zostac przetworzone.
      // Przy `redeem` to rozroznienie jest krytyczne — patrz komentarz przy `zaloguj`.
      throw bladOperatora(`KSeF nieosiągalny przy ${gdzie}: ${e.message}`);
    }
    let dane = null;
    try { dane = await res.json(); } catch { dane = null; }
    if (!res.ok) throw blad(gdzie, res, dane);
    return dane;
  }

  /**
   * Pelna sekwencja uwierzytelnienia tokenem KSeF. Piec zadan, kolejnosc jest wiazaca:
   *
   *   1. `/security/public-key-certificates` — klucz publiczny MF (jako certyfikat),
   *   2. `/auth/challenge`                   — wyzwanie ORAZ `timestampMs`,
   *   3. `/auth/ksef-token`                  — zaszyfrowany token + NIP, oddaje token operacji,
   *   4. `/auth/{referenceNumber}`           — odpytywanie o stan, tokenem operacji,
   *   5. `/auth/token/redeem`                — para tokenow, tokenem operacji.
   *
   * ⚠️ KROK 5 DZIALA TYLKO RAZ. Para wraca jednym wynikiem i wolajacy ma ja zapisac jednym
   * zapisem — polowiczny zapis znaczy utracony refresh token i ponowne uwierzytelnianie.
   * Dlatego kroku 5 nie wolno wolac „na probe" ani ponawiac po zerwanym polaczeniu.
   */
  async function zaloguj() {
    const certy = await zapytaj('/security/public-key-certificates', { gdzie: 'pobieraniu kluczy MF' });
    // ⚠️ STRAZNIK KSZTALTU, a nie ozdoba. HTTP 200 z pusta lista (albo z czymkolwiek innym
    // niz lista) przechodzi przez `zapytaj` bez slowa, a odczyt `certy[0].certificate` wywala
    // sie wtedy TypeError-em „Cannot read properties of undefined" — komunikatem, ktory nie
    // mowi operatorowi ani co sie stalo, ani gdzie. Ta sama regula obowiazuje przy trzech
    // pozostalych odczytach nizej.
    if (!Array.isArray(certy) || !certy[0]?.certificate) {
      throw bladOperatora(
        'KSeF nie oddał certyfikatu klucza publicznego — bez niego nie ma czym zaszyfrować '
        + 'tokena i uwierzytelnienia nie rozpoczęto. Spróbuj ponownie za chwilę.',
      );
    }
    const klucz = kluczZCertyfikatu(certy[0].certificate);

    const ch = await zapytaj('/auth/challenge', { metoda: 'POST', gdzie: 'inicjalizacji uwierzytelnienia' });
    // ⚠️ TEN SAM STRAZNIK KSZTALTU, CO PRZY CERTYFIKACIE I PRZY ODPOWIEDZI KSEF-TOKEN, TYLKO
    // POMINIETY W POPRZEDNIEJ RUNDZIE. Bez niego `null` (pusta/niepoprawna tresc z `zapytaj`)
    // wywala sie TypeError-em „Cannot read properties of null" BEZ znacznika `dlaOperatora`,
    // wiec panel pokazalby „blad techniczny panelu" zamiast zdania, z ktorego cokolwiek wynika.
    // `{}` jest GORSZE: HTTP jest 200, `ch.challenge` i `ch.timestampMs` sa `undefined`, ale
    // zadanie do `/auth/ksef-token` i tak WYCHODZI — z `encryptedToken` zaszyfrowanym z ladunku
    // `TOKEN|undefined` zamiast prawdziwego czasu challenge'a.
    if (!ch?.challenge || typeof ch?.timestampMs !== 'number') {
      throw bladOperatora(
        'KSeF nie oddał poprawnego wyzwania (challenge lub znacznika czasu) — bez nich nie da się '
        + 'zaszyfrować tokena i uwierzytelnienia nie rozpoczęto. Spróbuj ponownie za chwilę.',
      );
    }

    const init = await zapytaj('/auth/ksef-token', {
      metoda: 'POST',
      gdzie: 'uwierzytelnianiu tokenem',
      cialo: {
        challenge: ch.challenge,
        contextIdentifier: { type: 'Nip', value: nip },
        // ⚠️ timestamp POCHODZI Z CHALLENGE'A — zadnego `Date.now()` na tej sciezce.
        // Wlasne liczenie czasu to trzecie miejsce w tym projekcie liczace strefe,
        // a dwa poprzednie sie wylozyly.
        encryptedToken: zaszyfrujToken({ klucz, token, timestampMs: ch.timestampMs }),
      },
    });

    // ⚠️ OBA POLA SA WYMAGANE i oba sprawdzamy PRZED pierwszym pytaniem o stan. Brak tokena
    // operacji wywalilby sie TypeError-em juz tutaj, a brak numeru referencyjnego byloby
    // GORZEJ: adres stanu zlozylby sie w `/auth/undefined` i poleciloby zadanie, ktore
    // niczego nie znaczy.
    if (!init?.authenticationToken?.token || !init?.referenceNumber) {
      throw bladOperatora(
        'KSeF nie oddał kompletu danych uwierzytelnienia (numeru referencyjnego lub tokena '
        + 'operacji) — sekwencji nie da się dokończyć. Tokenów nie odbierano. Spróbuj ponownie.',
      );
    }

    // ⚠️ OD TEGO MIEJSCA JEDZIEMY TOKENEM OPERACJI, nie tokenem KSeF. Token KSeF juz nigdzie
    // wiecej nie leci — poszedl wylacznie zaszyfrowany, w ciele kroku 3.
    const operacyjny = init.authenticationToken.token;

    let stan = null;
    for (let i = 0; i < NAJWIECEJ_PYTAN; i += 1) {
      stan = await zapytaj(`/auth/${init.referenceNumber}`, {
        bearer: operacyjny,
        gdzie: 'sprawdzaniu stanu uwierzytelnienia',
      });
      if (stan?.status?.code !== STATUS_W_TOKU) break;
      // Po OSTATNIM pytaniu nie ma juz na co czekac — kolejnego pytania nie bedzie, a przerwa
      // przed odmowa to dwie sekundy zmarnowane operatorowi.
      if (i < NAJWIECEJ_PYTAN - 1) await spij(ODSTEP_PYTANIA_MS);
    }

    // ⚠️ ODMOWA, A NIE „sprobujmy mimo to". Po `redeem` nizej idziemy WYLACZNIE przy ZNANYM
    // STANIE KONCOWYM — czyli gdy serwer podal liczbowy `status.code` rozny od 100. Kazdy inny
    // przypadek (brak odpowiedzi, pusta tresc, nie-JSON, `{}`, `status` bez `code`) to
    // „NIE WIADOMO", a `redeem` dziala TYLKO RAZ.
    //
    // ⚠️ WARUNEK JEST CELOWO ODWROCONY. Wczesniej stalo tu `if (code === STATUS_W_TOKU) odmow`,
    // czyli odmowa tylko wtedy, gdy serwer JAWNIE powiedzial 100. Ale `zapytaj` legalnie oddaje
    // `null` przy pustej albo niepoprawnej tresci — wtedy petla wyzej przerywala sie po
    // PIERWSZYM pytaniu, warunek nie zachodzil i klient szedl spalic jednorazowy `redeem` na
    // uwierzytelnieniu, o ktorym nie wiedzial NIC. Dokladnie ta awaria, przed ktora ten
    // straznik mial chronic. Domyslna odpowiedzia na „nie wiadomo" jest odmowa.
    //
    // ⚠️ NIEROZSTRZYGNIETE: co KSeF wpisuje w `status.code` przy uwierzytelnieniu, ktore
    // sie NIE POWIODLO (spodziewamy sie 4xx-owego kodu, ale nikt tego nie zmierzyl na zywym
    // API). Dzis kazdy LICZBOWY kod rozny od 100 traktujemy jak „skonczone" i idziemy po tokeny
    // — jesli to bledny odczyt, `redeem` odmowi i sekwencje trzeba bedzie powtorzyc. Do
    // rozstrzygniecia przy pomiarze na prawdziwym koncie (Zadanie 0).
    const kodStanu = stan?.status?.code;
    const znanyStanKoncowy = typeof kodStanu === 'number' && kodStanu !== STATUS_W_TOKU;
    if (!znanyStanKoncowy) {
      const opis = stan?.status?.description ? ` — ${stan.status.description}` : '';
      // ⚠️ Komunikat NIE MA KLAMAC O CZASIE. Stalo tu „w wyznaczonym czasie (60 s)", a realne
      // czekanie to 30 pytan po 60 s limitu plus przerwy — nawet ponad pol godziny. Operator,
      // ktory czyta „60 s", szuka awarii sieci zamiast czekac na MF.
      const powodStanu = kodStanu === STATUS_W_TOKU
        ? `KSeF nie potwierdził uwierzytelnienia — ${NAJWIECEJ_PYTAN} pytań o stan i wciąż `
          + `„w toku" (odpytywanie trwa nawet ~${Math.round(NAJDLUZSZE_ODPYTYWANIE_MS / 60000)} min)`
        : 'KSeF nie podał stanu uwierzytelnienia (odpowiedź bez pola status.code)';
      throw bladOperatora(
        `${powodStanu}${opis}. Odbioru tokenów nie próbowano — ta operacja działa tylko raz. `
        + 'Spróbuj ponownie za chwilę.',
      );
    }

    // ⚠️ JEDNORAZOWY STRZAL — wolany DOKLADNIE RAZ i nigdy automatycznie ponawiany.
    // Zerwane polaczenie tutaj znaczy „nie wiadomo, czy para zostala wydana", a nie
    // „nie wyszlo": ponowienie mogloby trafic na juz zuzyty zasob.
    const para = await zapytaj('/auth/token/redeem', {
      metoda: 'POST', bearer: operacyjny, gdzie: 'odbieraniu tokenów',
    });

    // ⚠️⚠️ NAJDROZSZY STRAZNIK W TYM PLIKU. Tu HTTP jest 200, wiec `zapytaj` przepuszcza
    // tresc, a `para.accessToken.token` na odpowiedzi bez `accessToken` wywala sie TypeError-em
    // „Cannot read properties of undefined" — w chwili, gdy JEDNORAZOWY odbior JUZ SIE SPALIL.
    // Wolajacy nie dowiedzialby sie ani co sie stalo, ani ze po ten sam zasob nie ma juz po co
    // siegac. Komunikat ma powiedziec OBIE te rzeczy — dlatego mowi wprost o zaczynaniu od nowa.
    if (!para?.accessToken?.token || !para?.refreshToken?.token) {
      throw bladOperatora(
        'KSeF oddał niekompletną parę tokenów przy odbiorze. Jednorazowy odbiór został już '
        + 'zużyty, więc całą sekwencję uwierzytelnienia trzeba przeprowadzić od nowa.',
      );
    }

    // Para wraca RAZEM, zeby wolajacy mogl ja zapisac jednym zapisem.
    return {
      accessToken: para.accessToken.token,
      accessDo: para.accessToken.validUntil,
      refreshToken: para.refreshToken.token,
      refreshDo: para.refreshToken.validUntil,
    };
  }

  /**
   * Odswiezenie access tokena. ⚠️ Jedzie REFRESH TOKENEM w `Authorization` — nie tokenem
   * KSeF i nie wygaslym access tokenem. Oddaje SAM access token: refresh token sie tu nie
   * zmienia, wiec nie ma czego nadpisywac u wolajacego.
   */
  async function odswiez(refreshToken) {
    const dane = await zapytaj('/auth/token/refresh', {
      metoda: 'POST', bearer: refreshToken, gdzie: 'odświeżaniu tokena',
    });
    // Ten sam straznik ksztaltu, co przy odbiorze pary: HTTP 200 z odpowiedzia bez
    // `accessToken` dalby TypeError zamiast zdania, z ktorego cokolwiek wynika.
    if (!dane?.accessToken?.token) {
      throw bladOperatora(
        'KSeF nie oddał nowego access tokena przy odświeżaniu — dostęp trzeba uzyskać pełną '
        + 'sekwencją uwierzytelnienia tokenem KSeF.',
      );
    }
    return { accessToken: dane.accessToken.token, accessDo: dane.accessToken.validUntil };
  }

  /**
   * Metadane faktur, na ktorych jestesmy NABYWCA — serce zakladki kosztowej. Filtruje po
   * `subjectType: 'Subject2'` (podmiot 2 = nabywca w schemacie zapytan KSeF) i po dacie
   * TRWALEGO ZAPISU (`dateType: 'PermanentStorage'`), bo to ona jest niezmienna raz nadana —
   * data wystawienia na fakturze to tresc kontrahenta, nie fakt po naszej stronie.
   *
   * ⚠️⚠️ `pageSize` JEST NARZUCONY NA `ROZMIAR_STRONY`, wolajacy nie ma jak go pominac ani
   * podac wlasnego — dokladnie tak samo, jak `LIMIT_ZADANIA_MS` w `zapytaj` wyzej. Gdyby
   * podanie rozmiaru bylo opcjonalne, pierwsze wywolanie „dajcie mi faktury za maj" wrocilo
   * z cicho obcieta strona i nikt by tego nie zauwazyl, dopoki ktos nie policzylby wierszy
   * recznie.
   *
   * `pageOffset` to numer STRONY (nie offset w wierszach) — tak nazywa to KSeF w swoim API
   * i tak przekazuje wolajacy: usluga iterujaca po stronach ma inkrementowac `pageOffset`
   * o 1, a nie o `ROZMIAR_STRONY`.
   *
   * Sortowanie rosnaco (`sortOrder=Asc`) jest CELOWE: usluga wolajaca ma budowac kursor
   * przyrostowy „od ostatnio widzianej daty w gore", a malejace sortowanie zmuszaloby ja
   * do przewijania calej historii przy kazdym odswiezeniu.
   */
  async function pobierzMetadane({
    accessToken, from, to, pageOffset = 0,
  }) {
    const dane = await zapytaj(
      `/invoices/query/metadata?pageSize=${ROZMIAR_STRONY}&pageOffset=${pageOffset}&sortOrder=Asc`,
      {
        metoda: 'POST',
        bearer: accessToken,
        gdzie: 'pobieraniu metadanych faktur',
        cialo: {
          // Subject2 = podmiot 2, czyli NABYWCA. My kupujemy — to jest cala definicja
          // „faktury kosztowej" w tym module.
          subjectType: 'Subject2',
          dateRange: { dateType: 'PermanentStorage', from, to },
        },
      },
    );
    // ⚠️ STRAZNIK KSZTALTU, TA SAMA REGULA CO PRZY CERTYFIKACIE I PARZE TOKENOW WYZEJ — ALE
    // TYLKO DLA `invoices`. HTTP 200 z cialem bez `invoices` przechodzi przez `zapytaj` bez
    // slowa: bez tego straznika `dane.invoices ?? []` zamienilby brakujaca tablice w PUSTA
    // LISTE, a na ekranie kosztow to wyglada IDENTYCZNIE jak naprawde pusty miesiac. Tego
    // rozroznic nie da sie inaczej, wiec milczenie tu jest gorsze niz odmowa.
    //
    // ⚠️ ASYMETRIA JEST CELOWA. `hasMore: false` to NORMALNY stan koncowy KAZDEGO nocnego
    // przebiegu (ostatnia strona, brak nowych faktur) — a wiele API pomija w JSON-ie pole,
    // ktore w danym kontekscie nie ma zastosowania (`isTruncated` ma sens tylko przy
        // `hasMore: true`). Gdyby KSeF tak robil, twardy wymog obu znacznikow kazalby
    // odmawiac na OSTATNIEJ stronie kazdego przebiegu — czyli kazdej nocy bez nowych faktur.
    // Tego zachowania NIE ZMIERZONO na zywym API (Zadanie 0 wciaz przed nami), wiec dzis nie
    // wolno zakladac ostrzejszego kontraktu, niz naprawde wiemy. Dlatego brakujace albo
    // niebulowskie `hasMore`/`isTruncated` schodza do bezpiecznego `false`, a nie do odmowy.
    // Po pomiarze na zywym koncie: jesli KSeF zawsze oddaje oba pola, ten straznik mozna
    // zaostrzyc z powrotem do wymogu jawnej wartosci bulowskiej.
    if (!Array.isArray(dane?.invoices)) {
      throw bladOperatora(
        'KSeF nie oddał poprawnej listy faktur (brak tablicy faktur) — panel nie pokaże '
        + 'listy, której nie umie policzyć. Spróbuj ponownie.',
      );
    }
    // ⚠️⚠️ KSZTALT KAZDEJ POZYCJI, A NIE TYLKO SAMEJ TABLICY (recenzja, D3). Element, ktory nie
    // jest obiektem (`null`, liczba, napis, tablica), wywalal sie dopiero w `naWiersz` GOLYM
    // `TypeError`-em — czyli BEZ znacznika `dlaOperatora`. Skutki byly trzy naraz: kwarantanna
    // takiego bledu NIE PRZYJMUJE (przyjmuje wylacznie odmowy opisane dla czlowieka), przebieg
    // padal, kursor stal — i tak co noc, z komunikatem „blad techniczny panelu", z ktorego nie
    // wynika ani co sie stalo, ani gdzie.
    //
    // DLACZEGO TU, A NIE KWARANTANNA W CZUWACZU (rozwazona alternatywa). Kwarantanna adresuje
    // dokumenty NUMEREM KSeF i bez niego odmawia glosno (db/koszty.js) — a pozycja, ktora nie
    // jest nawet obiektem, numeru nie ma i miec nie moze. Odlozenie „czegos" bez adresu to
    // dokladnie ta kwarantanna rosnaca w nieskonczonosc, przed ktora broni `PRIMARY KEY NOT
    // NULL` w schemacie. Poza tym ksztalt ODPOWIEDZI jest faktem o odpowiedzi, a nie o jednym
    // dokumencie, wiec ma jedno miejsce — to samo, w ktorym stoi straznik tablicy `invoices`
    // wyzej. Oba warianty i tak konczylyby przebieg; ten oddaje przy tym zdanie dla czlowieka.
    const zla = dane.invoices.findIndex((f) => f === null || typeof f !== 'object' || Array.isArray(f));
    if (zla !== -1) {
      throw bladOperatora(
        `KSeF oddał listę faktur, w której pozycja nr ${zla + 1} nie jest dokumentem `
        + `(${Array.isArray(dane.invoices[zla]) ? 'tablica' : typeof dane.invoices[zla]}). `
        + 'Panel nie zgadnie, czego brakuje na tej pozycji, więc nie zapisze CAŁEJ strony — '
        + `kursor stoi, a strona (${from} → ${to}, offset ${pageOffset}) pojedzie ponownie.`,
      );
    }
    // ⚠️⚠️ ZEJSCIE DO `false` ZOSTAJE, ALE PRZESTAJE BYC NIEWIDOCZNE (recenzja, W3). Brakujace
    // `hasMore` konczy okno pobrania DOKLADNIE tak samo, jak prawdziwy koniec danych — a jesli
    // KSeF pomija to pole na stronie MAJACEJ nastepniki, ogon okna nie zostaje przeczytany
    // nigdy, bo kursor przeskakuje go razem z ostatnim oknem. To ta sama dziura, ktora
    // naprawiono dla sufitu stron, tylko z innego wyzwalacza.
    //
    // Klient jest JEDYNYM miejscem, ktore wie, ze wartosc zostala zgadnieta (wyzej juz jej
    // nie widac), wiec to on nazywa skutek: KONIEC OKNA JEST NIEPEWNY. Co z tym zrobic,
    // rozstrzyga czuwacz — i dzis nie wchodzi wtedy w okna nastepne.
    //
    // ⚠️⚠️ NIEPEWNOSC WYMAGA OBU WARUNKOW: braku `hasMore` ORAZ PELNEJ STRONY. Strona krotsza
    // niz `ROZMIAR_STRONY` (w tym pusta) nastepnika miec nie moze — serwer oddajacy 12 pozycji
    // z zadanych 250 powiedzial tym samym, ze nic wiecej nie ma. Bez tego drugiego warunku
    // KAZDA zwyczajna noc bez nowych faktur (pusta strona, `hasMore` pominiete jako
    // niemajace zastosowania) zapalalaby ostrzezenie o przerwanym pobraniu — a trwale
    // czerwony pasek przestaje cokolwiek znaczyc i przykrywa NASTEPNA, prawdziwa awarie.
    // To jest ta sama lekcja, co przy `zapiszBladPobrania` (db/koszty.js), i cena za nia
    // bylaby tu placona co noc.
    //
    // Do rozstrzygniecia na zywym koncie (Zadanie 0): jesli KSeF zawsze oddaje `hasMore`,
    // ten znacznik jest zawsze `false` i caly straznik mozna wtedy zaostrzyc z powrotem
    // do wymogu jawnej wartosci bulowskiej.
    //
    // `isTruncated` osobnego znacznika nie potrzebuje: ma znaczenie WYLACZNIE przy
    // `hasMore: true`, a wtedy zejscie do `false` daje zwykla kolejna strone, czyli petle
    // z dokumentacji MF, a nie przedwczesny koniec.
    const hasMorePodany = typeof dane.hasMore === 'boolean';
    const hasMore = hasMorePodany ? dane.hasMore : false;
    const isTruncated = typeof dane.isTruncated === 'boolean' ? dane.isTruncated : false;
    const koniecNiepewny = !hasMorePodany && dane.invoices.length >= ROZMIAR_STRONY;
    return {
      faktury: dane.invoices, hasMore, isTruncated, koniecNiepewny,
    };
  }

  /**
   * Oryginalny XML faktury z KSeF (services/archiwum-kosztow.js). ⚠️ NIE PRZEZ `zapytaj` —
   * tamta funkcja parsuje KAZDA odpowiedz jako JSON i na dokumencie XML oddalaby `null`,
   * gubiac cala tresc. Ta sama pulapka, co przy PDF-ach w infakt/client.js. Naglowek
   * i limit czasu zostaja te same, co w reszcie klienta — inny jest tylko odczyt (`res.text()`
   * zamiast `res.json()`).
   */
  async function pobierzXml({ accessToken, ksefNumber }) {
    let res;
    try {
      res = await http(`${baseUrl}/invoices/ksef/${encodeURIComponent(ksefNumber)}`, {
        method: 'GET',
        signal: AbortSignal.timeout(LIMIT_ZADANIA_MS),
        headers: { 'X-Error-Format': 'problem-details', Authorization: `Bearer ${accessToken}` },
      });
    } catch (e) {
      throw bladOperatora(`KSeF nieosiągalny przy pobieraniu dokumentu ${ksefNumber}: ${e.message}`);
    }
    const tresc = await res.text();
    if (!res.ok) {
      // Blad na tej sciezce wciaz przychodzi jako problem-details JSON (naglowek zadania go
      // wymusza) — sam DOKUMENT jest tym, co idzie surowym tekstem, wylacznie przy sukcesie.
      let dane = null;
      try { dane = JSON.parse(tresc); } catch { dane = null; }
      throw blad(`pobieraniu dokumentu ${ksefNumber}`, res, dane);
    }
    // ⚠️ TEN SAM STRAZNIK KSZTALTU, CO PRZY CERTYFIKACIE I CHALLENGE'U WYZEJ. HTTP 200 z pusta
    // trescia przechodzi bez slowa i archiwum dostalby pusty plik — nieodroznialny od prawdziwego
    // dokumentu, dopoki ktos go recznie nie otworzy na NAS-ie.
    if (!tresc) {
      throw bladOperatora(
        `KSeF oddał pustą odpowiedź przy pobieraniu dokumentu ${ksefNumber} — nie ma czego `
        + 'zapisać w archiwum. Spróbuj ponownie.',
      );
    }
    return tresc;
  }

  return {
    zaloguj, odswiez, pobierzMetadane, pobierzXml,
  };
}
