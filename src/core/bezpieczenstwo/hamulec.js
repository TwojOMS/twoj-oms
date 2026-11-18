// Hamulec na powtarzane proby logowania.
//
// Po co, skoro panel stoi w LAN-ie. Basic Auth ma wbudowany koszt zgadywania: kazda proba
// to nowe okienko przegladarki, wiec nikt nie zgaduje hasla recznie. Formularz tego kosztu
// NIE MA — jest polem tekstowym, do ktorego skrypt wrzuca tysiac hasel na minute. Bez
// hamulca zamiana okienka na ekran logowania byloby wiec ulatwieniem takze dla zgadujacego.
//
// Dlaczego w pamięci, a nie w bazie. Liczniki logowania wygasają po 15 minutach
// bezczynności i nie mają znaczenia po restarcie. Zapis do SQLite przy KAŻDEJ nieudanej
// próbie dokładałby operację dyskową dokładnie w tym miejscu, w którym zgadujący
// chciałby nam jej narobić najwięcej.

import { createHash } from 'node:crypto';
import { setTimeout as czekajDomyslnie } from 'node:timers/promises';

export const LIMIT_PROB = 5;
export const KARA_MS = 60_000;

/**
 * Tworzy hamulec. Kazde wywolanie daje WLASNY licznik — testy nie moga sobie nawzajem
 * przestawiac stanu, a dwie uslugi w jednym procesie nie dziela kary.
 *
 * `teraz` jest wszedzie parametrem, a nie odczytem zegara w srodku: inaczej test na
 * wygasniecie kary musialby naprawde spac minute.
 */
export function utworzHamulec({
  limit = LIMIT_PROB,
  karaMs = KARA_MS,
  wygasanieMs = null,
  maksKluczy = null,
  oknoMs = null,
} = {}) {
  const liczniki = new Map();

  // OPCJONALNE wygasanie i limit kluczy — używa ich m.in. /haslo/:token oraz hamulec logowania.
  // Bez opcji zachowanie jest podstawowe: licznik żyje do udanego logowania, a po karze każda
  // kolejna pomyłka od razu zapala następną. Z `wygasanieMs` wpis bez kary, którego ostatnia
  // próba jest starsza niż `wygasanieMs`, znika — licznik startuje od zera. `oknoMs` kasuje
  // wpis bez kary po upływie okna liczonego od pierwszej próby. `maksKluczy` przycina mapę:
  // najpierw martwe wpisy, potem najdawniej używane (Map trzyma kolejność wstawienia, a każdy
  // błąd przesuwa wpis na koniec).
  const martwy = (wpis, teraz) =>
    wpis.doKiedy <= teraz &&
    ((wygasanieMs !== null && teraz - wpis.ostatnia >= wygasanieMs) ||
      (oknoMs !== null && teraz - wpis.poczatek >= oknoMs));
  const zywy = (klucz, teraz) => {
    const wpis = liczniki.get(klucz);
    if (wpis && martwy(wpis, teraz)) {
      liczniki.delete(klucz);
      return undefined;
    }
    return wpis;
  };
  const przytnij = (teraz) => {
    if (maksKluczy === null || liczniki.size <= maksKluczy) return;
    for (const [k, w] of liczniki) if (martwy(w, teraz)) liczniki.delete(k);
    while (liczniki.size > maksKluczy) liczniki.delete(liczniki.keys().next().value);
  };

  return {
    /**
     * Czy wolno probowac. Zwraca `{ wolno, zostaloMs }` — `zostaloMs` jest po to, zeby
     * ekran mogl powiedziec „sprobuj za 40 sekund" zamiast bezradnego „za duzo prob".
     */
    sprawdz(klucz, teraz = Date.now()) {
      const wpis = zywy(klucz, teraz);
      if (!wpis || wpis.doKiedy <= teraz) return { wolno: true, zostaloMs: 0 };
      return { wolno: false, zostaloMs: wpis.doKiedy - teraz };
    },

    /**
     * Odnotowuje nieudana probe. Kara zapala sie dopiero przy `limit`-tej z rzedu.
     *
     * ⚠️ Kara LICZY SIE OD OSTATNIEJ PROBY, nie od pierwszej. Inaczej zgadujacy czekalby
     * minute raz, a potem mial darmowe proby az do konca okna — czyli hamulec spowalnialby
     * go jednorazowo zamiast stale.
     */
    odnotujBlad(klucz, teraz = Date.now()) {
      const wpis = zywy(klucz, teraz) ?? {
        proby: 0,
        doKiedy: 0,
        zapisanoBlokade: false,
        poczatek: teraz,
      };
      wpis.proby += 1;
      wpis.ostatnia = teraz;
      liczniki.delete(klucz); // na koniec kolejnosci — przycinanie usuwa najdawniej uzywane
      if (wpis.proby >= limit) {
        wpis.doKiedy = teraz + karaMs;
        // Nowa kara — jeszcze niezapisana. Bez tego resetu druga kara tego samego klucza
        // (po wygasnieciu pierwszej i piatej kolejnej pomylce) nie napisalaby juz ani
        // jednego wiersza „zablokowane”, bo `zapisanoBlokade` zostaloby z poprzedniej kary.
        wpis.zapisanoBlokade = false;
      }
      liczniki.set(klucz, wpis);
      przytnij(teraz);
      return wpis.proby;
    },

    /**
     * Czy TERAZ nalezy zapisac do dziennika logowan wpis „zablokowane” dla tej kary.
     *
     * ⚠️⚠️ Bez tej funkcji logowanie.js i strażnik (blokada Basic) pisałyby jeden taki wiersz na KAŻDE żądanie, które
     * trafia na już trwającą karę — a trwa ona domyślnie 60 s, więc pukanie skryptem dawałoby
     * setki wierszy na jedną karę. Prawda WYŁĄCZNIE dla pierwszego żądania po zapaleniu kary;
     * każde kolejne, aż do jej wygaśnięcia, dostaje `false` i nic nie zapisuje. Wołać
     * WYŁĄCZNIE gdy `sprawdz` już powiedział `wolno: false` — inaczej nie ma czego oznaczać.
     */
    zapiszBlokadeRaz(klucz, teraz = Date.now()) {
      const wpis = liczniki.get(klucz);
      if (!wpis || wpis.doKiedy <= teraz) return false; // kara juz minela albo nie istnieje
      if (wpis.zapisanoBlokade) return false;
      wpis.zapisanoBlokade = true;
      return true;
    },

    /**
     * Kasuje licznik po udanym logowaniu.
     *
     * ⚠️ BEZ TEGO cztery pomylki w ciagu dnia i jedno poprawne haslo zostawialyby licznik
     * na czterech — a piata pomylka tydzien pozniej zapalalaby kare, ktorej nikt by nie
     * zrozumial. Udane logowanie jest dowodem, ze to nie zgadujacy.
     */
    wyczysc(klucz) {
      liczniki.delete(klucz);
    },

    /** Dla testow i diagnostyki — nie do pokazywania czlowiekowi. */
    proby(klucz) {
      return liczniki.get(klucz)?.proby ?? 0;
    },

    /** Dla testow — liczba kluczy w pamieci (przycinanie przy `maksKluczy`). */
    rozmiar() {
      return liczniki.size;
    },
  };
}

// Wspólny stan formularza i Basic Auth dla jednej bazy/aplikacji. WeakMap nie utrzymuje
// zamkniętych instancji testowych w pamięci i nie miesza dwóch usług w procesie.
const hamulceLogowania = new WeakMap();
export function hamulecLogowaniaDla(db) {
  if (!hamulceLogowania.has(db)) hamulceLogowania.set(db, utworzHamulecLogowania());
  return hamulceLogowania.get(db);
}

export function utworzHamulecLogowania({ maksKluczy = 10_000, czekaj = czekajDomyslnie } = {}) {
  const opcje = { wygasanieMs: 15 * 60_000, maksKluczy };
  const pary = utworzHamulec(opcje);
  const adresy = utworzHamulec({ ...opcje, limit: 40, karaMs: 15 * 60_000, oknoMs: 15 * 60_000 });
  const konta = utworzHamulec({ ...opcje, limit: 30, karaMs: 2_000 });
  // Hash ogranicza także bajty klucza: losowe wielkie loginy nie zajmą 10 000 × bodyLimit.
  // Normalizacja jest wyłącznie do liczników, nie zmienia zasad porównania poświadczeń.
  const loginKlucza = (login) =>
    createHash('sha256')
      .update(
        String(login ?? '')
          .trim()
          .toLowerCase(),
      )
      .digest('hex');
  const kluczPary = (ip, login) => JSON.stringify([ip, loginKlucza(login)]);
  const liczniki = (ip, login) => [
    [pary, kluczPary(ip, login)],
    [adresy, ip],
    [konta, loginKlucza(login)],
  ];
  // Fastify udostępnia req.ips wyłącznie przy skonfigurowanym trustProxy, również gdy
  // bezpośredni nadawca nie jest na zaufanej liście. Nie odczytujemy samodzielnie IP z nagłówka.
  const wiarygodnyAdres = (req) =>
    req.ips !== undefined ||
    (req.headers['x-forwarded-for'] === undefined && req.headers['cf-connecting-ip'] === undefined);
  const rozgrzany = (h, klucz, prog) => {
    h.sprawdz(klucz); // usuwa wygasły wpis przed odczytem liczby prób
    return h.proby(klucz) >= prog;
  };
  const kolejki = new Map();
  const kluczeKolejki = (req, login) => {
    const klucze = ['para:' + kluczPary(req.ip, login)];
    const adres = 'adres:' + req.ip;
    const konto = 'konto:' + loginKlucza(login);
    if (wiarygodnyAdres(req) || rozgrzany(adresy, req.ip, 40) || kolejki.has(adres)) klucze.push(adres);
    if (rozgrzany(konta, loginKlucza(login), 30) || kolejki.has(konto)) klucze.push(konto);
    return klucze;
  };
  async function zajmij(req, login) {
    for (;;) {
      const klucze = kluczeKolejki(req, login);
      // Rezerwacja wszystkich kluczy jest synchroniczna: brak zakleszczeń między
      // kolejką konta i adresu. Limit obejmuje także wpisy oczekujące na inny klucz.
      if (
        klucze.some((k) => (kolejki.get(k)?.liczba ?? 0) >= 21) ||
        kolejki.size + klucze.filter((k) => !kolejki.has(k)).length > maksKluczy
      )
        return null;
      const poprzednie = klucze.map((k) => kolejki.get(k)?.ogon);
      let zakoncz;
      const ogon = new Promise((resolve) => {
        zakoncz = resolve;
      });
      for (const k of klucze) kolejki.set(k, { ogon, liczba: (kolejki.get(k)?.liczba ?? 0) + 1 });
      let zwolniono = false;
      const zwolnij = () => {
        if (zwolniono) return;
        zwolniono = true;
        for (const k of klucze) {
          const wpis = kolejki.get(k);
          if (--wpis.liczba === 0) kolejki.delete(k);
        }
        zakoncz();
      };
      await Promise.all(poprzednie);
      // Limit mógł zapalić się podczas czekania na parę/adres. Wejdź ponownie już
      // ze wspólnym kluczem konta, zanim dojdzie do walidacji hasła.
      if (kluczeKolejki(req, login).every((k) => klucze.includes(k))) return zwolnij;
      zwolnij();
    }
  }
  const sprawdz = (ip, login, teraz = Date.now()) => {
    const zostaloMs = Math.max(...liczniki(ip, login).map(([h, k]) => h.sprawdz(k, teraz).zostaloMs));
    return { wolno: zostaloMs === 0, zostaloMs };
  };
  return {
    sprawdz,
    zajmij,
    wiarygodnyAdres,
    sprawdzPrzedProba(req, login) {
      const zostaloMs = Math.max(
        pary.sprawdz(kluczPary(req.ip, login)).zostaloMs,
        wiarygodnyAdres(req) ? adresy.sprawdz(req.ip).zostaloMs : 0,
      );
      return { wolno: zostaloMs === 0, zostaloMs };
    },
    kluczPary,
    sprawdzPare: (ip, login, teraz = Date.now()) => pary.sprawdz(kluczPary(ip, login), teraz),
    odnotujBlad(ip, login, teraz = Date.now()) {
      for (const [h, k] of liczniki(ip, login)) {
        // Odrzucona próba nie przedłuża trwającej kary ani nie otwiera nowego wpisu logu.
        if (h.sprawdz(k, teraz).wolno) h.odnotujBlad(k, teraz);
      }
      return sprawdz(ip, login, teraz);
    },
    wyczysc: (ip, login) => pary.wyczysc(kluczPary(ip, login)),
    zapiszBlokadeRaz(ip, login, teraz = Date.now()) {
      // Bez short-circuit: oznaczamy wszystkie aktywne kary tym samym wpisem.
      return liczniki(ip, login)
        .map(([h, k]) => h.zapiszBlokadeRaz(k, teraz))
        .some(Boolean);
    },
    async opoznij(ip, login, teraz = Date.now(), twardyAdres = false) {
      const ms = Math.max(
        twardyAdres ? 0 : adresy.sprawdz(ip, teraz).zostaloMs,
        konta.sprawdz(loginKlucza(login), teraz).zostaloMs,
      );
      // Pełne 2 s odmowy POD blokadą kolejki: kolejna walidacja tego klucza dopiero
      // po zwolnieniu. Poprawne hasło omija miękką karę, ale nie kolejkę ani twarde IP.
      if (ms > 0) await czekaj(2_000);
    },
    rozmiary: () => [pary.rozmiar(), adresy.rozmiar(), konta.rozmiar()],
  };
}
