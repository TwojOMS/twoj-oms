import { dzienWarszawa } from '../../../domena/format-daty.js';
import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { EKRAN_INFAKTU, GDZIE_KLUCZ_INFAKTU } from '../../../domena/konfiguracja-infakt.js';
import { zl } from '../../../domena/suma-pozycji.js';
import { MIESIACE } from '../../../domena/okres-rozliczeniowy.js';
import { bezpiecznaNazwa } from '../../../domena/pliki.js';
import { doZaznaczenia, zakresMiesiaca, sumaListy } from '../../../domena/lista-faktur.js';
import { csvZaznaczonych, nazwaPlikuZaznaczonych } from '../../../domena/eksport-faktur-csv.js';
import { MAX_ZAZNACZONYCH } from '../../koszty/services/paczka-dla-biura.js';
import { czyKonsumencka, powrotWysylkiKsef } from '../../../domena/wysylka-ksef.js';
import { czyWysylacKonsumenckie } from '../db/ksef-konsumenckie.js';
import { KTO_AUTOMAT } from '../../../domena/ksef-automat.js';
import { wczytajAutomatKsef, zwolnijWstrzymane, czyDoZwolnienia } from '../db/ksef-automat.js';
import { zdanieWstrzymanej } from '../../../domena/ostrzezenia.js';
import { skrocFormePrawna } from '../../../domena/forma-prawna.js';
// Lista czesci paczki jedzie z uslugi — trasa jej nie powtarza. Druga kopia rozjechalaby sie
// z usluga przy pierwszej zmianie i albo odmawialaby czesci, ktora panel sklada, albo
// przepuszczala nazwe, ktorej nie zna.
import { CZESCI } from '../czesci-biura.js';
import { fakturyMozliweDoOdnotowaniaSkasowania } from '../db/faktury.js';
import { stanArchiwumSprzedazy, licznikiArchiwum } from '../db/archiwum-sprzedazy.js';
import { ktoKlikal } from '../../zamowienia/lista.js';
import { wylaczoneModuly } from '../../../oms/db/moduly-opcjonalne.js';
import { zProgramu } from '../../../integracje/program-fakturowy.ts';
import { odmianaNazwyProgramu, gdzieDokument } from '../../../domena/nazwa-programu.js';
import { zdanieBrakuProgramu, EKRAN_WYBORU_PROGRAMU } from '../../../domena/wybor-programu.js';
import { POWOD_BRAK_ZGODY } from '../../../domena/zgoda-ksef.js';
import { EKRAN_KSEF_SPRZEDAZY } from '../../../domena/ekrany.js';

// Wspólne dla zestawienia za okres i zestawienia zaznaczonych — jedno zdanie, jedno miejsce.
const zdanieBrakuZestawienia = `Panel nie ma podpiętego inFaktu — nie ma z czego złożyć zestawienia faktur. ${GDZIE_KLUCZ_INFAKTU}`;

// Zakladka FAKTURY. Trasa jest CIENKA: parsuje zadanie, wola usluge, renderuje.
// Reguly sa w domain/lista-faktur.js, sklejenie danych w services/faktury-widok.js.

const POLA = new Set(['invoice_date', 'sale_date']);
const TYPY = new Set(['vat', 'korekta']);
const PLATNOSCI = new Set(['zaplacona', 'niezaplacona']);

// Ile miesiecy wstecz w liscie wyboru. Rok to jeden pelny cykl rozliczeniowy; starsze
// dokumenty i tak leza w archiwum PDF na NAS-ie.
const MIESIECY_W_WYBORZE = 13;

// ⚠️ ZAKLADKA MA ODPOWIEDZIEC TAKZE WTEDY, GDY PANEL NIE MA inFAKTU. Ikona w pasku gornym
// prowadzaca w 404 wyglada jak usterka panelu, a nie jak funkcja, ktorej jeszcze nie ma —
// ta sama decyzja, co przy /raporty i /ustawieniach (routes/panel.js).
const BEZ_INFAKTU = {
  title: 'Faktury',
  naglowek: 'Faktury',
  opis: 'Ten panel nie ma podpiętego inFaktu, więc nie ma skąd wziąć faktur — zakładka jest '
    + 'pusta celowo. Dokumenty czyta się na żywo z inFaktu; bez klucza API inFaktu nie ma o co pytać. '
    + 'Klucz wpiszesz w Ustawienia → Integracje → inFakt (albo INFAKT_API_KEY w pliku konfiguracji); '
    + 'klucz zapisany na ekranie po raz pierwszy włącza tę zakładkę po ponownym uruchomieniu OMS-u.',
  // PRZ-093.10: odesłanie do ekranu konfiguracji (pusta-strona.ejs pokazuje je pod opisem).
  odnosnik: { href: EKRAN_INFAKTU, etykieta: 'Ustawienia → Integracje → inFakt' },
};

// PRZ-121.03a: przy JAWNYM „brak” zakładka mówi, że faktury są wyłączone (i gdzie obejrzeć stare), a nie prosi o klucz.
const bezProgramu = (wybor, strona) => {
  const zdanie = zdanieBrakuProgramu(wybor, 'Wcześniejsze faktury obejrzysz w programie, w którym je wystawiono.');
  return zdanie ? { ...strona, opis: zdanie, odnosnik: { href: EKRAN_WYBORU_PROGRAMU, etykieta: 'Ustawienia → Integracje → Moduł faktur' } } : strona;
};
const DOPISEK_PDF = 'PDF wcześniejszej faktury pobierzesz w programie, w którym ją wystawiono.';

// ⚠️ BIALA LISTA RODZAJOW DOKUMENTU DO POBRANIA PDF-U. Wczesniej trasa nizej brala „wszystko,
// co nie jest korekta" za fakture VAT — czyli literowka w adresie (`?rodzaj=vt`) albo nowy,
// nieznany rodzaj z inFaktu jechal po zasob /invoices/ i konczyl sie surowym 404 z API
// zamiast zdaniem, ktore operator rozumie. To ta sama zasada, co przy `POLA` wyzej i przy
// `POLA_DATY` w services/faktury-widok.js: nazwa spoza listy ma ODMOWIC, a nie zgadnac.
const RODZAJE_PDF = new Set(['vat', 'korekta']);

// Ile znakow komunikatu z adresu wolno pokazac. Tresc sklada trasa nizej, ale przyjsc moze
// z dowolnego adresu — a akapit dlugosci ekranu rozpychalby zakladke. EJS `<%= %>` i tak
// escapuje, wiec chodzi tu wylacznie o rozmiar.
// Katalog archiwum sprzedaży: program wbudowany czyta OMS_ARCHIWUM_SPRZEDAZY, inFakt — dawną zmienną (PRZ-122.B13).
const zmiennaArchiwum = (program) => (program?.opis?.wbudowany ? 'OMS_ARCHIWUM_SPRZEDAZY' : 'INFAKT_ARCHIWUM');
const MAX_KOMUNIKATU = 300;

// ⚠️ JEDNO ZRODLO PRZEDROSTKA DLA TRASY I WIDOKU. Trasa sklada tym przedrostkiem komunikat
// bledu (POST /faktury/archiwum/uruchom nizej), a widok (faktury.ejs) go NIE dopasowuje —
// dostaje juz gotowy `komunikatZly`. Dwie kopie tego samego lancucha rozjechalyby sie przy
// pierwszej zmianie tresci komunikatu (dokladnie tak, jak Finding z recenzji Zadania 7).
export const PREFIKS_BLEDU_ARCHIWUM = 'Archiwum: błąd';

export function registerFakturyRoutes(app, {
  // PRZ-118.07: PDF z listy czyta PROGRAM FAKTUROWY — `{ program }` albo stary `{ infakt }` (moduł podaje usługę
  // `infakt`; zProgramu owija klienta inFaktu adapterem, a program z szwu zostawia sobą).
  db = null, fakturyWidok = null, program: programPodany = null, infakt = null, wysylkaKsef = null,
  czuwaczArchiwumSprzedazy = null,
  // Paczka dla biura rachunkowego (spec 2026-09-02). `null` = panel bez inFaktu, czyli tryb
  // POPRAWNY: nie ma z czego zlozyc paczki, wiec przycisku po prostu nie ma (ta sama zasada,
  // co przy `mozliwyOdswiez` i `mozliwyPdf` na zakladce KOSZTY).
  paczkaDlaBiura = null,
  // PRZ-121.03a: wybór modułu faktur (usługa `wyborProgramu`); bez niego — teksty jak dotąd.
  wyborProgramu = null,
} = {}) {
  const program = zProgramu({ program: programPodany, infakt });
  // PRZ-118.09: nazwa programu w zdaniach ekranów (bez programu — inFakt, jak przed zmianą; domena/nazwa-programu.js).
  const nazwaProgramu = odmianaNazwyProgramu(program);
  const pokazWynikKsef = (req, reply, dane) => reply.view('ksef-wynik.ejs', {
    ...dane,
    programWbudowany: program?.opis?.wbudowany === true,
    // Tak samo jak zapis zgody: samo uprawnienie do Ustawień daje tylko odczyt.
    ustawieniaKsef: req.konto?.admin === true && dane.blad === POWOD_BRAK_ZGODY ? EKRAN_KSEF_SPRZEDAZY : null,
  });
  // ⚠️ PRZ-118.07: PROGRAM BEZ ZDOLNOŚCI `wyslijDoKsef` — podgląd i zatwierdzenie odpowiadają zdaniem z usługi wysyłki
  // (jedno źródło: program, którym usługa naprawdę wysyła), a nie ekranem wysyłki, która i tak by nie poszła.
  const odmowaWysylki = (reply) => reply.code(409).type('text/plain; charset=utf-8').send(wysylkaKsef.niedostepna);
  app.get('/faktury', async (req, reply) => {
    if (!fakturyWidok) return reply.view('pusta-strona.ejs', bezProgramu(wyborProgramu, BEZ_INFAKTU));

    const dzis = dzienWarszawa(new Date().toISOString());
    // Nieznany miesiac i nieznane pole wracaja do domyslnych zamiast odmawiac — to jest
    // przelacznik widoku, a nie decyzja o pieniadzach. Usluga i tak ma wlasna bramke
    // (services/faktury-widok.js), wiec nic zmyslonego nie dojdzie do zapytania.
    const miesiac = /^\d{4}-\d{2}$/.test(String(req.query.miesiac ?? ''))
      ? String(req.query.miesiac) : dzis.slice(0, 7);
    const pole = POLA.has(req.query.pole) ? req.query.pole : 'invoice_date';
    const typ = TYPY.has(req.query.typ) ? req.query.typ : '';
    const platnosc = PLATNOSCI.has(req.query.platnosc) ? req.query.platnosc : '';
    const filtry = (typ ? `&typ=${typ}` : '') + (platnosc ? `&platnosc=${platnosc}` : '');
    if (req.query.wybor === 'pdf') {
      return reply.redirect(`/faktury?miesiac=${encodeURIComponent(miesiac)}&pole=${encodeURIComponent(pole)}${filtry}`);
    }
    // „Zaznacz wszystkie" jest ADRESEM, nie skryptem — panel nie ma JavaScriptu, a pole
    // wyboru w nagłówku bez niego nie zaznaczy niczego. Ten sam wzorzec, co nad listą
    // zamówień (routes/zamowienia.js). Adres NIESIE filtr, bo inaczej zaznaczenie
    // przerzucałoby operatora na inny miesiąc niż ten, który ogląda.
    const zaznaczWszystkie = req.query.zaznacz === '1';
    const adres = (zazn) => `/faktury?miesiac=${encodeURIComponent(miesiac)}`
      + `&pole=${encodeURIComponent(pole)}${filtry}${zazn ? '&zaznacz=1' : ''}`;

    // ⚠️ DWIE OSOBNE PROBY, NIE JEDNA (recenzja Zadania 7, Finding 1). `dokumenty` i
    // `nieoplacone` to DWA NIEZALEZNE zapytania do inFaktu — jedno wciaz moze dzialac, gdy
    // drugie akurat pada (np. sekcja dlugu odmawia, bo inFakt oddal kontener, ktorego panel
    // nie rozumie — patrz komentarz przy `nieoplacone()` w services/faktury-widok.js). Gdyby
    // stały w jednym `Promise.all`/`catch`, jedna awaria gasilaby TAKZE pas, ktory akurat
    // dzialal poprawnie — a caly sens tej zakladki to degradacja, nie padniecie (ta sama
    // zasada, co przy `proformy` nizej). `Promise.allSettled` trzyma obie proby rownolegle,
    // a mimo to kazda dostaje wlasny wynik.
    // PRZ-118.07: program bez zdolności `nieoplacone` — o listę nie pytamy, sekcja dostaje zdanie (`brakNieoplaconych`).
    const brakNieoplaconych = fakturyWidok.brakNieoplaconych ?? null;
    const [wynikDokumentow, wynikNieoplaconych] = await Promise.allSettled([
      fakturyWidok.dokumenty({ miesiac, pole, typ, platnosc, dzis }),
      brakNieoplaconych ? [] : fakturyWidok.nieoplacone({ dzis }),
    ]);
    const dokumenty = wynikDokumentow.status === 'fulfilled' ? wynikDokumentow.value : [];
    const bladDokumentow = wynikDokumentow.status === 'rejected'
      ? komunikatDlaOperatora(wynikDokumentow.reason) : null;
    const nieoplacone = wynikNieoplaconych.status === 'fulfilled' ? wynikNieoplaconych.value : [];
    const bladNieoplaconych = wynikNieoplaconych.status === 'rejected'
      ? komunikatDlaOperatora(wynikNieoplaconych.reason) : null;

    // ⚠️ WLASNA PROBA, OSOBNA OD inFAKTU (recenzja Zadania 7, Finding 2). `proformy()` czyta
    // lokalna baze SQLite — inny system, inna awaria — a caly sens tej zakladki to
    // DEGRADACJA, nie padniecie. Gdyby ten wiersz stal w tej samej probie co inFakt (albo
    // wcale bez proby), blad bazy zabralby ze soba pasy nieoplaconych i faktur, ktore akurat
    // dzialaja poprawnie.
    let proformy = [];
    let bladProform = null;
    try {
      proformy = fakturyWidok.proformy({ miesiac });
    } catch (e) {
      bladProform = komunikatDlaOperatora(e);
    }

    return reply.view('faktury.ejs', {
      title: 'Faktury',
      nazwaProgramu,
      programWbudowany: program?.opis?.wbudowany === true,
      miesiac,
      pole,
      typ,
      platnosc,
      adresListy: adres(false),
      sumaListy: bladDokumentow ? null : sumaListy(dokumenty),
      zl,
      doZaznaczenia,
      zaznaczWszystkie,
      adresZaznaczWszystkie: adres(true),
      adresOdznaczWszystkie: adres(false),
      miesiace: listaMiesiecy(dzis, miesiac),
      // Ta sama lista nazw miesiecy, ktorej uzywaja ekrany okresow — szablon nie nazywa
      // miesiaca sam (patrz komentarz przy MIESIACE w domain/okres-rozliczeniowy.js).
      MIESIACE,
      dokumenty,
      nieoplacone,
      proformy,
      bladProform,
      // ⚠️ „SKASOWALEM TE FAKTURE W inFAKCIE" PRZENIESIONE TU Z KARTY ZAMOWIENIA
      // (prosba właściciela 01.09.2026: „na co dzien jest to nieuzywane"). Lista idzie
      // Z NASZEJ BAZY, a nie z inFaktu — dokument skasowany w inFakcie z tamtej listy
      // ZNIKA, wiec akcja przy wierszu z inFaktu byla by niedostepna dokladnie wtedy,
      // gdy jest potrzebna (db/faktury.js: fakturyMozliweDoOdnotowaniaSkasowania).
      doOdnotowaniaSkasowania: db && program?.opis?.wbudowany !== true
        ? fakturyMozliweDoOdnotowaniaSkasowania(db, { miesiac }) : [],
      // Predykat, a NIE nowe pole na dokumencie: `services/faktury-widok.js` ma test-pinner
      // z białą listą pól wyjścia, a widok i tak potrzebuje tu wyłącznie odpowiedzi „tak/nie".
      // Jedno źródło reguły (domain/wysylka-ksef.js) obsługuje obie warstwy.
      czyKonsumencka,
      konsumenckie: czyWysylacKonsumenckie(db),
      // PRZ-078: forma prawna nabywcy skrócona do wyświetlenia (pełna nazwa w `title`).
      skrocFormePrawna,
      // ⚠️ SUMA LICZY SIE TUTAJ, NIE W WIDOKU — widok w tym module niczego nie liczy
      // (ta sama zasada, co przy liscie okresow). `left_to_pay` jedzie z inFaktu
      // W GROSZACH (patrz komentarz przy `kwotaZl` w services/faktury-widok.js), wiec
      // przeliczenie idzie tym samym `zl`, co kazda inna kwota w panelu.
      //
      // `|| 0` zamiast `?? 0`: brakujace pole daje `NaN` po `Number(undefined)`, a jeden
      // uszkodzony wiersz zamienilby CALA sume dlugu w „NaN zl".
      //
      // ⚠️ PRZY BLEDZIE SEKCJI NIE LICZYMY NIC (recenzja Zadania 7, Finding 1). `nieoplacone`
      // jest wtedy pusta tablica (patrz `wynikNieoplaconych` wyzej), a `zl(0)` dalby „0.00 zl"
      // — zdanie „nikt nic nie jest winien", ktore w tej sytuacji jest FALSZYWE: prawda brzmi
      // „nie wiadomo". Widok i tak nie uzyje tej wartosci, gdy `bladNieoplaconych` jest
      // ustawiony (patrz warunek w faktury.ejs), ale `null` tutaj pilnuje tego takze na
      // poziomie danych, gdyby ktos kiedys zapomnial o tym warunku w widoku.
      sumaNaleznosciZl: bladNieoplaconych
        ? null
        : zl(nieoplacone.reduce((s, d) => s + (Number(d?.left_to_pay) || 0), 0)),
      bladDokumentow,
      bladNieoplaconych,
      brakNieoplaconych,
      // ⚠️ ARCHIWUM CZYTA SIE Z NASZEJ BAZY, NIE Z NAS-a. Panel nie chodzi tu po dysku, zeby
      // policzyc pliki — pas stanu ma byc tani, bo wisi nad kazdym otwarciem zakladki.
      // Lustrem tego, co lezy na NAS-ie, jest tabela `archiwum_sprzedazy` (db/archiwum-sprzedazy.js).
      // Przycisk zestawienia pod filtrem. Widok NIE pyta o usluge sam — dostaje gotowa
      // odpowiedz „tak/nie"; brak metody oznacza panel bez inFaktu, wiec nie obiecuje pliku.
      mozliweZestawieniePrzychodow: Boolean(paczkaDlaBiura?.zbudujZestawieniePrzychodow),
      archiwum: {
        wlaczone: Boolean(czuwaczArchiwumSprzedazy),
        zmienna: zmiennaArchiwum(program),
        stan: db ? stanArchiwumSprzedazy(db) : null,
        liczniki: db ? licznikiArchiwum(db) : { dokumentow: 0, skasowanych: 0 },
      },
      // Slad po przebiegu uruchomionym z przycisku — jedzie adresem, bo POST konczy sie
      // przekierowaniem (uzasadnienie przy trasie nizej).
      komunikat: typeof req.query.komunikat === 'string'
        ? req.query.komunikat.slice(0, MAX_KOMUNIKATU) : null,
      // Widok NIE dopasowuje przedrostka sam — jedno zrodlo prawdy to `PREFIKS_BLEDU_ARCHIWUM`
      // wyzej, ktorym POST /faktury/archiwum/uruchom sklada komunikat bledu.
      komunikatZly: typeof req.query.komunikat === 'string'
        && req.query.komunikat.startsWith(PREFIKS_BLEDU_ARCHIWUM),
    });
  });

  // Przycisk „Archiwizuj teraz" — przebieg WYMUSZONY, wzorzec POST /koszty/odswiez.
  //
  // ⚠️ WYMUSZONY, ZAWSZE. Zwykly `przebieg()` sprawdza pore (raz na dobe, w nocy —
  // services/czuwacz-archiwum-sprzedazy.js), wiec przycisk wcisniety w dzien nie zrobilby NIC
  // i wygladalby na zepsuty. Dokladnie ten sam blad poprawiono kiedys przy kosztach.
  //
  // ⚠️ POWROT PRZEZ PRZEKIEROWANIE, a nie render wprost z POST-a: GET /faktury czyta inFakt
  // NA ZYWO (dwa zapytania, wlasna degradacja kazdego pasa), wiec renderowanie ekranu tutaj
  // podwajaloby caly kod filtra. Komunikat jedzie w adresie — to jedyny slad przebiegu.
  //
  // ⚠️ TA TRASA NIE MA WLASNEGO LIMITU CZASU i nie ma go dostac: przeglad trzech miesiecy
  // w inFakcie potrafi trwac minuty, a panel celowo stoi na `requestTimeout: 0` (web/server.js).
  app.post('/faktury/archiwum/uruchom', async (req, reply) => {
    // Brak sekcji INFAKT_ARCHIWUM to tryb POPRAWNY — ale wtedy nie ma czego uruchomic,
    // i odmowa ma to POWIEDZIEC (jak przy pobieraniu PDF-u bez inFaktu wyzej).
    if (!czuwaczArchiwumSprzedazy) {
      return reply.code(503).send(zdanieBrakuProgramu(wyborProgramu) ?? `Panel nie ma włączonego archiwum sprzedaży (brak ${zmiennaArchiwum(program)}).`);
    }
    // Filtr wraca Z OPERATOREM. Bledne wartosci sa tu nieszkodliwe: GET /faktury ma wlasna
    // bramke i wraca do domyslnych — ale przepuszczanie ich dalej niosloby smiec w adresie.
    const miesiac = /^\d{4}-\d{2}$/.test(String(req.body?.miesiac ?? '')) ? String(req.body.miesiac) : '';
    const pole = POLA.has(req.body?.pole) ? req.body.pole : 'invoice_date';
    const typ = TYPY.has(req.body?.typ) ? req.body.typ : '';
    const platnosc = PLATNOSCI.has(req.body?.platnosc) ? req.body.platnosc : '';
    let komunikat;
    try {
      const w = await czuwaczArchiwumSprzedazy.przebieg({ wymuszony: true });
      // ⚠️ POMINIECIE NIE JEST POBRANIEM. Przebieg wymuszony wciaz potrafi odbic sie od
      // blokady „poprzedni jeszcze trwa" — i wtedy NIC sie nie stalo, co ekran ma powiedziec.
      komunikat = w?.pominiety
        ? `Archiwum: nic nie zrobiono — ${w.powod}.`
        : `Archiwum: pobranych ${w.pobranych}, adoptowanych ${w.adoptowanych}, `
          + `nadpisanych ${w.nadpisanych}, bez zmian ${w.bezZmian}, skasowanych ${w.skasowanych}`
          + (w.niedokonczone ? ' — przebieg NIEDOKOŃCZONY, reszta następnej nocy.' : '.');
    } catch (e) {
      // ⚠️ AWARIA ARCHIWUM NIE GASI ZAKLADKI. Faktury czyta sie z inFaktu, a nie z NAS-a —
      // wiec pelny dysk czy zerwany montaz ma wrocic ZDANIEM, nie piecsetka.
      //
      // ⚠️ BLAD TECHNICZNY (bez `dlaOperatora`) NIE NIESIE TU SZCZEGOLOW — `komunikatDlaOperatora`
      // dalaby ogolnikowe „szczegoly w logu zamowienia", a tu nie ma zadnego zamowienia i log nie
      // jest tam, gdzie operator patrzy. Prawdziwy powod juz i tak ZAPISAL czuwacz w
      // `ostatni_blad` (db/archiwum-sprzedazy.js) — linia stanu archiwum nizej na tym samym
      // ekranie go pokaze po odswiezeniu, wiec komunikat ma tam odeslac, a nie zmyslac wlasny.
      komunikat = e?.dlaOperatora
        ? `${PREFIKS_BLEDU_ARCHIWUM} — ${komunikatDlaOperatora(e)}`
        : `${PREFIKS_BLEDU_ARCHIWUM} — szczegóły w linii stanu archiwum poniżej.`;
    }
    return reply.code(303).redirect(
      `/faktury?miesiac=${encodeURIComponent(miesiac)}&pole=${encodeURIComponent(pole)}`
      + (typ ? `&typ=${typ}` : '') + (platnosc ? `&platnosc=${platnosc}` : '')
      + `&komunikat=${encodeURIComponent(komunikat)}`,
    );
  });

  // Zestawienie przychodów: PDF z samą listą faktur i korekt wybranego miesiąca. W odróżnieniu
  // od paczki NIE dokleja dokumentów PDF, więc usługa nie wykonuje ich pobrań z inFaktu.
  app.get('/faktury/zestawienie-przychodow', async (req, reply) => {
    if (!paczkaDlaBiura?.zbudujZestawieniePrzychodow) {
      return reply.code(503).send(zdanieBrakuProgramu(wyborProgramu) ?? `Panel nie ma podpiętego inFaktu — nie ma z czego zbudować zestawienia przychodów. ${GDZIE_KLUCZ_INFAKTU}`);
    }
    const miesiac = String(req.query.miesiac ?? '');
    if (!/^\d{4}-\d{2}$/.test(miesiac)) return reply.code(400).send(`„${miesiac}" to nie jest miesiąc w formacie RRRR-MM.`);
    try {
      const wynik = await paczkaDlaBiura.zbudujZestawieniePrzychodow(miesiac);
      return reply.type('application/pdf')
        .header('Content-Disposition', `attachment; filename="${wynik.nazwa}"`)
        .send(wynik.bajty);
    } catch (e) {
      if (!e?.dlaOperatora) throw e;
      return reply.code(400).send(komunikatDlaOperatora(e));
    }
  });

  // ⚠️⚠️ PACZKA DLA BIURA RACHUNKOWEGO (spec 2026-09-02, Czesc D): scalony PDF miesiaca —
  // zestawienie i dokumenty jednej czesci. Trasa jest CIENKA jak reszta tego pliku: parsuje
  // miesiac i czesc, wola usluge, oddaje bajty. Co i w jakiej kolejnosci wchodzi do paczki,
  // rozstrzyga `services/paczka-dla-biura.js` razem z `domain/paczka-dla-biura.js`.
  //
  // ⚠️⚠️ DWA PLIKI, JEDNA TRASA (decyzja wlasciciela 2026-09-02 wieczorem: „podzial — dwa pliki
  // do pobrania, jeden kosztowy, drugi przychodowy"). `?czesc=sprzedaz` daje zestawienie
  // sprzedazy z fakturami i korektami, `?czesc=koszty` — zestawienie kosztow z fakturami
  // kosztowymi. Jedna trasa, bo obie skladane sa tym samym kodem i podlegaja temu samemu
  // straznikowi; dwie trasy znaczylyby dwie definicje tego, co do paczki wchodzi.
  //
  // ⚠️ TRASA SYNCHRONICZNA — przegladarka CZEKA, i tak ma zostac. Z archiwum na dysku paczka
  // powstaje w sekundy; w najgorszym razie (puste archiwum, pelny miesiac) to ~90 pobran
  // z sieci, czyli do minuty. Panel celowo stoi na `requestTimeout: 0` (web/server.js) i nie
  // ma przed soba proxy, wiec zadanie nie ma sie od czego odbic — a kolejka z powiadomieniem
  // byla by trzecim czuwaczem do utrzymania dla operacji uruchamianej raz na miesiac.
  //
  // ⚠️ WSZYSTKO ALBO NIC: usluga odmawia z NUMEREM dokumentu, ktorego zabraklo, i nie oddaje
  // ani jednego bajtu. Paczka „prawie kompletna" jest gorsza niz brak paczki — ksiegowa nie ma
  // jak zauwazyc, ze brakuje w niej faktury, ktora zestawienie i tak wymienia.
  //
  // ⚠️⚠️ JEDNA PACZKA NARAZ (recenzja calej galezi) — ten sam straznik, co „jeden przebieg
  // naraz" w czuwaczach. Przegladarka wisi na tym zadaniu do minuty i przez ten czas nie
  // pokazuje NICZEGO, wiec drugie klikniecie jest zachowaniem normalnym, a nie bledem
  // operatora. Bez blokady dwa skladania ciagnelyby rownolegle te same ~90 dokumentow
  // z inFaktu i trzymaly dwa komplety bajtow w pamieci tego samego procesu, ktory obsluguje
  // nadania i wystawianie faktur — a operator i tak dostaje jeden plik.
  //
  // ⚠️ ODMOWA JEST GLOSNA (409), NIE CICHYM POMINIECIEM. W czuwaczach pominiety przebieg
  // wraca sam za godzine i nikt na niego nie patrzy; tutaj CZLOWIEK CZEKA na plik, wiec musi
  // dostac zdanie, ktore mowi, ze paczka juz powstaje i nie trzeba klikac trzeci raz.
  let paczkaTrwa = false;
  app.get('/faktury/paczka', async (req, reply) => {
    if (!paczkaDlaBiura) return reply.code(503).send(zdanieBrakuProgramu(wyborProgramu) ?? zdanieBrakuZestawienia);
    if (paczkaTrwa) {
      return reply.code(409).send(
        'Zestawienie faktur jest właśnie składane — poczekaj na pobranie pliku i spróbuj ponownie.',
      );
    }
    // ⚠️ MIESIAC W ADRESIE ODMAWIA, a nie wraca do domyslnego — inaczej niz filtr w GET /faktury
    // wyzej, i to jest rozstrzygniecie. Tam chodzi o PRZELACZNIK WIDOKU (widac, na co sie
    // patrzy); tutaj o PLIK, ktory idzie do ksiegowej: paczka za inny miesiac niz zamowiony
    // wyglada dokladnie tak samo, jak paczka poprawna.
    const miesiac = String(req.query.miesiac ?? '');
    if (!/^\d{4}-\d{2}$/.test(miesiac)) return reply.code(400).send(`„${miesiac}" to nie jest miesiąc w formacie RRRR-MM.`);
    // ⚠️ CZESC TAKZE ODMAWIA, a nie wraca do domyslnej — z tego samego powodu, co miesiac
    // wyzej. Plik sprzedazowy i kosztowy wygladaja identycznie, dopoki sie ich nie otworzy,
    // wiec „niech bedzie sprzedaz" oddawaloby ksiegowej cichaczem nie ten rejestr, o ktory
    // prosila. Usluga ma te sama bramke (jest jedynym miejscem, ktore zna liste czesci) —
    // tutaj stoi po to, zeby odmowa przyszla PRZED wolaniem inFaktu.
    const czesc = String(req.query.czesc ?? '');
    if (!CZESCI.includes(czesc)) {
      return reply.code(400).send(
        `„${czesc}" to nie jest część zestawienia faktur — panel składa dwa pliki: ${CZESCI.join(', ')}.`,
      );
    }
    // PRZ-102.22: wyłączony moduł Koszty (Ustawienia → Moduły) — część kosztowa odmawia ZANIM cokolwiek sięgnie do KSeF;
    // część sprzedażowa (inFakt) działa bez zmian.
    if (czesc === 'koszty' && db && wylaczoneModuly(db).includes('koszty')) {
      return reply.code(409).type('text/plain; charset=utf-8').send(
        'Moduł Koszty jest wyłączony — zestawienie faktur kosztowych niedostępne. Włączysz go w Ustawienia → Moduły; zestawienie faktur sprzedaży działa bez zmian.',
      );
    }
    let wynik;
    // ⚠️ ZATRZASK PODNOSI SIE W `finally` — blokada zostawiona po bledzie wyciszylaby przycisk
    // az do restartu panelu, bez ani jednego sladu: operator dostawalby „paczka jest wlasnie
    // skladana" na trasie, ktora nic juz nie robi. Ta sama pulapka, co w czuwaczach.
    paczkaTrwa = true;
    try {
      wynik = await paczkaDlaBiura.zbuduj(miesiac, czesc);
    } catch (e) {
      // Blad TECHNICZNY leci dalej, do logu — tak samo, jak przy kazdej innej trasie tego pliku.
      if (!e?.dlaOperatora) throw e;
      // PRZ-126.C06: odmowa usługi = strona w układzie panelu (zdanie + powrót na listę), nie goły tekst w nowej karcie.
      return odmowaZestawienia(reply, e.status ?? 400, komunikatDlaOperatora(e), miesiac);
    } finally {
      paczkaTrwa = false;
    }
    return reply.type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${wynik.nazwa}"`)
      .send(wynik.bajty);
  });

  // PRZ-122.B13d1: zestawienie ZAZNACZONYCH faktur z listy (jeden miesiac) — ta sama usluga skladania, co zestawienie
  // za okres, i TEN SAM zatrzask `paczkaTrwa` (jedno skladanie PDF naraz na proces, niezaleznie od rodzaju).
  // POST, bo zaznaczenie bywa dlugie (do 100 identyfikatorow) i nie powinno trafiac do adresu ani historii.
  // Odmowy (400) PRZED wolaniem uslugi — usluga ma te same bramki, tu stoja po to, zeby nie siegac do programu.
  function odmowaZestawienia(reply, status, opis, miesiac, pole) {
    const filtry = new URLSearchParams();
    if (/^\d{4}-\d{2}$/.test(miesiac)) filtry.set('miesiac', miesiac);
    if (POLA.has(pole)) filtry.set('pole', pole);
    return reply.code(status).view('pusta-strona.ejs', {
      title: 'Zestawienie faktur',
      naglowek: 'Nie udało się przygotować zestawienia faktur',
      opis,
      odnosnik: { href: `/faktury${filtry.size ? `?${filtry}` : ''}`, etykieta: '← Wróć do listy faktur' },
    });
  }

  app.post('/faktury/lista-zaznaczonych.csv', async (req, reply) => {
    const body = req.body ?? {};
    const miesiac = String(body.miesiac ?? '');
    const pole = String(body.pole ?? '');
    if (!zakresMiesiaca(miesiac) || !/^\d{4}-\d{2}$/.test(miesiac)) return odmowaZestawienia(reply, 400, `„${miesiac}” to nie jest miesiąc w formacie RRRR-MM.`, miesiac);
    if (!POLA.has(pole)) return odmowaZestawienia(reply, 400, `„${pole}” to nie jest pole daty listy faktur.`, miesiac, pole);
    const uuids = [...new Set([].concat(body.uuid ?? []).map((u) => String(u).trim()).filter(Boolean))];
    if (!uuids.length) return odmowaZestawienia(reply, 400, 'Zaznacz co najmniej jedną fakturę.', miesiac, pole);
    if (uuids.length > MAX_ZAZNACZONYCH) return odmowaZestawienia(reply, 400, `Można zaznaczyć najwyżej ${MAX_ZAZNACZONYCH} dokumentów.`, miesiac, pole);
    if (!fakturyWidok) return odmowaZestawienia(reply, 503, 'Lista faktur jest niedostępna.', miesiac, pole);
    let dokumenty;
    try {
      dokumenty = await fakturyWidok.dokumenty({ miesiac, pole, dzis: dzienWarszawa(new Date().toISOString()) });
    } catch (e) {
      if (!e?.dlaOperatora) throw e;
      return odmowaZestawienia(reply, e.status ?? 400, komunikatDlaOperatora(e), miesiac, pole);
    }
    const dostepne = new Set(dokumenty.filter((d) => d.uuid).map((d) => String(d.uuid)));
    const obce = uuids.filter((u) => !dostepne.has(u));
    if (obce.length) return odmowaZestawienia(reply, 400, `Dokumentów o identyfikatorach ${obce.join(', ')} nie ma na liście faktur ${miesiac}.`, miesiac, pole);
    const wybrane = new Set(uuids);
    return reply.type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${bezpiecznaNazwa(nazwaPlikuZaznaczonych(miesiac).slice(0, -4))}.csv"`)
      .send(csvZaznaczonych(dokumenty.filter((d) => d.uuid && wybrane.has(String(d.uuid)))));
  });

  app.post('/faktury/zestawienie-zaznaczonych', async (req, reply) => {
    if (!paczkaDlaBiura?.zbudujZaznaczone) return reply.code(503).send(zdanieBrakuProgramu(wyborProgramu) ?? zdanieBrakuZestawienia);
    if (paczkaTrwa) {
      return reply.code(409).send(
        'Zestawienie faktur jest właśnie składane — poczekaj na pobranie pliku i spróbuj ponownie.',
      );
    }
    const body = req.body ?? {};
    const miesiac = String(body.miesiac ?? '');
    if (!/^\d{4}-\d{2}$/.test(miesiac)) return odmowaZestawienia(reply, 400, `„${miesiac}" to nie jest miesiąc w formacie RRRR-MM.`, miesiac);
    const pole = String(body.pole ?? '');
    if (!POLA.has(pole)) return odmowaZestawienia(reply, 400, `„${pole}" to nie jest pole daty listy faktur — dozwolone: ${[...POLA].join(', ')}.`, miesiac, pole);
    // Jeden zaznaczony checkbox przychodzi jako napis, kilka — jako tablica.
    const uuids = [].concat(body.uuid ?? []).map((u) => String(u).trim()).filter(Boolean);
    if (uuids.length === 0) return odmowaZestawienia(reply, 400, 'Zaznacz co najmniej jedną fakturę.', miesiac, pole);
    let wynik;
    paczkaTrwa = true;
    try {
      wynik = await paczkaDlaBiura.zbudujZaznaczone({ uuids, miesiac, pole });
    } catch (e) {
      if (!e?.dlaOperatora) throw e;
      // Odmowa „czeka na KSeF" niesie 409; pozostale odmowy operatora — 400.
      return odmowaZestawienia(reply, e.status ?? 400, komunikatDlaOperatora(e), miesiac, pole);
    } finally {
      paczkaTrwa = false;
    }
    return reply.type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${wynik.nazwa}"`)
      .send(wynik.bajty);
  });

  // PDF prosto z listy. Osobna trasa od `/zamowienia/:id/faktura/pdf`, bo tamta prowadzi
  // PRZEZ ZAMÓWIENIE — nie objęłaby ani korekt, ani faktur wystawionych poza panelem.
  // PRZ-122.B10b: pobranie zamyka fakturę TwojeFaktury — HEAD (Fastify domyślnie = handler GET) nie może tego robić.
  app.get('/faktury/:uuid/pdf', { exposeHeadRoute: false }, async (req, reply) => {
    const { uuid } = req.params;
    const rodzaj = req.query.rodzaj;
    if (!program) return reply.code(503).send(zdanieBrakuProgramu(wyborProgramu, DOPISEK_PDF) ?? `Panel nie ma podpiętego inFaktu. ${GDZIE_KLUCZ_INFAKTU}`);
    // Odmowa CZYTELNA, a nie 404 z inFaktu: rodzaj rozstrzyga, ktory zasob API odpytac,
    // wiec nieznana nazwa znaczy „panel nie wie, po co siegnac", a nie „faktura VAT".
    if (!RODZAJE_PDF.has(rodzaj)) {
      return reply.code(400).send(
        `„${rodzaj ?? ''}" to nie jest rodzaj dokumentu, który panel potrafi pobrać — `
        + `zna tylko: ${[...RODZAJE_PDF].join(', ')}.`,
      );
    }
    const korekta = rodzaj === 'korekta';
    let bajty;
    try {
      bajty = korekta ? await program.pobierzPdfKorekty(uuid) : await program.pobierzPdf(uuid);
    } catch (e) {
      // B10a: faktura VAT (B2B i B2C — B2C-QR) bez numeru KSeF — nie błąd, tylko „jeszcze nie”; zdanie podaje adres podglądu.
      if (e?.czekaNaKsef) return reply.code(409).send(komunikatDlaOperatora(e));
      return reply.code(400).send(`Nie udało się pobrać dokumentu: ${komunikatDlaOperatora(e)}`);
    }
    const nazwa = `${korekta ? 'korekta' : 'faktura'}-${bezpiecznaNazwa(req.query.numer || uuid)}.pdf`;
    return reply.type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${nazwa}"`)
      .send(bajty);
  });

  // PRZ-122.B10a: podgląd PDF dokumentu programu wbudowanego dla operatora (napis podglądu, bez kodu KSeF) — także
  // przed numerem KSeF. Otwierany w przeglądarce, nie jako plik do wysłania. Prawo „faktury” z prefiksu adresu.
  app.get('/faktury/twojefaktury/:id/podglad.pdf', async (req, reply) => {
    if (typeof program?.podgladPdf !== 'function') {
      return reply.code(404).send('Podgląd PDF jest tylko dla faktur programu wbudowanego.');
    }
    let bajty;
    try {
      bajty = await program.podgladPdf(req.params.id);
    } catch (e) {
      if (!e?.dlaOperatora) throw e;
      return reply.code(e.status ?? 400).send(komunikatDlaOperatora(e));
    }
    return reply.type('application/pdf')
      .header('Content-Disposition', `inline; filename="podglad-${bezpiecznaNazwa(req.params.id)}.pdf"`)
      .send(bajty);
  });

  // PRZ-102.12: wynik ostatniego przebiegu automatu KSeF — ten sam ekran wyniku co po przycisku, bo automat
  // wysyła tą samą usługą i ma te same trzy kategorie (wysłano / nie wiadomo / pominięte). Tylko odczyt z bazy.
  app.get('/faktury/ksef/automat', async (req, reply) => {
    const { wynik, wlaczony, godzina, wstrzymane, tryb } = db ? wczytajAutomatKsef(db)
      : { wynik: null, wlaczony: false, godzina: null, wstrzymane: [], tryb: null };
    return pokazWynikKsef(req, reply, {
      title: 'Automat KSeF — wynik', adresPowrotu: '/faktury', nazwaProgramu, gdzieProgramu: gdzieDokument(program),
      wyslane: wynik?.wyslane ?? [], niepewne: wynik?.niepewne ?? [], pominiete: wynik?.pominiete ?? [],
      przyjete: null, blad: wynik?.blad ?? null,
      automat: { wynik, wlaczony, godzina, kto: KTO_AUTOMAT, poZasadzie: wynik?.poZasadzie ?? [],
        wstrzymane: (wstrzymane ?? []).map((w) => ({ ...w, zdanie: zdanieWstrzymanej(w, nazwaProgramu, undefined, tryb), doZwolnienia: czyDoZwolnienia(w) })) },
    });
  });

  // Poprawka po recenzji PRZ-102.12: „Zwolnij” zdejmuje fakturę z listy wstrzymanych — automat spróbuje ją wysłać
  // przy następnym przebiegu (jutro albo dziś, jeśli dzisiejszego jeszcze nie było). Nic tu nie wysyła. Prawo jak
  // do ręcznej wysyłki (ekran Faktur), bo skutek jest ten sam: ta faktura może pojechać do KSeF.
  app.post('/faktury/ksef/automat/zwolnij', async (req, reply) => {
    const uuid = String(req.body?.uuid ?? '').trim();
    if (!uuid) return reply.code(400).type('text/plain; charset=utf-8').send('Brak identyfikatora faktury do zwolnienia.');
    // C09ca: wpis „odrzucona” / „nie-wyslano” (TwojeFaktury) — ta wersja nie wraca do kolejki, więc zdjęcie wpisu
    // obiecywałoby wysyłkę, której nie będzie. Odmowa, wpis zostaje.
    // ZDROWIE-RECZNIE: w trybie „ręcznie” automat nie wysyła niczego, więc poprawioną wersję wysyła operator.
    const automat = db ? wczytajAutomatKsef(db) : null;
    const wpis = automat ? automat.wstrzymane.find((w) => w.uuid === uuid) : null;
    if (wpis && !czyDoZwolnienia(wpis)) {
      return reply.code(409).type('text/plain; charset=utf-8').send(wpis.kod === 'odrzucona'
        ? (automat.tryb === 'reczna'
          ? 'Tej faktury nie da się zwolnić — automat i tak jej nie wyśle, bo KSeF odrzucił tę wersję. Popraw fakturę w zakładce FAKTURY i wyślij poprawioną wersję ręcznie.'
          : 'Tej faktury nie da się zwolnić — automat i tak jej nie wyśle, bo KSeF odrzucił tę wersję. Popraw fakturę; nową wersję automat wyśle sam.')
        : 'Tej faktury nie da się zwolnić — automat i tak jej nie wyśle, bo nie ponawia tej samej wysyłki. Wyślij ją ręcznie bez zmian z zakładki FAKTURY.');
    }
    if (db) zwolnijWstrzymane(db, uuid);
    return reply.code(303).redirect('/faktury/ksef/automat');
  });

  // ⚠️⚠️ TA TRASA NICZEGO NIE WYSYLA. Pokazuje, co POLECIALOBY do KSeF, gdyby operator
  // zatwierdzil — wysyla dopiero POST /faktury/ksef/wyslij. Rozdzielenie na dwa kroki jest
  // cala trescia wymogu: dokumentu w KSeF nie da sie skasowac, zostaje wylacznie korekta,
  // wiec czlowiek ma dostac ekran, na ktorym zdazy sie rozmyslic (ta sama konstrukcja, co
  // przy nadaniu zbiorczym: masowe-nadaj.ejs → POST /zamowienia/masowe/nadaj).
  app.post('/faktury/ksef/podglad', async (req, reply) => {
    // Brak sekcji INFAKT_* to tryb POPRAWNY, ale nie da sie wtedy pokazac podgladu czegos,
    // czego nie ma skad wziac — odmowa ma to POWIEDZIEC (jak przy pobieraniu PDF-u wyzej).
    if (!wysylkaKsef) {
      return reply.code(503).send(zdanieBrakuProgramu(wyborProgramu) ?? `Panel nie ma podpiętego inFaktu — nie ma czego wysłać do KSeF. ${GDZIE_KLUCZ_INFAKTU}`);
    }
    if (wysylkaKsef.niedostepna) return odmowaWysylki(reply);
    // Jeden zaznaczony checkbox przychodzi z Fastify jako NAPIS, kilka — jako tablica.
    // `[].concat` normalizuje oba przypadki; ta sama normalizacja stoi jeszcze raz
    // w `coWolnoWyslac`, bo regula nie ma prawa polegac na tym, ze wolajacy o niej pamietal.
    const uuids = [].concat(req.body?.uuid ?? []);
    const miesiac = req.body?.miesiac;
    const pole = req.body?.pole;
    // Adres powrotu niesie filtr, na ktory operator patrzyl — „Wróć" ma go oddac tam,
    // skad przyszedl, a nie na domyslny miesiac. Bledne wartosci sa tu nieszkodliwe:
    // GET /faktury ma wlasna bramke i wraca do domyslnych.
    // PRZ-102.23: przycisk z karty zamowienia niesie `powrot` — wraca sie na karte (biala lista w domenie).
    const { adres: adresPowrotu, etykieta: etykietaPowrotu, powrot } = powrotWysylkiKsef(req.body?.powrot, { miesiac, pole });

    // ⚠️ PRZY PUSTYM ZAZNACZENIU NIE PYTAMY inFAKTU W OGOLE — nie ma czego liczyc, a ekran
    // i tak konczy sie komunikatem bez przycisku wysylki.
    let wynik = { doWyslania: [], pominiete: [], dokumenty: [] };
    if (uuids.length) {
      try {
        // ⚠️ ZBIOR LICZY SIE TUTAJ OD NOWA, z listy pobranej na swiezo — i policzy sie
        // JESZCZE RAZ przy zatwierdzeniu. Miedzy jednym ekranem a drugim wlasciciel mogl
        // wyslac dokument recznie w inFakcie, a drugie zgloszenie byloby duplikatem
        // u organu (patrz naglowek domain/wysylka-ksef.js).
        wynik = await wysylkaKsef.podglad({ uuids, miesiac, pole });
      } catch (e) {
        // Nieznany miesiac albo nieznane pole daty odmawia CZYTELNIE, zamiast wywalic 500:
        // ten formularz stoi przed operacja nieodwracalna, wiec „nie wiadomo, na co
        // patrzysz" musi zatrzymac ekran, a nie zamienic sie w domyslny miesiac.
        return reply.code(400).send(`Nie udało się przygotować wysyłki: ${komunikatDlaOperatora(e)}`);
      }
    }

    return reply.view('ksef-podglad.ejs', {
      title: 'Wysyłka do KSeF', miesiac, pole, adresPowrotu, etykietaPowrotu, powrot, nazwaProgramu, ...wynik,
    });
  });

  // ⚠️⚠️ TU DOKUMENT JEDZIE DO KSeF I TEGO SIE NIE COFA. Skasowac go juz nie sposob —
  // zostaje wylacznie korekta, widoczna u organu.
  //
  // ⚠️⚠️ TRASA NIE PRZEKIEROWUJE PO WYSYLCE. Ekran wyniku jest JEDYNYM potwierdzeniem
  // operacji, ktorej nie da sie ani powtorzyc, ani cofnac — dokladnie ta sama zasada, co
  // przy nadaniu masowym paczek (przewodnik 4.13a): przekierowanie na liste zgubiloby
  // i to, co poszlo, i to, co pominieto, i to, o czym NIE WIADOMO.
  app.post('/faktury/ksef/wyslij', async (req, reply) => {
    // Brak sekcji INFAKT_* to tryb POPRAWNY — ale wtedy nie ma dokad wyslac, i odmowa ma
    // to POWIEDZIEC (jak przy podgladzie wyzej).
    if (!wysylkaKsef) {
      return reply.code(503).send(zdanieBrakuProgramu(wyborProgramu) ?? `Panel nie ma podpiętego inFaktu — nie ma czego wysłać do KSeF. ${GDZIE_KLUCZ_INFAKTU}`);
    }
    if (wysylkaKsef.niedostepna) return odmowaWysylki(reply);
    // Jeden zaznaczony checkbox przychodzi z Fastify jako NAPIS, kilka — jako tablica.
    const uuids = [].concat(req.body?.uuid ?? []);
    const miesiac = req.body?.miesiac;
    const pole = req.body?.pole;
    // Powrot ma oddac operatora tam, skad przyszedl — na TEN miesiac i TO pole daty albo na karte zamowienia.
    const { adres: adresPowrotu, etykieta: etykietaPowrotu } = powrotWysylkiKsef(req.body?.powrot, { miesiac, pole });
    // Wartosci domyslne stoja PRZED rozpakowaniem wyniku, zeby brak ktoregokolwiek pola
    // nie wywalil widoku wlasnie na tym ekranie — jedynym sladzie nieodwracalnej operacji.
    const pusty = { wyslane: [], pominiete: [], niepewne: [], przyjete: null, blad: null };

    let wynik;
    try {
      // ⚠️ ZBIOR LICZY SIE W USLUDZE OD NOWA, z listy pobranej na swiezo — NIE jest
      // przepisywany z podgladu (patrz naglowek domain/wysylka-ksef.js). Miedzy jednym
      // ekranem a drugim wlasciciel mogl wyslac dokument recznie w inFakcie.
      // ⚠️ NAZWA OPERATORA JEDZIE DO USLUGI, bo to ona pisze slad do logu. Panelu uzywaja dwie
      // osoby, a pierwszym pytaniem po zerwanej probie jest „kto to klikal i o ktorej" — od tego
      // zalezy, kogo zapytac, czy zajrzal juz do inFaktu (tak samo jak w routes/okresy.js).
      wynik = await wysylkaKsef.wyslij({ uuids, miesiac, pole }, ktoKlikal(req));
    } catch (e) {
      // Tu ladują wylacznie awarie SPRZED wysylki (nieznany miesiac, niedostepna lista
      // dokumentow) — sama awaria wywolania wraca z uslugi jako `blad` razem z lista
      // „nie wiadomo". Ekran zamiast pieciusetki, bo operator musi wiedziec, ze NIC
      // nie poszlo.
      return pokazWynikKsef(req, reply, {
        title: 'Wysyłka do KSeF', miesiac, pole, adresPowrotu, etykietaPowrotu, nazwaProgramu, ...pusty, blad: komunikatDlaOperatora(e),
      });
    }

    return pokazWynikKsef(req, reply, {
      title: 'Wysyłka do KSeF', miesiac, pole, adresPowrotu, etykietaPowrotu, nazwaProgramu, ...pusty, ...wynik,
    });
  });
}

// ⚠️ Finding 3 (recenzja Zadania 7): trasa przyjmuje KAZDY skladniowo poprawny „RRRR-MM"
// (patrz walidacja `miesiac` wyzej), a ten wybor oferuje wylacznie ostatnie 13 miesiecy —
// wiec `?miesiac=2020-01` pokazywalo tabele z 2020 roku, a lista wyboru dalej milczaco
// pokazywala pierwszy z oferowanych miesiecy: ekran przeczyl sam sobie. Brakujacy miesiac
// dolacza tutaj do listy, zeby select pokazywal PRAWDE o tym, na co operator patrzy.
function listaMiesiecy(dzis, wybrany) {
  const [rok, mies] = dzis.slice(0, 7).split('-').map(Number);
  const wynik = [];
  for (let i = 0; i < MIESIECY_W_WYBORZE; i += 1) {
    const przesuniecie = mies - 1 - i;
    const r = rok + Math.floor(przesuniecie / 12);
    const m = ((przesuniecie % 12) + 12) % 12 + 1;
    wynik.push(`${r}-${String(m).padStart(2, '0')}`);
  }
  if (wybrany && !wynik.includes(wybrany)) {
    wynik.push(wybrany);
    // Format „RRRR-MM" sortuje sie leksykograficznie tak samo jak chronologicznie —
    // odwrocone porownanie daje ta sama kolejnosc (od najnowszego), co petla wyzej.
    wynik.sort((a, b) => b.localeCompare(a));
  }
  return wynik;
}
