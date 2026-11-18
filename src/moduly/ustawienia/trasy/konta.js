// Ekran zarządzania kontami i uprawnieniami — /ustawienia/konta.
//
// Lista kont, formularz nowego konta, per-konto formularz uprawnień/hasła/przełącznika
// czynne i dziennik prób logowania (na tym samym ekranie, nie osobno — administrator, który
// podejrzewa włamanie, ma zobaczyć oba naraz: kto ma dostęp i kto próbował go zdobyć).

import {
  zalozKonto,
  listaKont,
  ustawUprawnienia,
  ustawCzynne,
  ustawAdmina,
  zmienHaslo,
  uprawnieniaKonta,
  ostatnieLogowania,
  kontoPoLoginie,
} from '../../../core/bezpieczenstwo/konta.js';
import { EKRANY, ROLE, ekranyRoli } from '../../../domena/ekrany.js';
import { nawigacjaUstawien } from '../nawigacja.js';
import { podmienSekret, sekretZmienionyAt } from '../../../core/bezpieczenstwo/sekret-sesji.js';
import { ciasteczkoWyczyszczenia, NAZWA_CIASTECZKA_OMS } from '../../../core/bezpieczenstwo/sesja.js';
import { polaczenieBezpieczne } from '../../../core/bezpieczenstwo/logowanie-wspolne.js';
// Role w bazie — lista ról, przypisanie roli i stara trasa ptaszków przez rolę osobistą.
import { listaRol, rolaPoKluczu, przypiszRole, ustawPtaszkiPrzezRole, opisRoliKonta } from '../role.js';
// E-mail konta, zaproszenia i reset hasła jednorazowym linkiem (mail albo „Pokaż link”).
import { wydajLink, uniewaznijLinkiKonta, zastapPoprzednieLinki, wycofajLink } from '../linki-hasla.js';
import {
  zalozKontoZaproszone,
  zalozKontoZHaslem,
  ustawEmail,
  sprawdzEmail,
  emailKonta,
  BladKonta,
} from '../konta-dostep.js';
import { trescMaila } from '../poczta-kont.js';
import { oznaczBladPoczty, komunikatWysylkiMaila } from '../../wiadomosci/poczta-ustawien.ts';
import { wczytajSzablonyWiadomosci } from '../../../oms/db/szablony-wiadomosci.js';
import { modelKonta, MAKS_IMIENIA } from './moje-konto.js';
import { POLITYKA_REFERERA_LINKU } from './haslo-link.js';
import { adresLinkow } from '../adres-panelu.ts';
import { malymi } from '../role.js';
import { kontoWPodgladzieDemo, logowaniaDemo } from '../../../core/bezpieczenstwo/podglad-demo.js';
import { stronaOdmowy } from '../../../core/web/odmowa.js';

// Odmowa 404 w układzie OMS (zamiast gołego tekstu) z powrotem na listę kont —
// konto, którego nie ma, nie ma też własnej strony. Status, tekst i kolejność sprawdzeń bez zmian.
const BRAK_KONTA = { tytul: 'Nie znaleziono konta', wroc: '/ustawienia/konta', napisWroc: 'Wróć do kont' };
const BRAK_ROLI = { tytul: 'Nie znaleziono roli', wroc: '/ustawienia/konta', napisWroc: 'Wróć do kont' };

// ⚠️ EKRAN JEST TYLKO DLA KONTA Z FLAGA `admin` — niezaleznie od ptaszka na „Ustawieniach".
// Rola bez flagi admin może dostać ptaszek „Ustawienia” (administrator edytuje role),
// ale zakładanie kont to inna stawka: kto zakłada konta, nadaje sobie każde uprawnienie.
function tylkoAdmin(req, reply) {
  if (req.konto?.admin) return null;
  // Gość demo publicznego OGLĄDA ten ekran (podglad-demo.js) — wyłącznie GET; zapis blokuje już hak.
  if (req.konto?.podgladDemo && req.method === 'GET') return null;
  // ⚠️ `wlasnyUklad: true`, NIE `bezPaska` (ktore samo w sobie nie wystarcza — dziala tylko
  // WEWNATRZ layout-oms.ejs). `brak-dostepu.ejs` jest SAMODZIELNYM DOKUMENTEM z wlasnym
  // `<!doctype html>` (jak w `odmow()` w straznik.js) — bez
  // `wlasnyUklad` layout-oms.ejs opakowalby ten dokument w DRUGI `<!doctype html>`/`<html>`,
  // bo ta trasa idzie PRZEZ zwykly handler (a wiec PO haku `preHandler`, w przeciwienstwie do
  // `odmow()` w straznik.js, ktory dziala w `onRequest` i dlatego dodatkowo sam dolicza
  // `motyw`) — `reply.locals.motyw` z preHandlera i tak dojdzie do szablonu przez merge
  // w @fastify/view (`Object.assign({}, defaultCtx, this.locals, data)`), ale layout i TAK
  // by sie odpalil, dajac dokument zagniezdzony w dokumencie.
  return reply.code(403).view('brak-dostepu.ejs', { title: 'Brak dostępu', wlasnyUklad: true });
}

/** Ptaszki zgodne z presetem roli? Ekran ma mowic prawde, a nie powtarzac etykiete. */
function zgodneZRola(rola, ekrany) {
  const preset = new Set(ekranyRoli(rola));
  return preset.size === ekrany.size && [...preset].every((e) => ekrany.has(e));
}

/**
 * Czy PO ustawieniu (`czynne`, `admin`) na koncie `kontoId` w bazie zostanie choć JEDEN
 * czynny administrator — licząc WSZYSTKIE konta, nie tylko to jedno.
 *
 * ⚠️⚠️ TRZECI BEZPIECZNIK.
 * Uprawnienia konta serwisowego z `.env` degradują się STANEM BAZY (`czyIstniejeCzynnyAdmin`,
 * core/bezpieczenstwo/konta.js): dopóki nie ma ani jednego czynnego admina, hasło z pliku jest
 * PEŁNYM adminem (straznik.js, `dopuscSerwisowe`) — to jedyna droga pierwszego startu, także
 * w nowej instalacji. Gdyby dało się wyłączyć albo odebrać admina OSTATNIEMU czynnemu
 * administratorowi, brama degradacji zamykałaby się NA ZAWIAS: kto zna hasło z `.env`,
 * odzyskiwałby pełne uprawnienia JEDNYM KLIKNIĘCIEM w ten właśnie formularz. Do tego jest to
 * zwykłe zabezpieczenie przed zamknięciem się poza panelem — bez niego powrót jest wyłącznie
 * przez SSH do bazy.
 *
 * Funkcja CELOWO NIE ZNA `req.konto` i nie rozróżnia „sobie” od „komuś innemu” — porównuje
 * stan PO operacji ze stanem PRZED. Odebranie admina KOMUŚ INNEMU, kto akurat jest jedynym
 * czynnym adminem, to DOKŁADNIE taka sama dziura jak zrobienie tego sobie — bezpiecznik
 * „nie odbierz sobie” (niżej) dotyczy tylko własnego konta i działa zawsze, nawet gdy inni
 * admini zostają; ten tutaj jest ogólną regułą stanu dla WSZYSTKICH kont, własnych i cudzych.
 *
 * ⚠️⚠️ NIE WYSTARCZY spytać „czy PO operacji zostanie choć jeden czynny admin” w oderwaniu
 * od tego, ilu ich było PRZED. Gdy jedyny admin jest WYŁĄCZONY (zero czynnych), ponowny zapis
 * formularza uprawnień TEGO SAMEGO konta (`admin` zostaje `true`, `czynne` zostaje `false`,
 * bo ta trasa nie zmienia `czynne`) dostałby odmowę „to jest OSTATNI czynny administrator”,
 * choć operacja niczego nie pogarsza (przed: zero, po: zero). Ta sama odmowa blokowałaby
 * MIANOWANIE admina innemu, aktywnemu kontu — jedyną drogę odzyskania panelu bez SSH do bazy.
 * Blokujemy WYŁĄCZNIE prawdziwe pogorszenie: przejście od „TO konto było jedynym czynnym
 * adminem” do „nie będzie go wcale”. Gdy PRZED operacją to konto i tak nie było czynnym
 * adminem (a nikt inny też nie), operacja przechodzi zawsze — nie da się zejść poniżej zera.
 */
function pozostanieCzynnyAdmin(db, kontoId, { czynne, admin }) {
  const wszyscy = listaKont(db);
  const inni = wszyscy.filter((k) => k.id !== kontoId);
  // Konto zaproszone (bez hasła) nie jest czynnym administratorem — nie zamyka bramy degradacji.
  if (inni.some((k) => k.czynne && k.admin && !k.zaproszone)) return true;
  // Nikt INNY nie jest czynnym adminem — liczy sie WYLACZNIE los TEGO konta.
  const toKonto = wszyscy.find((k) => k.id === kontoId);
  const bylCzynnyAdminemPrzed = Boolean(toKonto?.czynne) && Boolean(toKonto?.admin) && !toKonto?.zaproszone;
  if (!bylCzynnyAdminemPrzed) return true; // nie bylo co stracic — nie da sie zejsc ponizej zera
  return Boolean(czynne) && Boolean(admin);
}

const KOMUNIKAT_OSTATNI_ADMIN =
  'Nie można tego zrobić — to jest OSTATNI czynny administrator. ' +
  'Bez ani jednego czynnego admina hasło serwisowe z .env znowu stałoby się pełnym adminem, ' +
  'więc panel musi mieć zawsze co najmniej jednego. Załóż albo włącz drugie konto ' +
  'administratora, zanim odbierzesz to uprawnienie tutaj.';

const KOMUNIKATY_ZAPISU = {
  nowe: 'Założono konto.',
  uprawnienia: 'Zapisano uprawnienia.',
  haslo: 'Zmieniono hasło.',
  czynne: 'Zmieniono stan konta.',
  rola: 'Zmieniono rolę.',
  email: 'Zapisano e-mail.',
  wyslano: 'Wysłano link e-mailem.',
};

const SPOSOBY_LINKU = ['mail', 'pokaz'];

function polaNowegoKonta(pola = {}) {
  // Hasło celowo nie należy do modelu widoku. Po każdej odmowie trzeba wpisać je ponownie.
  return {
    login: String(pola.login ?? ''),
    imie: String(pola.imie ?? ''),
    rola: String(pola.rola ?? ''),
    email: String(pola.email ?? ''),
  };
}

// `logowania.wynik` w bazie to IDENTYFIKATOR (bez ogonków, stabilny dla kodu — patrz
// logowanie.js), nie tekst dla człowieka. Ekran pokazuje tekst z ogonkami; identyfikator zostaje
// wyłącznie w bazie i w warunkach kodu (np. `wynik = 'udane'` w listaKont,
// core/bezpieczenstwo/konta.js).
const OPISY_WYNIKOW_LOGOWANIA = {
  udane: 'Udane',
  'zle-haslo': 'Złe hasło',
  zablokowane: 'Zablokowane (za dużo prób)',
  serwisowe: 'Serwisowe (hasło z .env)',
  'serwisowe-odrzucone': 'Serwisowe odrzucone (jest czynny admin)',
  'konto-wylaczone': 'Konto wyłączone',
  'haslo-z-linku': 'Hasło ustawione z linku',
};

/**
 * ⚠️ CO Z WYNIKIEM, KTOREGO MAPA NIE ZNA (np. dopisanym za pol roku, gdy ktos doda nowy stan
 * logowania w logowanie.js i zapomni dopisać go tutaj) — NIE chowamy takiego wiersza
 * i nie podmieniamy go na coś ogólnego jak „inny” — pokazujemy SUROWY identyfikator.
 * Administrator, który podejrzewa włamanie, ma zobaczyć KAŻDĄ próbę logowania; dziennik,
 * który milczy o wpisie (albo pokazuje „inny” dla wszystkiego, co nowe), jest gorszy niż
 * dziennik z brzydkim, ale prawdziwym kluczem.
 */
function opisWynikuLogowania(wynik) {
  return OPISY_WYNIKOW_LOGOWANIA[wynik] ?? wynik;
}

/**
 * @param {any} app
 * @param {{ db: any, teraz?: () => Date, adresPanelu?: string | null | (() => string | null), mailer?: () => any, loginSerwisowy?: string | null, nazwaCiasteczka?: string }} opcje
 */
export function registerKontaRoutes(
  app,
  {
    db,
    teraz = () => new Date(),
    adresPanelu: adresPaneluOpcja = null,
    mailer = () => null,
    loginSerwisowy = null,
    nazwaCiasteczka = NAZWA_CIASTECZKA_OMS,
  },
) {
  // Adres panelu czytany przy każdym żądaniu (OMS_ADRES_PANELU albo zapis z Ustawień → Poczta wychodząca).
  const adresTeraz = typeof adresPaneluOpcja === 'function' ? adresPaneluOpcja : () => adresPaneluOpcja;
  // Strona z jednorazowym linkiem nie trafia do pamięci przeglądarki; Referer bez ścieżki.
  // Polityka `strict-origin`, nie `no-referrer` — inaczej każdy formularz tej strony dostaje 403.
  const pokazLinkuNaglowki = (reply) =>
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', POLITYKA_REFERERA_LINKU);
  // Konto z tabeli o loginie konta serwisowego `.env` przesłoniłoby je w strażniku
  // (konto z tabeli ma pierwszeństwo) — dwa różne „serwis” w jednym panelu. Bez względu na wielkość liter.
  const loginZarezerwowany = (login) => Boolean(loginSerwisowy) && malymi(login) === malymi(loginSerwisowy);
  const KOMUNIKAT_LOGIN_SERWISOWY = (login) =>
    `Login „${login}” jest zarezerwowany dla konta serwisowego z .env — wybierz inny.`;
  const komunikatLoginZajety = (login) => `Login „${login}” jest już zajęty przez inne konto — wybierz inny.`;
  // Mail i „Pokaż link” — ta sama zasada (adres-panelu.ts, adresLinkow): plik → zapis → adres, z którego
  // admin właśnie korzysta. Adres z żądania jest tu dopuszczalny, bo każda trasa tego pliku, która wydaje link, stoi
  // za `tylkoAdmin` (test: adres-panelu-domyslny.test.js, „(f)”).
  const adresLinkowDla = (req) => adresLinkow(adresTeraz(), req);
  const komunikatZapisu = (req) => {
    if (req.query?.zapisano !== 'wyslano-domyslny') return KOMUNIKATY_ZAPISU[req.query?.zapisano] ?? null;
    const adres = adresLinkowDla(req);
    return adres?.domyslny
      ? `Wysłano. Link w mailu prowadzi do ${adres.adres} (adres, z którego teraz korzystasz). ` +
          'Jeśli pracownik otworzy go spoza tej sieci, wpisz adres w Ustawienia → Integracje → Poczta wychodząca.'
      : KOMUNIKATY_ZAPISU.wyslano;
  };

  function stronaKonta(req, reply, id, extra = {}) {
    return reply.view('konto.ejs', {
      szerokosc: 'formularz',
      title: 'Konto użytkownika',
      adminWidok: true,
      wlasne: id === req.konto?.id,
      serwisowe: false,
      // Gość demo w podglądzie nie widzi loginu ani imienia administratora (podglad-demo.js).
      konto: req.konto?.podgladDemo
        ? kontoWPodgladzieDemo(
            modelKonta(db, id),
            db.prepare('SELECT admin FROM konta WHERE id = ?').get(id)?.admin === 1,
          )
        : modelKonta(db, id),
      role: listaRol(db).map((r) => ({ klucz: r.klucz, etykieta: r.nazwa })),
      rolaKlucz: db.prepare('SELECT rola FROM konta WHERE id = ?').get(id)?.rola ?? null,
      link: null,
      adresZPrzegladarki: false,
      zapisano: komunikatZapisu(req),
      blad: null,
      nawigacja: nawigacjaUstawien(req, reply),
      ...extra,
    });
  }

  /** Powód odmowy wydania linku — sprawdzany PRZED zapisem czegokolwiek (także przed założeniem konta). */
  function bladWysylki(req, sposob, email) {
    if (!adresLinkowDla(req)) {
      // Bez adresu w pliku i w zapisie, a adres żądania nie przeszedł walidacji (np. dziwny nagłówek z proxy).
      return sposob === 'mail'
        ? 'Wysyłka mailem wymaga adresu panelu (OMS_ADRES_PANELU albo Ustawienia → Integracje → Poczta wychodząca) — użyj „Pokaż link”.'
        : 'Nie da się ustalić adresu panelu z adresu w przeglądarce — wpisz go w Ustawienia → Integracje → Poczta wychodząca.';
    }
    if (sposob !== 'mail') return null;
    if (!mailer()) return 'Wysyłka mailem jest niedostępna (brak SMTP) — użyj „Pokaż link”.';
    if (!email) return 'Konto nie ma adresu e-mail — dopisz go albo użyj „Pokaż link”.';
    return null;
  }

  async function wyslijAlboPokaz(req, reply, { id, cel, sposob }) {
    const konto = modelKonta(db, id);
    const utworzylKontoId = req.konto?.id ?? null;
    const adres = adresLinkowDla(req);
    if (!adres) return stronaKonta(req, reply.code(400), id, { blad: bladWysylki(req, sposob, konto.email) });
    const adresLinku = (token) => `${adres.adres}/haslo/${token}`;
    if (sposob === 'mail') {
      // Poprzedni link przestaje działać DOPIERO po udanej wysyłce. Przy błędzie SMTP
      // nowy link jest wycofany, a poprzedni (np. z „Pokaż link”, już przekazany pracownikowi) działa dalej.
      // W oknie wysyłki konto ma dwa aktywne linki — użycie jednego unieważnia drugi (uzyjLinku).
      const { token, id: linkId } = wydajLink(db, {
        kontoId: id,
        cel,
        utworzylKontoId,
        teraz,
        zastapPoprzednie: false,
      });
      try {
        // Szablon z Ustawień → Szablony wiadomości → Maile do zespołu, czytany przy każdej wysyłce.
        const szablon = wczytajSzablonyWiadomosci(db).wbudowane[cel] ?? null;
        // Znacznik błędu poczty TYLKO na błędzie samego sendMail — błąd odczytu szablonu
        // (np. SQLite z kodem) nie jest odmową serwera poczty.
        await mailer()
          .sendMail({ to: konto.email, ...trescMaila({ cel, imie: konto.imie, link: adresLinku(token), szablon }) })
          .catch((bladWysylki) => {
            throw oznaczBladPoczty(bladWysylki);
          });
      } catch (e) {
        wycofajLink(db, linkId, teraz);
        // Odmowa serwera poczty (kod nodemailera) — zdanie z kodu i wskazówka do Ustawień (ekran tylko dla
        // admina, więc ją widzi); treść błędu nigdy na ekran. Błąd bez kodu — dawne zdanie co do znaku.
        const zPoczty = Boolean(/** @type {any} */ (e)?.zTransportuPoczty);
        return stronaKonta(req, reply.code(502), id, {
          blad: zPoczty
            ? `Nie udało się wysłać maila: ${komunikatWysylkiMaila(e, { wskazUstawienia: true })} Możesz też użyć „Pokaż link”. Poprzedni link, jeśli był, nadal działa.`
            : 'Nie udało się wysłać maila — użyj „Pokaż link”. Poprzedni link, jeśli był, nadal działa.',
        });
      }
      zastapPoprzednieLinki(db, { kontoId: id, nowyLinkId: linkId, teraz });
      // Przy adresie domyślnym komunikat mówi, dokąd prowadzi link (komunikatZapisu).
      return reply.redirect(`/ustawienia/konta/${id}?zapisano=${adres.domyslny ? 'wyslano-domyslny' : 'wyslano'}`);
    }
    const { token } = wydajLink(db, { kontoId: id, cel, utworzylKontoId, teraz });
    return stronaKonta(req, pokazLinkuNaglowki(reply), id, {
      link: adresLinku(token),
      // Bez adresu w pliku i w zapisie link prowadzi pod adres z przeglądarki admina — ekran ma to powiedzieć.
      adresZPrzegladarki: adres.domyslny,
    });
  }

  /** „Dodaj użytkownika”: konto bez hasła i link zaproszenia (mail albo do skopiowania). */
  async function zaproszenie(req, reply, pola, noweKonto) {
    const odmow = (blad) => widok(req, reply.code(400), { blad, noweKonto });
    const login = String(pola.login ?? '').trim();
    const imie = String(pola.imie ?? '').trim();
    const email = String(pola.email ?? '').trim();
    const sposob = String(pola.sposob ?? '');
    const rola = rolaPoKluczu(db, pola.rola);
    if (!login || !imie || !rola) return odmow('Brak loginu, imienia albo nieznana rola.');
    if (imie.length > MAKS_IMIENIA) return odmow(`Imię może mieć najwyżej ${MAKS_IMIENIA} znaków.`);
    if (!SPOSOBY_LINKU.includes(sposob)) return odmow('Wybierz: zaproszenie mailem albo link do skopiowania.');
    if (loginZarezerwowany(login)) return odmow(KOMUNIKAT_LOGIN_SERWISOWY(login));
    if (kontoPoLoginie(db, login)) return odmow(komunikatLoginZajety(login));
    if (email) {
      try {
        sprawdzEmail(db, null, email);
      } catch (e) {
        if (e instanceof BladKonta) return odmow(e.message);
        throw e;
      }
    }
    const blad = bladWysylki(req, sposob, email || null);
    if (blad) return odmow(blad);
    let id;
    try {
      id = zalozKontoZaproszone(db, { login, imie, rola: rola.klucz, email: email || null, teraz });
    } catch (e) {
      // Wyścig (drugi zapis między kontrolą wyżej a INSERT) — UNIQUE z bazy to ta sama odmowa.
      if (e instanceof BladKonta) return odmow(e.kod === 'login-zajety' ? komunikatLoginZajety(login) : e.message);
      throw e;
    }
    return wyslijAlboPokaz(req, reply, { id, cel: 'zaproszenie', sposob });
  }

  function widok(req, reply, { blad = null, noweKonto = null, edycjaUprawnien = null } = {}) {
    const kontaSurowe = listaKont(db);
    // Do wypisania w widoku, ktore konto jest „Ty" (blokuje sobie admina/wylaczenia — patrz
    // konta.ejs) i ktore jest jedynym czynnym adminem (blokuje TO SAMO, ale KOMUKOLWIEK).
    const liczbaCzynnychAdminow = kontaSurowe.filter((k) => k.czynne && k.admin && !k.zaproszone).length;
    const konta = kontaSurowe.map((k) => {
      const podglad = edycjaUprawnien?.id === k.id ? edycjaUprawnien : null;
      const ekrany = podglad?.ekrany ?? uprawnieniaKonta(db, k.id);
      const etykieta = ROLE[k.rola]?.etykieta ?? k.rola;
      return {
        ...k,
        ekrany,
        admin: podglad?.admin ?? k.admin,
        // Nazwa roli z bazy; „+ zmiany” tylko przy rozjeździe ptaszków konta z rolą.
        opisRoli: opisRoliKonta(db, k.id) ?? (zgodneZRola(k.rola, ekrany) ? etykieta : `${etykieta} + zmiany`),
        ostatniAdmin: k.czynne && k.admin && liczbaCzynnychAdminow === 1,
        // Ptaszki per konto renderują się wyłącznie w odpowiedzi 400 starej trasy.
        edycja: podglad !== null,
      };
    });
    const podglad = req.konto?.podgladDemo === true;
    return reply.view('konta.ejs', {
      title: 'Użytkownicy i uprawnienia',
      konta: podglad ? konta.map((k) => kontoWPodgladzieDemo(k, k.admin)) : konta,
      EKRANY,
      nawigacja: nawigacjaUstawien(req, reply),
      role: listaRol(db).map((r) => ({ klucz: r.klucz, etykieta: r.nazwa })),
      // `ip` już płynie z ostatnieLogowania — dołączamy tylko czytelny opis wyniku.
      // W podglądzie demo zmyślony — prawdziwy niesie loginy i IP innych gości (podglad-demo.js).
      logowania: (podglad ? logowaniaDemo(teraz()) : ostatnieLogowania(db, 50)).map((l) => ({
        ...l,
        opisWyniku: opisWynikuLogowania(l.wynik),
      })),
      wlasneId: req.konto?.id ?? null,
      sekretZmieniony: sekretZmienionyAt(db),
      zapisano: KOMUNIKATY_ZAPISU[req.query?.zapisano] ?? null,
      noweKonto: noweKonto ?? polaNowegoKonta(),
      blad,
    });
  }

  app.get('/ustawienia/konta', async (req, reply) => tylkoAdmin(req, reply) ?? widok(req, reply));
  app.get('/ustawienia/zespol/logowania', async (req, reply) => tylkoAdmin(req, reply) ?? widok(req, reply));

  app.post('/ustawienia/konta/wyloguj-wszystkie', async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    podmienSekret(db);
    return reply
      .header('Set-Cookie', ciasteczkoWyczyszczenia(nazwaCiasteczka, { bezpieczne: polaczenieBezpieczne(req) }))
      .redirect('/login');
  });

  app.post('/ustawienia/konta/nowe', async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const pola = req.body ?? {};
    const { imie, haslo, rola } = pola;
    const noweKonto = polaNowegoKonta(pola);
    // Formularz ekranu posyła `sposob` → zaproszenie bez hasła. Ścieżka z `haslo`
    // (bez `sposob`) zostaje dla chronionych testów i skryptów; ekran nie ma już pola hasła.
    if (pola.sposob !== undefined) return zaproszenie(req, reply, pola, noweKonto);
    // PRZYCINAMY białe znaki PRZED każdym użyciem loginu — walidacja pustego pola,
    // sprawdzenie duplikatu i zapis do bazy mają widzieć DOKŁADNIE ten sam login,
    // inaczej `' ewa '` i `'ewa'` zakładałyby dwa różne konta.
    // ⚠️ DECYZJA: NIE zmieniamy wielkosci liter. Login jest dzis porownywany doslownie
    // (kontoPoLoginie, `l.login = k.login` w listaKont) i istniejace konta moga miec
    // wielkosc liter wpisana z rak — wymuszenie malych liter TYLKO dla nowych kont dawaloby
    // dwie rozne semantyki loginu w tej samej bazie (stare: dowolna wielkosc, nowe: zawsze
    // male), co jest mylące samo w sobie.
    const login = String(req.body?.login ?? '').trim();
    const rolaZBazy = rolaPoKluczu(db, rola);
    if (!login || !imie || !haslo || !rolaZBazy) {
      return widok(req, reply.code(400), {
        blad: 'Brak loginu, imienia, hasła albo nieznana rola. Hasło wpisz ponownie.',
        noweKonto,
      });
    }
    // ⚠️⚠️ Duplikat loginu (najczęstsza pomyłka na tym ekranie — „ewa” drugi raz) sprawdzamy
    // PRZED zapisem i pokazujemy ten sam ekran z odmową (`blad` w `widok()`, pas
    // `pas-uprzedzenie` w konta.ejs). Unikalny indeks `konta.login` łapie już tylko wyścig dwóch
    // zapisów — zalozKontoZHaslem (konta-dostep.js) zamienia go na tę samą odmowę, zamiast
    // surowego błędu SQLite w odpowiedzi 500, który wysypałby schemat bazy do przeglądarki.
    if (loginZarezerwowany(login)) {
      return widok(req, reply.code(400), { blad: KOMUNIKAT_LOGIN_SERWISOWY(login), noweKonto });
    }
    if (kontoPoLoginie(db, login)) {
      return widok(req, reply.code(400), {
        blad: komunikatLoginZajety(login),
        noweKonto,
      });
    }
    // Ptaszki konta = ptaszki roli z bazy; INSERT i przypisanie w jednej transakcji.
    try {
      zalozKontoZHaslem(db, { login, imie, haslo, rola: rolaZBazy.klucz });
    } catch (e) {
      if (e instanceof BladKonta && e.kod === 'login-zajety')
        return widok(req, reply.code(400), { blad: komunikatLoginZajety(login), noweKonto });
      throw e;
    }
    return reply.redirect('/ustawienia/konta?zapisano=nowe');
  });

  app.post('/ustawienia/konta/:id/uprawnienia', async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const id = Number(req.params.id);
    const cel = listaKont(db).find((k) => k.id === id);
    if (!cel) return stronaOdmowy(reply, 404, 'Nie ma takiego konta', BRAK_KONTA);

    // Pole `ekran` z formularza: jeden ptaszek przychodzi jako napis, kilka jako tablica,
    // zero — nie przychodzi wcale. Wszystkie trzy postacie to ta sama rzecz.
    const surowe = req.body?.ekran;
    const wybrane = surowe == null ? [] : Array.isArray(surowe) ? surowe : [surowe];
    const znane = new Set(EKRANY.map((e) => e.klucz));
    // ⚠️ `'api'` NIE JEST W `EKRANY` (to syntetyczny klucz z `ekranDlaAdresu` w domena/ekrany.js
    // dla `/api/*` — trasy programu zewnętrznego), więc dostaje wyjątek TUTAJ, zamiast
    // zostać po cichu odfiltrowany razem z każdym innym nieznanym słowem z formularza.
    const ekrany = wybrane.filter((e) => znane.has(e) || e === 'api');
    const admin = req.body?.admin === '1';

    // ⚠️⚠️ TRZECI BEZPIECZNIK PRZED DWOMA PONIZEJ (patrz komentarz przy funkcji): liczy sie
    // TYLKO to, czy po operacji zostanie choc jeden czynny admin — nie kto ja wykonuje. Stoi
    // PIERWSZY, zeby dla admina bedacego OSTATNIM czynnym admin komunikat mowil wprost „to jest
    // ostatni admin", a nie ogolne „nie mozna odebrac sobie" (ponizej), ktore sugerowaloby, ze
    // ktos inny moglby to zrobic za niego.
    if (!pozostanieCzynnyAdmin(db, id, { czynne: cel.czynne, admin })) {
      return widok(req, reply.code(400), {
        blad: KOMUNIKAT_OSTATNI_ADMIN,
        edycjaUprawnien: { id, ekrany: new Set(ekrany), admin },
      });
    }
    // ⚠️⚠️ DWA BEZPIECZNIKI. Odebranie sobie `admin` albo wylaczenie wlasnego konta zamyka
    // czlowieka poza panelem jednym klikiem — a wraca sie wtedy wylacznie przez SSH do bazy.
    // TEN dziala ZAWSZE, nawet gdy zostaja inni admini (w odroznieniu od bezpiecznika wyzej,
    // ktory patrzy wylacznie na LICZBE czynnych adminow) — bo to blokada UX „nie zamykaj sie
    // sam", nie tylko ochrona bramy degradacji.
    if (id === req.konto?.id && !admin) {
      return widok(req, reply.code(400), {
        blad: 'Nie można odebrać sobie uprawnień administratora',
        edycjaUprawnien: { id, ekrany: new Set(ekrany), admin },
      });
    }
    // Wynik per konto, ale zawsze przez rolę — `admin` → Administrator, inaczej rola osobista
    // konta z dokładnie tymi ptaszkami. Ptaszki i flaga `admin` zapisują się w jednej transakcji.
    ustawPtaszkiPrzezRole(db, id, { ekrany, admin, teraz });
    return reply.redirect('/ustawienia/konta?zapisano=uprawnienia');
  });

  // Zmiana roli konta. Bezpieczniki te same i w tej samej kolejności co w /uprawnienia.
  app.post('/ustawienia/konta/:id/rola', async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const id = Number(req.params.id);
    const cel = listaKont(db).find((k) => k.id === id);
    if (!cel) return stronaOdmowy(reply, 404, 'Nie ma takiego konta', BRAK_KONTA);
    const rola = rolaPoKluczu(db, req.body?.rola);
    if (!rola) return stronaOdmowy(reply, 404, 'Nie ma takiej roli', BRAK_ROLI);
    if (!pozostanieCzynnyAdmin(db, id, { czynne: cel.czynne, admin: rola.admin })) {
      return widok(req, reply.code(400), { blad: KOMUNIKAT_OSTATNI_ADMIN });
    }
    if (id === req.konto?.id && !rola.admin) {
      return widok(req, reply.code(400), { blad: 'Nie można odebrać sobie uprawnień administratora' });
    }
    przypiszRole(db, id, rola.klucz);
    return reply.redirect('/ustawienia/konta?zapisano=rola');
  });

  app.post('/ustawienia/konta/:id/haslo', async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const id = Number(req.params.id);
    // Bez tego sprawdzenia `id=9999` i `id=abc` (NaN, nigdy nie pasuje żadnemu wierszowi)
    // dawałyby 302 na ekran — administrator widziałby potwierdzenie zmiany hasła, której NIGDY
    // nie było (zmienHaslo na nieistniejącym `id` po prostu nic nie aktualizuje, bez błędu).
    // Dwie pozostałe trasy (`/uprawnienia`, `/czynne`) też sprawdzają `cel` i oddają 404.
    const cel = listaKont(db).find((k) => k.id === id);
    if (!cel) return stronaOdmowy(reply, 404, 'Nie ma takiego konta', BRAK_KONTA);
    if (!req.body?.haslo) {
      return widok(req, reply.code(400), { blad: 'Puste hasło — wpisz je ponownie.' });
    }
    zmienHaslo(db, id, req.body.haslo);
    // Hasło ustawione inną drogą — nieużyty link do hasła nie może go potem nadpisać.
    uniewaznijLinkiKonta(db, id, teraz);
    return reply.redirect('/ustawienia/konta?zapisano=haslo');
  });

  app.post('/ustawienia/konta/:id/czynne', async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const id = Number(req.params.id);
    const cel = listaKont(db).find((k) => k.id === id);
    if (!cel) return stronaOdmowy(reply, 404, 'Nie ma takiego konta', BRAK_KONTA);
    const czynne = req.body?.czynne === '1';

    // Ta sama para bezpiecznikow, co w /uprawnienia — patrz komentarze tam. Kolejnosc ta sama
    // celowo: „ostatni admin" ma pierwszenstwo tresci komunikatu nad „wlasne konto".
    if (!pozostanieCzynnyAdmin(db, id, { czynne, admin: cel.admin })) {
      return widok(req, reply.code(400), { blad: KOMUNIKAT_OSTATNI_ADMIN });
    }
    if (id === req.konto?.id && !czynne) {
      return widok(req, reply.code(400), { blad: 'Nie można wyłączyć własnego konta' });
    }
    // ⚠️ WYLACZAMY, NIGDY NIE KASUJEMY. Skasowane konto zabiera ze soba rozliczalnosc:
    // historia ma dalej moc powiedziec, kto nadal ta paczke rok temu.
    ustawCzynne(db, id, czynne);
    // Wyłączenie konta unieważnia wszystkie jego linki do hasła.
    if (!czynne) uniewaznijLinkiKonta(db, id, teraz);
    return reply.redirect('/ustawienia/konta?zapisano=czynne');
  });

  // Strona konta dla administratora — rola, e-mail, czynne/wyłączone, link do hasła.
  const kontoZTrasy = (req) => listaKont(db).find((k) => k.id === Number(req.params.id)) ?? null;

  app.get('/ustawienia/konta/:id', async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const cel = kontoZTrasy(req);
    if (!cel) return stronaOdmowy(reply, 404, 'Nie ma takiego konta', BRAK_KONTA);
    return stronaKonta(req, reply, cel.id);
  });

  app.post('/ustawienia/konta/:id/email', async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const cel = kontoZTrasy(req);
    if (!cel) return stronaOdmowy(reply, 404, 'Nie ma takiego konta', BRAK_KONTA);
    try {
      ustawEmail(db, cel.id, req.body?.email, teraz);
    } catch (e) {
      if (e instanceof BladKonta) return stronaKonta(req, reply.code(400), cel.id, { blad: e.message });
      throw e;
    }
    return reply.redirect(`/ustawienia/konta/${cel.id}?zapisano=email`);
  });

  app.post('/ustawienia/konta/:id/link', async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const cel = kontoZTrasy(req);
    if (!cel) return stronaOdmowy(reply, 404, 'Nie ma takiego konta', BRAK_KONTA);
    if (!cel.czynne)
      return stronaKonta(req, reply.code(400), cel.id, {
        blad: 'Konto jest wyłączone — włącz je, zanim wyślesz link.',
      });
    const sposob = String(req.body?.sposob ?? '');
    if (!SPOSOBY_LINKU.includes(sposob))
      return stronaKonta(req, reply.code(400), cel.id, { blad: 'Wybierz: mail albo link do skopiowania.' });
    const blad = bladWysylki(req, sposob, emailKonta(db, cel.id));
    if (blad) return stronaKonta(req, reply.code(400), cel.id, { blad });
    return wyslijAlboPokaz(req, reply, { id: cel.id, cel: cel.zaproszone ? 'zaproszenie' : 'reset', sposob });
  });
}

// Eksport wylacznie do testu jednostkowego bezpiecznika (tests/moduly/ustawienia/web-konta.test.js) —
// funkcja jest czysta wzgledem `req`/sesji (patrz komentarz przy niej), wiec da sie ja
// sprawdzic wprost, bez app.inject i bez logowania jako ktokolwiek.
export { pozostanieCzynnyAdmin };
