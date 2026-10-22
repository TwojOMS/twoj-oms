import { koloryStatusow, etykietyStatusow, wPamieciStatusowZadania } from '../../oms/db/statusy.js';
import { katalogiWidokow, sciezkaWidoku } from './widoki.js';
import fastifyView from '@fastify/view';
import fastifyStatic from '@fastify/static';
import { adresZasobu } from './wersja-zasobow.js';
import { logoInstalacji } from './logo-instalacji.js';
import fastifyFormbody from '@fastify/formbody';
import fastifyBasicAuth from '@fastify/basic-auth';
import ejs from 'ejs';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { zarejestrujOchroneCsrf } from '../bezpieczenstwo/csrf.js';
import { zbudujStraznika } from '../bezpieczenstwo/straznik.js';
import { podgladUstawienDemo, wUstawieniach } from '../bezpieczenstwo/podglad-demo.js';
import { nazwaCiasteczkaOms } from '../bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../bezpieczenstwo/sekret-sesji.js';
import { kontoPoLoginie, czyIstniejeCzynnyAdmin } from '../bezpieczenstwo/konta.js';
import { motywZNaglowka, bezpiecznyPowrot } from '../../domena/motyw.js';
import { bezpiecznyPowrotNaListe } from '../../domena/filtry-listy.js';
import { wKontekscie } from '../../domena/kontekst-zadania.js';
import { nawigacjaDla } from '../../domena/menu-stron.js';
import { wylaczoneModuly } from '../../oms/db/moduly-opcjonalne.js';
import { indeksListy } from '../../oms/db/indeks-listy.js';
import { menuKontaDla } from '../../domena/menu-konta.js';
import { maDostepDoAdresu, tytulEkranuDlaAdresu } from '../../domena/ekrany.js';
import { fmtDataCzas, fmtDataCzasKrotko } from '../../domena/format-daty.js';
import { etapPrzesylki, etykietaEtapu, dniKalendarzowe } from '../../domena/etap-przesylki.js';
import { etykietaWysylki, nazwaDostawy } from '../../domena/wysylka.js';
import { klasaStatusu, modyfikatorStatusu } from './klasa-statusu.js';
// Liczniki statusów zamówień do bocznego menu na ekranach, które nie niosą własnego `panelStatusow`
// (Przesyłki, Faktury…). Z TEGO SAMEGO indeksu co lista (PRZ-051), więc liczby się zgadzają.
// ⚠️ Bez liczb, gdy indeksu nie ma (panel indywidualny, baza bez migracji) albo się nie odświeżył:
// liczba sprzed zapisu, który nie doszedł, twierdziłaby coś, czego nie ma, a strona ma się otworzyć.
async function licznikiStatusowDlaMenu(db, req, nawigacja) {
  if (req.method !== 'GET' || !nawigacja?.kontekst?.statusy?.length) return null;
  try {
    const teraz = Date.now();
    const indeks = indeksListy(db);
    await indeks.odswiez(teraz);
    const l = indeks.liczniki(teraz);
    return { do_zrobienia: l.do_zrobienia, wszystkie: l.wszystkie, po_terminie: l.po_terminie, ...l.statusy };
  } catch (e) {
    req.log?.error?.(e, 'indeks listy: liczniki menu niepoliczone');
    return null;
  }
}

function kanonicznyPowrot(adresPowrotu, definicje) {
  const adres = new URL(bezpiecznyPowrot(adresPowrotu), 'http://oms.local');
  const zagniezdzone = adres.searchParams.getAll('powrot');
  if (zagniezdzone.length === 1) {
    const powrot = bezpiecznyPowrotNaListe(zagniezdzone[0], definicje);
    if (powrot === '/') adres.searchParams.delete('powrot');
    else adres.searchParams.set('powrot', powrot);
  } else if (zagniezdzone.length > 1) {
    // Dwie wartosci nie maja jednoznacznego znaczenia. Nie wybieramy pierwszej ani ostatniej,
    // bo warstwy HTTP roznie interpretuja duplikaty, a jedna z nich moze wskazywac obcy host.
    adres.searchParams.delete('powrot');
  }
  return `${adres.pathname}${adres.search}`;
}
function adresZReferer(req) {
  const referer = req.headers.referer ?? req.headers.referrer;
  const host = req.headers.host;
  if (!referer || !host) return null;
  try {
    const zrodlo = new URL(String(referer));
    const biezacyOrigin = new URL(`${req.protocol}://${host}`).origin;
    if (zrodlo.origin !== biezacyOrigin) return null;
    return `${zrodlo.pathname}${zrodlo.search}`;
  } catch {
    return null;
  }
}
function sciezkaPowrotuDlaMenu(app, req, definicje) {
  if (req.method === 'GET' || req.method === 'HEAD') return kanonicznyPowrot(req.url, definicje);

  // Odpowiedz wyrenderowana przez POST nie moze wracac pod ten sam adres: przegladarka po
  // zmianie motywu wykona GET. Referer opisuje ekran z formularzem, a pole `powrot` jest
  // bezpiecznym zapasem dla lancuchow POST -> POST. Kazdy kandydat musi byc istniejaca
  // trasa GET; ciala operacji ani pozostalych pol formularza nie przenosimy do URL-a.
  const kandydaci = [adresZReferer(req), req.body?.powrot];
  for (const kandydat of kandydaci) {
    if (kandydat == null) continue;
    const powrot = kanonicznyPowrot(kandydat, definicje);
    const pathname = new URL(powrot, 'http://oms.local').pathname;
    // ⚠️ `findRoute`, NIE `hasRoute` (Fastify 5, 2026-09-29). W v5 `hasRoute` porownuje
    // WZORZEC definicji (`/zamowienia/:id`), wiec adres karty z numerem nie pasowal i powrot
    // po cichu spadal na liste. `findRoute` idzie przez `router.find` — dopasowuje KONKRETNA
    // sciezke tym samym routerem, ktory obsluguje zadania (tak dzialalo `hasRoute` w v4).
    // Wlasne dopasowanie po spisie `trasyOms` byloby drugim routerem z inna semantyka
    // (parametry z regexem, `/public/*`, ukosnik koncowy). Pilnuje: motyw-post.test.js
    // i scripts/mutacje-fastify5-powrot.mjs.
    if (app.findRoute({ method: 'GET', url: pathname })) return powrot;
  }
  return '/';
}
const __dir = dirname(fileURLToPath(import.meta.url));
const __publicDir = join(__dir, '../../public');
const SYGNATURA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function wczytajLogo(plik) {
  let bajty;
  try { bajty = readFileSync(plik); } catch { throw new Error('OMS_LOGO_PLIK: nie da się odczytać pliku'); }
  if (!bajty.subarray(0, 8).equals(SYGNATURA_PNG)) throw new Error('OMS_LOGO_PLIK: plik nie jest obrazem PNG');
  return bajty;
}
export function registerWeb(app, {db, config}) {
// Ten sam znak w belce i na karcie; bez konfiguracji karta używa PNG 32 px z paczki.
const logo = config.marka?.logoPlik ? wczytajLogo(config.marka.logoPlik) : null;
const znak = logoInstalacji(db, { bajty: logo, alt: config.marka?.logoAlt ?? '', wPliku: Boolean(config.marka?.logoPlik) });
app.decorate('logoInstalacji', znak);
let ostatnieLogo;
let adres;
const zasob = nazwa => {
  const bajty = znak.biezace().bajty;
  if (!adres || bajty !== ostatnieLogo) {
    ostatnieLogo = bajty;
    adres = adresZasobu(__publicDir, bajty ? { 'favicon-32.png': bajty, 'favicon-192.png': bajty } : {});
  }
  return adres(nazwa);
};
const menu = app.menuOms;
if (!Array.isArray(menu)) throw new Error('Brak menuOms z manifestów Aplikacja.menu');
const trasyOms = [];
app.addHook('onRequest', (_req, _reply, done) => { wPamieciStatusowZadania(done); });
app.addHook('onRoute', (opcje) => {
    const metody = Array.isArray(opcje.method) ? opcje.method : [opcje.method];
    for (const metoda of metody) trasyOms.push({ metoda, url: opcje.url });
  });
app.decorate('trasyOms', trasyOms);
app.addHook('onRoute', (opcje) => {
    const oryginal = opcje.handler;
    opcje.handler = function (req, reply) {
      const kto = req.konto && !req.konto.serwisowe ? req.konto.imie : null;
      return wKontekscie(kto, () => oryginal.call(this, req, reply));
    };
  });
app.register(fastifyFormbody);
app.register(fastifyBasicAuth, {
    authenticate: { realm: 'OMS' },
    validate: async (user, pass) => {
      if (user !== config.auth.user || pass !== config.auth.pass) throw new Error('Unauthorized');
    },
  });
app.register(fastifyView, {
    engine: { ejs },
    root: join(__dir, '../..'),
    layout: 'core/web/widoki/layout-oms.ejs',
options: { views: katalogiWidokow() },
    // `fmtDataCzas`/`fmtDataCzasKrotko` w defaultContext, zeby byly dostepne w KAZDYM
    // widoku bez przekazywania ich osobno w kazdej trasie (Zadanie „strona glowna",
    // punkt C) — jeden format daty w calym module, patrz domain/format-daty.js. Tak samo
    // `klasaStatusu`: lista i karta maluja ten sam status jedna funkcja (web/klasa-statusu.js).
    //
    // ⚠️ `etykietaWysylki` jest tu z TEGO SAMEGO powodu, ale stawka jest wyzsza: od
    // 2026-08-01 nazwa dostawy i dopisek „(pobranie)" to DWIE wartosci sklejane w jedna
    // etykiete. Lista, karta i ekran nadania musza mowic o tej samej paczce tak samo —
    // widok skladajacy ten dopisek u siebie zgubilby go przy pierwszym przeoczeniu, a to
    // jest informacja o pieniadzach, ktore kurier ma zainkasowac.
    defaultContext: {
      title: 'Zamówienia', fmtDataCzas, fmtDataCzasKrotko, klasaStatusu, modyfikatorStatusu,
      etykietaStatusu: klucz => klucz,
      etapPrzesylki, etykietaEtapu, dniKalendarzowe,
      etykietaWysylki,
      // Pelna nazwa uslugi (Allegro) z odwrotem na etykiete kubelka — patrz domain/wysylka.js.
      nazwaDostawy,
      // ⚠️ htmx WYLACZONY DOMYSLNIE i wlaczany po jednym ekranie (`htmx: true` z trasy).
      // Ekran zwrotu ma nie miec ANI JEDNEGO skryptu — jego dwukrokowosc bierze sie stad,
      // ze nic nie liczy sie na zywo, i pilnuje tego test. Wartosc domyslna tutaj sprawia,
      // ze ekran dopisany w przyszlosci nie dostanie biblioteki przez przypadek ani nie
      // wywali szablonu na brak zmiennej.
      htmx: false,
      // Gorny pasek rysuje sie WSZEDZIE poza ekranem logowania. Wartosc domyslna stoi
      // tutaj, a nie w kazdej trasie osobno - inaczej pierwszy widok dopisany pozniej
      // wywalilby caly szablon na brak zmiennej, i to dopiero na produkcji.
      bezPaska: false,
      proba: false,
      demo: null,
      podgladDemo: false,
      // PRZ-100: adresy /public/*.css|js z wersją (`?v=`) — po wydaniu przeglądarka za pośrednikiem nie trzyma starego pliku.
      zasob,
    },
  });
app.register(fastifyStatic, { root: __publicDir, prefix: '/public/' });
// Te same adresy dla pliku, zapisu z panelu i paczki. Zapis działa bez restartu.
for (const nazwa of ['favicon-192.png', 'favicon-32.png']) {
  app.get(`/public/${nazwa}`, async (_req, reply) => reply.type('image/png')
    .send(znak.biezace().bajty ?? readFileSync(join(__publicDir, nazwa))));
}
// Starsze zakładki i przeglądarki pytające domyślnie o ICO trafiają na ten sam PNG co układ.
app.get('/favicon.ico', async (_req, reply) => reply.redirect(zasob('favicon-32.png'), 301));
wczytajSekret(db);
app.after(() => {
app.addHook('preHandler', async (_req, reply) => {
 const view = reply.view;
 reply.view = function(page, ...args) { return view.call(this, typeof page === 'string' ? sciezkaWidoku(page) : page, ...args); };
});
app.addHook('onRequest', zbudujStraznika({
      basicAuth: app.basicAuth, db, nazwaCiasteczka: nazwaCiasteczkaOms(config.proba),
      odlozoneEkrany: () => config.odlozoneEkrany ?? wylaczoneModuly(db),
      // ⚠️ WSTRZYKIWANE, a nie siegane ze srodka straznika: ten sam modul obsluguje panel
      // zamowien indywidualnych, ktory kont NIE MA i ma sie zachowywac dokladnie jak dotad
      // (dowodzi tego tests/security/panel-bez-kont.test.js).
      konta: {
        kontoPoLoginie: (login) => kontoPoLoginie(db, login),
        czyIstniejeCzynnyAdmin: () => czyIstniejeCzynnyAdmin(db),
        loginSerwisowy: config.auth.user,
        usluga: 'oms',
      },
    }));
// PRZ-083: demo publiczne — gość ogląda Ustawienia, nie zapisuje (podglad-demo.js). Bez konta gościa haka nie ma.
if (config.demo) app.addHook('onRequest', podgladUstawienDemo({ loginGoscia: config.demo.login }));
zarejestrujOchroneCsrf(app);
app.addHook('preHandler', async (req, reply) => {
      const kolory = koloryStatusow(db);
      const etykiety = etykietyStatusow(db);
      const sciezkaPowrotu = sciezkaPowrotuDlaMenu(app, req, config.definicje);
      const odlozoneEkrany = config.odlozoneEkrany ?? wylaczoneModuly(db);
      const nawigacja = nawigacjaDla({ sciezka: req.url, konto: req.konto ?? null, menu, odlozoneEkrany, etykietyStatusow: etykiety });
      reply.locals = {
        ...(reply.locals ?? {}),
        klasaStatusu: s => klasaStatusu(s, kolory),
        modyfikatorStatusu: s => modyfikatorStatusu(s, kolory),
        etykietaStatusu: klucz => etykiety[klucz] ?? klucz,
        title: tytulEkranuDlaAdresu(req.url),
        motyw: motywZNaglowka(req.headers.cookie),
        // Adres, na ktory ma wrocic przelacznik motywu. `req.url` niesie sciezke razem
        // z zapytaniem, wiec przelaczenie nie gubi ani filtrow, ani otwartej sekcji karty.
        sciezkaPowrotu,
        // Wspólny model działów i menu kontekstowego korzysta z tej samej mapy ekranów
        // oraz tych samych praw co strażnik. Lista i karta nadpisują wyłącznie
        // `panelStatusow`, bo jako jedyne znają rzeczywiste liczniki i aktywny filtr.
        nawigacja,
        modulWlaczony: (modul) => !odlozoneEkrany.includes(modul),
        // PRZ-085: liczby przy statusach na KAŻDEJ zakładce, nie tylko na liście i karcie.
        licznikiStatusow: await licznikiStatusowDlaMenu(db, req, nawigacja),
        // Kontrolki pytaja o SWOJ adres. Mapowanie adres -> zakres pozostaje jedno,
        // wspolne ze straznikiem; widok nie utrzymuje drugiej listy praw.
        mozeAdres: (url) => maDostepDoAdresu(req.konto ?? null, url),
        // Model Ustawień ukrywa „Użytkowników i uprawnienia" bez flagi `admin` — bez tego
        // pola trasy nie wiedziałyby, które pozycje przekazać do wspólnego slotu nawigacji,
        // kto akurat patrzy na strone. `req.konto` jest `undefined` na panelu indywidualnym
        // (straznik wolany tam BEZ `konta`, patrz web/straznik.js), stad `?? null`.
        konto: req.konto ?? null,
        menuKonta: menuKontaDla(req.konto ?? null, { powrot: sciezkaPowrotu }),
        // Tekst alternatywny znaku w belce (PRZ-060, OMS_LOGO_ALT); bez niego znak jest ozdobą.
        marka: { logoAlt: znak.biezace().alt },
        logoInstalacji: { wPliku: znak.wPliku, ...znak.biezace() },
        // PRZ-075: tryb próby (lista: komunikat demo zamiast alarmu synchronizacji) i konto gościa demo
        // (ekran logowania pokazuje jego login i hasło). Poza trybem próby `demo` jest zawsze null (core/demo.ts).
        proba: config.proba === true,
        demo: config.demo ?? null,
        // PRZ-083: gość demo na ekranie Ustawień — układ robi treść martwą i stawia pasek podglądu (podglad-demo.js).
        podgladDemo: req.konto?.podgladDemo === true && wUstawieniach(req.url),
      };
    });
});
return app;
}
