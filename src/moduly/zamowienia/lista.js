import { etykietyStatusow, opcjeStatusow } from '../../oms/db/statusy.js';
import { pobierzZamowienie, dopiszLog, zapiszFaktyStatusu } from '../../oms/db/zamowienia.js';
import { zapiszLubOdpusc } from '../wysylka/services/status-kuriera.js';
import { zamowienieZGrupa } from '../../oms/db/scalenia.js';
import { wyliczStatus, doZrobienia } from '../../domena/status.js';
import { faktyDlaStatusu } from '../../domena/status-reczny.js';
import { ETYKIETY_WYSYLKI } from '../../domena/wysylka.js';
import { parsujFiltry, numerStrony, adresZFiltrami, bezpiecznyPowrotNaListe, METODY_DO_FILTRA, kanalyDoFiltra } from '../../domena/filtry-listy.js';
import { adresKartyZamowienia, kluczPozycjiListy } from '../../domena/adres-karty-zamowienia.js';
import { wybraneZListy, podzielDoStatusu, powodZaDuzegoDruku } from '../../domena/masowe.js';
import { metodyPlatnosciWBazie } from '../../oms/db/filtry.js';
import { normalizujMetode, opcjeMetodPlatnosci } from '../../domena/metody-platnosci.js';
import { kanalyWymagajaceUwagi } from '../../domena/kanal-stan.js';
import { kluczDozwolony } from '../../domena/ostrzezenia.js';
import { odrzuc, poTerminie } from '../../oms/db/ostrzezenia.js';
import { adresKanalu } from '../../domena/kanaly.js';
import { bladPolleraNaEkran } from '../../domena/zdrowie.js';
import { indeksListy, PRZYCZYNA_POMINIETEGO } from '../../oms/db/indeks-listy.js';
import ejs from 'ejs';
import { komunikatDlaOperatora } from '../../domena/bledy.js';
import { poPolsku } from '../../domena/blad-po-polsku.js';
import { bezpiecznaNazwa } from '../../domena/pliki.js';
import { daneSpecyfikacji } from '../../domena/specyfikacja.js';
import { listaProduktowZbiorcza } from '../../domena/lista-produktow.js';
import { daneZestawienia } from '../../domena/zestawienie-zamowien.js';
import { fmtDataCzasKrotko } from '../../domena/format-daty.js';
import { zbudujSpecyfikacjePdf, zbudujSpecyfikacjeWieluPdf } from './pdf/specyfikacja-pdf.js';
import { zbudujListeProduktowPdf, zbudujZestawieniePdf } from './pdf/wydruki-pdf.js';
import {teraz,AKCJA_ALLEGRO_PROBA,allegroWymagaOdpytania,miniaturyEkranu,ktoKlikal,sprzedawcaSpecyfikacji,daneKarty,KATALOG_WIDOKOW,fragment} from './wspolne.js';
// Wierszy na stronie listy (PRZ-051). Tyle samo, co sufit druku specyfikacji
// (SUFIT_SPECYFIKACJI_DRUKU w domena/masowe.js): „zaznacz wszystkie" zaznacza strone, wiec
// jedno klikniecie nigdy nie przekroczy partii, ktora panel umie wydrukowac. Sklep z mniejsza
// liczba zamowien w zakladce nie widzi zmiany — strona miesci wszystko.
export const ROZMIAR_STRONY = 100;

// Identyfikatory z formularza akcji masowej: jeden zaznaczony przychodzi jako napis, kilka
// jako tablica, zaden — wcale. Nigdy `undefined` do `wczytajListe`, bo to znaczy „wszystkie".
const zaznaczone = (surowe) => [].concat(surowe ?? []);

// PRZ-094.22 (właściciel 18.10.2026: „czasami trzeba czekać dość długo”). Masowa zmiana statusu odsyłała status do
// sklepu/Allegro zamówienie PO zamówieniu — zmierzone na demo z atrapą opóźnioną o 2 s: 50 zamówień = 151 s, z czego
// baza 0,5 s. Różne zamówienia nie zależą od siebie (każde ma własny cel w kanale), więc idą równolegle; kolejność
// W OBRĘBIE zamówienia (odczyt Allegro → zapis) zostaje w `odeslijStatus`. Limit mały, żeby nie zalać API sklepu.
export const ROWNOLEGLE_ODESLANIA = 4;

// Wynik w kolejności wejścia, nie zakończenia — ekran wyniku wypisuje nieudane w kolejności listy.
async function wykonajZLimitem(elementy, limit, fn) {
  const wyniki = new Array(elementy.length);
  let nastepny = 0;
  const robotnik = async () => {
    while (nastepny < elementy.length) {
      const i = nastepny++;
      wyniki[i] = await fn(elementy[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, elementy.length) }, robotnik));
  return wyniki;
}

export function registerListaRoutes(app, kontekst) {
const {db,config,poller,nadanie,faktura,proforma,kurierzy,gus,syncSklep,wiadomosci,przesylkiAllegro,stanyKanalow,zdrowie,fakturaAllegro,fakturaHurtem,doczytanieKsef,powrotKarty,adresPowrotuNaKarte,wczytajListe,statusyDlaKarty,OKNO_OSTRZEZEN_PRZESYLEK_DNI,zbierzOstrzezenia,wyborWiadomosci,daneWiadomosci,renderujKarte,renderujNowe,magazynEkranu,niesiePolaFormularza,opisZmian,kopiujDaneFakturyDoWysylki,pozycjaZadania,zWynikami,magazynDlaKarty}=kontekst;
app.post('/ostrzezenia/odrzuc', async (req, reply) => {
    const klucz = typeof req.body?.klucz === 'string' ? req.body.klucz : null;
    if (!kluczDozwolony(klucz)) return reply.code(400).send('Nieznany klucz ostrzeżenia.');
    odrzuc(db, klucz, { kto: req.konto?.login ?? ktoKlikal(req) });
    return reply.redirect('/');
  });
app.get('/', async (req, reply) => {
    // ⚠️ OD PRZ-051 LISTA NIE CZYTA CALEJ BAZY. Liczniki zakladek, liczbe wynikow i wybor
    // strony daje indeks listy (oms/db/indeks-listy.js) — odpowiedzi TYCH SAMYCH regul domeny,
    // zapisane przy kazdym zamowieniu; tutaj czytamy pelne wiersze wylacznie dla jednej strony.
    // Pomiar przed zmiana: 15 000 zamowien = 17 s zamrozenia procesu, 32 767 = blad SQL.
    // Jedna chwila na caly widok: indeks, zakladki i zegar w wierszach licza sie wzgledem niej.
    const terazMs = Date.now();
    const indeks = indeksListy(db);
    // ⚠️ ODSWIEZENIE PISZE DO BAZY (tabela indeksu). Gdy baza odrzuca zapis (pelny dysk, plik
    // tylko do odczytu), lista ma sie nadal otworzyc — z ostatniego stanu indeksu i ze zdaniem,
    // ze moze byc nieaktualna — zamiast surowego bledu sterownika. Ta sama zasada, co przy
    // odswiezaniu statusu kuriera na karcie: awaria zapisu nie zabiera ekranu.
    let indeksNieaktualny = false;
    try { await indeks.odswiez(terazMs); } catch (e) {
      req.log?.error?.(e, 'indeks listy nie odswiezyl sie');
      indeksNieaktualny = true;
    }

    // Filtr statusu z adresu (panel boczny, wzor Apilo). Nieznana wartosc (literowka,
    // stary link po zmianie klucza w ETYKIETY) NIE ma cicho pokazywac calej listy —
    // spada do domyslnego widoku roboczego, bo to jest jedyny bezpieczny domyslny stan
    // tego panelu (patrz komentarz przy doZrobienia w domain/status.js).
    // Ukryty status dodatkowy pozostaje poprawnym adresem pustej listy.
    const filtrStatus = typeof req.query?.status === 'string' && (req.query.status === 'indywidualne' || Object.hasOwn(etykietyStatusow(db), req.query.status))
      ? req.query.status
      : null;
    // `?wszystkie=1` istnieje od pierwszej wersji listy i jest opisany w dokumentacji —
    // panel boczny go NIE zastepuje, tylko dokleja obok siebie druga droge do tego samego.
    const pokazWszystkie = req.query?.wszystkie === '1';
    const pokazPoTerminie = req.query?.po_terminie === '1';
    // Fraza z pola nad tabelą. Powtorzony klucz (?szukaj=a&szukaj=b) Fastify oddaje jako
    // tablice — `typeof === 'string'` odrzuca go tak samo, jak przy `?edytuj` na karcie.
    const szukaj = typeof req.query?.szukaj === 'string' ? req.query.szukaj.trim() : '';
    // Filtry nad tabela: zakres dat, metoda wysylki, metoda platnosci (domain/filtry-listy.js).
    const filtry = parsujFiltry(req.query, config.definicje);
    const kontekst = {
      szukaj: szukaj || null,
      status: filtrStatus,
      wszystkie: pokazWszystkie,
      poTerminie: pokazPoTerminie,
    };
    let zakladka;
    let aktywny;
    // ⚠️ SZUKANIE BIJE ZAKLADKE STATUSU i robi to celowo. Operator wpisuje numer albo nazwisko
    // wtedy, gdy chce znalezc KONKRETNE zamowienie — a wtedy najczesciej nie wie (i nie ma
    // powodu wiedziec), w jakim ono jest stanie. Szukanie zawezone do biezacej zakladki
    // oddawaloby pusta liste dokladnie dla zamowien juz zalatwionych, czyli tych, o ktore
    // klient dzwoni najczesciej („gdzie moja paczka"). Panel boczny nie ma wtedy zadnej
    // pozycji aktywnej — bo wyniki nie sa zadna z nich.
    //
    // ⚠️ ALE FILTRY ZOSTAJA — i to jest granica, ktorej nie wolno przesunac (prosba
    // wlasciciela, 01.08.2026: „chce np. poszukac jakiegos klienta i wyswietlic jego
    // zamowienia z okreslonego czasu"). Roznica jest w tym, KTO co wpisal: zakladka statusu
    // to NAWIGACJA („co mam dzis do zrobienia"), wiec fraza slusznie ja zdejmuje; zakres dat
    // i metody to wartosci wpisane SWIADOMIE, wiec fraza ma je zawezac, a nie kasowac.
    if (szukaj) {
      zakladka = null;
      aktywny = null;
    } else if (filtrStatus) {
      zakladka = { rodzaj: 'status', status: filtrStatus };
      aktywny = filtrStatus;
    } else if (pokazPoTerminie) {
      zakladka = { rodzaj: 'po_terminie' };
      aktywny = 'po_terminie';
    } else if (pokazWszystkie) {
      zakladka = { rodzaj: 'wszystkie' };
      aktywny = 'wszystkie';
    } else {
      zakladka = { rodzaj: 'robocze' };
      aktywny = 'do_zrobienia';
    }

    // ⚠️ STRONA (PRZ-051). Numer za koncem listy (stary link, zakladka, z ktorej zamowienia
    // wlasnie wyszly) pokazuje OSTATNIA strone, a nie pusta tabele z napisem „brak zamowien" —
    // ten napis klamalby, bo zamowienia sa, tylko wczesniej.
    const zapytanie = { zakladka, filtry, szukaj, limit: ROZMIAR_STRONY, teraz: terazMs };
    let strona = numerStrony(req.query?.strona);
    let wynik = indeks.strona({ ...zapytanie, offset: (strona - 1) * ROZMIAR_STRONY });
    const stron = Math.max(1, Math.ceil(wynik.lacznie / ROZMIAR_STRONY));
    if (strona > stron) {
      strona = stron;
      wynik = indeks.strona({ ...zapytanie, offset: (strona - 1) * ROZMIAR_STRONY });
    }
    const adresListy = adresZFiltrami(filtry, { ...kontekst, strona });
    // Wiersz strony, ktorego nie da sie odczytac, a indeks o tym jeszcze nie wie (zapis spoza
    // panelu): nie znika po cichu — trafia do tej samej notki, co uszkodzone znane indeksowi.
    const pominiete = [];
    const zamowienia = wczytajListe(wynik.ids, { teraz: new Date(terazMs), bezSurowych: true, pomijajUszkodzone: true,
      naPominiete: (z) => pominiete.push({ id: z.id, numer: z.numer, blad: PRZYCZYNA_POMINIETEGO }) }).map((z) => ({
      ...z,
      adresKarty: adresKartyZamowienia(z.id, { powrot: adresListy }, config.definicje),
    }));
    const stronicowanie = stron > 1 ? {
      strona, stron,
      poprzednia: strona > 1 ? adresZFiltrami(filtry, { ...kontekst, strona: strona - 1 }) : null,
      nastepna: strona < stron ? adresZFiltrami(filtry, { ...kontekst, strona: strona + 1 }) : null,
    } : null;

    // ⚠️ SEDNO TEGO PANELU: liczniki i wiersze licza TE SAME reguly domeny (`wyliczStatus`,
    // `doZrobienia`, zegar wieku) — od PRZ-051 przez indeks listy, ktory zapisuje ich
    // odpowiedzi przy kazdym zamowieniu i liczy je COUNT-em. Status nie jest kolumna do
    // przestawiania, tylko wynikiem wyliczanym z faktow (komentarz nad `wyliczStatus`);
    // powtorzenie tej logiki drugi raz w SQL-u rozjechaloby sie z lista przy pierwszej zmianie
    // reguly — dlatego indeks przechowuje WYNIKI reguly, a nie jej kopie.
    //
    // Struktura plaska celowo: w Etapie 1 kanal sprzedazy jest jeden. Grupowanie po
    // kanalach (kiedy dojdzie) opakuje ta liste w grupy — sam ksztalt pozycji
    // (klucz/etykieta/liczba/href/aktywna) nie musi sie do tego przebudowywac.
    //
    // ⚠️ LICZNIKI NIE UWZGLEDNIAJA FILTROW — i to jest decyzja, nie przeoczenie. Panel boczny
    // odpowiada na pytanie „ile tego w ogole jest", a filtry sa naklejone na WIDOK. Licznik
    // zmieniajacy sie razem z zakresem dat przestalby byc punktem odniesienia, po ktory
    // sie do niego siega.
    //
    // Adresy zakladek NIOSA filtry dalej (adresZFiltrami), bo zakres dat jest wpisany
    // swiadomie i przeskok na „Wyslane" nie ma go kasowac. Fraza sie NIE przenosi:
    // klikniecie zakladki znaczy „chce te zakladke", a fraza zakladki wlasnie zdejmuje.
    //
    // ⚠️ PANEL BOCZNY SKLADA SIE ZNOWU Z SAMYCH ZAKLADEK STATUSU (2026-08-07).
    //
    // Do tego dnia stala tu osobna, szesnasta pozycja „Indywidualne" — nie status, tylko
    // KANAL (`?kanal=indywidualne`), doklejony do panelu, bo zamowienia z panelu
    // indywidualnego nie mialy wlasnego stanu i inaczej nie dalo sie ich wylowic. Odkad
    // „indywidualne" JEST statusem (domain/status.js, prosba wlasciciela), ta pozycja
    // musiala odejsc: zostawiona dawalaby w jednym panelu DWA WPISY O TEJ SAMEJ NAZWIE
    // i ROZNYCH LICZBACH (status liczy czekajace na akceptacje projektu, kanal — wszystkie
    // kiedykolwiek zlozone), czyli licznik nie do zinterpretowania bez czytania kodu.
    //
    // Nic nie ubylo z funkcji: kanal `indywidualne` stoi dalej w polu wyboru „Kanał"
    // w formularzu filtrow — dokladnie tam, gdzie stoja kanaly sklepow i `reczne`
    // i oba konta Allegro. To wlasnie ta pozycja byla wyjatkiem, nie regula.
    //
    // ⚠️ `aktywna` liczy KAZDA POZYCJA U SIEBIE, a nie wspolny `.map` na koncu listy — to
    // zostaje mimo znikniecia pozycji kanalowej, bo dwie pierwsze zakladki tez maja wlasne
    // warunki, a wspolny `.map` po `p.klucz === aktywny` kusi przy kazdej kolejnej zmianie.
    const liczniki = indeks.liczniki(terazMs);
    const panelStatusow = [
      { klucz: 'do_zrobienia', etykieta: 'Do zrobienia', liczba: liczniki.do_zrobienia, href: adresZFiltrami(filtry, {}), aktywna: aktywny === 'do_zrobienia' },
      { klucz: 'wszystkie', etykieta: 'Wszystkie', liczba: liczniki.wszystkie, href: adresZFiltrami(filtry, { wszystkie: true }), aktywna: aktywny === 'wszystkie' },
      (() => {
        // Liczba spóźnionych z TEGO SAMEGO indeksu, co pozostałe liczniki — ten sam zegar
        // (`wiekZamowienia`), co kolumna w wierszu. Klasa TYLKO przy N > 0 — pozycja
        // ma krzyczeć, gdy jest o co, a nie być na stałe czerwoną plamą.
        const n = liczniki.po_terminie;
        return { klucz: 'po_terminie', etykieta: 'Po terminie', liczba: n,
          href: adresZFiltrami(filtry, { poTerminie: true }),
          aktywna: aktywny === 'po_terminie', klasa: n > 0 ? 'pozycja-po-terminie' : null };
      })(),
      ...Object.keys(etykietyStatusow(db)).map((klucz) => ({
        klucz,
        etykieta: etykietyStatusow(db)[klucz],
        liczba: liczniki.statusy[klucz],
        href: adresZFiltrami(filtry, { status: klucz }),
        aktywna: aktywny === klucz,
      })),
    ];

    // Chipy aktywnych filtrow. Kazdy niesie adres BEZ SIEBIE — czyli krzyzyk przy chipie
    // to po prostu ten sam komplet z jedna wartoscia wyzerowana. Zakres dat jest JEDNYM
    // chipem, bo „od" bez „do" nikt nie kasuje osobno.
    const chipy = [];
    if (filtry.od || filtry.do) {
      chipy.push({
        etykieta: `${filtry.od ?? '…'} – ${filtry.do ?? '…'}`,
        href: adresZFiltrami({ ...filtry, od: null, do: null }, kontekst),
      });
    }
    if (filtry.wysylka) {
      chipy.push({
        etykieta: `Wysyłka: ${ETYKIETY_WYSYLKI[filtry.wysylka] ?? filtry.wysylka}`,
        href: adresZFiltrami({ ...filtry, wysylka: null }, kontekst),
      });
    }
    if (filtry.platnosc) {
      // Chip mowi ETYKIETA slownika, nie kluczem z adresu — „Płatność: BLIK", nie „blik".
      chipy.push({
        etykieta: `Płatność: ${normalizujMetode(filtry.platnosc).etykieta}`,
        href: adresZFiltrami({ ...filtry, platnosc: null }, kontekst),
      });
    }
    // Kanal sprzedazy ma chip tak samo, jak pozostale filtry — takze wtedy, gdy zostal
    // wlaczony pozycja panelu bocznego, a nie polem wyboru. To JEDEN parametr w adresie,
    // wiec musi dac sie zdjac jedna droga: bez chipu operator, ktory kliknal „Indywidualne",
    // nie mialby czym wrocic do pelnej listy poza recznym skracaniem adresu.
    if (filtry.kanal) {
      chipy.push({
        etykieta: `Kanał: ${adresKanalu(filtry.kanal, config.definicje)}`,
        href: adresZFiltrami({ ...filtry, kanal: null }, kontekst),
      });
    }

    const stanPollera = poller?.stan?.() ?? null;
    // ⚠️ WSZYSTKIE kanaly wymagajace uwagi, nie pierwszy z brzegu. Pasek pollera pokazuje
    // JEDEN blad (`stan()` oddaje pierwszego pollera z bledem) — przy dwoch zepsutych
    // kanalach drugi bylby niewidoczny, a przy jednym komunikat mowil o przyczynie
    // technicznej zamiast o skutkach.
    const kanalyDoUwagi = kanalyWymagajaceUwagi(stanyKanalow?.() ?? []);
    return reply.view('lista.ejs', {
      zamowienia,
      // Liczba WSZYSTKICH pasujących (nagłówek wyników frazy, licznik filtrów) — nie długość
      // strony. `stronicowanie` = null, gdy wszystko mieści się na jednej stronie.
      lacznie: wynik.lacznie,
      stronicowanie,
      sprawdzanieIndeksu: indeks.sprawdzanie(),
      // Zamowienia, ktorych nie da sie odczytac — z numerem i przyczyna, zeby dalo sie je naprawic.
      uszkodzone: [...(indeksNieaktualny ? [] : indeks.uszkodzone()), ...pominiete]
        .filter((u, i, wszystkie) => wszystkie.findIndex((x) => x.id === u.id) === i),
      indeksNieaktualny,
      kanalyDoUwagi,
      // Tabelka ostrzezen (spec 2026-08-29) — same fakty lokalne, zero sieci w tej trasie.
      ostrzezenia: zbierzOstrzezenia(req),
      etykiety: etykietyStatusow(db),
      panelStatusow,
      filtry,
      chipy,
      // Zakladka do przeniesienia przez formularz filtrow — patrz komentarz w lista.ejs.
      filtrStatus,
      pokazWszystkie,
      pokazPoTerminie,
      adresListy,
      kluczListy: kluczPozycjiListy(adresListy, config.definicje),
      // Adres tego samego widoku BEZ filtrow — przycisk „Wyczyść wszystko".
      adresBezFiltrow: adresZFiltrami({}, kontekst),
      metodyDoFiltra: METODY_DO_FILTRA.map((k) => ({ klucz: k, etykieta: ETYKIETY_WYSYLKI[k] ?? k })),
      // Katalog i etykiety pochodzą z jawnej konfiguracji także przed pierwszym zamówieniem.
      // Kanał lub istniejące zamówienia: ta sama reguła, co statusy w menu.
      kanalyDoFiltra: kanalyDoFiltra(config.definicje).filter(k => k.klucz !== 'indywidualne' || Object.hasOwn(etykietyStatusow(db), 'indywidualne')),
      // Lista metod platnosci Z BAZY, nie ze stalej: sklep dokłada bramki bez pytania nas
      // o zdanie, a wpisana na sztywno lista po cichu przestalaby byc kompletem.
      metodyPlatnosci: opcjeMetodPlatnosci(metodyPlatnosciWBazie(db)),
      // Lista statusow do paska akcji masowych — TA SAMA, co na karcie zamowienia.
      opcjeStatusu: opcjeStatusow(db),
      // Fraza wraca do pola nad tabela — zeby dalo sie ja poprawic, a nie wpisywac od zera —
      // i do naglowka wynikow. Wraca DOKLADNIE tak, jak czlowiek ja napisal; postac
      // znormalizowana sluzy wylacznie do porownywania i nie ma prawa wrocic na ekran.
      szukaj,
      // Miniatura produktu w kolumnie „Produkty" — adres liczy DOMENA, a nie widok. Adres
      // oryginalu zostaje w bazie nietkniety, tak samo jak przed ta zmiana: to WIDOK wybiera
      // rozmiar, a nie poller, wiec poprawka reguly nie wymaga ponownego odczytu sklepow.
      //
      // ⚠️ LUSTRO CZYTAMY RAZ, NA CALA STRONE (miniaturyEkranu wyzej) — tu, a nie w widoku,
      // bo widok renderuje wiele zamowien po wiele pozycji.
      miniatura: miniaturyEkranu(db, zamowienia),
      // ⚠️ `stan()` oddaje pollera Z NIEPUSTYM BLEDEM, a dopiero w jego braku pierwszy sklep
      // (bootstrap.js) — pasek jest JEDYNYM miejscem w panelu, w ktorym widac awarie
      // synchronizacji, a do 04.08.2026 pokazywal wylacznie pierwszy SKLEP, wiec blad kanalu
      // Allegro nie docieral do czlowieka nigdy. Dokladamy tu nazwe kanalu dla czlowieka
      // (`adresKanalu` — TA SAMA funkcja, ktora opisuje kolumne „Kanał sprzedaży"), bo bez
      // niej komunikat o padnietym Allegro czytaloby sie jak awarie sklepu.
      // ⚠️ `ostatni_blad` PODMIENIONY NA WERSJE EKRANOWA (10.09.2026) — po polsku i bez
      // czkniec, TA SAMA regula, co w tabelce ostrzezen nad paskiem (domain/zdrowie.js,
      // bladPolleraNaEkran). Dwie rozne odpowiedzi o tym samym pollerze na jednym ekranie
      // — tabelka milczy, pasek krzyczy „Błąd" po angielsku — ucza ignorowania obu.
      // PRZ-089: instalacja bez kanałów (OMS_KANALY=[]) nie ma pollera wcale — „Brak synchronizacji” stałby
      // tam bez końca jak awaria, choć /health mówi `zdrowy: true, zrodla: []`.
      bezKanalow: !stanPollera && !config.definicje?.length,
      stanPollera: stanPollera
        ?{ ...stanPollera, kanal: adresKanalu(stanPollera.sklep, config.definicje), ostatni_blad: bladPolleraNaEkran(stanPollera) }
        : null,
      // „Zaznacz wszystkie" BEZ JAVASCRIPTU — zwykly adres, tak jak filtry i wyszukiwanie
      // (przewodnik OMS: stan chodzi przez adres strony). Odhaczenie pojedynczych wierszy
      // po zaznaczeniu wszystkich dziala normalnie, bo formularz wysyla to, co jest
      // zaznaczone W CHWILI zatwierdzenia, a nie to, co mowi adres.
      zaznaczWszystkie: String(req.query?.zaznacz ?? '') === '1',
      // Oba adresy skladane TU, z zachowaniem filtrow i frazy — inaczej „zaznacz wszystkie"
      // kasowaloby zawezenie listy i operator zaznaczylby zamowienia, ktorych nie widzial.
      adresZaznaczWszystkie: adresZFiltrami(filtry, { ...kontekst, strona, zaznacz: true }),
      adresOdznaczWszystkie: adresZFiltrami(filtry, { ...kontekst, strona, zaznacz: false }),
      // ⚠️ ADRES POWROTU PO AKCJI MASOWEJ (zgloszenie wlasciciela, 10.09.2026). Jedzie
      // ukrytym polem w pasku akcji, bo `formaction` przyciskow jest gole i sam adres
      // ekranu do trasy POST nie dociera. Bez tego zmiana statusu hurtem odsylala operatora
      // na gola strone glowna — czyli z zakladki „W realizacji" na „Do zrobienia" i bez
      // filtrow, po KAZDEJ partii.
      //
      // ⚠️ BEZ `zaznacz`: „zaznacz wszystkie" jest stanem TAMTEGO renderu, a nie widokiem,
      // do ktorego sie wraca. Po zmianie statusu czesc zaznaczonych wypada z zakladki, wiec
      // powrot z `zaznacz=1` zaznaczylby po cichu INNY zbior — tuz przed kolejna akcja masowa.
      adresPowrotu: adresZFiltrami(filtry, { ...kontekst, strona }),
    });
  });
app.post('/zamowienia/masowe/status', async (req, reply) => {
    const wybrane = wybraneZListy(wczytajListe(zaznaczone(req.body?.id)), req.body?.id);
    const docelowy = String(req.body?.status ?? '').trim();
    const { doZmiany, pominiete } = podzielDoStatusu(wybrane, docelowy);

    const nieudane = [];
    // ⚠️ K1 (recenzja Partii 1 Planu B). TRZECIA KATEGORIA, a nie odmiana „pominietych":
    // status W PANELU zostal zmieniony (i tego nie odwracamy — to zapis faktu stwierdzonego
    // przez czlowieka), ale NIE DOJECHAL do sklepu/Allegro. Zmierzone przy recenzji:
    // 20 zamowien allegrowych, kanal odmawia zapisu → 302 na liste, `sync_woo_blad` zapisany
    // 20/20, na ekranie ANI SLOWA. Operator widzial „udalo sie", a kupujacy dalej widzieli
    // stary status. Niezmiennik 4.13a: pominiete wracaja Z POWODEM i musza byc widoczne.
    const niedoslane = [];
    const doOdeslania = [];
    for (const z of doZmiany) {
      try {
        zapiszFaktyStatusu(db, z.id, { ...faktyDlaStatusu(z, docelowy, { powod: null }), kto: req.konto?.login ?? ktoKlikal(req) });
      } catch (e) {
        // Awaria zapisu JEDNEGO zamowienia nie ma prawa przerwac petli — reszta zaznaczen
        // czeka, a operator ma zobaczyc, ktore konkretnie nie przeszlo.
        dopiszLog(db, z.id, { akcja: 'status.masowy', wynik: `BŁĄD: ${e.message}` });
        nieudane.push({ id: z.id, numer: z.numer, powod: komunikatDlaOperatora(e) });
        continue;
      }
      // Log zapisuje status FAKTYCZNIE OSIAGNIETY, a nie sam wybor — ta sama zasada, co przy
      // zmianie pojedynczej (fakty silniejsze od wyboru wygrywaja).
      const osiagniety = wyliczStatus(pobierzZamowienie(db, z.id));
      dopiszLog(db, z.id, {
        akcja: 'status.masowy',
        wynik: `Ręcznie (${ktoKlikal(req)}): zmiana masowa na „${etykietyStatusow(db)[docelowy]}" `
          + `(${doZmiany.length} zamówień) — status po zmianie: ${etykietyStatusow(db)[osiagniety]}.`,
      });
      doOdeslania.push(z);
    }
    // `odeslijStatus` NIGDY nie rzuca — powod nieudanej wysylki wraca w `{ blad }`
    // i az do tej poprawki byl tu wyrzucany do kosza. Zapisy w bazie wyzej poszly juz wszystkie
    // (synchronicznie), wiec status w panelu nie czeka na sklep zadnego zamowienia.
    if (syncSklep) {
      const odeslane = await wykonajZLimitem(doOdeslania, ROWNOLEGLE_ODESLANIA, (z) => syncSklep.odeslijStatus(z.id));
      doOdeslania.forEach((z, i) => {
        const blad = odeslane[i]?.blad;
        if (blad) niedoslane.push({ id: z.id, numer: z.numer, powod: poPolsku(blad) });
      });
    }

    // ⚠️ Gdy WSZYSTKO przeszlo, wracamy na liste zwyklym przekierowaniem — bo zmiana statusu
    // jest odwracalna i ekran „udalo sie" byloby kliknieciem wiecej przy kazdej normalnej
    // zmianie. Gdy cokolwiek zostalo pominiete, ekran wyniku jest OBOWIAZKOWY: bez niego
    // operator widzialby, ze „cos sie zmienilo, ale nie wszystko", i nie wiedzialby co ani
    // dlaczego. Ciche wyrzucenie pominietych byloby gorsze niz odmowa calosci.
    // ⚠️ WRACAMY TAM, SKAD KLIKNIETO (10.09.2026), a nie na gola liste. Operator pracuje
    // zakladka i filtrami — odeslanie go na „Do zrobienia" bez zawezenia znaczylo, ze po
    // kazdej partii musi odtworzyc swoj widok recznie. Wartosc jest z formularza, wiec
    // przechodzi przez bariere (`bezpiecznyPowrotNaListe`): sciezka spoza listy zamowien
    // daje gola liste, a nie przekierowanie na obcy serwer.
    const powrot = bezpiecznyPowrotNaListe(req.body?.powrot, config.definicje, etykietyStatusow(db));
    const doPokazania = [...pominiete, ...nieudane];
    if (!doPokazania.length && !niedoslane.length) return reply.redirect(powrot);
    return reply.view('masowe-wynik.ejs', {
      tytul: 'Zmiana statusu',
      // Ekran wyniku odsyla TYM SAMYM adresem — to z niego operator wraca odnosnikiem,
      // gdy cokolwiek zostalo pominiete.
      powrot,
      // Zamowienie z nieudanym odeslaniem NIE stoi w „Status zmieniony": stoi w swojej
      // sekcji, ktora mowi OBIE prawdy naraz („zapisane w panelu, ale nie dojechalo").
      // Wypisane w obu miejscach kazaloby operatorowi zgadywac, ktore zdanie jest wazniejsze.
      udane: doZmiany
        .filter((z) => !nieudane.some((n) => n.id === z.id))
        .filter((z) => !niedoslane.some((n) => n.id === z.id))
        .map((z) => ({ id: z.id, numer: z.numer, opis: etykietyStatusow(db)[docelowy] })),
      pominiete: doPokazania,
      niedoslane,
      etykietaUdanych: 'Status zmieniony',
    });
  });
app.get('/zamowienia/:id/specyfikacja.pdf', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');
    let bajty;
    try {
      const sprzedawca = sprzedawcaSpecyfikacji(config);
      // PRZ-101.04: główne grupy scalonej drukuje pozycje CAŁEJ grupy (ta sama funkcja, co faktura).
      bajty = await zbudujSpecyfikacjePdf(daneSpecyfikacji(zamowienieZGrupa(db, z), { sprzedawca, klienciWdt: config.klienciWdt }));
    } catch (e) {
      // ⚠️ `zapiszLubOdpusc`, ta sama zasada, co przy odswiezaniu statusu kuriera wyzej:
      // awaria zapisu logu (dysk pelny, baza tylko do odczytu) nie ma prawa zamienic
      // czytelnego 400 w surowy blad sterownika bazy (HTTP 500).
      zapiszLubOdpusc(() => dopiszLog(db, id, { akcja: 'specyfikacja.pdf', wynik: `BŁĄD: ${e.message}` }));
      return reply.code(400).send(`Nie udało się przygotować specyfikacji: ${komunikatDlaOperatora(e)}`);
    }
    const nazwaPliku = `specyfikacja-${bezpiecznaNazwa(z.numer ?? String(id))}.pdf`;
    return reply.type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${nazwaPliku}"`)
      .send(bajty);
  });
// Wydruki wewnetrzne z menu „Wydruki" (PRZ-084): „Lista produktów" (same produkty z iloscia,
// bez danych klienta, cen i wysylki — domain/lista-produktow.js) i „Zestawienie zamówień"
// (jak „order-shipping" z Apilo — domain/zestawienie-zamowien.js). Do PRZ-084 lista byla
// strona HTML; właściciel 15.10: „lista powinna otwierać się jako PDF do druku".
//
// ⚠️ `inline`, nie `attachment` jak specyfikacja: menu otwiera je w nowej karcie, a kartka
// ma od razu stac w podgladzie przegladarki z przyciskiem druku — nie w Pobranych.
// Ekran w straznik trafia przez prefiks `/zamowienia` (domain/ekrany.js), tak samo jak
// specyfikacja — to kartki do pakowania.
const wydrukowano = () => fmtDataCzasKrotko(new Date().toISOString());
const pdfInline = (reply, bajty, nazwaPliku) => reply.type('application/pdf')
  .header('Content-Disposition', `inline; filename="${nazwaPliku}"`)
  .send(bajty);
const WYDRUKI = {
  'lista-produktow': {
    co: 'listy produktów',
    akcja: 'lista-produktow.pdf',
    zbuduj: (zamowienia) => zbudujListeProduktowPdf(listaProduktowZbiorcza(zamowienia), { wydrukowano: wydrukowano() }),
  },
  zestawienie: {
    co: 'zestawienia zamówień',
    akcja: 'zestawienie.pdf',
    zbuduj: (zamowienia) => zbudujZestawieniePdf(
      zamowienia.map((z) => daneZestawienia(z, { kanal: adresKanalu(z.sklep, config.definicje), klienciWdt: config.klienciWdt })),
      { wydrukowano: wydrukowano() },
    ),
  },
};
for (const [nazwa, wydruk] of Object.entries(WYDRUKI)) {
  app.get(`/zamowienia/:id/${nazwa}.pdf`, async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');
    let bajty;
    try {
      bajty = await wydruk.zbuduj([zamowienieZGrupa(db, z)]);
    } catch (e) {
      zapiszLubOdpusc(() => dopiszLog(db, id, { akcja: wydruk.akcja, wynik: `BŁĄD: ${e.message}` }));
      return reply.code(400).send(`Nie udało się przygotować ${wydruk.co}: ${komunikatDlaOperatora(e)}`);
    }
    return pdfInline(reply, bajty, `${nazwa}-${bezpiecznaNazwa(z.numer ?? String(id))}.pdf`);
  });
  // Hurtem: JEDEN dokument dla wszystkich zaznaczonych — ten sam odczyt zaznaczenia i ten sam
  // sufit partii, co specyfikacje nizej (rysowanie jest synchroniczne, patrz tam).
  app.post(`/zamowienia/${nazwa}.pdf`, async (req, reply) => {
    const wybrane = wybraneZListy(wczytajListe(zaznaczone(req.body?.id)), req.body?.id);
    if (!wybrane.length) return reply.code(400).send('Nie zaznaczono żadnego zamówienia.');
    const zaDuzo = powodZaDuzegoDruku(wybrane.length, wydruk.co);
    if (zaDuzo) return reply.code(400).send(zaDuzo);
    let bajty;
    try {
      bajty = await wydruk.zbuduj(wybrane.map((z) => zamowienieZGrupa(db, z)));
    } catch (e) {
      for (const z of wybrane) {
        zapiszLubOdpusc(() => dopiszLog(db, z.id, { akcja: `${wydruk.akcja}.masowa`, wynik: `BŁĄD: ${e.message}` }));
      }
      return reply.code(400).send(`Nie udało się przygotować ${wydruk.co}: ${komunikatDlaOperatora(e)}`);
    }
    const nazwaPliku = wybrane.length === 1
      ? `${nazwa}-${bezpiecznaNazwa(wybrane[0].numer ?? '')}.pdf`
      : `${nazwa}-${wybrane.length}-zamowien.pdf`;
    return pdfInline(reply, bajty, nazwaPliku);
  });
}
app.post('/zamowienia/specyfikacje.pdf', async (req, reply) => {
    const wybrane = wybraneZListy(wczytajListe(zaznaczone(req.body?.id)), req.body?.id);
    // ⚠️ Pusty PDF wyglada jak plik, ktory sie udal — a przy wydruku do paczki znaczy paczke
    // BEZ dokumentu. Odmowa CZYTELNA jest tu tansza niz cisza (ta sama zasada, co w
    // pdf/specyfikacja-pdf.js: `zbudujSpecyfikacjeWieluPdf` odmawia identycznie na pustej
    // liscie — ale nie ma prawa polegac WYLACZNIE na tamtej odmowie, bo trasa ma dac
    // komunikat operatorski, a nie techniczny wyjatek).
    if (!wybrane.length) return reply.code(400).send('Nie zaznaczono żadnego zamówienia.');
    // ⚠️ SUFIT PARTII DRUKU (12.08.2026). Do tego dnia trasa nie miala go wcale, bo „rysowanie
    // jest lokalne, wiec nic nie grozi". Grozi, i to z rzeczy niewidocznych stad: lista nie ma
    // stronicowania, „zaznacz wszystkie" zaznacza KAZDY wyrenderowany wiersz, a rysowanie jest
    // SYNCHRONICZNE — czyli jedno pomylkowe klikniecie zatrzymuje panel dla wszystkich na czas
    // rysowania calej bazy. Uzasadnienie liczby stoi przy stalej w domain/masowe.js.
    const zaDuzo = powodZaDuzegoDruku(wybrane.length);
    if (zaDuzo) return reply.code(400).send(zaDuzo);
    let bajty;
    try {
      const sprzedawca = sprzedawcaSpecyfikacji(config);
      bajty = await zbudujSpecyfikacjeWieluPdf(wybrane.map((z) => daneSpecyfikacji(zamowienieZGrupa(db, z), { sprzedawca, klienciWdt: config.klienciWdt })));
    } catch (e) {
      // Dokument jest JEDEN dla calego zaznaczenia, wiec awaria jest wspolna — slad idzie
      // do KAZDEGO zaznaczonego zamowienia (ta sama zasada, co przy fakturach hurtem: log ma
      // odpowiadac na pytanie „czy panel probowal", zadawane tygodniami pozniej przy
      // KTORYMKOLWIEK z nich). `zapiszLubOdpusc` osobno na kazdy wpis — awaria zapisu jednego
      // nie ma prawa schowac pozostalych.
      for (const z of wybrane) {
        zapiszLubOdpusc(() => dopiszLog(db, z.id, { akcja: 'specyfikacja.pdf.masowa', wynik: `BŁĄD: ${e.message}` }));
      }
      return reply.code(400).send(`Nie udało się przygotować specyfikacji: ${komunikatDlaOperatora(e)}`);
    }
    const nazwaPliku = wybrane.length === 1
      ? `specyfikacja-${bezpiecznaNazwa(wybrane[0].numer ?? '')}.pdf`
      : `specyfikacje-${wybrane.length}-zamowien.pdf`;
    return reply.type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${nazwaPliku}"`)
      .send(bajty);
  });
}
export { ktoKlikal, miniaturyEkranu } from './wspolne.js';
