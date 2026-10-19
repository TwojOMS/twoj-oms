// Ekran zarzadzania kontami i uprawnieniami — /ustawienia/konta (Zadanie 6, spec 2026-09-12).
//
// Do tego dnia konto dalo sie zalozyc WYLACZNIE zapytaniem SQL. Ten plik daje wlascicielowi
// ekran: liste kont, formularz nowego konta, per-konto formularz uprawnien/hasla/przelacznika
// czynne, i dziennik prob logowania (na tym samym ekranie, nie osobno — administrator, ktory
// podejrzewa wlamanie, ma zobaczyc oba naraz: kto ma dostep i kto probowal go zdobyc).

import {
  zalozKonto, listaKont, ustawUprawnienia, ustawCzynne, ustawAdmina,
  zmienHaslo, uprawnieniaKonta, ostatnieLogowania, kontoPoLoginie,
} from '../../../core/bezpieczenstwo/konta.js';
import { EKRANY, ROLE, ekranyRoli } from '../../../domena/ekrany.js';
import { nawigacjaUstawien } from '../nawigacja.js';
import { podmienSekret, sekretZmienionyAt } from '../../../core/bezpieczenstwo/sekret-sesji.js';
import { ciasteczkoWyczyszczenia, NAZWA_CIASTECZKA_OMS } from '../../../core/bezpieczenstwo/sesja.js';
import { polaczenieBezpieczne } from '../../../core/bezpieczenstwo/logowanie-wspolne.js';
// PRZ-068: role w bazie — lista ról, przypisanie roli i stara trasa ptaszków przez rolę osobistą.
import { listaRol, rolaPoKluczu, przypiszRole, ustawPtaszkiPrzezRole, opisRoliKonta } from '../role.js';
// PRZ-069: e-mail konta, zaproszenia i reset hasła jednorazowym linkiem (mail albo „Pokaż link”).
import { wydajLink, uniewaznijLinkiKonta, zastapPoprzednieLinki, wycofajLink } from '../linki-hasla.js';
import { zalozKontoZaproszone, zalozKontoZHaslem, ustawEmail, sprawdzEmail, emailKonta, BladKonta } from '../konta-dostep.js';
import { trescMaila } from '../poczta-kont.js';
import { wczytajSzablonyWiadomosci } from '../../../oms/db/szablony-wiadomosci.js';
import { modelKonta, MAKS_IMIENIA } from './moje-konto.js';
import { POLITYKA_REFERERA_LINKU } from './haslo-link.js';
import { adresLinkow } from '../adres-panelu.ts';
import { malymi } from '../role.js';
import { kontoWPodgladzieDemo, logowaniaDemo } from '../../../core/bezpieczenstwo/podglad-demo.js';

// ⚠️ EKRAN JEST TYLKO DLA KONTA Z FLAGA `admin` — niezaleznie od ptaszka na „Ustawieniach".
// Rola Sprzedaz ma dostep do konfiguracji panelu (formulki, kanaly) w niektorych instalacjach,
// ale zakladanie kont to inna stawka: kto zaklada konta, nadaje sobie kazde uprawnienie.
function tylkoAdmin(req, reply) {
  if (req.konto?.admin) return null;
  // PRZ-083: gość demo publicznego OGLĄDA ten ekran (podglad-demo.js) — wyłącznie GET; zapis blokuje już hak.
  if (req.konto?.podgladDemo && req.method === 'GET') return null;
  // ⚠️ `wlasnyUklad: true`, NIE `bezPaska` (ktore samo w sobie nie wystarcza — dziala tylko
  // WEWNATRZ layout-oms.ejs). `brak-dostepu.ejs` jest SAMODZIELNYM DOKUMENTEM z wlasnym
  // `<!doctype html>` (patrz komentarz na gorze tego pliku i K1 w straznik.js) — bez
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
 * Czy PO ustawieniu (`czynne`, `admin`) na koncie `kontoId` w bazie zostanie choc JEDEN
 * czynny administrator — liczac WSZYSTKIE konta, nie tylko to jedno.
 *
 * ⚠️⚠️ TRZECI BEZPIECZNIK (brief go nie przewiduje — wykryl go dopiero recenzja strażnika).
 * Uprawnienia konta serwisowego z `.env` degraduja sie STANEM BAZY (`czyIstniejeCzynnyAdmin`,
 * db/konta.js): dopoki nie ma ani jednego czynnego admina, haslo z pliku jest PELNYM adminem
 * (straznik.js, `dopuscSerwisowe`) — to jedyna droga pierwszego startu, takze u kogos, kto
 * kupil ten kod. Gdyby dalo sie wylaczyc albo odebrac admina OSTATNIEMU czynnemu
 * administratorowi, brama degradacji zamykalaby sie NA ZAWIAS: kto zna haslo z `.env`,
 * odzyskiwalby pelne uprawnienia JEDNYM KLIKNIECIEM w ten wlasnie formularz. Do tego jest to
 * zwykle zabezpieczenie przed zamknieciem sie poza panelem — bez niego powrot jest wylacznie
 * przez SSH do bazy.
 *
 * Funkcja CELOWO NIE ZNA `req.konto` i nie rozroznia „sobie" od „komus innemu" — liczy
 * WYLACZNIE stan PO operacji, ALE POROWNANY ZE STANEM PRZED (patrz D3 nizej). To wlasciwa
 * regula: odebranie admina KOMUS INNEMU, kto akurat jest jedynym czynnym adminem, jest
 * DOKLADNIE taka sama dziura, jak zrobienie tego sobie — bezpiecznik „nie odbierz sobie"
 * (nizej) jest UNIKALNY dla samego siebie i dziala zawsze, nawet gdy inni admini zostaja;
 * ten tutaj jest ogolna regula stanu, ktora obejmuje WSZYSTKIE konta, wlasne i cudze jednakowo.
 *
 * ⚠️⚠️ D3 (recenzja 2026-09-12, druga fala): NIE WYSTARCZY spytac „czy PO operacji zostanie
 * choc jeden czynny admin" w oderwaniu od tego, ile ich bylo PRZED. Na bazie, ktorej jedyny
 * admin jest WYLACZONY (zero czynnych adminow), zapisanie formularza uprawnien TEGO SAMEGO
 * konta (np. ponowny zapis ptaszkow, `admin` zostaje `true`, `czynne` zostaje `false`, bo ta
 * trasa nie zmienia `czynne`) dawaloby starym liczeniem `Boolean(false) && Boolean(true)` =
 * `false` — odmowe „to jest OSTATNI czynny administrator", choc naprawde nie ma ANI JEDNEGO,
 * a operacja niczego nie pogarsza (przed: zero, po: zero). Gorzej: DOKLADNIE ta sama odmowa
 * blokowalaby probe MIANOWANIA admina innemu, aktywnemu kontu — jedyna droge odzyskania panelu
 * bez SSH do bazy — bo formula nie odrozniala „bylo zero" od „bylo jeden, a teraz bedzie zero".
 * Blokujemy WYLACZNIE prawdziwe pogorszenie: przejscie od „TO konto bylo jedynym czynnym
 * adminem" do „nie bedzie go wcale". Gdy PRZED operacja to konto i tak nie bylo czynnym
 * adminem (a nikt inny tez nie), operacja przechodzi zawsze — nie da sie zejsc ponizej zera.
 */
function pozostanieCzynnyAdmin(db, kontoId, { czynne, admin }) {
  const wszyscy = listaKont(db);
  const inni = wszyscy.filter((k) => k.id !== kontoId);
  // PRZ-069: konto zaproszone (bez hasła) nie jest czynnym administratorem — nie zamyka bramy degradacji.
  if (inni.some((k) => k.czynne && k.admin && !k.zaproszone)) return true;
  // Nikt INNY nie jest czynnym adminem — liczy sie WYLACZNIE los TEGO konta.
  const toKonto = wszyscy.find((k) => k.id === kontoId);
  const bylCzynnyAdminemPrzed = Boolean(toKonto?.czynne) && Boolean(toKonto?.admin) && !toKonto?.zaproszone;
  if (!bylCzynnyAdminemPrzed) return true; // nie bylo co stracic — nie da sie zejsc ponizej zera
  return Boolean(czynne) && Boolean(admin);
}

const KOMUNIKAT_OSTATNI_ADMIN = 'Nie można tego zrobić — to jest OSTATNI czynny administrator. '
  + 'Bez ani jednego czynnego admina hasło serwisowe z .env znowu stałoby się pełnym adminem, '
  + 'więc panel musi mieć zawsze co najmniej jednego. Załóż albo włącz drugie konto '
  + 'administratora, zanim odbierzesz to uprawnienie tutaj.';

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

// D1+D2 (recenzja 2026-09-12): `logowania.wynik` w bazie to IDENTYFIKATOR (bez ogonkow,
// stabilny dla kodu — patrz logowanie.js), nie tekst dla czlowieka. Ekran ma pokazywac tekst
// z ogonkami, zgodnie z reguly stylu tego repo; identyfikator zostaje wylacznie w bazie i w
// warunkach kodu (np. `wynik = 'udane'` w listaKont powyzej).
const OPISY_WYNIKOW_LOGOWANIA = {
  udane: 'Udane',
  'zle-haslo': 'Złe hasło',
  zablokowane: 'Zablokowane (za dużo prób)',
  serwisowe: 'Serwisowe (hasło z .env)',
  'serwisowe-odrzucone': 'Serwisowe odrzucone (jest czynny admin)',
  'konto-wylaczone': 'Konto wyłączone',
  'haslo-z-linku': 'Hasło ustawione z linku', // PRZ-069
};

/**
 * ⚠️ CO Z WYNIKIEM, KTOREGO MAPA NIE ZNA (np. dopisanym za pol roku, gdy ktos doda nowy stan
 * logowania w logowanie.js i zapomni dopisac go tutaj) — DECYZJA (recenzja 2026-09-12): NIE
 * chowamy takiego wiersza i nie podmieniamy go na cos ogolnego jak „inny" — pokazujemy SUROWY
 * identyfikator, dokladnie tak, jak wygladal do tej pory. Administrator, ktory podejrzewa
 * wlamanie, ma zobaczyc KAZDA probe logowania; dziennik, ktory milczy o wpisie (albo pokazuje
 * „inny" dla wszystkiego, co nowe), jest gorszy niz dziennik z brzydkim, ale prawdziwym kluczem.
 */
function opisWynikuLogowania(wynik) {
  return OPISY_WYNIKOW_LOGOWANIA[wynik] ?? wynik;
}

/**
 * @param {any} app
 * @param {{ db: any, teraz?: () => Date, adresPanelu?: string | null | (() => string | null), mailer?: () => any, loginSerwisowy?: string | null, nazwaCiasteczka?: string }} opcje
 */
export function registerKontaRoutes(app, { db, teraz = () => new Date(), adresPanelu: adresPaneluOpcja = null, mailer = () => null, loginSerwisowy = null, nazwaCiasteczka = NAZWA_CIASTECZKA_OMS }) {
  // PRZ-094.04: adres panelu czytany przy każdym żądaniu (OMS_ADRES_PANELU albo zapis z Ustawień → Poczta wychodząca).
  const adresTeraz = typeof adresPaneluOpcja === 'function' ? adresPaneluOpcja : () => adresPaneluOpcja;
  // PRZ-069: strona z jednorazowym linkiem nie trafia do pamięci przeglądarki; Referer bez ścieżki (spec §4.4).
  // Polityka `strict-origin`, nie `no-referrer` — inaczej każdy formularz tej strony dostaje 403 (recenzja D8 r1, P1-1).
  const pokazLinkuNaglowki = (reply) => reply.header('Cache-Control', 'no-store').header('Referrer-Policy', POLITYKA_REFERERA_LINKU);
  // Recenzja D8 r1, P3-4: konto z tabeli o loginie konta serwisowego `.env` przesłoniłoby je w strażniku
  // (konto z tabeli ma pierwszeństwo) — dwa różne „serwis” w jednym panelu. Bez względu na wielkość liter.
  const loginZarezerwowany = (login) => Boolean(loginSerwisowy) && malymi(login) === malymi(loginSerwisowy);
  const KOMUNIKAT_LOGIN_SERWISOWY = (login) => `Login „${login}” jest zarezerwowany dla konta serwisowego z .env — wybierz inny.`;
  const komunikatLoginZajety = (login) => `Login „${login}” jest już zajęty przez inne konto — wybierz inny.`;
  // PRZ-094.10: mail i „Pokaż link” — ta sama zasada (adres-panelu.ts, adresLinkow): plik → zapis → adres, z którego
  // admin właśnie korzysta. Adres z żądania jest tu dopuszczalny, bo każda trasa tego pliku, która wydaje link, stoi
  // za `tylkoAdmin` (test: adres-panelu-domyslny-prz094-10.test.js, „(f)”).
  const adresLinkowDla = (req) => adresLinkow(adresTeraz(), req);
  const komunikatZapisu = (req) => {
    if (req.query?.zapisano !== 'wyslano-domyslny') return KOMUNIKATY_ZAPISU[req.query?.zapisano] ?? null;
    const adres = adresLinkowDla(req);
    return adres?.domyslny
      ? `Wysłano. Link w mailu prowadzi do ${adres.adres} (adres, z którego teraz korzystasz). `
        + 'Jeśli pracownik otworzy go spoza tej sieci, wpisz adres w Ustawienia → Integracje → Poczta wychodząca.'
      : KOMUNIKATY_ZAPISU.wyslano;
  };

  function stronaKonta(req, reply, id, extra = {}) {
    return reply.view('konto.ejs', {
      title: 'Konto użytkownika', adminWidok: true, wlasne: id === req.konto?.id, serwisowe: false,
      // PRZ-083: gość demo w podglądzie nie widzi loginu ani imienia administratora (podglad-demo.js).
      konto: req.konto?.podgladDemo
        ? kontoWPodgladzieDemo(modelKonta(db, id), db.prepare('SELECT admin FROM konta WHERE id = ?').get(id)?.admin === 1)
        : modelKonta(db, id),
      role: listaRol(db).map((r) => ({ klucz: r.klucz, etykieta: r.nazwa })),
      rolaKlucz: db.prepare('SELECT rola FROM konta WHERE id = ?').get(id)?.rola ?? null,
      link: null, adresZPrzegladarki: false, zapisano: komunikatZapisu(req), blad: null,
      nawigacja: nawigacjaUstawien(req, reply), ...extra,
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
      // Recenzja D8 r1, P3-2: poprzedni link przestaje działać DOPIERO po udanej wysyłce. Przy błędzie SMTP
      // nowy link jest wycofany, a poprzedni (np. z „Pokaż link”, już przekazany pracownikowi) działa dalej.
      // W oknie wysyłki konto ma dwa aktywne linki — użycie jednego unieważnia drugi (uzyjLinku).
      const { token, id: linkId } = wydajLink(db, { kontoId: id, cel, utworzylKontoId, teraz, zastapPoprzednie: false });
      try {
        // PRZ-101.06: szablon z Ustawień → Szablony wiadomości → Maile do zespołu, czytany przy każdej wysyłce.
        const szablon = wczytajSzablonyWiadomosci(db).wbudowane[cel] ?? null;
        await mailer().sendMail({ to: konto.email, ...trescMaila({ cel, imie: konto.imie, link: adresLinku(token), szablon }) });
      } catch {
        wycofajLink(db, linkId, teraz);
        return stronaKonta(req, reply.code(502), id, {
          blad: 'Nie udało się wysłać maila — użyj „Pokaż link”. Poprzedni link, jeśli był, nadal działa.',
        });
      }
      zastapPoprzednieLinki(db, { kontoId: id, nowyLinkId: linkId, teraz });
      // PRZ-094.10: przy adresie domyślnym komunikat mówi, dokąd prowadzi link (komunikatZapisu).
      return reply.redirect(`/ustawienia/konta/${id}?zapisano=${adres.domyslny ? 'wyslano-domyslny' : 'wyslano'}`);
    }
    const { token } = wydajLink(db, { kontoId: id, cel, utworzylKontoId, teraz });
    return stronaKonta(req, pokazLinkuNaglowki(reply), id, {
      link: adresLinku(token),
      // Recenzja końcowa, P3-4: bez adresu w pliku i w zapisie link prowadzi pod adres z przeglądarki admina — ekran ma to powiedzieć.
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
      try { sprawdzEmail(db, null, email); } catch (e) { if (e instanceof BladKonta) return odmow(e.message); throw e; }
    }
    const blad = bladWysylki(req, sposob, email || null);
    if (blad) return odmow(blad);
    let id;
    try {
      id = zalozKontoZaproszone(db, { login, imie, rola: rola.klucz, email: email || null, teraz });
    } catch (e) {
      // Recenzja D8 r1, P3-6: wyścig (drugi zapis między kontrolą wyżej a INSERT) — UNIQUE z bazy to ta sama odmowa.
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
        // PRZ-068: nazwa roli z bazy; „+ zmiany” tylko przy rozjeździe ptaszków konta z rolą (plan O5).
        opisRoli: opisRoliKonta(db, k.id) ?? (zgodneZRola(k.rola, ekrany) ? etykieta : `${etykieta} + zmiany`),
        ostatniAdmin: k.czynne && k.admin && liczbaCzynnychAdminow === 1,
        // PRZ-068 (plan O4): ptaszki per konto renderują się wyłącznie w odpowiedzi 400 starej trasy.
        edycja: podglad !== null,
      };
    });
    const podglad = req.konto?.podgladDemo === true;
    return reply.view('konta.ejs', {
      title: 'Użytkownicy i uprawnienia', konta: podglad ? konta.map((k) => kontoWPodgladzieDemo(k, k.admin)) : konta, EKRANY,
      nawigacja: nawigacjaUstawien(req, reply),
      role: listaRol(db).map((r) => ({ klucz: r.klucz, etykieta: r.nazwa })),
      // D2: `ip` juz plynie z ostatnieLogowania — dolaczamy tylko czytelny opis wyniku (D1).
      // PRZ-083: w podglądzie demo zmyślony — prawdziwy niesie loginy i IP innych gości (podglad-demo.js).
      logowania: (podglad ? logowaniaDemo(teraz()) : ostatnieLogowania(db, 50)).map((l) => ({ ...l, opisWyniku: opisWynikuLogowania(l.wynik) })),
      wlasneId: req.konto?.id ?? null,
      sekretZmieniony: sekretZmienionyAt(db),
      zapisano: KOMUNIKATY_ZAPISU[req.query?.zapisano] ?? null,
      noweKonto: noweKonto ?? polaNowegoKonta(),
      blad,
    });
  }

  app.get('/ustawienia/konta', async (req, reply) => tylkoAdmin(req, reply) ?? widok(req, reply));

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
    // PRZ-069 (plan O6): formularz ekranu posyła `sposob` → zaproszenie bez hasła. Ścieżka z `haslo`
    // (bez `sposob`) zostaje dla chronionych testów i skryptów; ekran nie ma już pola hasła.
    if (pola.sposob !== undefined) return zaproszenie(req, reply, pola, noweKonto);
    // D8 (recenzja 2026-09-12): PRZYCINAMY biale znaki PRZED kazdym uzyciem loginu — walidacja
    // pustego pola, sprawdzenie duplikatu i zapis do bazy maja widziec DOKLADNIE ten sam login,
    // inaczej `' ewa '` i `'ewa'` zakladalyby dwa rozne konta (zmierzone w recenzji).
    // ⚠️ DECYZJA: NIE zmieniamy wielkosci liter. Login jest dzis porownywany doslownie
    // (kontoPoLoginie, `l.login = k.login` w listaKont) i istniejace konta moga miec
    // wielkosc liter wpisana z rak — wymuszenie malych liter TYLKO dla nowych kont dawaloby
    // dwie rozne semantyki loginu w tej samej bazie (stare: dowolna wielkosc, nowe: zawsze
    // male), co jest myloce samo w sobie i nie bylo czescia zgloszenia.
    const login = String(req.body?.login ?? '').trim();
    const rolaZBazy = rolaPoKluczu(db, rola);
    if (!login || !imie || !haslo || !rolaZBazy) {
      return widok(req, reply.code(400), {
        blad: 'Brak loginu, imienia, hasła albo nieznana rola. Hasło wpisz ponownie.', noweKonto,
      });
    }
    // ⚠️⚠️ W5 (recenzja 2026-09-12): BEZ tego sprawdzenia duplikat loginu leci wprost do
    // `INSERT` w zalozKonto (db/konta.js) i rozbija sie o unikalny indeks `konta.login` —
    // Fastify oddawal wtedy SUROWY blad SQLite w tresci odpowiedzi 500
    // (`{"code":"ERR_SQLITE_ERROR","message":"UNIQUE constraint failed: konta.login"}`),
    // czyli wysypywal schemat bazy do przegladarki za kazdym razem, gdy ktos pomyli sie
    // w loginie (najczestsza pomylka na tym ekranie — „ewa" drugi raz). Lekarstwo — parametr
    // `blad` w `widok()` i pas `pas-uprzedzenie` w konta.ejs — juz tu bylo, tylko nikt go nie
    // wolal: sprawdzamy PRZED zapisem i pokazujemy ten sam ekran z odmowa, zamiast pozwolic
    // bazie rzucic.
    if (loginZarezerwowany(login)) {
      return widok(req, reply.code(400), { blad: KOMUNIKAT_LOGIN_SERWISOWY(login), noweKonto });
    }
    if (kontoPoLoginie(db, login)) {
      return widok(req, reply.code(400), {
        blad: komunikatLoginZajety(login),
        noweKonto,
      });
    }
    // PRZ-068 (recenzja D8 r1): ptaszki konta = ptaszki roli z bazy; INSERT i przypisanie w jednej transakcji.
    try {
      zalozKontoZHaslem(db, { login, imie, haslo, rola: rolaZBazy.klucz });
    } catch (e) {
      if (e instanceof BladKonta && e.kod === 'login-zajety') return widok(req, reply.code(400), { blad: komunikatLoginZajety(login), noweKonto });
      throw e;
    }
    return reply.redirect('/ustawienia/konta?zapisano=nowe');
  });

  app.post('/ustawienia/konta/:id/uprawnienia', async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const id = Number(req.params.id);
    const cel = listaKont(db).find((k) => k.id === id);
    if (!cel) return reply.code(404).send('Nie ma takiego konta');

    // Pole `ekran` z formularza: jeden ptaszek przychodzi jako napis, kilka jako tablica,
    // zero — nie przychodzi wcale. Wszystkie trzy postacie to ta sama rzecz.
    const surowe = req.body?.ekran;
    const wybrane = surowe == null ? [] : (Array.isArray(surowe) ? surowe : [surowe]);
    const znane = new Set(EKRANY.map((e) => e.klucz));
    // ⚠️ `'api'` NIE JEST W `EKRANY` (to synteyczny klucz z ekranDlaAdresu/straznik.js dla
    // `/api/*` — integracja panelu :3000, „Dodaj do OMS"), wiec dostaje wyjatek TUTAJ,
    // zamiast zostac po cichu odfiltrowany razem z kazdym innym nieznanym slowem z formularza.
    const ekrany = wybrane.filter((e) => znane.has(e) || e === 'api');
    const admin = req.body?.admin === '1';

    // ⚠️⚠️ TRZECI BEZPIECZNIK PRZED DWOMA PONIZEJ (patrz komentarz przy funkcji): liczy sie
    // TYLKO to, czy po operacji zostanie choc jeden czynny admin — nie kto ja wykonuje. Stoi
    // PIERWSZY, zeby dla admina bedacego OSTATNIM czynnym admin komunikat mowil wprost „to jest
    // ostatni admin", a nie ogolne „nie mozna odebrac sobie" (ponizej), ktore sugerowaloby, ze
    // ktos inny moglby to zrobic za niego.
    if (!pozostanieCzynnyAdmin(db, id, { czynne: cel.czynne, admin })) {
      return widok(req, reply.code(400), {
        blad: KOMUNIKAT_OSTATNI_ADMIN, edycjaUprawnien: { id, ekrany: new Set(ekrany), admin },
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
    // D6 (recenzja 2026-09-12): te dwa zapisy NIE sa w transakcji — awaria bazy miedzy nimi
    // (dysk pelny, proces zabity) zostawilaby ptaszki ekranow zapisane, a flage `admin`
    // nietknieta. TANIE lekarstwo (BEGIN IMMEDIATE/COMMIT jak w db/zamowienia.js) siedzialoby
    // w db/konta.js, a ten plik zadania ma ten modul WYLACZNIE do odczytu (zakres zadania) —
    // ZOSTAWIONE SWIADOMIE, opisane w raporcie koncowym, nie „rozgrzebywane" na sile.
    // PRZ-068 (plan O3): wynik per konto, ale zawsze przez rolę — `admin` → Administrator, inaczej
    // rola osobista konta z dokładnie tymi ptaszkami. Zapis w jednej transakcji (zamyka też D6 wyżej).
    ustawPtaszkiPrzezRole(db, id, { ekrany, admin, teraz });
    return reply.redirect('/ustawienia/konta?zapisano=uprawnienia');
  });

  // PRZ-068: zmiana roli konta. Bezpieczniki te same i w tej samej kolejności co w /uprawnienia.
  app.post('/ustawienia/konta/:id/rola', async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const id = Number(req.params.id);
    const cel = listaKont(db).find((k) => k.id === id);
    if (!cel) return reply.code(404).send('Nie ma takiego konta');
    const rola = rolaPoKluczu(db, req.body?.rola);
    if (!rola) return reply.code(404).send('Nie ma takiej roli');
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
    // W4 (recenzja 2026-09-12): bez tego sprawdzenia `id=9999` i `id=abc` (NaN, nigdy nie
    // pasuje zadnemu wierszowi) dawaly 302 na ekran — wlasciciel widzial potwierdzenie
    // zmiany hasla, ktorej NIGDY nie bylo (zmienHaslo na nieistniejacym `id` po prostu nic
    // nie aktualizuje, bez bledu). Dwie pozostale trasy (`/uprawnienia`, `/czynne`) juz
    // sprawdzaly `cel` i oddawaly 404 — ta ma robic dokladnie to samo.
    const cel = listaKont(db).find((k) => k.id === id);
    if (!cel) return reply.code(404).send('Nie ma takiego konta');
    if (!req.body?.haslo) {
      return widok(req, reply.code(400), { blad: 'Puste hasło — wpisz je ponownie.' });
    }
    zmienHaslo(db, id, req.body.haslo);
    // PRZ-069 (recenzja D8 r1, P3-1): hasło ustawione inną drogą — nieużyty link do hasła nie może go potem nadpisać.
    uniewaznijLinkiKonta(db, id, teraz);
    return reply.redirect('/ustawienia/konta?zapisano=haslo');
  });

  app.post('/ustawienia/konta/:id/czynne', async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const id = Number(req.params.id);
    const cel = listaKont(db).find((k) => k.id === id);
    if (!cel) return reply.code(404).send('Nie ma takiego konta');
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
    // PRZ-069: wyłączenie konta unieważnia wszystkie jego linki do hasła (spec §4.2).
    if (!czynne) uniewaznijLinkiKonta(db, id, teraz);
    return reply.redirect('/ustawienia/konta?zapisano=czynne');
  });

  // PRZ-069: strona konta dla administratora — rola, e-mail, czynne/wyłączone, link do hasła.
  const kontoZTrasy = (req) => listaKont(db).find((k) => k.id === Number(req.params.id)) ?? null;

  app.get('/ustawienia/konta/:id', async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const cel = kontoZTrasy(req);
    if (!cel) return reply.code(404).send('Nie ma takiego konta');
    return stronaKonta(req, reply, cel.id);
  });

  app.post('/ustawienia/konta/:id/email', async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const cel = kontoZTrasy(req);
    if (!cel) return reply.code(404).send('Nie ma takiego konta');
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
    if (!cel) return reply.code(404).send('Nie ma takiego konta');
    if (!cel.czynne) return stronaKonta(req, reply.code(400), cel.id, { blad: 'Konto jest wyłączone — włącz je, zanim wyślesz link.' });
    const sposob = String(req.body?.sposob ?? '');
    if (!SPOSOBY_LINKU.includes(sposob)) return stronaKonta(req, reply.code(400), cel.id, { blad: 'Wybierz: mail albo link do skopiowania.' });
    const blad = bladWysylki(req, sposob, emailKonta(db, cel.id));
    if (blad) return stronaKonta(req, reply.code(400), cel.id, { blad });
    return wyslijAlboPokaz(req, reply, { id: cel.id, cel: cel.zaproszone ? 'zaproszenie' : 'reset', sposob });
  });
}

// Eksport wylacznie do testu jednostkowego bezpiecznika (tests/oms/web-konta.test.js) —
// funkcja jest czysta wzgledem `req`/sesji (patrz komentarz przy niej), wiec da sie ja
// sprawdzic wprost, bez app.inject i bez logowania jako ktokolwiek.
export { pozostanieCzynnyAdmin };
