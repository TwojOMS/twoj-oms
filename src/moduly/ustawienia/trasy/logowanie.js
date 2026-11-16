import {
  podpisz, ciasteczkoSesji, ciasteczkoWyczyszczenia, nazwaCiasteczkaOms,
} from '../../../core/bezpieczenstwo/sesja.js';
import { hamulecLogowaniaDla } from '../../../core/bezpieczenstwo/hamulec.js';
import {
  rowneStaloCzasowo, polaczenieBezpieczne,
} from '../../../core/bezpieczenstwo/logowanie-wspolne.js';
import { wczytajSekret } from '../../../core/bezpieczenstwo/sekret-sesji.js';
// ⚠️ `bezpiecznyPowrot` mieszka w core/bezpieczenstwo/powrot.js — to OGÓLNA bramka na
// przekierowanie, nie część przełącznika motywu (domena/motyw.js tylko go przekazuje dalej).
// Kopiowanie go tutaj dałoby dwie implementacje tej samej reguły bezpieczeństwa, które
// rozjadą się przy pierwszej poprawce.
import { bezpiecznyPowrot } from '../../../core/bezpieczenstwo/powrot.js';
import { kontoPoLoginie, dopiszLogowanie, czyIstniejeCzynnyAdmin } from '../../../core/bezpieczenstwo/konta.js';
import { zahaszuj, zgodneHaslo } from '../../../domena/hasla.js';
import { MODULY_FAKTUR } from '../../../domena/wybor-programu.js';

// Programy do faktur z rejestru wyboru programu (dostępne bez zgody, bez „Brak”): „A albo B”, „A, B albo C”.
// Z rejestru, a nie wpisane w widok — nowy program pojawi się na ekranie logowania sam. Program dostępny
// dopiero po zgodzie instalacji nie trafia na ekran, który widzi każdy.
const programyFaktur = () => {
  const nazwy = MODULY_FAKTUR.filter((m) => m.dostepny === true && m.id !== 'brak').map((m) => m.etykieta);
  return nazwy.length > 1 ? `${nazwy.slice(0, -1).join(', ')} albo ${nazwy.at(-1)}` : (nazwy[0] ?? '');
};

// W demo nazwa nadawcy ma dopisek „(demo)” dla dokumentów. Na ekranie logowania zdanie i tak mówi,
// że firma jest zmyślona, więc dopisek byłby powtórzeniem.
const bezDopiskuDemo = (nazwa) => nazwa.replace(/\s*\(demo\)$/i, '');

// `firma` — nazwa z adresu firmy (plik albo Ustawienia), czytana przy każdym wejściu na ekran.
export function registerLogowanieRoutes(app, { db, config, firma = /** @type {() => (string | null)} */ (() => null) }) {
  const nazwaCiasteczka = nazwaCiasteczkaOms(config.proba);
  const nazwaFirmy = () => {
    const n = String(firma() ?? '').trim();
    return (config.demo ? bezDopiskuDemo(n) : n) || null;
  };
  // Formularz konta w demo: wejście `/login?konto`, powrót po błędzie tego formularza i po ustawieniu hasła.
  const formularzKonta = (req) => Boolean(config.demo)
    && (req.query?.konto !== undefined || req.body?.formularz === 'konto' || req.query?.haslo === 'ustawione');
  const ekran = (req, reply, dane) => reply.view('login.ejs', {
    title: 'Logowanie',
    bezPaska: true,
    ekranLogowania: true,
    firma: nazwaFirmy(),
    programyFaktur: programyFaktur(),
    formularzKonta: formularzKonta(req),
    komunikat: null,
    blad: null,
    zostaloS: 0,
    ...dane,
  });
  const hamulec = hamulecLogowaniaDla(db);
  // ⚠️⚠️ ZAPIS-ATRAPA, POLICZONY RAZ przy rejestracji tras, nie przy każdym żądaniu — patrz
  // użycie niżej. Scrypt (N=16384) to jedyny drogi krok w całej trasie: gdy liczy się
  // WYŁĄCZNIE dla konta istniejącego i czynnego, odpowiedź trwa kilkadziesiąt ms zamiast
  // kilku, a z samego czasu odpowiedzi da się wyliczyć loginy pracowników i to, które konta
  // są wyłączone.
  const ATRAPA_HASLA = zahaszuj('atrapa-czasu-logowania-nigdy-nie-jest-prawdziwym-haslem');

  app.get('/login', async (req, reply) => ekran(req, reply, {
    powrot: bezpiecznyPowrot(req.query?.powrot),
    // Po ustawieniu hasła z jednorazowego linku (trasy/haslo-link.js) — bez automatycznego logowania.
    komunikat: req.query?.haslo === 'ustawione' ? 'Hasło ustawione — zaloguj się nowym hasłem.' : null,
  }));

  async function loguj(req, reply) {
    const powrot = bezpiecznyPowrot(req.body?.powrot);
    const login = String(req.body?.uzytkownik ?? '');

    const odmowLimit = (stan, zapisz = true) => {
      // ⚠️ Ta gałąź wraca PRZED `dopiszLogowanie` niżej, więc bez tego wpisu z dziennika
      // wypadałyby dokładnie najgłośniejsze próby, czyli te, o które dziennik pyta się
      // najczęściej. Bez sprawdzania hasła (i tak nie liczymy tu scryptu — kara już trwa) —
      // własny wynik `zablokowane`, żeby nie mylić go ze zwykłym złym hasłem.
      //
      // ⚠️⚠️ Wpis NIE na każde żądanie w trakcie kary: hamulec sam NIE PISZE, więc nic by go
      // nie spowalniało, a kara zamieniłaby się w pisanie bez ograniczenia. `zapiszBlokadeRaz`
      // pilnuje, żeby jedna kara dała co najwyżej jeden taki wiersz (patrz hamulec.js).
      if (zapisz && hamulec.zapiszBlokadeRaz(req.ip, login)) {
        dopiszLogowanie(db, {
          login: String(req.body?.uzytkownik ?? ''), usluga: 'oms', ip: req.ip, wynik: 'zablokowane',
        });
      }
      return ekran(req, reply.status(429).header('Retry-After', Math.ceil(stan.zostaloMs / 1000)), {
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

    // ⚠️⚠️ Scrypt liczy się ZAWSZE, także gdy `zTabeli` nie istnieje albo jest wyłączone —
    // przeciwko `ATRAPA_HASLA` (zbudowanej RAZ wyżej, przy rejestracji tras). Skrót
    // `zTabeli.czynne && zgodneHaslo(...)` pomijałby scrypt dla konta nieistniejącego albo
    // wyłączonego. Z zawsze liczonym scryptem konto istniejące ze złym hasłem, nieistniejące
    // i wyłączone odpowiadają w podobnym czasie (rzędu 100 ms), w granicach szumu pomiaru.
    // Wynik porównania z ATRAPA_HASLA jest ODRZUCANY (patrz `hasloPasuje` niżej) — chodzi
    // WYŁĄCZNIE o to, żeby czas był ten sam, nie o to, żeby atrapa kogokolwiek wpuściła.
    const zgodnoscZHaszem = zgodneHaslo(req.body?.haslo ?? '', wierszHasla?.hash_hasla ?? ATRAPA_HASLA);
    // ⚠️⚠️ `zgodnoscZHaszem` powyżej LICZY SIĘ ZAWSZE (scrypt, dla kanału czasowego — patrz
    // ATRAPA_HASLA wyżej), także gdy porównanie poszło przeciw ATRAPA_HASLA, bo `wierszHasla`
    // było puste. Samo `zTabeli` w `wpuszczony` niżej odrzuca taki wynik TYLKO dla konta
    // NIEISTNIEJĄCEGO. Dla konta, które W TABELI JEST, a `wierszHasla` wyszłoby puste (dziś
    // nieosiągalne: `hash_hasla TEXT NOT NULL`), bezpieczeństwo trzymałby wyłącznie schemat
    // bazy. Jawna bramka na `wierszHasla !== null` odcina to od schematu: nawet gdyby ta
    // kolumna kiedyś stała się nullable, atrapa hasła (jawny string w źródle) nie mogłaby
    // sama stać się prawdziwym hasłem do cudzego konta.
    const hasloPasuje = wierszHasla !== null && zgodnoscZHaszem;

    // ⚠️⚠️ Dopóki w tabeli jest CZYNNY admin, `/login` odrzuca hasło z `.env` DOKŁADNIE jak
    // każde złe hasło — inaczej to poświadczenie maszynowe (Basic Auth programu zewnętrznego)
    // dałoby się zamienić formularzem na ciasteczko przeglądarkowe, które otwiera trasy
    // `/api/*` z zapisami.
    //
    // Gdy nie ma czynnego admina (`czynnyAdminIstnieje === false`), `.env` MA dalej wpuszczać —
    // to jedyna droga pierwszego uruchomienia, także w nowej instalacji (pilnuje tego
    // tests/moduly/ustawienia/logowanie.test.js).
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
        // ⚠️ `hasloPasuje` jest policzone ZAWSZE (scrypt wyżej), więc dziennik mówi to, co
        // NAPRAWDĘ wiadomo: hasło było zgodne (a blokuje wyłącznie `czynne`) → konto
        // wyłączone; hasło było złe → złe hasło, niezależnie od tego, czy konto jest czynne.
        // Dziennik nie twierdzi, że ustalił coś, czego nie sprawdził.
        //
        // ⚠️⚠️ TRZECI wynik, osobny od „złe hasło” — hasło z `.env` było w rzeczywistości
        // POPRAWNE, ale odrzucone, bo w tabeli jest już czynny admin. Administrator czytający
        // dziennik ma widzieć, że ktoś ZNA hasło serwisowe i próbuje go użyć, a nie że ktoś
        // zgadywał na ślepo — to dwie różne sprawy.
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
      return ekran(req, reply.status(401), {
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
    if (!zwolnij) return ekran(req, reply.status(429).header('Retry-After', 2), {
      powrot: bezpiecznyPowrot(req.body?.powrot), blad: 'zablokowane', zostaloS: 2,
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
