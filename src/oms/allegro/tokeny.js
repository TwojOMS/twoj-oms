import { transport } from '../../integracje/transport.js';
import { wczytajTokeny, zapiszTokeny, zapiszBladTokenu, generacjaDostepu, sprawdzGeneracjeDostepu } from '../db/tokeny.js';
import { brakujaceUprawnienia, brakZgodyNaOferty, maZgodeNaOferty } from '../../domena/uprawnienia-kanalu.js';
import { kontoZTokenu } from '../../domena/tozsamosc-kanalu.js';

// Refresh token Allegro zyje 3 miesiace. Ostrzegamy 7 dni wczesniej, bo wygasniecie jest
// stanem, z ktorego panel SAM NIE WYJDZIE — wymaga czlowieka przy przegladarce (device
// flow). Awaria bylaby cicha: lista dalej pokazuje stare zamowienia (niezmiennik 4.9).
export const DNI_OSTRZEZENIA = 7;

// Token „wazny jeszcze przez dwie minuty" jest w praktyce martwy: zdazy wygasnac w srodku
// przebiegu pollera, ktory chodzi po wielu stronach zamowien. Odswiezamy z wyprzedzeniem.
const MARGINES_MS = 5 * 60 * 1000;

// Allegro nie podaje waznosci refresh tokena w odpowiedzi — liczymy z udokumentowanych
// 3 miesiecy. Wartosc sluzy WYLACZNIE ostrzeganiu, nigdy decyzji o wywolaniu.
const DNI_ZYCIA_REFRESH = 90;

// ⚠️ ZAPASOWA WAZNOSC ACCESS TOKENA, gdy odpowiedz 200 nie niesie `expires_in`.
//
// Kolejnosc wartosci: PARA TOKENOW jest cenniejsza niz znajomosc terminu waznosci. Gdy
// Allegro odpowie 200 i zwroci pare, ale bez `expires_in`, rotacja PO ICH STRONIE JUZ SIE
// STALA — stary refresh token jest spalony. Wysypanie sie tutaj (bo `new Date(NaN)` rzuca)
// znaczyloby, ze nowej pary nie zapisujemy nigdzie i kanal umiera do czasu, az czlowiek
// przejdzie device flow. Dlatego zapisujemy pare mimo braku terminu.
//
// Wartosc jest KROTKA celowo, i celowo krotsza niz jakikolwiek prawdziwy access token
// Allegro (te zyja ~12 h): nie udajemy, ze znamy termin, tylko wymuszamy odswiezenie przy
// najblizszym uzyciu. Mamy czym — swiezy refresh token lezy juz w bazie. Blad w te strone
// kosztuje jedno zadanie HTTP wiecej; blad w druga stronę kosztuje wizyte czlowieka.
const ZAPASOWE_ZYCIE_ACCESS_S = 10 * 60;

// ⚠️ DEDUPLIKACJA TRWAJACEGO ODSWIEZENIA — NA POZIOMIE MODULU, NIE INSTANCJI.
//
// `createTokeny` bywa wolane per zadanie HTTP (i osobno przez pollera), wiec pole w
// domknieciu chronilo by tylko przed dwoma wywolaniami TEJ SAMEJ instancji. Dwie instancje
// nad ta sama baza dalej wyslalyby TEN SAM refresh token dwoma zadaniami — a Allegro przy
// wykryciu reuzycia potrafi uniewaznic cala rodzine tokenow, czyli zabic kanal.
//
// WeakMap po obiekcie bazy (a nie po sciezce): identycznosc bazy jest tym, co naprawde
// decyduje, czy chodzi o ten sam wiersz, a wpis znika razem z zamknieta baza w testach.
// Wewnetrzna Mapa jest po nazwie kanalu — dwa rozne kanaly wolno odswiezac rownolegle.
//
// ⚠️ NIE `BEGIN IMMEDIATE`: transakcja SQLite nie obejmuje `await fetch`, a trzymanie jej
// przez czas zadania sieciowego zablokowaloby CALA baze na sekundy.
const trwajaceOdswiezenia = new WeakMap();

function mapaTrwajacych(db) {
  let m = trwajaceOdswiezenia.get(db);
  if (!m) {
    m = new Map();
    trwajaceOdswiezenia.set(db, m);
  }
  return m;
}

// Kod bledu OAuth (`invalid_grant`, `invalid_client`, `authorization_pending`…) wolno
// pokazac czlowiekowi — nie niesie poswiadczen. ⚠️ Ale bierzemy go WYLACZNIE wtedy, gdy
// wyglada jak kod OAuth (male litery i podkreslenia, krotki). Serwer, ktory wsadzi w to
// pole cokolwiek innego, nie ma jak przemycic sekretu do bazy ani na ekran (4.10).
// `error_description` nie jest czytane NIGDZIE — tam OAuth potrafi wstawic fragment
// poswiadczen.
function kodOauth(d) {
  return typeof d?.error === 'string' && /^[a-z_]{1,64}$/.test(d.error) ? d.error : null;
}

// ⚠️ „Trzeba polaczyc kanal ponownie" jest PRAWDA WYLACZNIE przy `invalid_grant`. Przy 5xx
// jest nieprawda (usterka przejsciowa), a przy `invalid_client` jest szkodliwa: device flow
// z zlym `clientSecret` i tak sie nie uda, wiec zdanie wyslaloby czlowieka klikac
// w przegladarce zamiast poprawic plik z poswiadczeniami.
// Przycisk „Połącz z Allegro” jest w panelu: Ustawienia → Integracje → Moje połączenia, przy koncie Allegro.
// Komunikat, ktory wymaga wiazania, podaje to miejsce razem z nazwa TEGO kanalu.
const GDZIE_POLACZYC = (kanal) => `Ustawienia → Integracje → Moje połączenia, przy koncie Allegro tego kanału (${kanal || '<kanał>'})`;

function komunikatOdmowy(status, kod, kanal) {
  if (status >= 500) {
    return `Allegro nie przyjęło odświeżenia tokenu (HTTP ${status}). To zwykle usterka przejściowa `
      + 'po ich stronie — panel spróbuje ponownie przy następnym przebiegu. NIE łącz kanału ponownie; '
      + 'jeśli trwa to dłużej niż godzinę, sprawdź status Allegro.';
  }
  if (kod === 'invalid_grant') {
    return `Odświeżenie tokenu odrzucone (HTTP ${status}, ${kod}) — refresh token wygasł albo został `
      + 'już zużyty. Kanał sam z tego nie wyjdzie: trzeba połączyć go ponownie („Połącz z Allegro” w '
      + `${GDZIE_POLACZYC(kanal)}).`;
  }
  if (kod === 'invalid_client') {
    return `Odświeżenie tokenu odrzucone (HTTP ${status}, ${kod}) — Allegro nie uznało poświadczeń `
      + 'kanału (clientId/clientSecret). Popraw je w konfiguracji panelu; ponowne łączenie kanału '
      + 'NIC tu nie da.';
  }
  return `Odświeżenie tokenu odrzucone (HTTP ${status}${kod ? `, ${kod}` : ''}). Nie wiadomo, czy to `
    + 'usterka przejściowa — sprawdź stan kanału, zanim połączysz go ponownie.';
}

export function createTokeny({ db, kanal, ustawienia, fetchImpl, http = transport({ fetchImpl }) }) {
  // ⚠️ Naglowek Basic budujemy PRZY KAZDYM ZADANIU i nigdzie go nie zapamietujemy — ma zyc
  // tylko tyle, ile trwa wywolanie (niezmiennik 4.10: poswiadczenia nie ida do logu ani na
  // ekran, wiec tym bardziej nie maja lezec w polu obiektu, ktory ktos moze wypisac).
  const basic = () => Buffer.from(`${ustawienia.clientId}:${ustawienia.clientSecret}`).toString('base64');
  const naglowki = () => ({
    Authorization: `Basic ${basic()}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
    // ⚠️ OAUTH TO TEZ SA ZADANIA DO ALLEGRO. Kusi, zeby liczyc naglowek zgodnosci wylacznie
    // przy API zamowien — ale `/auth/oauth/device` i `/auth/oauth/token` ida na te sama
    // aplikacje i na ten sam klucz, ktory Allegro grozi zablokowac. Gorzej: to wlasnie one
    // ida PIERWSZE, wiec kanal niezgodny zatrzymalby sie na wiazaniu i na odswiezeniu
    // tokenu, czyli w miejscu, z ktorego panel SAM NIE WYJDZIE (potrzebny czlowiek przy
    // przegladarce). Wartosc pochodzi z `ALLEGRO_USER_AGENT` (walidowana przy starcie).
    //
    // ⚠️ JEDNO ZRODLO DLA WSZYSTKICH TRZECH ZADAN TEGO MODULU (odswiezenie, `/device`,
    // dokonczenie wiazania). Trzy kopie naglowkow rozjechalyby sie przy pierwszej poprawce
    // jednej z nich, a rozjazd byloby widac dopiero w panelu zgodnosci Allegro.
    'User-Agent': ustawienia.userAgent,
  });
  const wiersz = () => wczytajTokeny(db, kanal);
  const zywy = (w) => Boolean(w?.access_token && w?.wygasa_at && Date.parse(w.wygasa_at) - MARGINES_MS > Date.now());

  // ⚠️ NIESIE TOKENY (caly wiersz z bazy) — sluzy mechanizmowi, nie widokowi. Do szablonu
  // idzie `stanDlaEkranu()` nizej.
  function stan() {
    const w = wiersz();
    const refreshDo = w?.refresh_wygasa_at ? Date.parse(w.refresh_wygasa_at) : null;
    const zostaloDni = refreshDo == null ? null : Math.floor((refreshDo - Date.now()) / 86400000);
    return {
      ...w,
      zostaloDni,
      // Brak wiersza to NIE awaria, tylko „jeszcze nie powiazano". Rzucanie tutaj wywalaloby
      // liste zamowien z powodu kanalu, ktorego nikt jeszcze nie podlaczyl.
      wymagaPowiazania: !w?.refresh_token || zostaloDni == null || zostaloDni <= DNI_OSTRZEZENIA,
    };
  }

  // To samo, ale BEZ POSWIADCZEN — wersja dla szablonu i dla logu (niezmiennik 4.10).
  // Buduje sie z BIALEJ LISTY pol, a nie przez usuwanie tokenow z `stan()`: dopisanie
  // kolejnej kolumny do tabeli nie ma prawa cicho wypchnac sekretu na ekran.
  function stanDlaEkranu() {
    const s = stan();
    return {
      kanal,
      polaczony: Boolean(s.refresh_token),
      wymagaPowiazania: s.wymagaPowiazania,
      zostaloDni: s.zostaloDni,
      // ⚠️ TERMIN, A NIE TOKEN. Data wygasniecia refresh tokena nie jest poswiadczeniem
      // i jest JEDYNA rzecza, ktora mowi czlowiekowi, kiedy bedzie musial wrocic do
      // wiazania kanalu („Połącz z Allegro” w Ustawieniach → Integracje). Same „dni" nie wystarcza: liczba
      // bez daty starzeje sie w chwili, w ktorej ktos ja skopiuje do notatki.
      refreshWygasaAt: s.refresh_wygasa_at ?? null,
      ostatniBlad: s.ostatni_blad ?? null,
      zaktualizowaneAt: s.zaktualizowane_at ?? null,
      // ⚠️⚠️ NAZWY BRAKUJACYCH ZAKRESOW, NIGDY SAM TOKEN. Token jest tu odczytany i od razu
      // sprowadzony do listy nazw — te nie sa poswiadczeniem (niezmiennik 4.10 dotyczy
      // tokenow i hasel), a bez nich panel nie ma jak zauwazyc, ze kanal dziala przy
      // zamowieniach i jednoczesnie nie ma zakresu do Centrum wiadomosci. Odswiezenie tokenu
      // zakresow NIE DOPISUJE — wchodza wylacznie przy nowej autoryzacji.
      brakujaceUprawnienia: brakujaceUprawnienia(s.access_token),
      // PRZ-160 E3.02 (D42): zgoda na oferty — same flagi z zakresow tokenu, nigdy token.
      brakOfert: brakZgodyNaOferty(s.access_token),
      zgodaOfert: maZgodeNaOferty(s.access_token),
      // UWAGA UWAGA: Z JAKIM KONTEM ALLEGRO TEN KANAL JEST NAPRAWDE ZWIAZANY. Identyfikator
      // konta nie jest poswiadczeniem (niezmiennik 4.10 dotyczy tokenow i hasel), a jest
      // JEDYNA rzecza, po ktorej czlowiek pozna, ze przewiazal kanal na zle konto —
      // device flow wiaze z kontem ZALOGOWANYM W PRZEGLADARCE, a nie z nazwa kanalu.
      // 28.08.2026 kosztowalo to 6 zdublowanych zamowien i przestawiony kursor pollera.
      kontoAllegro: kontoZTokenu(s.access_token),
    };
  }

  // Zapis pary po KAZDEJ udanej odpowiedzi (odswiezenie i device flow) — jedno miejsce,
  // zeby liczenie dat nie rozjechalo sie miedzy dwiema sciezkami.
  function zapiszPare(d, generacja) {
    // ⚠️ `expires_in` bywa stringiem („43199”) — `Number` to prostuje, a `Number.isFinite`
    // odsiewa `undefined`, `null` i smiec. BEZ tego `new Date(NaN).toISOString()` RZUCA
    // RangeError, zapis nigdy sie nie wykonuje, a para po stronie Allegro jest juz zrotowana.
    const sekundy = Number(d.expires_in);
    const zycie = Number.isFinite(sekundy) && sekundy > 0 ? sekundy : ZAPASOWE_ZYCIE_ACCESS_S;
    zapiszTokeny(db, kanal, {
      accessToken: d.access_token,
      refreshToken: d.refresh_token,
      wygasaAt: new Date(Date.now() + zycie * 1000).toISOString(),
      refreshWygasaAt: new Date(Date.now() + DNI_ZYCIA_REFRESH * 86400000).toISOString(),
    }, generacja);
  }

  async function odswiez(refreshToken) {
    const generacja = generacjaDostepu(db, kanal);
    sprawdzGeneracjeDostepu(db, kanal, generacja);
    // ⚠️ TUTAJ OSLONY NA `fetch` NIE MA I MIEC NIE MOZE — i to jest decyzja, a nie
    // przeoczenie (sprawdzone przy naprawie wiazania, 2026-08-05).
    //
    // REFRESH TOKEN ALLEGRO JEST JEDNORAZOWY. Wyjatek
    // z `fetch` jest przy tym NIEROZSTRZYGALNY — zadanie moglo nie wyjsc wcale, ale rownie
    // dobrze moglo dojsc i zrotowac pare, a urwac sie dopiero na odpowiedzi. Ponowienie
    // tym samym tokenem byloby wtedy REUZYCIEM, a Allegro po wykryciu reuzycia potrafi
    // uniewaznic cala rodzine tokenow — czyli zabic kanal az do wizyty czlowieka przy
    // przegladarce. Ryzykujemy wiec kanalem, zeby oszczedzic jedno zadanie HTTP.
    //
    // Nie musimy: poller tyka co 2 minuty i sam sprobuje ponownie, czytajac wiersz z bazy
    // NA NOWO (`odswiezRaz`). Cena bledu sieciowego to tutaj jeden pominiety przebieg
    // synchronizacji, a nie martwy kanal. Wyjatek leci wiec w gore — `finally`
    // w `odswiezRaz` zwalnia blokade, a poller loguje i idzie dalej.
    const r = await http(`${ustawienia.auth}/token`, {
      method: 'POST',
      headers: naglowki(),
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    // ⚠️ `.catch` OBOWIAZKOWO: Allegro pod obciazeniem potrafi oddac HTML-owa strone bledu
    // albo puste cialo. Bez tego `.json()` rzuca SyntaxError i ginie CALA obsluga ponizej —
    // razem ze sladem dla czlowieka.
    const d = (await r.json().catch(() => null)) ?? {};
    sprawdzGeneracjeDostepu(db, kanal, generacja);
    if (!r.ok) {
      // ⚠️ NIE PONAWIAMY. Kazda proba po nieudanym odswiezeniu leci tokenem, ktory Allegro
      // mogl juz zrotowac — petla ponowien spalilaby swiezo wydana pare.
      //
      // Do bazy i do wyjatku idzie kod HTTP, kod bledu OAuth i zdanie napisane przez nas.
      // `error_description` NIE JEST CZYTANE — przy bledach OAuth potrafi w nim stac
      // fragment poswiadczen (niezmiennik 4.10).
      const kod = kodOauth(d);
      zapiszBladTokenu(db, kanal, komunikatOdmowy(r.status, kod, kanal));
      throw new Error(`Allegro ${kanal}: odświeżenie tokenu odrzucone (HTTP ${r.status}${kod ? `, ${kod}` : ''})`);
    }
    // ⚠️ KSZTALT SPRAWDZANY PRZED LICZENIEM DAT. Odpowiedz 200 bez pary tokenow znaczy, ze
    // Allegro zrotowalo pare, a my nie mamy czym odswiezac dalej — kanal wlasnie umarl.
    // Bez tego sladu w bazie zostawalby `ostatni_blad = NULL`, czyli czlowiek NIE
    // DOWIEDZIALBY SIE, ze kanal jest martwy, dopoki nie zauwazy braku zamowien.
    if (!d.access_token || !d.refresh_token) {
      zapiszBladTokenu(
        db,
        kanal,
        `Allegro odpowiedziało na odświeżenie tokenu (HTTP ${r.status}), ale bez kompletnej pary `
        + 'tokenów — panel nie ma czym odświeżać dalej. Trzeba połączyć kanał ponownie '
        + `(„Połącz z Allegro” w ${GDZIE_POLACZYC(kanal)}).`,
      );
      throw new Error(`Allegro ${kanal}: odpowiedź odświeżenia bez pary tokenów (HTTP ${r.status})`);
    }
    // ⚠️ ZAPIS CALEJ PARY, RAZEM Z `refresh_token`. Stary refresh jest po tej odpowiedzi
    // spalony po stronie Allegro — zostawienie go w bazie znaczy, ze kolejne odswiezenie
    // poleci wartoscia, ktora na pewno nie zadziala.
    zapiszPare(d, generacja);
    return d.access_token;
  }

  // Odswiezenie z deduplikacja: dwa rownolegle `waznyToken()` na wygaslym tokenie robia
  // DOKLADNIE JEDNO wyjscie do sieci i dostaja ten sam nowy token.
  function odswiezRaz() {
    const wToku = mapaTrwajacych(db);
    const juzTrwa = wToku.get(kanal);
    if (juzTrwa) return juzTrwa;

    const obietnica = (async () => {
      // ⚠️ PONOWNY ODCZYT WIERSZA, juz pod „blokada". Wywolujacy przeczytal wiersz przed
      // `await`-em; w miedzyczasie inne wywolanie moglo zdazyc zrotowac pare. Poleciec tu
      // refresh tokenem z tamtego odczytu znaczy wyslac token JUZ SPALONY.
      const w = wiersz();
      if (!w?.refresh_token) throw new Error(`Allegro ${kanal}: kanał nie jest połączony — użyj „Połącz z Allegro” w ${GDZIE_POLACZYC(kanal)}.`);
      if (zywy(w)) return w.access_token;
      return odswiez(w.refresh_token);
    })();

    // ⚠️ `finally`, a nie `then`: odswiezenie zakonczone BLEDEM tez musi zwolnic wpis.
    // Niezwolniona blokada wyciszylaby kanal na zawsze — cicho, bo panel dalej dziala
    // (ta sama lekcja co `wTrakcie` w services/poller.js).
    //
    // ⚠️ Porownujemy z `zpilnowana`, czyli z TYM, CO NAPRAWDE LEZY W MAPIE — nie z surowa
    // `obietnica`. Pomylka tych dwoch znaczy, ze warunek nigdy nie jest prawdziwy, wpis
    // zostaje na zawsze i kanal po pierwszym 503 milknie do restartu procesu.
    const zpilnowana = obietnica.finally(() => {
      if (wToku.get(kanal) === zpilnowana) wToku.delete(kanal);
    });
    // Wpis stawiamy SYNCHRONICZNIE, jeszcze zanim ktokolwiek zdazy nas wywlaszczyc.
    wToku.set(kanal, zpilnowana);
    // Ostatni `catch` jest tylko po to, zeby wpis w mapie nie byl „unhandled rejection"
    // dla wywolujacego, ktory sie na niego nie zapisze. Wynik i tak oddajemy niezmieniony.
    zpilnowana.catch(() => {});
    return zpilnowana;
  }

  async function waznyToken() {
    sprawdzGeneracjeDostepu(db, kanal);
    const w = wiersz();
    // Kanal niepolaczony ma powiedziec CO ZROBIC, a nie wywalic sie na `undefined`.
    if (!w?.refresh_token) throw new Error(`Allegro ${kanal}: kanał nie jest połączony — użyj „Połącz z Allegro” w ${GDZIE_POLACZYC(kanal)}.`);
    return zywy(w) ? w.access_token : odswiezRaz();
  }

  return { waznyToken, stan, stanDlaEkranu };
}
