import {
  podpisz, ciasteczkoSesji, ciasteczkoWyczyszczenia, nazwaCiasteczkaOms,
} from '../../../core/bezpieczenstwo/sesja.js';
import { hamulecLogowaniaDla } from '../../../core/bezpieczenstwo/hamulec.js';
import {
  czyTrasaOtwarta, rowneStaloCzasowo, polaczenieBezpieczne,
} from '../../../core/bezpieczenstwo/logowanie-wspolne.js';
// Re-eksport: straznik i testy siegaly po nie tutaj, zanim staly sie wspolne.
export { czyTrasaOtwarta, polaczenieBezpieczne };
import { wczytajSekret } from '../../../core/bezpieczenstwo/sekret-sesji.js';
// ⚠️ `bezpiecznyPowrot` mieszka w domain/motyw.js, bo tam powstal — ale jest OGOLNA bramka
// na przekierowanie, nie czescia przelacznika motywu. Kopiowanie go tutaj dalo by dwie
// implementacje tej samej reguly bezpieczenstwa, ktore rozjada sie przy pierwszej poprawce.
import { bezpiecznyPowrot } from '../../../core/bezpieczenstwo/powrot.js';
import { kontoPoLoginie, dopiszLogowanie, czyIstniejeCzynnyAdmin } from '../../../core/bezpieczenstwo/konta.js';
import { zahaszuj, zgodneHaslo } from '../../../domena/hasla.js';

export function registerLogowanieRoutes(app, { db, config }) {
  const nazwaCiasteczka = nazwaCiasteczkaOms(config.proba); // PRZ-080
  const hamulec = hamulecLogowaniaDla(db);
  // ⚠️⚠️ W2 (recenzja 2026-09-12): ZAPIS-ATRAPA, POLICZONY RAZ przy rejestracji tras, nie
  // przy kazdym zadaniu — patrz uzycie nizej. Zmierzone PRZED ta poprawka na prawdziwym
  // serwerze (mediana z czterech prob): konto istniejace i czynne ze zlym haslem — 47,6 ms;
  // konto nieistniejace — 6,8 ms; konto wylaczone — 6,1 ms. Powod: `zTabeli.czynne &&
  // zgodneHaslo(...)` skracalo reszte przez `&&`, wiec scrypt (N=16384, jedyny drogi krok
  // w calej trasie) odpalal sie WYLACZNIE dla konta istniejacego i czynnego — a to pozwala
  // wyliczyc loginy pracownikow i to, ktore konta sa wylaczone, z samego czasu odpowiedzi.
  const ATRAPA_HASLA = zahaszuj('atrapa-czasu-logowania-nigdy-nie-jest-prawdziwym-haslem');

  app.get('/login', async (req, reply) => reply.view('login.ejs', {
    title: 'Logowanie',
    bezPaska: true,
    powrot: bezpiecznyPowrot(req.query?.powrot),
    blad: null,
    zostaloS: 0,
    // PRZ-069: po ustawieniu hasła z jednorazowego linku (trasy/haslo-link.js) — bez automatycznego logowania.
    komunikat: req.query?.haslo === 'ustawione' ? 'Hasło ustawione — zaloguj się nowym hasłem.' : null,
  }));

  async function loguj(req, reply) {
    const powrot = bezpiecznyPowrot(req.body?.powrot);
    const login = String(req.body?.uzytkownik ?? '');

    const odmowLimit = (stan, zapisz = true) => {
      // ⚠️ W3 (recenzja 2026-09-12): ten wpis BRAKOWAL. Osiem zlych prob pod rzad dawalo
      // PIEC wpisow w dzienniku — ta galaz wracala PRZED `dopiszLogowanie` nizej, wiec
      // wypadaly z logu dokladnie najglosniejsze proby, czyli te, o ktore dziennik pyta
      // sie najczesciej. Bez sprawdzania hasla (i tak nie liczymy tu scryptu — kara juz
      // trwa) — wlasny wynik `zablokowane`, zeby nie mylic go ze zwyklym zlym haslem.
      //
      // ⚠️⚠️ N1 (druga fala 2026-09-12): W3 pisalo TEN wpis na KAZDE zadanie w trakcie kary,
      // nie tylko na pierwsze — hamulec sam NIE PISZE, wiec nic go nie spowalnialo, i 60 s
      // kary zamienialo sie w 60 s pisania bez ograniczenia. `zapiszBlokadeRaz` pilnuje, zeby
      // jedna kara dala co najwyzej jeden taki wiersz (patrz hamulec.js).
      if (zapisz && hamulec.zapiszBlokadeRaz(req.ip, login)) {
        dopiszLogowanie(db, {
          login: String(req.body?.uzytkownik ?? ''), usluga: 'oms', ip: req.ip, wynik: 'zablokowane',
        });
      }
      return reply.status(429).header('Retry-After', Math.ceil(stan.zostaloMs / 1000)).view('login.ejs', {
        title: 'Logowanie',
        bezPaska: true,
        powrot,
        blad: 'zablokowane',
        zostaloS: Math.ceil(stan.zostaloMs / 1000),
      });
    };
    const stan = hamulec.sprawdzPrzedProba(req, login);
    if (!stan.wolno) return odmowLimit(stan);

    // Najpierw konto z tabeli, potem — i tylko jesli tam go nie ma — haslo z `.env`.
    const zTabeli = kontoPoLoginie(db, req.body?.uzytkownik ?? '');
    const wierszHasla = zTabeli
      ? db.prepare('SELECT hash_hasla FROM konta WHERE id = ?').get(zTabeli.id)
      : null;

    // ⚠️ OBA porownania konta serwisowego licza sie ZAWSZE, takze gdy zTabeli juz istnieje.
    // Skrot `&&`/wczesniejszy `return` przerwalby po nazwie konta i czas odpowiedzi
    // zdradzalby, czy login byl trafiony — ta sama regula, co przed tym zadaniem.
    const zgodnyUzytkownik = rowneStaloCzasowo(req.body?.uzytkownik, config.auth.user);
    const zgodneHasloEnv = rowneStaloCzasowo(req.body?.haslo, config.auth.pass);

    // ⚠️⚠️ W2 (recenzja 2026-09-12): scrypt liczy sie ZAWSZE, takze gdy `zTabeli` nie
    // istnieje albo jest wylaczone — przeciwko `ATRAPA_HASLA` (zbudowanej RAZ wyzej, przy
    // rejestracji tras). Wczesniej `zTabeli.czynne && zgodneHaslo(...)` skracalo sie przez
    // `&&` PRZED wywolaniem scryptu dla konta nieistniejacego albo wylaczonego (47,6 ms /
    // 6,8 ms / 6,1 ms, patrz `ATRAPA_HASLA` wyzej). PO TEJ POPRAWCE zmierzone (mediana
    // z 8 prob na osobnych serwerach, zeby hamulec nie wciol scryptu po piatej probie):
    // istniejace+czynne ze zlym haslem 97,3 ms; nieistniejace 93,4 ms; wylaczone 98,6 ms —
    // trzy przypadki w granicach szumu pomiaru, nierozroznialne. Wynik porownania
    // z ATRAPA_HASLA jest ODRZUCANY (patrz `hasloPasuje` i komentarz N4 nizej) — chodzi
    // WYLACZNIE o to, zeby czas byl ten sam, nie o to, zeby atrapa kogokolwiek wpuscila.
    const zgodnoscZHaszem = zgodneHaslo(req.body?.haslo ?? '', wierszHasla?.hash_hasla ?? ATRAPA_HASLA);
    // ⚠️⚠️ N4 (druga fala 2026-09-12): `zgodnoscZHaszem` powyzej LICZY SIE ZAWSZE (scrypt,
    // dla kanalu czasowego — patrz ATRAPA_HASLA wyzej), takze gdy porownanie poszlo przeciw
    // ATRAPA_HASLA, bo `wierszHasla` bylo puste. Komentarz w tym miejscu twierdzil kiedys,
    // ze taki wynik jest „ZAWSZE odrzucany" dzieki `zTabeli &&` w `wpuszczony` nizej — ale to
    // bylo prawdziwe TYLKO dla konta NIEISTNIEJACEGO. Dla konta, ktore W TABELI JEST, a
    // `wierszHasla` wyszloby puste (dzis nieosiagalne: `hash_hasla TEXT NOT NULL`), `zTabeli`
    // samo w sobie jest prawdziwe niezaleznie od `wierszHasla` — wiec bezpieczenstwo bylo
    // PRZYPADKOWE (trzyma je wylacznie schemat bazy), nie ZAMIERZONE (trzyma je kod). Jawna
    // bramka na `wierszHasla !== null` odcina to od schematu: nawet gdyby ta kolumna kiedys
    // stala sie nullable, atrapa hasla (jawny string w zrodle) nie moglaby sama stac sie
    // prawdziwym haslem do cudzego konta.
    const hasloPasuje = wierszHasla !== null && zgodnoscZHaszem;

    // ⚠️⚠️ DECYZJA WLASCICIELA (druga fala 2026-09-12, punkt 5): dopoki w tabeli jest CZYNNY
    // admin, `/login` ma odrzucac haslo z `.env` DOKLADNIE jak kazde zle haslo — inaczej
    // takie poswiadczenie maszynowe (Basic Auth panelu :3000, integracja „Dodaj do OMS")
    // dawaloby sie zamienic formularzem na ciasteczko przegladarkowe, ktore otwiera 9 tras
    // `/api/*` z zapisami. Do tego udane logowanie serwisowe wola `hamulec.wyczysc(req.ip)`
    // nizej — bez tej bramki kazdy, kto zna haslo z `.env`, moglby nim kasowac sobie licznik
    // prob i bez konca zgadywac hasla kont z tabeli, nigdy nie zapalajac kary.
    //
    // Przy PUSTEJ tabeli (`czynnyAdminIstnieje === false`) `.env` MA dalej wpuszczac — to
    // jedyna droga pierwszego uruchomienia, takze u kogos, kto kupil ten kod (pilnuje tego
    // tests/oms/logowanie.test.js).
    const czynnyAdminIstnieje = czyIstniejeCzynnyAdmin(db);
    const wpuszczonySerwisowo = zgodnyUzytkownik && zgodneHasloEnv && !czynnyAdminIstnieje;

    const wpuszczony = zTabeli
      ? (zTabeli.czynne && hasloPasuje)
      : wpuszczonySerwisowo;

    if (!wpuszczony) {
      const limit = hamulec.odnotujBlad(req.ip, login);
      dopiszLogowanie(db, {
        login: String(req.body?.uzytkownik ?? ''), usluga: 'oms', ip: req.ip,
        // ⚠️ Dziennik ODROZNIA „zle haslo" od „konto wylaczone", a ekran logowania NIE.
        // Czlowiekowi nie mowimy, ktore pole bylo zle; administratorowi czytajacemu
        // dziennik mowimy wszystko — to sa dwa rozne czytelniki.
        //
        // ⚠️ D5 (recenzja 2026-09-12): PRZED W2 haslo dla konta wylaczonego nie bylo w ogole
        // sprawdzane (`&&` skracal sie na `zTabeli.czynne`), a dziennik i tak pisal
        // „konto-wylaczone" — czyli twierdzil, ze cos ustalil, czego nie sprawdzil. Teraz
        // `hasloPasuje` jest policzone ZAWSZE (W2 wyzej), wiec dziennik mowi to, co
        // NAPRAWDE wiadomo: haslo bylo zgodne (a blokuje wylacznie `czynne`) → konto
        // wylaczone; haslo bylo zle → zle haslo, niezaleznie od tego, czy konto jest czynne.
        //
        // ⚠️⚠️ Punkt 5 (druga fala 2026-09-12): TRZECI wynik, osobny od „zle haslo" — haslo
        // z `.env` bylo w rzeczywistosci POPRAWNE, ale odrzucone bo w tabeli jest juz czynny
        // admin. Administrator czytajacy dziennik ma widziec, ze ktos ZNA haslo serwisowe
        // i probuje go uzyc, a nie ze ktos zgadywal na slepo — to dwie rozne sprawy.
        wynik: (() => {
          if (zTabeli) return hasloPasuje ? 'konto-wylaczone' : 'zle-haslo';
          if (zgodnyUzytkownik && zgodneHasloEnv && czynnyAdminIstnieje) return 'serwisowe-odrzucone';
          return 'zle-haslo';
        })(),
      });
      // ⚠️ Proba, ktora WLASNIE zapalila kare, oddaje 429, a nie 401 — mimo ze byla takze
      // nieudanym logowaniem. Inaczej ekran mowilby „za duzo prob", a status odpowiedzi
      // „zle haslo": kto czyta log, zobaczylby co innego niz operator na ekranie.
      if (!limit.wolno) {
        // Opóźnienie tylko błędnej odpowiedzi: poprawne hasło omija szeroki limit.
        // Logujemy przed czekaniem, żeby wygaśnięcie 2 s kary nie zgubiło wpisu.
        if (hamulec.zapiszBlokadeRaz(req.ip, login)) dopiszLogowanie(db, {
          login, usluga: 'oms', ip: req.ip, wynik: 'zablokowane',
        });
        await hamulec.opoznij(req.ip, login, Date.now(), hamulec.wiarygodnyAdres(req));
        return odmowLimit(limit, false);
      }
      return reply.status(401).view('login.ejs', {
        title: 'Logowanie',
        bezPaska: true,
        powrot,
        // ⚠️ Komunikat NIE MOWI, ktore pole bylo zle. „Zly login" i „zle haslo" to dwa
        // rozne komunikaty, z ktorych zgadujacy odczytuje, ze nazwa konta jest trafiona.
        blad: 'zle-dane',
        zostaloS: 0,
      });
    }

    hamulec.wyczysc(req.ip, login);
    dopiszLogowanie(db, {
      login: String(req.body?.uzytkownik ?? ''), usluga: 'oms', ip: req.ip,
      wynik: zTabeli ? 'udane' : 'serwisowe',
    });
    return reply
      .header('Set-Cookie', ciasteczkoSesji(
        nazwaCiasteczka,
        // ⚠️ Login z TABELI, a nie zawsze `config.auth.user` — inaczej ciasteczko konta
        // z tabeli podpisywaloby sie loginem serwisowym, a straznik (dopuscZalogowanego)
        // szukalby w tabeli konta, ktorego login nie zgadza sie z tym, kto sie wlasnie
        // zalogowal.
        podpisz(zTabeli ? zTabeli.login : config.auth.user, wczytajSekret(db), Date.now(), zTabeli ? zTabeli.wersja_hasla : 0),
        { bezpieczne: polaczenieBezpieczne(req) },
      ))
      .redirect(powrot);
  }

  app.post('/login', async (req, reply) => {
    const zwolnij = await hamulec.zajmij(req, String(req.body?.uzytkownik ?? ''));
    if (!zwolnij) return reply.status(429).header('Retry-After', 2).view('login.ejs', {
      title: 'Logowanie', bezPaska: true, powrot: bezpiecznyPowrot(req.body?.powrot), blad: 'zablokowane', zostaloS: 2,
    });
    try { return await loguj(req, reply); }
    finally { zwolnij(); }
  });

  // ⚠️ POST, nie GET — z tego samego powodu, co przelacznik motywu. Wylogowanie GET-em
  // uruchamialaby przegladarka wczytujaca odnosniki naprzod, i operator wylatywalby
  // z panelu bez dotkniecia czegokolwiek.
  app.post('/wyloguj', async (req, reply) => reply
    .header('Set-Cookie', ciasteczkoWyczyszczenia(nazwaCiasteczka, { bezpieczne: polaczenieBezpieczne(req) }))
    .redirect('/login'));

}
