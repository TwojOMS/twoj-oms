import { dzienWarszawa } from '../../../domena/format-daty.js';
import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { zl } from '../../../domena/suma-pozycji.js';
import { MIESIACE } from '../../../domena/okres-rozliczeniowy.js';
import { bezpiecznaNazwa } from '../../../domena/pliki.js';
// ⚠️ WIDOK PYTA O TO SAMO, CO BARIERA — TĄ SAMĄ FUNKCJĄ. Pole wyboru przy fakturze
// konsumenckiej obiecywałoby operatorowi wysyłkę, której `coWolnoWyslac` i tak nie
// przepuści, a licznik na czerwonym przycisku by kłamał. Kopia tej reguły w szablonie
// rozjechałaby się z domeną przy pierwszej zmianie — a chodzi o operację nieodwracalną.
import { czyKonsumencka } from '../../../domena/wysylka-ksef.js';
import { skrocFormePrawna } from '../../../domena/forma-prawna.js';
// Lista czesci paczki jedzie z uslugi — trasa jej nie powtarza. Druga kopia rozjechalaby sie
// z usluga przy pierwszej zmianie i albo odmawialaby czesci, ktora panel sklada, albo
// przepuszczala nazwe, ktorej nie zna.
import { CZESCI } from '../czesci-biura.js';
import { fakturyMozliweDoOdnotowaniaSkasowania } from '../db/faktury.js';
import { stanArchiwumSprzedazy, licznikiArchiwum } from '../db/archiwum-sprzedazy.js';
import { ktoKlikal } from '../../zamowienia/lista.js';

// Zakladka FAKTURY. Trasa jest CIENKA: parsuje zadanie, wola usluge, renderuje.
// Reguly sa w domain/lista-faktur.js, sklejenie danych w services/faktury-widok.js.

const POLA = new Set(['invoice_date', 'sale_date']);

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
    + 'pusta celowo. Dokumenty czyta się na żywo z inFaktu; bez sekcji INFAKT_* w konfiguracji '
    + 'kontenera nie ma o co pytać.',
};

// ⚠️ BIALA LISTA RODZAJOW DOKUMENTU DO POBRANIA PDF-U. Wczesniej trasa nizej brala „wszystko,
// co nie jest korekta" za fakture VAT — czyli literowka w adresie (`?rodzaj=vt`) albo nowy,
// nieznany rodzaj z inFaktu jechal po zasob /invoices/ i konczyl sie surowym 404 z API
// zamiast zdaniem, ktore operator rozumie. To ta sama zasada, co przy `POLA` wyzej i przy
// `POLA_DATY` w services/faktury-widok.js: nazwa spoza listy ma ODMOWIC, a nie zgadnac.
const RODZAJE_PDF = new Set(['vat', 'korekta']);

// Ile znakow komunikatu z adresu wolno pokazac. Tresc sklada trasa nizej, ale przyjsc moze
// z dowolnego adresu — a akapit dlugosci ekranu rozpychalby zakladke. EJS `<%= %>` i tak
// escapuje, wiec chodzi tu wylacznie o rozmiar.
const MAX_KOMUNIKATU = 300;

// ⚠️ JEDNO ZRODLO PRZEDROSTKA DLA TRASY I WIDOKU. Trasa sklada tym przedrostkiem komunikat
// bledu (POST /faktury/archiwum/uruchom nizej), a widok (faktury.ejs) go NIE dopasowuje —
// dostaje juz gotowy `komunikatZly`. Dwie kopie tego samego lancucha rozjechalyby sie przy
// pierwszej zmianie tresci komunikatu (dokladnie tak, jak Finding z recenzji Zadania 7).
export const PREFIKS_BLEDU_ARCHIWUM = 'Archiwum: błąd';

export function registerFakturyRoutes(app, {
  db = null, fakturyWidok = null, infakt = null, wysylkaKsef = null,
  czuwaczArchiwumSprzedazy = null,
  // Paczka dla biura rachunkowego (spec 2026-09-02). `null` = panel bez inFaktu, czyli tryb
  // POPRAWNY: nie ma z czego zlozyc paczki, wiec przycisku po prostu nie ma (ta sama zasada,
  // co przy `mozliwyOdswiez` i `mozliwyPdf` na zakladce KOSZTY).
  paczkaDlaBiura = null,
} = {}) {
  app.get('/faktury', async (req, reply) => {
    if (!fakturyWidok) return reply.view('pusta-strona.ejs', BEZ_INFAKTU);

    const dzis = dzienWarszawa(new Date().toISOString());
    // Nieznany miesiac i nieznane pole wracaja do domyslnych zamiast odmawiac — to jest
    // przelacznik widoku, a nie decyzja o pieniadzach. Usluga i tak ma wlasna bramke
    // (services/faktury-widok.js), wiec nic zmyslonego nie dojdzie do zapytania.
    const miesiac = /^\d{4}-\d{2}$/.test(String(req.query.miesiac ?? ''))
      ? String(req.query.miesiac) : dzis.slice(0, 7);
    const pole = POLA.has(req.query.pole) ? req.query.pole : 'invoice_date';
    // „Zaznacz wszystkie" jest ADRESEM, nie skryptem — panel nie ma JavaScriptu, a pole
    // wyboru w nagłówku bez niego nie zaznaczy niczego. Ten sam wzorzec, co nad listą
    // zamówień (routes/zamowienia.js). Adres NIESIE filtr, bo inaczej zaznaczenie
    // przerzucałoby operatora na inny miesiąc niż ten, który ogląda.
    const zaznaczWszystkie = req.query.zaznacz === '1';
    const adres = (zazn) => `/faktury?miesiac=${encodeURIComponent(miesiac)}`
      + `&pole=${encodeURIComponent(pole)}${zazn ? '&zaznacz=1' : ''}`;

    // ⚠️ DWIE OSOBNE PROBY, NIE JEDNA (recenzja Zadania 7, Finding 1). `dokumenty` i
    // `nieoplacone` to DWA NIEZALEZNE zapytania do inFaktu — jedno wciaz moze dzialac, gdy
    // drugie akurat pada (np. sekcja dlugu odmawia, bo inFakt oddal kontener, ktorego panel
    // nie rozumie — patrz komentarz przy `nieoplacone()` w services/faktury-widok.js). Gdyby
    // stały w jednym `Promise.all`/`catch`, jedna awaria gasilaby TAKZE pas, ktory akurat
    // dzialal poprawnie — a caly sens tej zakladki to degradacja, nie padniecie (ta sama
    // zasada, co przy `proformy` nizej). `Promise.allSettled` trzyma obie proby rownolegle,
    // a mimo to kazda dostaje wlasny wynik.
    const [wynikDokumentow, wynikNieoplaconych] = await Promise.allSettled([
      fakturyWidok.dokumenty({ miesiac, pole, dzis }),
      fakturyWidok.nieoplacone({ dzis }),
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
      miesiac,
      pole,
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
      doOdnotowaniaSkasowania: db ? fakturyMozliweDoOdnotowaniaSkasowania(db, { miesiac }) : [],
      // Predykat, a NIE nowe pole na dokumencie: `services/faktury-widok.js` ma test-pinner
      // z białą listą pól wyjścia, a widok i tak potrzebuje tu wyłącznie odpowiedzi „tak/nie".
      // Jedno źródło reguły (domain/wysylka-ksef.js) obsługuje obie warstwy.
      czyKonsumencka,
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
      // ⚠️ ARCHIWUM CZYTA SIE Z NASZEJ BAZY, NIE Z NAS-a. Panel nie chodzi tu po dysku, zeby
      // policzyc pliki — pas stanu ma byc tani, bo wisi nad kazdym otwarciem zakladki.
      // Lustrem tego, co lezy na NAS-ie, jest tabela `archiwum_sprzedazy` (db/archiwum-sprzedazy.js).
      // Przycisk zestawienia pod filtrem. Widok NIE pyta o usluge sam — dostaje gotowa
      // odpowiedz „tak/nie"; brak metody oznacza panel bez inFaktu, wiec nie obiecuje pliku.
      mozliweZestawieniePrzychodow: Boolean(paczkaDlaBiura?.zbudujZestawieniePrzychodow),
      archiwum: {
        wlaczone: Boolean(czuwaczArchiwumSprzedazy),
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
      return reply.code(503).send('Panel nie ma włączonego archiwum sprzedaży (brak INFAKT_ARCHIWUM).');
    }
    // Filtr wraca Z OPERATOREM. Bledne wartosci sa tu nieszkodliwe: GET /faktury ma wlasna
    // bramke i wraca do domyslnych — ale przepuszczanie ich dalej niosloby smiec w adresie.
    const miesiac = /^\d{4}-\d{2}$/.test(String(req.body?.miesiac ?? '')) ? String(req.body.miesiac) : '';
    const pole = POLA.has(req.body?.pole) ? req.body.pole : 'invoice_date';
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
      + `&komunikat=${encodeURIComponent(komunikat)}`,
    );
  });

  // Zestawienie przychodów: PDF z samą listą faktur i korekt wybranego miesiąca. W odróżnieniu
  // od paczki NIE dokleja dokumentów PDF, więc usługa nie wykonuje ich pobrań z inFaktu.
  app.get('/faktury/zestawienie-przychodow', async (req, reply) => {
    if (!paczkaDlaBiura?.zbudujZestawieniePrzychodow) {
      return reply.code(503).send('Panel nie ma podpiętego inFaktu — nie ma z czego zbudować zestawienia przychodów.');
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
    if (!paczkaDlaBiura) return reply.code(503).send('Panel nie ma podpiętego inFaktu — nie ma z czego złożyć paczki.');
    if (paczkaTrwa) {
      return reply.code(409).send(
        'Paczka dla biura jest właśnie składana — poczekaj na pobranie pliku i spróbuj ponownie.',
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
        `„${czesc}" to nie jest część paczki — panel składa dwa pliki: ${CZESCI.join(', ')}.`,
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
      return reply.code(400).send(komunikatDlaOperatora(e));
    } finally {
      paczkaTrwa = false;
    }
    return reply.type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${wynik.nazwa}"`)
      .send(wynik.bajty);
  });

  // PDF prosto z listy. Osobna trasa od `/zamowienia/:id/faktura/pdf`, bo tamta prowadzi
  // PRZEZ ZAMÓWIENIE — nie objęłaby ani korekt, ani faktur wystawionych poza panelem.
  app.get('/faktury/:uuid/pdf', async (req, reply) => {
    const { uuid } = req.params;
    const rodzaj = req.query.rodzaj;
    if (!infakt) return reply.code(503).send('Panel nie ma podpiętego inFaktu.');
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
      bajty = korekta ? await infakt.pobierzPdfKorekty(uuid) : await infakt.pobierzPdf(uuid);
    } catch (e) {
      return reply.code(400).send(`Nie udało się pobrać dokumentu: ${komunikatDlaOperatora(e)}`);
    }
    const nazwa = `${korekta ? 'korekta' : 'faktura'}-${bezpiecznaNazwa(req.query.numer || uuid)}.pdf`;
    return reply.type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${nazwa}"`)
      .send(bajty);
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
      return reply.code(503).send('Panel nie ma podpiętego inFaktu — nie ma czego wysłać do KSeF.');
    }
    // Jeden zaznaczony checkbox przychodzi z Fastify jako NAPIS, kilka — jako tablica.
    // `[].concat` normalizuje oba przypadki; ta sama normalizacja stoi jeszcze raz
    // w `coWolnoWyslac`, bo regula nie ma prawa polegac na tym, ze wolajacy o niej pamietal.
    const uuids = [].concat(req.body?.uuid ?? []);
    const miesiac = req.body?.miesiac;
    const pole = req.body?.pole;
    // Adres powrotu niesie filtr, na ktory operator patrzyl — „Wróć" ma go oddac tam,
    // skad przyszedl, a nie na domyslny miesiac. Bledne wartosci sa tu nieszkodliwe:
    // GET /faktury ma wlasna bramke i wraca do domyslnych.
    const adresPowrotu = `/faktury?miesiac=${encodeURIComponent(miesiac ?? '')}`
      + `&pole=${encodeURIComponent(pole ?? '')}`;

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
      title: 'Wysyłka do KSeF', miesiac, pole, adresPowrotu, ...wynik,
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
      return reply.code(503).send('Panel nie ma podpiętego inFaktu — nie ma czego wysłać do KSeF.');
    }
    // Jeden zaznaczony checkbox przychodzi z Fastify jako NAPIS, kilka — jako tablica.
    const uuids = [].concat(req.body?.uuid ?? []);
    const miesiac = req.body?.miesiac;
    const pole = req.body?.pole;
    // Powrot ma oddac operatora tam, skad przyszedl — na TEN miesiac i TO pole daty.
    const adresPowrotu = `/faktury?miesiac=${encodeURIComponent(miesiac ?? '')}`
      + `&pole=${encodeURIComponent(pole ?? '')}`;
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
      return reply.view('ksef-wynik.ejs', {
        title: 'Wysyłka do KSeF', miesiac, pole, adresPowrotu, ...pusty, blad: komunikatDlaOperatora(e),
      });
    }

    return reply.view('ksef-wynik.ejs', {
      title: 'Wysyłka do KSeF', miesiac, pole, adresPowrotu, ...pusty, ...wynik,
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
