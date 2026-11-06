// Straznik wejscia. WSPOLNY dla obu paneli (indywidualnego i OMS): przepuszcza wazne CIASTECZKO SESJI albo poprawny BASIC AUTH.
//
// ⚠️ DLACZEGO OBA ZAMKI, A NIE WYMIANA JEDNEGO NA DRUGI. Basic Auth zostaje z dwoch
// niezaleznych powodow, z ktorych kazdy sam wystarcza:
//   1. Panel zamowien indywidualnych loguje sie do OMS-u wlasnie nim („Dodaj do OMS”,
//      OMS_URL + OMS_USER/OMS_PASS w src/config.js). Zdjecie Basic Auth zlamaloby te
//      integracje po cichu — przy pierwszym prawdziwym zamowieniu klienta.
//   2. Sto siedemdziesiat dziewiec plikow testowych sklada naglowek `Basic` wprost w tresci
//      bez wspolnego helpera. Wymiana zamka oznaczalaby reczne ruszenie ich wszystkich
//      przy okazji zmiany uwierzytelniania — czyli najlepszy znany sposob, zeby testy
//      przestaly czegokolwiek pilnowac.
//
// Co sie zmienia dla czlowieka: przegladarka BEZ ciasteczka i BEZ naglowka dostaje
// przekierowanie na /login zamiast odpowiedzi 401. To jest cala roznica miedzy naszym
// ekranem a systemowym okienkiem Chrome — okienko rysuje przegladarka w odpowiedzi na 401
// i nie da sie go ostylowac ani ominac inaczej niz nie odpowiadajac 401.
//
// ⚠️⚠️ UPRAWNIENIA PER EKRAN (Zadanie 4, spec 2026-09-12) sa WSTRZYKIWANE parametrem `konta`,
// nie wbudowane na sztywno. Panel zamowien indywidualnych (:3000) kont NIE MA i NIE MA MIEC —
// wola tego strażnika bez tego parametru i zostaje na jednym hasle z `.env`, dokladnie jak
// przed tym zadaniem (dowodzi tego tests/security/panel-bez-kont.test.js). OMS (:3001) wola go
// z `konta` i dopiero wtedy strażnik sprawdza ptaszki konta z tabeli oraz degraduje konto
// serwisowe z `.env` w zaleznosci od tego, czy w bazie jest juz czynny administrator.

import {
  sprawdz, zNaglowka, wartoOdswiezyc, podpisz, ciasteczkoSesji, ciasteczkoWyczyszczenia,
} from './sesja.js';
import { odczytajSekret } from './sekret-sesji.js';
import { czyTrasaOtwarta, polaczenieBezpieczne } from './logowanie-wspolne.js';
import { bezpiecznyPowrot } from './powrot.js';
import {
  ekranDlaAdresu, czyTrasaMaszynowa, maDostepDoEkranu, EKRANY,
} from '../../domena/ekrany.js';
import { motywZNaglowka } from '../../domena/motyw.js';
import { hamulecLogowaniaDla } from './hamulec.js';
import { dopiszLogowanie } from './konta.js';
import { sciezkaWidoku } from '../web/widoki.js';
import { rozbierzNaglowek, skrotKlucza, ZAKRESY_API } from '../../domena/klucze-api.js';
import { kluczPoSkrocie, odnotujUzycie } from './klucze-api.js';

const METODY_NAWIGACJI = ['GET', 'HEAD'];

/**
 * @param basicAuth hak z @fastify/basic-auth (app.basicAuth) — wstrzykiwany, a nie
 *   siegany z `app` w srodku, zeby dalo sie go w tescie zastapic atrapa.
 * @param konta `{ kontoPoLoginie, czyIstniejeCzynnyAdmin, loginSerwisowy }` albo
 *   `null`. ⚠️ `null` NIE JEST TRYBEM AWARYJNYM — to panel zamowien indywidualnych (:3000),
 *   ktory zostaje na jednym hasle z `.env` (decyzja właściciela 2026-09-12). Brak wstrzyknietej
 *   zaleznosci, a nie galaz `if (tryb === 'stary')` w srodku: galaz zyla by tu na zawsze,
 *   a nikt by nie wiedzial, ktora z dwoch sciezek jest sprawdzana testami.
 *   ⚠️ D1 (recenzja 2026-09-12): kontrakt mial takze pole `usluga` — wolajacy je skladali
 *   (server.js, mikropanele testow), ale ten modul nigdy go nie czytal; `logowanie.js` obok
 *   i tak wpisuje do dziennika logowan wlasna, niezalezna stala `'oms'`. Pole klamalo, ze
 *   cos konfiguruje — usuniete z kontraktu, zamiast zostawic martwy parametr.
 */
export function zbudujStraznika({
  basicAuth, db, nazwaCiasteczka, konta = null, klucze = null, odlozoneEkrany = () => [],
}) {
  // Panel indywidualny nie wstrzykuje tego odczytu; blokada dotyczy tylko OMS.
  const sprawdzModul = (req, reply) => {
    const ekran = ekranDlaAdresu(sciezkaZdekodowana(req.url) ?? req.url);
    if (!odlozoneEkrany().includes(ekran)) return false;
    reply.code(404).view(sciezkaWidoku('modul-wylaczony.ejs'), {
      title: 'Moduł wyłączony', wlasnyUklad: true,
      motyw: motywZNaglowka(req.headers.cookie), admin: req.konto?.admin === true,
    });
    return true;
  };
  if (konta) konta = { ...konta, sprawdzModul };
  const hamulec = hamulecLogowaniaDla(db);
  // PRZ-153: klucz API wstrzykuje tylko OMS (`{ db, limit }`); panel indywidualny wola bez `klucze` i /api/v1 nie zna.
  const uzyciaKluczy = new Map();
  // IP -> koniec okna blokady, dla ktorej 429 juz trafilo do dziennika (jeden wiersz na blokade, nie na zadanie).
  const zapisaneBlokady = new Map();
  return async function straznik(req, reply) {
    if (czyTrasaOtwarta(req.url)) return;
    // ⚠️ Na /api/v1 WYLACZNIE klucz: ciasteczko i Basic nie sa tu sprawdzane (plan PRZ-153, „Ograniczenia
    // globalne”). Router Fastify DEKODUJE %XX w sciezce (`/api/v%31/ja` = /api/v1/ja), dlatego czyAdresApiV1
    // porownuje sciezke zdekodowana. `..`, `./` i `//` router zostawia bez zmian (zmierzone 06.11), wiec nie trzeba
    // ich zrownywac. Druga warstwa: hak onRequest pluginu /api/v1 odmawia 401 kazdemu zadaniu bez req.kluczApi.
    if (klucze && czyAdresApiV1(req.url)) return dopuscKluczem(req, reply, klucze, uzyciaKluczy, zapisaneBlokady);
    // PRZ-153.E4.1: kolejki druku przyjmuja TAKZE klucz z zakresem `druk` (obok Basic serwisu, ktory zostaje do E8).
    // Sciezka zdekodowana jak przy /api/v1 (router dekoduje %XX). Wybor po samym schemacie `Bearer`: zly klucz idzie
    // sciezka klucza (401 kod klucz, licznik limit-api), a nie do hamulca logowania wspolnego z formularzem.
    // Klucz na kazdym innym adresie panelu nie trafia tutaj — idzie sciezka Basic i dostaje 401 jak dotad.
    if (klucze && czyBearer(req.headers.authorization) && czyTrasaMaszynowaZdekodowana(req.url)) {
      const odmowa = dopuscKluczem(req, reply, klucze, uzyciaKluczy, zapisaneBlokady, 'druk');
      if (odmowa) return odmowa;
      if (konta?.sprawdzModul(req, reply)) return reply;
      return;
    }

    // ⚠️ Sam ODCZYT, nigdy zakladanie. Straznik chodzi przy kazdym zadaniu, a zapis w tej
    // sciezce zamienialby baze chwilowo niezapisywalna (pelny dysk) w panel oddajacy 500
    // na kazdej stronie. Sekret zaklada sie RAZ, przy budowie serwera.
    // Brak sekretu = brak wazniej sesji: `sprawdz` z pustym sekretem odmawia (fail closed).
    const sekret = odczytajSekret(db);
    const sesja = sprawdz(zNaglowka(nazwaCiasteczka, req.headers.cookie), sekret);

    if (sesja) {
      if (!konta) {
        odnowSesje(req, reply, sesja, sekret, nazwaCiasteczka);
        return;
      }
      return dopuscZalogowanego(req, reply, konta, sesja, sekret, nazwaCiasteczka);
    }

    const maNaglowek = typeof req.headers.authorization === 'string'
      && req.headers.authorization !== '';
    const toNawigacja = METODY_NAWIGACJI.includes(String(req.method).toUpperCase())
      && String(req.headers.accept ?? '').includes('text/html');

    // ⚠️ Przekierowanie WYLACZNIE dla wejscia przegladarki na strone. Zadanie z naglowkiem
    // `Authorization` (panel indywidualny, skrypt, curl) ma dalej dostac 401 albo przejsc —
    // odeslanie go na ekran logowania zamienialoby czytelna odmowe w stronę HTML,
    // ktora wolajacy uznalby za powodzenie.
    if (!maNaglowek && toNawigacja) {
      const powrot = bezpiecznyPowrot(req.url);
      return reply.redirect(`/login?powrot=${encodeURIComponent(powrot)}`);
    }

    // @fastify/basic-auth jest hakiem w stylu `done(err)`. Zawijamy go w obietnice, zeby
    // dolozyc do niego warunek wyzej — a odmowe zostawiamy jego wlasnej obsludze, bo to
    // ona dokleja naglowek `WWW-Authenticate` i wlasciwy kod 401.
    // Pipeline HTTP uruchamia wiele haków zanim callback Basic Auth odnotuje błąd.
    // Wspólna z formularzem kolejka obejmuje walidację, zapis wyniku i karę.
    const naglowek = String(req.headers.authorization ?? '');
    const zakodowane = /^Basic\s+(\S+)\s*$/i.exec(naglowek)?.[1];
    const dane = zakodowane ? Buffer.from(zakodowane, 'base64').toString('utf8') : '';
    const dwukropek = dane.indexOf(':');
    const login = dwukropek >= 0 ? dane.slice(0, dwukropek) : '';
    const zwolnij = await hamulec.zajmij(req, login);
    if (!zwolnij) return reply.code(429).header('Retry-After', 2).send('Za dużo prób logowania, spróbuj ponownie później');
    try {
      const zapiszBlokade = () => {
        // Panel bez tabeli kont nie ma dziennika OMS.
        if (konta && hamulec.zapiszBlokadeRaz(req.ip, login)) dopiszLogowanie(db, {
          login, usluga: 'oms', ip: req.ip, wynik: 'zablokowane',
        });
      };
      const odmowLimit = (limit) => reply.code(429).header('Retry-After', Math.ceil(limit.zostaloMs / 1000))
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
    // Basic Auth przeszlo, wiec to konto SERWISOWE z `.env` — inne tam nie istnieja.
    return dopuscSerwisowe(req, reply, konta);
  };
}

/**
 * ⚠️ Porownujemy sciezke ZDEKODOWANA: router (find-my-way) dekoduje %XX przed dopasowaniem trasy, wiec
 * `/api/v%31/ja` trafia do trasy /api/v1/ja. decodeURIComponent dekoduje wiecej niz router (takze %2F), czyli
 * w razie roznicy uznaje za API wiecej adresow, nigdy mniej. Zle kodowanie (np. `%zz`) = API: wymagamy klucza
 * (zawodzimy zamknieciem). Wielkosc liter rozrozniana jak w routerze (`/API/v1` to nie API i nie trasa API).
 */
export function czyAdresApiV1(url) {
  const sciezka = sciezkaZdekodowana(url);
  if (sciezka === null) return true;
  return sciezka === '/api/v1' || sciezka.startsWith('/api/v1/');
}

/** Sciezka bez zapytania, zdekodowana jak w routerze; `null` = zle kodowanie (kazdy wolajacy sam wybiera strone zamkniecia). */
function sciezkaZdekodowana(url) {
  const surowa = String(url ?? '').split(/[?#]/)[0];
  try {
    return decodeURIComponent(surowa);
  } catch {
    return null;
  }
}

/**
 * PRZ-153.E4.1: czy adres to kolejka druku (`czyTrasaMaszynowa`) po zdekodowaniu — `/kolejka%2Ddruku` = `/kolejka-druku`.
 * Zle kodowanie = nie kolejka: zadanie idzie dawna sciezka (Basic), czyli klucz go nie otwiera.
 * ⚠️ Zdekodowany `?` (%3F) nie moze skrocic sciezki do prefiksu kolejki — sprawdzamy cala zdekodowana sciezke.
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
  return reply.code(429).header('Retry-After', String(Math.max(1, Math.ceil(zostaloMs / 1000))))
    .send({ kod: 'limit', powod });
}

/**
 * PRZ-153.E1.2: wejscie kluczem `Authorization: Bearer toms_…`. W bazie jest tylko sha256 klucza; szukamy po
 * skrocie (UNIQUE), klucza wprost nie porownujemy.
 * ⚠️ Bez hamulca logowania (`hamulec.js`): jego licznik IP jest wspolny z formularzem i szereguje zadania —
 * czuwacz z odwolanym kluczem zablokowalby logowanie haslem z tego komputera. Zgadywanie kluczy hamuje E1.3:
 * wlasny `limit` (limit-api.js) — 20 nieudanych prob z IP w 60 s blokuje ten IP na wejsciu kluczem (/api/v1
 * i Bearer na kolejkach druku; Basic i formularz bez zmian) do konca okna, a trafiony klucz ma 120 wywolan na okno.
 * 401 bez `WWW-Authenticate` (to nie jest Basic). Wpis 401 i 429 do dziennika robi hak `onResponse` pluginu API
 * (tylko /api/v1 — kolejki druku nie sa w tym pluginie i do dziennika API nie ida).
 * `zakres` (E4.1, kolejki druku): wymagany zakres klucza; brak → 403 `brak_zakresu`, jak `wymagajZakresu` w module api.
 * Zwraca `reply` przy odmowie, `undefined` przy wpuszczeniu.
 */
function dopuscKluczem(req, reply, { db, limit }, uzycia, zapisaneBlokady, zakres = null) {
  const teraz = Date.now();
  const blokadaIp = limit.zablokowanyIp(req.ip, teraz);
  if (!blokadaIp.wolno) {
    // Zablokowany czuwacz pyta dalej co sekunde; do dziennika idzie tylko pierwsza odmowa w tym oknie blokady.
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
    // Kazda nieudana proba sie liczy, takze brak naglowka: program bez klucza to tez blad konfiguracji.
    limit.odnotujZly(req.ip, teraz);
    return reply.code(401).send(ODMOWA_KLUCZA);
  }
  // Ustawiane przed limitem, zeby wpis 429 w dzienniku mial klucz_id.
  req.kluczApi = {
    id: wiersz.id, nazwa: wiersz.nazwa, prefiks: wiersz.prefiks,
    zakresy: new Set(ZAKRESY_API.filter((z) => wiersz.zakresy.includes(z))),
  };
  const wywolania = limit.sprawdz(wiersz.id, teraz);
  if (!wywolania.wolno) return odmowaLimitu(reply, wywolania.zostaloMs, 'Za dużo wywołań tym kluczem, spróbuj za chwilę.');
  // Opakowanie tras (pipeline.js) wpisuje `req.konto.imie` do dziennika zmian. Pusty zbior uprawnien i admin
  // false = klucz nie otwiera zadnego ekranu, nawet gdyby kiedys trafil poza /api/v1.
  req.konto = {
    imie: `klucz: ${wiersz.nazwa}`, login: `klucz:${wiersz.prefiks}`, rola: 'klucz-api', admin: false,
    serwisowe: false, kluczApi: true, uprawnienia: new Set(),
  };
  const ostatnio = uzycia.get(wiersz.id);
  if (ostatnio === undefined || teraz - ostatnio >= ODSTEP_UZYCIA_MS) {
    uzycia.set(wiersz.id, teraz);
    // Zapis w strazniku nie moze zamienic chwilowo niezapisywalnej bazy w 500 na kazdym wywolaniu API.
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

// Data nieczytelna = klucz wygasly (zawodzimy zamknieciem).
function czyWygasl(wygasaAt, teraz) {
  if (wygasaAt === null || wygasaAt === undefined) return false;
  const wygasa = Date.parse(wygasaAt);
  return Number.isNaN(wygasa) || wygasa <= teraz;
}

function odnowSesje(req, reply, sesja, sekret, nazwaCiasteczka) {
  if (!wartoOdswiezyc(sesja)) return;
  reply.header('Set-Cookie', ciasteczkoSesji(
    nazwaCiasteczka,
    podpisz(sesja.uzytkownik, sekret, Date.now(), sesja.wersja_hasla ?? 0),
    { bezpieczne: polaczenieBezpieczne(req) },
  ));
}

/**
 * Odmowa widoczna dla czlowieka, a dla skryptu — krotki tekst z kodem 403.
 *
 * ⚠️⚠️ K1 (recenzja 2026-09-12): `odmow` jest wolana z haka `onRequest`, a `reply.locals`
 * (`motyw`/`menu`/`sciezkaPowrotu`, ktorych potrzebuje `layout-oms.ejs`) ustawia dopiero
 * hak `preHandler` w web/server.js — PO tym haku. Render przez layout wybuchal wiec na
 * golym `<%= motyw %>` (layout-oms.ejs:9): status 403 sie utrzymywal, ale czlowiek widzial
 * zepsuty panel z bezwzgledna sciezka pliku i zrodlem szablonu w tresci odpowiedzi zamiast
 * ekranu „Brak dostępu" — dokladnie ta sytuacja, w ktorej ktos „naprawia" to, wylaczajac
 * caly mechanizm uprawnien.
 *
 * Naprawa: WLASNY, SAMODZIELNY DOKUMENT (`wlasnyUklad`, ta sama furtka co /kampania) —
 * zamiast doliczac tu `motywZNaglowka`/`menuStron`, zeby dalej isc przez `layout-oms.ejs`.
 * Wybor CELOWY, nie tylko prostszy: ekran odmowy i tak nie ma pokazywac menu ani paska
 * ikon — czlowiek bez uprawnienia do ekranu nie ma po co widziec odnosnikow, ktorych nie
 * otworzy — wiec ominiecie layoutu nie kosztuje niczego, co ten czlowiek powinien zobaczyc.
 *
 * ⚠️ TRESC NIE MOZE ZDRADZAC, CZEGO DOTYCZYLA ODMOWA poza tym, co czlowiek i tak wie (adres,
 * na ktory wszedl) — `brak-dostepu.ejs` nie dostaje ani sciezki, ani nazwy ekranu.
 */
function odmow(req, reply) {
  if (String(req.headers.accept ?? '').includes('text/html')) {
    // ⚠️⚠️ N3 (druga fala 2026-09-12): `motywZNaglowka` (src/oms/domain/motyw.js) jest
    // CZYSTA FUNKCJA naglowka `Cookie` — nie potrzebuje ani `motyw`/`menu` policzonych przez
    // hak `preHandler` (ktorego K1 wyzej celowo omija), ani niczego innego, czego `odmow()`
    // nie mialby juz w rece poprzez `req`. Poprzedni komentarz w brak-dostepu.ejs twierdzil,
    // ze uhonorowanie ciemnego motywu „wymagaloby tego samego haka" — to bylo nieprawdziwe.
    // PRZ-083: PEŁNA ścieżka widoku. Ten hak działa w onRequest, zanim pipeline.js (preHandler) zacznie tłumaczyć
    // krótkie nazwy — od PRZ-021 „brak-dostepu.ejs” szukane było w src/ i odmowa wychodziła jako JSON z ENOENT.
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

  // Ciasteczko wystawione na konto z `.env`, ktorego w tabeli nie ma. Dopoki nie ma
  // czynnego admina, jest ono pelnoprawnym wejsciem — inaczej czlowiek, ktory wlasnie
  // zalozyl panel, wypadalby na `/login` zaraz po zalogowaniu.
  if (!konto && login === konta.loginSerwisowy) {
    odnowSesje(req, reply, sesja, sekret, nazwaCiasteczka);
    return dopuscSerwisowe(req, reply, konta);
  }

  // Dawne cookie bez wersji jest wersją 0 tylko do pierwszej zmiany hasła konta.
  // Sprawdzamy PRZED odnowieniem, aby stare cookie nie dostało nowej wersji.
  if (!konto || !konto.czynne || (sesja.wersja_hasla ?? 0) !== (konto.wersja_hasla ?? 0)) {
    reply.header('Set-Cookie', ciasteczkoWyczyszczenia(nazwaCiasteczka, { bezpieczne: polaczenieBezpieczne(req) }));
    // ⚠️ D3 (recenzja 2026-09-12): zadanie BEZ `Accept: text/html` (skrypt, panel
    // indywidualny przez Basic Auth po zdjeciu uprawnien) ma dostac 401, nie 302. Inaczej
    // wolajacy idzie za przekierowaniem i dostaje `/login` z kodem 200 — czytelna odmowa
    // zamieniona w strone HTML, ktora wolajacy uznalby za powodzenie. To DOKLADNIE ta sama
    // pulapka, przed ktora ostrzega naglowek modulu przy sciezce Basic Auth.
    if (!String(req.headers.accept ?? '').includes('text/html')) {
      return reply.code(401).send('Sesja nieważna, zaloguj się ponownie');
    }
    // ⚠️ D4: `bezpiecznyPowrot(req.url)`, ta sama bramka co galaz „brak sesji" wyzej —
    // bez niej czlowiek po przelogowaniu ladowal na `/`, nie tam, gdzie faktycznie byl.
    //
    // ⚠️⚠️ N2 (druga fala 2026-09-12): `req.url` tutaj potrafi byc trasa WYLACZNIE POST-owa
    // (`/wyloguj`, `/wyloguj-wszystkie`, `/motyw`) — te maja `Accept: text/html`, bo to zwykly
    // formularz, ale nie istnieja jako GET. Zmierzone: konto wylaczone, klik „Wyloguj" → 302
    // `/login?powrot=%2Fwyloguj`; po zalogowaniu na inne konto → 302 `/wyloguj` → przegladarka
    // idzie za przekierowaniem GET-em → 404 (przed ta poprawka ladowal na `/`). Niesiemy wiec
    // `powrot` WYLACZNIE dla metod nawigacyjnych (GET/HEAD) — dla POST-a operator i tak nie
    // wraca do formularza, ktory go tu wyslal, wiec `/login` bez `powrot` (czyli domyslne `/`
    // po zalogowaniu) jest bezpieczniejsze niz zgadywanie GET-owego odpowiednika tej trasy.
    if (!METODY_NAWIGACJI.includes(String(req.method).toUpperCase())) {
      return reply.redirect('/login');
    }
    return reply.redirect(`/login?powrot=${encodeURIComponent(bezpiecznyPowrot(req.url))}`);
  }

  odnowSesje(req, reply, sesja, sekret, nazwaCiasteczka);
  req.konto = {
    id: konto.id, login: konto.login, imie: konto.imie, rola: konto.rola, admin: konto.admin,
    uprawnienia: konto.uprawnienia, serwisowe: false,
  };

  // PRZ-102.01: osobiste ustawienie, tak jak /konto — niezależne od prawa „ustawienia”.
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
  // ⚠️⚠️ DEGRADACJA STANEM BAZY, NIE USTAWIENIEM (spec 2026-09-12, §7).
  // Dopoki nie ma ani jednego CZYNNEGO admina, haslo z `.env` jest pelnym adminem: to jedyny
  // sposob, zeby pierwszy start na pustej bazie w ogole sie odbyl — takze u kogos, kto
  // kupil ten kod. Od pierwszego czynnego admina zostaje mu wylacznie `api`, czyli
  // integracja panelu :3000 („Dodaj do OMS") i nic wiecej.
  //
  // ⚠️ WSZYSTKIE testy panelu otwieraja `openOmsDb(':memory:')`, wiec tabela kont jest
  // w nich PUSTA — i dlatego 107 plikow skladajacych naglowek `Basic` nie wymagalo ani
  // jednej zmiany. ⚠️ W6 (recenzja 2026-09-12, poprawka nieprawdziwego komentarza): to NIE
  // znaczy, ze zwykly test nie moze udowodnic tej galezi — tests/oms/straznik-degradacja-env.test.js
  // rozroznia ja CZTEREMA przypadkami (pusta tabela / czynny admin / wylaczony admin /
  // konto sprzedazy bez admina), z ktorych kazdy padlby po usunieciu reguly
  // `czyIstniejeCzynnyAdmin`. Planowane wzmocnienie mutacyjne — scripts/mutacje-konta-role.mjs
  // — jest DODATKOWYM dowodem (mutacje 7, 10, 32), nie jedynym.
  const pelnia = !konta.czyIstniejeCzynnyAdmin();
  req.konto = {
    login: konta.loginSerwisowy, imie: 'konto serwisowe', rola: 'serwisowe', admin: pelnia,
    // ⚠️ W7 (recenzja 2026-09-12): PELNIA ma tez PELNY zbior ptaszkow, nie sam `admin: true`.
    // Ekran kont i boczne menu (Zadania 6 i 8) rysuja pozycje z `uprawnienia`, nie z
    // `admin` — pusty zbior znaczyl, ze wlasnie ten, kto zaklada system, widzial calkowicie
    // pusty panel, mimo ze nizej (`if (pelnia) return;`) straznik i tak wpuszcza go wszedzie.
    uprawnienia: new Set(pelnia ? [...EKRANY.map((e) => e.klucz), 'api'] : ['api']),
    serwisowe: true,
  };
  if (konta.sprawdzModul(req, reply)) return reply;
  if (pelnia) return;

  // ⚠️⚠️ KOLEJKI DRUKU ZOSTAJA KONTU MASZYNOWEMU TAKZE PO DEGRADACJI (recenzja calosci,
  // 2026-09-13). Czuwacze przy drukarce loguja sie tym samym haslem z `.env` i odpytuja
  // `/kolejka-druku*` w petli; bez tego wyjatku pierwsze zalozone konto administratora
  // ZATRZYMYWALO DRUK ETYKIET — po cichu, bo petla czuwacza traktuje 403 jak „panel
  // nieosiagalny", a `/health` o kolejce druku nie mowi nic. Pelne uzasadnienie i pomiar
  // stoja przy `PREFIKSY_MASZYNOWE` w domain/ekrany.js.
  if (czyTrasaMaszynowa(req.url)) return;

  const ekran = ekranDlaAdresu(req.url);
  if (ekran === 'api' || ekran === 'kazdy' || ekran === 'otwarte') return;
  return odmow(req, reply);
}
