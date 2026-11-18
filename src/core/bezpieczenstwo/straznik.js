// Strażnik wejścia. Wspólny dla obu paneli (indywidualnego i OMS): przepuszcza ważne CIASTECZKO SESJI albo poprawny BASIC AUTH.
//
// ⚠️ DLACZEGO OBA ZAMKI, A NIE WYMIANA JEDNEGO NA DRUGI. Basic Auth zostaje z dwóch
// niezależnych powodów, z których każdy sam wystarcza:
//   1. Panel zamówień indywidualnych loguje się do OMS-u właśnie nim („Dodaj do OMS”,
//      zmienne OMS_USER i OMS_PASS z `.env`). Zdjęcie Basic Auth złamałoby tę
//      integrację po cichu — przy pierwszym prawdziwym zamówieniu klienta.
//   2. Setki plików testowych składają nagłówek `Basic` wprost w treści
//      bez wspólnego helpera. Wymiana zamka oznaczałaby ręczne ruszenie ich wszystkich
//      przy okazji zmiany uwierzytelniania — czyli najlepszy znany sposób, żeby testy
//      przestały czegokolwiek pilnować.
//
// Co się zmienia dla człowieka: przeglądarka BEZ ciasteczka i BEZ nagłówka dostaje
// przekierowanie na /login zamiast odpowiedzi 401. To jest cała różnica między naszym
// ekranem a systemowym okienkiem Chrome — okienko rysuje przeglądarka w odpowiedzi na 401
// i nie da się go ostylować ani ominąć inaczej niż nie odpowiadając 401.
//
// ⚠️⚠️ UPRAWNIENIA PER EKRAN są WSTRZYKIWANE parametrem `konta`,
// nie wbudowane na sztywno. Panel zamówień indywidualnych kont NIE MA i NIE MA MIEĆ —
// woła tego strażnika bez tego parametru i zostaje na jednym haśle z `.env`.
// OMS woła go z `konta` i dopiero wtedy strażnik sprawdza ptaszki konta z tabeli oraz degraduje konto
// serwisowe z `.env` w zależności od tego, czy w bazie jest już czynny administrator.

import { sprawdz, zNaglowka, wartoOdswiezyc, podpisz, ciasteczkoSesji, ciasteczkoWyczyszczenia } from './sesja.js';
import { odczytajSekret } from './sekret-sesji.js';
import { czyTrasaOtwarta, polaczenieBezpieczne } from './logowanie-wspolne.js';
import { bezpiecznyPowrot } from './powrot.js';
import { ekranDlaAdresu, czyTrasaMaszynowa, maDostepDoEkranu, EKRANY } from '../../domena/ekrany.js';
import { motywZNaglowka } from '../../domena/motyw.js';
import { hamulecLogowaniaDla } from './hamulec.js';
import { dopiszLogowanie } from './konta.js';
import { sciezkaWidoku } from '../web/widoki.js';
import { rozbierzNaglowek, skrotKlucza, ZAKRESY_API } from '../../domena/klucze-api.js';
import { kluczPoSkrocie, odnotujUzycie } from './klucze-api.js';

const METODY_NAWIGACJI = ['GET', 'HEAD'];

/**
 * @param basicAuth hak z @fastify/basic-auth (app.basicAuth) — wstrzykiwany, a nie
 *   sięgany z `app` w środku, żeby dało się go w teście zastąpić atrapą.
 * @param konta `{ kontoPoLoginie, czyIstniejeCzynnyAdmin, loginSerwisowy }` albo
 *   `null`. ⚠️ `null` NIE JEST TRYBEM AWARYJNYM — to panel zamówień indywidualnych,
 *   który zostaje na jednym haśle z `.env`. Brak wstrzykniętej
 *   zależności, a nie gałąź `if (tryb === 'stary')` w środku: gałąź żyłaby tu na zawsze,
 *   a nikt by nie wiedział, która z dwóch ścieżek jest sprawdzana testami.
 *   ⚠️ Pola `usluga` strażnik nie czyta: dziennik logowań dostaje stałą `'oms'` (tutaj, przy blokadzie
 *   Basic, i w `logowanie.js`). `usluga` podawane w `konta` przez core/web/pipeline.js nic nie konfiguruje.
 */
export function zbudujStraznika({
  basicAuth,
  db,
  nazwaCiasteczka,
  konta = null,
  klucze = null,
  odlozoneEkrany = () => [],
}) {
  // Panel indywidualny nie wstrzykuje tego odczytu; blokada dotyczy tylko OMS.
  const sprawdzModul = (req, reply) => {
    const ekran = ekranDlaAdresu(sciezkaZdekodowana(req.url) ?? req.url);
    if (!odlozoneEkrany().includes(ekran)) return false;
    reply.code(404).view(sciezkaWidoku('modul-wylaczony.ejs'), {
      title: 'Moduł wyłączony',
      wlasnyUklad: true,
      motyw: motywZNaglowka(req.headers.cookie),
      admin: req.konto?.admin === true,
    });
    return true;
  };
  if (konta) konta = { ...konta, sprawdzModul };
  const hamulec = hamulecLogowaniaDla(db);
  // Klucz API wstrzykuje tylko OMS (`{ db, limit }`); panel indywidualny woła bez `klucze` i /api/v1 nie zna.
  const uzyciaKluczy = new Map();
  // IP -> koniec okna blokady, dla której 429 już trafiło do dziennika (jeden wiersz na blokadę, nie na żądanie).
  const zapisaneBlokady = new Map();
  return async function straznik(req, reply) {
    if (czyTrasaOtwarta(req.url)) return;
    // ⚠️ Na /api/v1 WYŁĄCZNIE klucz: ciasteczko i Basic nie są tu sprawdzane. Router Fastify DEKODUJE %XX
    // w ścieżce (`/api/v%31/ja` = /api/v1/ja), dlatego czyAdresApiV1 porównuje ścieżkę zdekodowaną.
    // `..`, `./` i `//` router zostawia bez zmian, więc nie trzeba ich zrównywać. Druga warstwa: hak onRequest
    // pluginu /api/v1 odmawia 401 każdemu żądaniu bez req.kluczApi.
    if (klucze && czyAdresApiV1(req.url)) return dopuscKluczem(req, reply, klucze, uzyciaKluczy, zapisaneBlokady);
    // Kolejki druku przyjmują TAKŻE klucz z zakresem `druk` (obok Basic serwisu).
    // Ścieżka zdekodowana jak przy /api/v1 (router dekoduje %XX). Wybór po samym schemacie `Bearer`: zły klucz idzie
    // ścieżką klucza (401 kod klucz, licznik limit-api), a nie do hamulca logowania wspólnego z formularzem.
    // Klucz na każdym innym adresie panelu nie trafia tutaj — idzie ścieżka Basic i dostaje 401.
    if (klucze && czyBearer(req.headers.authorization) && czyTrasaMaszynowaZdekodowana(req.url)) {
      const odmowa = dopuscKluczem(req, reply, klucze, uzyciaKluczy, zapisaneBlokady, 'druk');
      if (odmowa) return odmowa;
      if (konta?.sprawdzModul(req, reply)) return reply;
      return;
    }

    // ⚠️ Sam ODCZYT, nigdy zakładanie. Strażnik chodzi przy każdym żądaniu, a zapis w tej
    // ścieżce zamieniałby bazę chwilowo niezapisywalną (pełny dysk) w panel oddający 500
    // na każdej stronie. Sekret zakłada się RAZ, przy budowie serwera.
    // Brak sekretu = brak ważnej sesji: `sprawdz` z pustym sekretem odmawia (fail closed).
    const sekret = odczytajSekret(db);
    const sesja = sprawdz(zNaglowka(nazwaCiasteczka, req.headers.cookie), sekret);

    if (sesja) {
      if (!konta) {
        odnowSesje(req, reply, sesja, sekret, nazwaCiasteczka);
        return;
      }
      return dopuscZalogowanego(req, reply, konta, sesja, sekret, nazwaCiasteczka);
    }

    const maNaglowek = typeof req.headers.authorization === 'string' && req.headers.authorization !== '';
    const toNawigacja =
      METODY_NAWIGACJI.includes(String(req.method).toUpperCase()) &&
      String(req.headers.accept ?? '').includes('text/html');

    // ⚠️ Przekierowanie WYŁĄCZNIE dla wejścia przeglądarki na stronę. Żądanie z nagłówkiem
    // `Authorization` (panel indywidualny, skrypt, curl) ma dalej dostać 401 albo przejść —
    // odesłanie go na ekran logowania zamieniałoby czytelną odmowę w stronę HTML,
    // którą wołający uznałby za powodzenie.
    if (!maNaglowek && toNawigacja) {
      const powrot = bezpiecznyPowrot(req.url);
      return reply.redirect(`/login?powrot=${encodeURIComponent(powrot)}`);
    }

    // @fastify/basic-auth jest hakiem w stylu `done(err)`. Zawijamy go w obietnicę, żeby
    // dołożyć do niego warunek wyżej — a odmowę zostawiamy jego własnej obsłudze, bo to
    // ona dokleja nagłówek `WWW-Authenticate` i właściwy kod 401.
    // Pipeline HTTP uruchamia wiele haków zanim callback Basic Auth odnotuje błąd.
    // Wspólna z formularzem kolejka obejmuje walidację, zapis wyniku i karę.
    const naglowek = String(req.headers.authorization ?? '');
    const zakodowane = /^Basic\s+(\S+)\s*$/i.exec(naglowek)?.[1];
    const dane = zakodowane ? Buffer.from(zakodowane, 'base64').toString('utf8') : '';
    const dwukropek = dane.indexOf(':');
    const login = dwukropek >= 0 ? dane.slice(0, dwukropek) : '';
    const zwolnij = await hamulec.zajmij(req, login);
    if (!zwolnij)
      return reply.code(429).header('Retry-After', 2).send('Za dużo prób logowania, spróbuj ponownie później');
    try {
      const zapiszBlokade = () => {
        // Panel bez tabeli kont nie ma dziennika OMS.
        if (konta && hamulec.zapiszBlokadeRaz(req.ip, login))
          dopiszLogowanie(db, {
            login,
            usluga: 'oms',
            ip: req.ip,
            wynik: 'zablokowane',
          });
      };
      const odmowLimit = (limit) =>
        reply
          .code(429)
          .header('Retry-After', Math.ceil(limit.zostaloMs / 1000))
          .send('Za dużo prób logowania, spróbuj ponownie później');
      const limit = hamulec.sprawdzPrzedProba(req, login);
      if (!limit.wolno) {
        zapiszBlokade();
        return odmowLimit(limit);
      }
      try {
        await new Promise((resolve, reject) => {
          basicAuth(req, reply, (err) => (err ? reject(err) : resolve()));
        });
      } catch (err) {
        // Nie liczymy braku danych logowania; autoryzacja ekranów jest poza tym catch.
        if (maNaglowek) {
          const poBledzie = hamulec.odnotujBlad(req.ip, login);
          if (!poBledzie.wolno) {
            zapiszBlokade();
            await hamulec.opoznij(req.ip, login, Date.now(), hamulec.wiarygodnyAdres(req));
            return odmowLimit(poBledzie);
          }
        }
        throw err;
      }
      hamulec.wyczysc(req.ip, login);
    } finally {
      zwolnij();
    }

    if (!konta) return;
    // Basic Auth przeszło, więc to konto SERWISOWE z `.env` — innych tam nie ma.
    return dopuscSerwisowe(req, reply, konta);
  };
}

/**
 * ⚠️ Porównujemy ścieżkę ZDEKODOWANĄ: router (find-my-way) dekoduje %XX przed dopasowaniem trasy, więc
 * `/api/v%31/ja` trafia do trasy /api/v1/ja. decodeURIComponent dekoduje więcej niż router (także %2F), czyli
 * w razie różnicy uznaje za API więcej adresów, nigdy mniej. Złe kodowanie (np. `%zz`) = API: wymagamy klucza
 * (zawodzimy zamknięciem). Wielkość liter rozróżniana jak w routerze (`/API/v1` to nie API i nie trasa API).
 */
export function czyAdresApiV1(url) {
  const sciezka = sciezkaZdekodowana(url);
  if (sciezka === null) return true;
  return sciezka === '/api/v1' || sciezka.startsWith('/api/v1/');
}

/** Ścieżka bez zapytania, zdekodowana jak w routerze; `null` = złe kodowanie (każdy wołający sam wybiera stronę zamknięcia). */
function sciezkaZdekodowana(url) {
  const surowa = String(url ?? '').split(/[?#]/)[0];
  try {
    return decodeURIComponent(surowa);
  } catch {
    return null;
  }
}

/**
 * Czy adres to kolejka druku (`czyTrasaMaszynowa`) po zdekodowaniu — `/kolejka%2Ddruku` = `/kolejka-druku`.
 * Złe kodowanie = nie kolejka: żądanie idzie ścieżką Basic, czyli klucz go nie otwiera.
 * ⚠️ Zdekodowany `?` (%3F) nie może skrócić ścieżki do prefiksu kolejki — sprawdzamy całą zdekodowaną ścieżkę.
 */
export function czyTrasaMaszynowaZdekodowana(url) {
  const sciezka = sciezkaZdekodowana(url);
  if (sciezka === null || /[?#]/.test(sciezka)) return false;
  return czyTrasaMaszynowa(sciezka);
}

const czyBearer = (naglowek) => typeof naglowek === 'string' && /^\s*Bearer(\s|$)/i.test(naglowek);

const ODMOWA_KLUCZA = { kod: 'klucz', powod: 'Brak, zły albo odwołany klucz API.' };
const ODSTEP_UZYCIA_MS = 60_000;

function odmowaLimitu(reply, zostaloMs, powod) {
  return reply
    .code(429)
    .header('Retry-After', String(Math.max(1, Math.ceil(zostaloMs / 1000))))
    .send({ kod: 'limit', powod });
}

/**
 * Wejście kluczem `Authorization: Bearer toms_…`. W bazie jest tylko sha256 klucza; szukamy po
 * skrócie (UNIQUE), klucza wprost nie porównujemy.
 * ⚠️ Bez hamulca logowania (`hamulec.js`): jego licznik IP jest wspólny z formularzem i szereguje żądania —
 * czuwacz z odwołanym kluczem zablokowałby logowanie hasłem z tego komputera. Zgadywanie kluczy hamuje
 * własny `limit` (limit-api.js) — 20 nieudanych prób z IP w 60 s blokuje ten IP na wejściu kluczem (/api/v1
 * i Bearer na kolejkach druku; Basic i formularz bez zmian) do końca okna, a trafiony klucz ma 120 wywołań na okno.
 * 401 bez `WWW-Authenticate` (to nie jest Basic). Wpis 401 i 429 do dziennika robi hak `onResponse` pluginu API
 * (tylko /api/v1 — kolejki druku nie są w tym pluginie i do dziennika API nie idą).
 * `zakres` (kolejki druku): wymagany zakres klucza; brak → 403 `brak_zakresu`, jak `wymagajZakresu` w module api.
 * Zwraca `reply` przy odmowie, `undefined` przy wpuszczeniu.
 */
function dopuscKluczem(req, reply, { db, limit }, uzycia, zapisaneBlokady, zakres = null) {
  const teraz = Date.now();
  const blokadaIp = limit.zablokowanyIp(req.ip, teraz);
  if (!blokadaIp.wolno) {
    // Zablokowany czuwacz pyta dalej co sekundę; do dziennika idzie tylko pierwsza odmowa w tym oknie blokady.
    const koniecBlokady = teraz + blokadaIp.zostaloMs;
    if (zapisaneBlokady.get(req.ip) === koniecBlokady) {
      req.bezWpisuDoDziennikaApi = true;
    } else {
      if (zapisaneBlokady.size >= 10_000) {
        for (const [ip, koniec] of zapisaneBlokady) if (koniec <= teraz) zapisaneBlokady.delete(ip);
        while (zapisaneBlokady.size >= 10_000) zapisaneBlokady.delete(zapisaneBlokady.keys().next().value);
      }
      zapisaneBlokady.set(req.ip, koniecBlokady);
    }
    return odmowaLimitu(reply, blokadaIp.zostaloMs, 'Za dużo nieudanych prób klucza z tego adresu.');
  }
  const klucz = rozbierzNaglowek(req.headers.authorization);
  const wiersz = klucz ? kluczPoSkrocie(db, skrotKlucza(klucz)) : null;
  if (!wiersz || wiersz.odwolany_at || czyWygasl(wiersz.wygasa_at, teraz)) {
    // Każda nieudana próba się liczy, także brak nagłówka: program bez klucza to też błąd konfiguracji.
    limit.odnotujZly(req.ip, teraz);
    return reply.code(401).send(ODMOWA_KLUCZA);
  }
  // Ustawiane przed limitem, żeby wpis 429 w dzienniku miał klucz_id.
  req.kluczApi = {
    id: wiersz.id,
    nazwa: wiersz.nazwa,
    prefiks: wiersz.prefiks,
    zakresy: new Set(ZAKRESY_API.filter((z) => wiersz.zakresy.includes(z))),
  };
  const wywolania = limit.sprawdz(wiersz.id, teraz);
  if (!wywolania.wolno)
    return odmowaLimitu(reply, wywolania.zostaloMs, 'Za dużo wywołań tym kluczem, spróbuj za chwilę.');
  // Opakowanie tras (pipeline.js) wpisuje `req.konto.imie` do dziennika zmian. Pusty zbiór uprawnień i admin
  // false = klucz nie otwiera żadnego ekranu, nawet gdyby kiedyś trafił poza /api/v1.
  req.konto = {
    imie: `klucz: ${wiersz.nazwa}`,
    login: `klucz:${wiersz.prefiks}`,
    rola: 'klucz-api',
    admin: false,
    serwisowe: false,
    kluczApi: true,
    uprawnienia: new Set(),
  };
  const ostatnio = uzycia.get(wiersz.id);
  if (ostatnio === undefined || teraz - ostatnio >= ODSTEP_UZYCIA_MS) {
    uzycia.set(wiersz.id, teraz);
    // Zapis w strażniku nie może zamienić chwilowo niezapisywalnej bazy w 500 na każdym wywołaniu API.
    try {
      odnotujUzycie(db, wiersz.id, { teraz: new Date(teraz).toISOString(), ip: req.ip });
    } catch (err) {
      req.log?.warn?.({ err }, 'Klucz API: nie zapisano użycia');
    }
  }
  if (zakres && !req.kluczApi.zakresy.has(zakres)) {
    return reply.code(403).send({ kod: 'brak_zakresu', powod: `Klucz nie ma zakresu ${zakres}.` });
  }
}

// Data nieczytelna = klucz wygasły (zawodzimy zamknięciem).
function czyWygasl(wygasaAt, teraz) {
  if (wygasaAt === null || wygasaAt === undefined) return false;
  const wygasa = Date.parse(wygasaAt);
  return Number.isNaN(wygasa) || wygasa <= teraz;
}

function odnowSesje(req, reply, sesja, sekret, nazwaCiasteczka) {
  if (!wartoOdswiezyc(sesja)) return;
  reply.header(
    'Set-Cookie',
    ciasteczkoSesji(nazwaCiasteczka, podpisz(sesja.uzytkownik, sekret, Date.now(), sesja.wersja_hasla ?? 0), {
      bezpieczne: polaczenieBezpieczne(req),
    }),
  );
}

/**
 * Odmowa widoczna dla człowieka, a dla skryptu — krótki tekst z kodem 403.
 *
 * ⚠️⚠️ `odmow` jest wołana z haka `onRequest`, a `reply.locals`
 * (`motyw`/`menu`/`sciezkaPowrotu`, których potrzebuje `layout-oms.ejs`) ustawia dopiero
 * hak `preHandler` w web/pipeline.js — PO tym haku. Render przez layout wybuchał więc na
 * gołym `<%= motyw %>` (layout-oms.ejs): status 403 się utrzymywał, ale człowiek widział
 * zepsuty panel z bezwzględną ścieżką pliku i źródłem szablonu w treści odpowiedzi zamiast
 * ekranu „Brak dostępu" — dokładnie ta sytuacja, w której ktoś „naprawia" to, wyłączając
 * cały mechanizm uprawnień.
 *
 * Rozwiązanie: WŁASNY, SAMODZIELNY DOKUMENT (`wlasnyUklad`, furtka w layout-oms.ejs) —
 * zamiast doliczać tu `motywZNaglowka`/`menuStron`, żeby dalej iść przez `layout-oms.ejs`.
 * Wybór CELOWY, nie tylko prostszy: ekran odmowy i tak nie ma pokazywać menu ani paska
 * ikon — człowiek bez uprawnienia do ekranu nie ma po co widzieć odnośników, których nie
 * otworzy — więc ominięcie layoutu nie kosztuje niczego, co ten człowiek powinien zobaczyć.
 *
 * ⚠️ TREŚĆ NIE MOŻE ZDRADZAĆ, CZEGO DOTYCZYŁA ODMOWA poza tym, co człowiek i tak wie (adres,
 * na który wszedł) — `brak-dostepu.ejs` nie dostaje ani ścieżki, ani nazwy ekranu.
 */
function odmow(req, reply) {
  if (String(req.headers.accept ?? '').includes('text/html')) {
    // ⚠️⚠️ `motywZNaglowka` (src/domena/motyw.js) jest CZYSTĄ FUNKCJĄ nagłówka `Cookie` — nie potrzebuje
    // ani `motyw`/`menu` policzonych przez hak `preHandler` (który ten ekran celowo omija), ani niczego
    // innego, czego `odmow()` nie miałby już w ręku przez `req`. Ciemny motyw da się więc uhonorować
    // bez tego haka.
    // PEŁNA ścieżka widoku. Ten hak działa w onRequest, zanim pipeline.js (preHandler) zacznie tłumaczyć
    // krótkie nazwy — krótka nazwa „brak-dostepu.ejs” byłaby szukana w src/, a odmowa wychodziłaby jako JSON z ENOENT.
    return reply.code(403).view(sciezkaWidoku('brak-dostepu.ejs'), {
      title: 'Brak dostępu',
      wlasnyUklad: true,
      motyw: motywZNaglowka(req.headers.cookie),
    });
  }
  return reply.code(403).send('Brak uprawnień do tego ekranu');
}

function dopuscZalogowanego(req, reply, konta, sesja, sekret, nazwaCiasteczka) {
  const login = sesja.uzytkownik;
  const konto = konta.kontoPoLoginie(login);

  // Ciasteczko wystawione na konto z `.env`, którego w tabeli nie ma. Dopóki nie ma
  // czynnego admina, jest ono pełnoprawnym wejściem — inaczej człowiek, który właśnie
  // założył panel, wypadałby na `/login` zaraz po zalogowaniu.
  if (!konto && login === konta.loginSerwisowy) {
    odnowSesje(req, reply, sesja, sekret, nazwaCiasteczka);
    return dopuscSerwisowe(req, reply, konta);
  }

  // Dawne cookie bez wersji jest wersją 0 tylko do pierwszej zmiany hasła konta.
  // Sprawdzamy PRZED odnowieniem, aby stare cookie nie dostało nowej wersji.
  if (!konto || !konto.czynne || (sesja.wersja_hasla ?? 0) !== (konto.wersja_hasla ?? 0)) {
    reply.header('Set-Cookie', ciasteczkoWyczyszczenia(nazwaCiasteczka, { bezpieczne: polaczenieBezpieczne(req) }));
    // ⚠️ Żądanie BEZ `Accept: text/html` (skrypt, panel indywidualny przez Basic Auth
    // po zdjęciu uprawnień) ma dostać 401, nie 302. Inaczej wołający idzie za
    // przekierowaniem i dostaje `/login` z kodem 200 — czytelna odmowa zamieniona w stronę HTML,
    // którą wołający uznałby za powodzenie. To DOKŁADNIE ta sama pułapka, przed którą
    // ostrzega komentarz przy ścieżce Basic Auth wyżej.
    if (!String(req.headers.accept ?? '').includes('text/html')) {
      return reply.code(401).send('Sesja nieważna, zaloguj się ponownie');
    }
    // ⚠️ `bezpiecznyPowrot(req.url)`, ta sama bramka co gałąź „brak sesji" wyżej —
    // bez niej człowiek po przelogowaniu lądowałby na `/`, nie tam, gdzie faktycznie był.
    //
    // ⚠️⚠️ `req.url` tutaj potrafi być trasą WYŁĄCZNIE POST-ową
    // (`/wyloguj`, `/wyloguj-wszystkie`, `/motyw`) — te mają `Accept: text/html`, bo to zwykły
    // formularz, ale nie istnieją jako GET. Przykład: konto wyłączone, klik „Wyloguj" → 302
    // `/login?powrot=%2Fwyloguj`; po zalogowaniu na inne konto → 302 `/wyloguj` → przeglądarka
    // idzie za przekierowaniem GET-em → 404. Niesiemy więc `powrot` WYŁĄCZNIE dla metod
    // nawigacyjnych (GET/HEAD) — dla POST-a operator i tak nie wraca do formularza, który go tu wysłał,
    // więc `/login` bez `powrot` (czyli domyślne `/` po zalogowaniu) jest bezpieczniejsze niż
    // zgadywanie GET-owego odpowiednika tej trasy.
    if (!METODY_NAWIGACJI.includes(String(req.method).toUpperCase())) {
      return reply.redirect('/login');
    }
    return reply.redirect(`/login?powrot=${encodeURIComponent(bezpiecznyPowrot(req.url))}`);
  }

  odnowSesje(req, reply, sesja, sekret, nazwaCiasteczka);
  req.konto = {
    id: konto.id,
    login: konto.login,
    imie: konto.imie,
    rola: konto.rola,
    admin: konto.admin,
    uprawnienia: konto.uprawnienia,
    serwisowe: false,
  };

  // Osobiste ustawienie, tak jak /konto — niezależne od prawa „ustawienia”.
  // Dokładna ścieżka: pozostałe ekrany Ustawień zachowują własną bramkę.
  if (req.url.split('?')[0] === '/ustawienia/powiadomienia') return;
  const ekran = ekranDlaAdresu(req.url);
  if (konta.sprawdzModul(req, reply)) return reply;
  if (ekran === 'kazdy' || ekran === 'otwarte') return;
  if (ekran === null) return odmow(req, reply);
  if (ekran === 'api') return maDostepDoEkranu(konto, 'api') ? undefined : odmow(req, reply);
  if (maDostepDoEkranu(konto, ekran)) return;
  return odmow(req, reply);
}

function dopuscSerwisowe(req, reply, konta) {
  // ⚠️⚠️ DEGRADACJA STANEM BAZY, NIE USTAWIENIEM.
  // Dopóki nie ma ani jednego CZYNNEGO admina, hasło z `.env` jest pełnym adminem: to jedyny
  // sposób, żeby pierwszy start na pustej bazie w ogóle się odbył — także u kogoś, kto
  // pobrał ten kod. Od pierwszego czynnego admina zostaje mu wyłącznie `api`, czyli
  // integracja panelu zamówień indywidualnych („Dodaj do OMS") i nic więcej.
  //
  // ⚠️ Testy panelu otwierają `openOmsDb(':memory:')`, więc tabela kont jest
  // w nich PUSTA — i dlatego pliki składające nagłówek `Basic` nie wymagały zmian.
  // ⚠️ To NIE znaczy, że zwykły test nie może udowodnić tej gałęzi: wystarczy założyć w tabeli konto
  // administratora (tests/core/bezpieczenstwo/straznik-druk-klucz.test.js) albo wstrzyknąć
  // `czyIstniejeCzynnyAdmin` (tests/core/bezpieczenstwo-luki.test.ts).
  const pelnia = !konta.czyIstniejeCzynnyAdmin();
  req.konto = {
    login: konta.loginSerwisowy,
    imie: 'konto serwisowe',
    rola: 'serwisowe',
    admin: pelnia,
    // ⚠️ PEŁNIA ma też PEŁNY zbiór ptaszków, nie sam `admin: true`.
    // Ekran kont i boczne menu rysują pozycje z `uprawnienia`, nie z
    // `admin` — pusty zbiór znaczyłby, że właśnie ten, kto zakłada system, widziałby całkowicie
    // pusty panel, mimo że niżej (`if (pelnia) return;`) strażnik i tak wpuszcza go wszędzie.
    uprawnienia: new Set(pelnia ? [...EKRANY.map((e) => e.klucz), 'api'] : ['api']),
    serwisowe: true,
  };
  if (konta.sprawdzModul(req, reply)) return reply;
  if (pelnia) return;

  // ⚠️⚠️ KOLEJKI DRUKU ZOSTAJĄ KONTU MASZYNOWEMU TAKŻE PO DEGRADACJI.
  // Czuwacze przy drukarce logują się tym samym hasłem z `.env` i odpytują
  // `/kolejka-druku*` w pętli; bez tego wyjątku pierwsze założone konto administratora
  // ZATRZYMYWAŁOBY DRUK ETYKIET — po cichu, bo pętla czuwacza traktuje 403 jak „panel
  // nieosiągalny", a `/health` o kolejce druku nie mówi nic. Pełne uzasadnienie
  // stoi przy `PREFIKSY_MASZYNOWE` w domena/ekrany.js.
  if (czyTrasaMaszynowa(req.url)) return;

  const ekran = ekranDlaAdresu(req.url);
  if (ekran === 'api' || ekran === 'kazdy' || ekran === 'otwarte') return;
  return odmow(req, reply);
}
