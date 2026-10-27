import { sprawyZamowienia, przesylkaUkryta } from './przesylka-stan.js';
import { stanFaktury } from './faktura-stan.js';
import { anulowaneWymagaUwagi } from './status.js';
import { saldoWplat, platnoscPrzyOdbiorze } from './platnosci.js';
import { podsumowaniePozycji } from './tabela-pozycji.js';
import { czyKanalAllegro } from './wysylka.js';
import { czekaNaKsef as czekaNaKsefDom, czekaNaKsefDluzejNizDobe } from './ksef-oczekiwanie.js';
import { NAZWA_ZAPASOWA } from './nazwa-programu.js';
// ⚠️ `weryfikacjaNierozstrzygnieta` STAL TU DO 06.08.2026 i zniknal razem z wyciszona uwaga
// „Allegro nie potwierdzilo przyjecia pliku" (uzasadnienie przy tamtym miejscu, nizej).
// Predykat ZOSTAJE w domain/allegro-faktura.js — uzywa go zapytanie czuwacza i to on ma
// odzyc razem z ta sprawa, gdy `GET .../invoices` zacznie odpowiadac.

// Pasek „Do zalatwienia" na karcie zamowienia. Zbiera w JEDNO miejsce sprawy, ktore do tej
// pory byly rozsypane po calej karcie jako osiem identycznie wygladajacych `.uwaga` — od
// „faktura do wyjasnienia w KSeF" po „zamowienie nieoplacone", ktore przy B2B jest norma.
//
// ⚠️ NIC tu nie jest liczone od nowa. Kazda sprawa pochodzi z funkcji, ktora juz istnieje
// i juz rzadzi czyms innym: `sprawyZamowienia` trzyma zamowienie na liscie roboczej,
// `stanFaktury` blokuje ponowne wystawienie, `saldoWplat` wylicza `oplacone_at`,
// `podsumowaniePozycji` odpowiada tej samej arytmetyce, co bariera faktury. Gdyby pasek
// liczyl cokolwiek sam, rozjechalby sie z nimi przy pierwszej zmianie reguly — i zaczalby
// klamac o tym, czy jest co robic, dokladnie tam, gdzie operator na to patrzy najpierw.
//
// Pasek NIE ZASTEPUJE ostrzezen w sekcjach. Pelne instrukcje (co zrobic z dokumentem w KSeF,
// dlaczego nie wolno ponowic nadania) zostaja przy przycisku, ktorego dotycza. Pasek mowi
// „cos jest", sekcja mowi „co z tym zrobic".

// Waga steruje kolejnoscia i kolorem. DWIE, nie piec: „blokada" znaczy „panel sam z tego
// nie wyjdzie, potrzebna reka czlowieka", „uwaga" znaczy „stan dopuszczalny, ale wart oka".
const BLOKADA = 'blokada';
const UWAGA = 'uwaga';

/**
 * Lista spraw do zalatwienia. Kazda: { klucz, waga, tekst, kotwica }.
 * Pusta tablica = zamowienie czyste (karta nie renderuje wtedy paska w ogole).
 *
 * NIGDY nie rzuca: uszkodzone dane maja pokazac karte bez paska, a nie zamiast karty
 * pokazac 500 — dokladnie ta sama zasada, co przy `podsumowaniePozycji` na liscie.
 */
export function sprawyKarty(zamowienie, teraz = Date.now(), { nazwa = NAZWA_ZAPASOWA } = {}) {
  // PRZ-118.09: `nazwa` = odmiana nazwy programu fakturowego (domyślnie inFakt — domena/nazwa-programu.js).
  if (!zamowienie) return [];
  const sprawy = [];

  try {
    // 1. PRZESYLKI. Tekst bierzemy gotowy z domeny przesylek — przy wielu paczkach niesie
    //    juz „paczka N: ...", a bez tego operator nie wiedzialby, ktory list sprawdzic.
    for (const opis of sprawyZamowienia(zamowienie.przesylki, teraz)) {
      sprawy.push({ klucz: 'przesylka', waga: BLOKADA, tekst: opis, kotwica: '#przesylka' });
    }
  } catch { /* uszkodzony wiersz przesylki nie ma prawa zabrac calego paska */ }

  try {
    // 2. FAKTURA. Wylacznie stany, z ktorych panel sam nie wyjdzie — faktura wystawiona
    //    ani jej brak nie sa zadna sprawa.
    const stan = stanFaktury(zamowienie.faktura, teraz);
    if (stan === 'do_wyjasnienia') {
      const powod = zamowienie.faktura?.blad_opis ? `: ${zamowienie.faktura.blad_opis}` : '';
      sprawy.push({
        klucz: 'faktura',
        waga: BLOKADA,
        tekst: `Faktura do wyjaśnienia${powod}. Sprawdź w ${nazwa.miejscownik}, czy dokument powstał.`,
        kotwica: '#faktura',
      });
    } else if (stan === 'zawieszona') {
      sprawy.push({
        klucz: 'faktura',
        waga: BLOKADA,
        tekst: 'Wystawianie faktury zawieszone — panel nie wie, czy dokument powstał.',
        kotwica: '#faktura',
      });
    }

    // ⚠️ „CZEKA NA KSEF" TO STAN, W KTORYM PANEL UTKNALBY NA ZAWSZE (niezmiennik 4.9).
    // Dokument, ktorego wlasciciel nigdy nie wysle (pomylka, korekta, urlop), zostawia
    // kupujacego bez faktury — a panel milczy, bo z jego punktu widzenia „wszystko czeka":
    // faktura JEST wystawiona, wiec zaden istniejacy warunek wyzej sie nie odzywa.
    //
    // Doba, bo wlasciciel wysyla do KSeF w ciagu dnia: 24 h mijaja dopiero wtedy, gdy cos
    // naprawde stanelo.
    //
    // ⚠️⚠️ TEKST WSKAZUJE WYJSCIA, KTORE ISTNIEJA DZISIAJ (recenzja Partii 2, K4). Do
    // 06.08.2026 stalo tu „albo wyslij go do Allegro bez numeru" przy przycisku, ktorego
    // NIE BYLO w kodzie — niezmiennik 4.9 („panel nie zostawia stanu bez wyjscia") byl wiec
    // spelniony WYLACZNIE NAPISEM: czlowiek czytal instrukcje, szukal przycisku i nie
    // znajdowal go. K4 to zdanie usunela „do czasu, az przycisk powstanie".
    //
    // Przycisk POWSTAL (Zadanie 11: trasa POST /zamowienia/:id/faktura-allegro-bez-ksef
    // i furtka na karcie), wiec zdanie wraca — i musi wrocic, bo od tej chwili milczenie
    // o nim jest tym samym bledem odwroconym: sprawa pokazywalaby JEDNO wyjscie z DWOCH,
    // a to drugie jest jedynym, ktore czlowiek moze wykonac BEZ wlasciciela i bez inFaktu.
    //
    // ⚠️⚠️ SPRAWA STOI NA WYNIKU PYTANIA CZUWACZA (`ksef_odczyt = 'ok'`), A NIE NA UPLYWIE
    // DOBY — poprawka z recenzji Partii 2 (K1). Sam czas nie jest zadnym dowodem: przy
    // zdechlym czuwaczu albo niedostepnym inFakcie KAZDA allegrowa faktura starsza niz doba
    // zapalalaby BLOKADE „wyslij dokument do KSeF" wlascicielowi, ktory JUZ GO WYSLAL. Panel
    // oskarzalby wtedy czlowieka o wlasna slepote — a to jest dokladnie ta klasa usterki,
    // ktora Partia 1 zamknela commitem 1cf1554.
    //
    // 'ok' znaczy: PYTALISMY i inFakt ODPOWIEDZIAL, ze numeru KSeF tam nie ma. NULL („nikt nie
    // pytal") i 'blad' („pytanie nie doszlo") nie znacza NIC i sprawy nie zapalaja.
    //
    // ⚠️ ZAKRES BIERZEMY ZE WSPOLNEJ DEFINICJI (domain/ksef-oczekiwanie.js) — TEJ SAMEJ,
    // ktorej uzywa zapytanie czuwacza. Wlasna kopia stala tu do 06.08.2026 i byla SZERSZA:
    // zapalala blokade przy fakturze bez numeru dokumentu (o ktora czuwacz nie zapyta nigdy,
    // wiec tekst szedl z pusta luka: „Faktura  czeka na KSeF od …") i przy zamowieniu
    // ANULOWANYM, ktore ma juz swoja wlasna blokade nizej.
    //
    // ⚠️ ZAKRES POSZERZYL SIE 06.08.2026 razem z zakresem czuwacza: obejmuje TAKZE dokument,
    // ktorego wysylke do KSeF zlecil PANEL, choćby ze sklepu. Faktura sklepowa, ktorej nikt
    // z panelu nie wyslal, dalej nie jest zadna sprawa — nie ma DOKAD pojechac i numeru nie
    // dostanie nigdy, wiec blokada przy niej swiecilaby przy KAZDEJ fakturze sklepowej.
    // Rozpoznanie kanalu siedzi we wspolnym warunku, predykatem `czyKanalAllegro`.
    //
    // ⚠️ TRESC sprawy rozne gałęzie maja ROZNA (patrz nizej): wyjscia, ktore panel wskazuje,
    // sa przy fakturze allegrowej inne niz przy sklepowej.
    const oczekujaca = czekaNaKsefDom(zamowienie);
    const odczyt = zamowienie.faktura?.ksef_odczyt;
    const numerFaktury = zamowienie.faktura?.numer ?? '';

    // ⚠️ INFAKT TEGO DOKUMENTU JUZ NIE ZNA (404 przy odczycie — czuwacz zapisuje 'nieznana').
    // To NIE jest czekanie, tylko zamowienie zablokowane: numeru KSeF nikt juz nie przyniesie,
    // a `UNIQUE (zamowienie_id)` nie pozwoli wystawic drugiej faktury. Wyjscie ISTNIEJE i jest
    // na tej samej karcie — dlatego bez czekania doby: nie ma na co czekac.
    if (oczekujaca && odczyt === 'nieznana') {
      sprawy.push({
        klucz: 'ksef',
        waga: BLOKADA,
        tekst: `Faktury ${numerFaktury} NIE MA JUŻ w ${nazwa.miejscownik} — dokument został tam skasowany, `
          + 'więc numeru KSeF nikt już nie przyniesie, a panel nie wystawi drugiej. '
          // ⚠️ ODNOTOWANIE PRZENIESIONE NA ZAKLADKE FAKTURY (01.09.2026, prosba właściciela). Zdanie
          // musi kierowac TAM, gdzie ta akcja stoi dzisiaj — sprawa odsylajaca do przycisku,
          // ktorego na karcie juz nie ma, jest gorsza niz brak sprawy.
          + 'Jeśli to ty ją skasowałeś, odnotuj to w zakładce Faktury („Faktura skasowana '
          + `w ${nazwa.miejscownik}”) — zamówienie zwolni się do ponownego wystawienia.`,
        kotwica: '#faktura',
      });
    } else if (odczyt === 'ok' && czekaNaKsefDluzejNizDobe(zamowienie, teraz) && !czyKanalAllegro(zamowienie)) {
      // ⚠️⚠️ DOKUMENT, KTOREGO WYSYLKE DO KSeF ZLECIL PANEL, A NUMERU NIE MA OD DOBY. Od
      // 06.08.2026 `czekaNaKsef` obejmuje TAKZE takie faktury (poszerzony zakres czuwacza,
      // domain/ksef-oczekiwanie.js) — a sprawa musi wtedy mowic CO INNEGO niz przy Allegro.
      //
      // Zdanie allegrowe nizej („kupujacy jej jeszcze nie ma", „wyslij przyciskiem do Allegro")
      // byloby tu podwojnie nieprawdziwe: przy fakturze sklepowej nikt na nia u kupujacego nie
      // czeka, a przycisku wysylki do Allegro na tej karcie NIE MA. Sprawa wskazujaca wyjscie,
      // ktorego nie ma, jest stanem bez wyjscia (niezmiennik 4.9) — dokladnie tym, przed czym
      // bronila recenzja Partii 2 (K4).
      //
      // ⚠️ PANEL SAM NICZEGO NIE PONOWI i to jest cala tresc tej sprawy: drugie zgloszenie tego
      // samego dokumentu byloby duplikatem u organu, po ktorym zostaje wylacznie korekta
      // (db/wysylki-ksef.js). Jedynym nastepnym krokiem jest CZLOWIEK w inFakcie.
      //
      // ⚠️⚠️ CZAS LICZYMY OD ZLECENIA WYSYLKI (`ksef_zlecona_at`), A NIE OD WYSTAWIENIA
      // DOKUMENTU — i to dotyczy TAK SAMO daty w zdaniu, JAK I progu doby, ktory te sprawe
      // w ogole zapala. Podmiotem tego zdania jest WYSYLKA Z PANELU, a nie faktura: do poprawki
      // stala tu `utworzona_at` i zdanie wskazywalo moment, w ktorym panel jeszcze niczego nie
      // zlecil. Zakladka faktur jest MIESIECZNA, wiec wlasciciel wysyla dokumenty z zeszlego
      // miesiaca — czekanie bylo przez to zawyzane o TYGODNIE. Kolumna przychodzi na tym samym
      // obiekcie (`zlecona_at` z `wysylki_ksef`, doklada ja db/zamowienia.js) i przy tej galezi
      // jest ZAWSZE wypelniona: to ona wpuscila zamowienie do `czekaNaKsef`.
      //
      // ⚠️⚠️ PROG DOBY POPRAWIONY 06.08.2026 (recenzja calosci, Finding 2): `czekaNaKsefDluzej-
      // NizDobe` liczyl czas od WYSTAWIENIA, wiec faktura z zeszlego miesiaca dostawala te
      // blokade DWIE MINUTY po najzupelniej normalnej wysylce — czyli przy wiekszosci wysylek.
      // Zdanie mowilo prawde („panel zlecil o 10:05"), a blokada obok niego byla falszem.
      sprawy.push({
        klucz: 'ksef',
        waga: BLOKADA,
        tekst: `Panel zlecił wysyłkę faktury ${numerFaktury} do KSeF, a numeru nie ma od `
          + `${zamowienie.faktura?.ksef_zlecona_at} — ${nazwa.mianownik} odpowiada, że dokumentu tam jeszcze `
          + `nie ma. Sprawdź ten dokument w ${nazwa.miejscownik}: albo zgłoszenie utknęło, albo organ je `
          + 'odrzucił. Panel sam wysyłki NIE ponowi — drugie zgłoszenie byłoby duplikatem, '
          + 'którego nie da się skasować.',
        kotwica: '#faktura',
      });
    } else if (odczyt === 'ok' && czekaNaKsefDluzejNizDobe(zamowienie, teraz)) {
      // ⚠️ PROG DOBY BIERZEMY ZE WSPOLNEJ DEFINICJI (domain/ksef-oczekiwanie.js) — TEJ SAMEJ,
      // ktora rzadzi widocznoscia furtki „bez numeru KSeF" na karcie. Wlasna kopia liczby
      // znaczylaby przycisk pokazany wczesniej (albo pozniej) niz sprawa, ktora go zapowiada.
      //
      // ⚠️ DATA W ZDANIU TO WYSTAWIENIE DOKUMENTU i tak ma zostac: przy fakturze allegrowej
      // podmiotem jest FAKTURA, ktora czeka na numer od chwili powstania (kupujacy jej nie ma).
      // Prog doby liczy sie natomiast od PÓŹNIEJSZEGO z dwoch stempli (ksef-oczekiwanie.js),
      // wiec gdy panel zlecil wysylke takiej faktury przed chwila, blokada milczy przez dobe
      // OD TEJ WYSYLKI — bo dopiero ona jest tym, na co teraz czekamy.
      //
      // ⚠️ `ksef_odczyt === 'ok'` ZOSTAJE TYLKO PRZY SPRAWIE, nie przy furtce — i to jest
      // roznica merytoryczna (patrz komentarz przy czekaNaKsefDluzejNizDobe): sprawa OSKARZA
      // wlasciciela o niewyslanie dokumentu, wiec musi stac na dowodzie od czuwacza; przycisk
      // niczego nie zarzuca, a znikniety przy zdechlym czuwaczu bylby stanem bez wyjscia.
      sprawy.push({
        klucz: 'ksef',
        waga: BLOKADA,
        tekst: `Faktura ${numerFaktury} czeka na KSeF od ${zamowienie.faktura?.utworzona_at} `
          + `— kupujący jej jeszcze nie ma. Wyślij ten dokument do KSeF w ${nazwa.miejscownik} albo, `
          + 'jeśli świadomie godzisz się na dokument bez tego numeru, wyślij go kupującemu '
          + 'przyciskiem „Wyślij do Allegro BEZ numeru KSeF” na tej karcie.',
        kotwica: '#faktura',
      });
    }

    // ⚠️⚠️ WYSLANIE FAKTURY DO ALLEGRO NIE JEST KONCEM OPERACJI (Zadanie 10). Allegro sprawdza
    // plik antywirusem, a REJECTED znaczy, ze kupujacy faktury NIE MA — mimo ze `allegro_wyslana_at`
    // jest wypelnione, log karty mowi „plik wyslany", a przycisk wysylki odmawia ponowienia
    // („dokument juz u kupujacego"). Bez tej sprawy panel twierdzilby, ze kupujacy fakture dostal.
    //
    // ⚠️ ZAKRES BIERZEMY ZE WSPOLNEJ DEFINICJI (domain/allegro-faktura.js) — TEJ SAMEJ, ktorej
    // uzywa zapytanie czuwacza. Wlasna kopia warunku rozjechalaby sie z nim przy pierwszej zmianie
    // reguly, dokladnie tak jak rozjechala sie kopia warunku KSeF (recenzja Partii 2, W4+W5).
    const fa = zamowienie.faktura;
    if (fa?.allegro_weryfikacja === 'REJECTED') {
      sprawy.push({
        klucz: 'faktura-allegro',
        waga: BLOKADA,
        // ⚠️ SPRAWA WSKAZUJE WYJSCIE, KTORE NAPRAWDE ISTNIEJE (recenzja Partii 3, K2). Do
        // 06.08.2026 kazala „wyslac jeszcze raz", a `wolnoWyslacDoAllegro` odmawiala — pasek
        // kazal ponowic, panel odmawial, przycisku nie bylo. Teraz odmowa ustepuje przy
        // REJECTED, wiec sprawa moze NAZWAC przycisk, ktory na tej karcie jest.
        tekst: `Allegro ODRZUCIŁO plik faktury ${fa.numer ?? ''} — kupujący jej NIE MA, `
          + `mimo że panel plik wysłał. Sprawdź dokument w ${nazwa.miejscownik} i wyślij go jeszcze raz `
          + 'przyciskiem „Wyślij plik faktury do Allegro jeszcze raz” na tej karcie — '
          + 'ponowienie PODMIENIA plik przy tym samym zgłoszeniu, drugiego dokumentu nie zrobi.',
        kotwica: '#faktura',
      });
    }
    // ⚠️⚠️ TU BYLA UWAGA „Allegro od … nie potwierdzilo przyjecia pliku faktury" (Zadanie 10),
    // zapalana przy `weryfikacjaNierozstrzygnieta` po dobie od `allegro_wyslana_at`.
    // WYCISZONA 06.08.2026 decyzja wlasciciela — i to NIE jest sprzatanie, tylko cofniecie
    // decyzji podjetej na hipotezie, ktora pomiar obalil.
    //
    // Zadanie 10 stalo na §2.2 notatki `docs/superpowers/notatki/2026-08-05-allegro-zapis-
    // rozpoznanie.md`: `GET /order/checkout-forms/{id}/invoices` oddawal 400 na kazdym naszym
    // zamowieniu, ale zostawaly DWIE hipotezy — „zasob nie dziala" oraz „400 znaczy: zamowienie
    // nie ma ANI JEDNEJ faktury". Przy tej drugiej `WAITING` bylby stanem PRZEJSCIOWYM (zasob
    // ozywa, gdy faktura powstanie), a uwaga po dobie — rzadkim, sensownym sygnalem.
    //
    // POMIAR Z 06.08.2026, na pierwszej PRAWDZIWEJ fakturze wyslanej do Allegro: ten sam GET,
    // na zamowieniu, ktore fakture JUZ MA, dalej oddaje 400. Druga hipoteza OBALONA. Zasob jest
    // dla nas niedostepny, wiec `allegro_weryfikacja` NIE WYJDZIE Z `WAITING` nigdy — a uwaga
    // zapalalaby sie przy KAZDEJ wyslanej fakturze i zostawala na zawsze. Pasek, na ktorym
    // wisi wpis przy kazdym zamowieniu, przestaje byc narzedziem: to dokladnie to, przed czym
    // ostrzegal komentarz stojacy tu wczesniej.
    //
    // ⚠️ ODPYTYWANIA W CZUWACZU NIE RUSZAMY (services/czuwacz-ksef.js) — gdy Allegro naprawi
    // zasob, stan zacznie sie rozstrzygac SAM. WYCISZONA JEST SPRAWA NA PASKU, nie petla.
    //
    // CO MA SIE STAC, GDY ZASOB ZACZNIE ODPOWIADAC: pierwsza faktura, ktora wyjdzie z `WAITING`
    // na `ACCEPTED` albo `REJECTED`, jest dowodem, ze zrodlo zyje. Wtedy — i dopiero wtedy —
    // ta uwaga ma tu wrocic w postaci sprzed wyciszenia (waga UWAGA, nie blokada: `PUT .../file`
    // sie udal, wiec brakuje potwierdzenia, a nie pliku), bo `WAITING` znowu bedzie znaczyl
    // „jeszcze nie wiadomo", a nie „nigdy sie nie dowiemy".
    //
    // ⚠️ `REJECTED` WYZEJ ZOSTAJE BLOKADA i wyciszenie go NIE DOTYCZY: przychodzi z odpowiedzi
    // na `PUT .../file`, a nie z zepsutego odczytu, i znaczy, ze kupujacy faktury NIE MA.
  } catch { /* jw. */ }

  try {
    // 3. ANULOWANIE PO NADANIU ALBO PO WYSTAWIENIU FAKTURY. Sam status „Anulowane" wyglada
    //    jak sprawa zamknieta, a paczka moze byc w drodze, a dokument czekac w inFakcie na
    //    wieczorna wysylke do KSeF.
    if (anulowaneWymagaUwagi(zamowienie)) {
      // ⚠️⚠️ TYM SAMYM PREDYKATEM, CO `anulowaneWymagaUwagi` — poprawka po recenzji
      // 13.09.2026. Tamta funkcja liczy od 13.09 wyłącznie paczki NIEUKRYTE
      // (`przesylkaUkryta`), a ten wybór treści został na gołej liczbie wierszy przesyłek.
      // Skutek: zamówienie anulowane z JEDYNĄ paczką UKRYTĄ i wiszącą fakturą słusznie
      // zostaje sprawą — ale z powodu FAKTURY — a karta pisała „anulowane po nadaniu paczki"
      // i kotwiczyła w `#przesylka`. Operator trafiał w jedyną rzecz, którą człowiek już
      // zamknął, i mógł nie dojść do dokumentu wymagającego korekty w KSeF. Drugi czytelnik
      // tego samego predykatu MUSI go wołać, a nie mieć własnej, uproszczonej wersji.
      //
      // ⚠️ `przesylkaUkryta`, NIE goła kolumna `ukryta_at`: ukrycie WYGASA, gdy u kuriera
      // wydarzy się coś PO nim — paczka spisana na straty, która ruszyła, znów decyduje
      // o treści. Reguła po kolumnie uciszyłaby wtedy paczkę ŻYWĄ.
      //
      // ⚠️ KOTWICA IDZIE ZA TREŚCIĄ. Zdanie o fakturze, które przewija kartę do przesyłki,
      // jest gorsze od samego złego zdania: mówi, gdzie szukać, i wskazuje nie to miejsce.
      const zywePaczki = (zamowienie.przesylki ?? []).filter((p) => !przesylkaUkryta(p));
      const poPaczce = zywePaczki.length > 0;
      const co = poPaczce ? 'nadaniu paczki' : 'wystawieniu faktury';
      sprawy.push({
        klucz: 'anulowane',
        waga: BLOKADA,
        tekst: `Zamówienie anulowane po ${co} — sprawdź, czy da się to jeszcze zatrzymać.`,
        kotwica: poPaczce ? '#przesylka' : '#faktura',
      });
    }
  } catch { /* jw. */ }

  try {
    // 4. SALDO WPLAT. Niedoplata i nadplata sa OBIE jawne: pierwsza to pieniadze, ktorych
    //    nie ma, druga to pieniadze klienta, ktore trzeba oddac albo rozliczyc.
    const saldo = saldoWplat(zamowienie);
    // ⚠️ Przy pobraniu niedoplata NIE JEST sprawa — kurier zainkasuje przy doreczeniu.
    // Nadplata i blad arytmetyki zostaja: te znacza cos rownie zle przy kazdej metodzie.
    //
    // ⚠️ TAK SAMO PRZY ROZLICZENIU ZBIORCZYM (spec 2026-08-01 §8) — i tu stawka jest wyzsza.
    // Zamowienie nalezace do okresu rozliczeniowego NIE MA WLASNYCH PIENIEDZY: klient placi
    // RAZ, za caly miesiac, a wplata siedzi na okresie (tabela `platnosci_okresu`). Bez tego
    // warunku KAZDE z kilkudziesieciu zamowien miesiaca melduje „Niedopłata 100.00 zł
    // z 100.00 zł" — na zawsze, bo tych pieniedzy na zamowieniu nigdy nie bedzie. Spec nazwal
    // ten skutek wprost („zatruwałoby statusy"): pasek spraw jest jedynym miejscem, w ktorym
    // operator szuka prawdziwych blokad, a kilkadziesiat stalych falszywych alarmow miesiecznie
    // po prostu go wylacza.
    //
    // NADPLATA i BLAD ARYTMETYKI ZOSTAJA takze tutaj: to nie sa „brakujace pieniadze, ktore
    // przyjda z okresem", tylko pieniadze, ktore NAPRAWDE wpłynęły na to zamowienie (albo
    // kwota nie do policzenia) — jedno i drugie znaczy to samo w kazdym trybie rozliczenia.
    const wOkresie = Boolean(zamowienie.okres_rozliczeniowy_id);
    if (saldo.stan === 'niedoplata' && !platnoscPrzyOdbiorze(zamowienie) && !wOkresie) {
      sprawy.push({
        klucz: 'platnosci',
        waga: UWAGA,
        tekst: `Niedopłata ${saldo.roznicaZl} zł z ${saldo.kwotaZl} zł — zamówienie nie jest opłacone.`,
        kotwica: '#platnosci',
      });
    } else if (saldo.stan === 'nadplata') {
      sprawy.push({
        klucz: 'platnosci',
        waga: UWAGA,
        tekst: `Nadpłata ${saldo.roznicaZl} zł — sprawdź, czy nadwyżki nie trzeba zwrócić klientowi.`,
        kotwica: '#platnosci',
      });
    } else if (saldo.stan === 'blad') {
      sprawy.push({
        klucz: 'platnosci',
        waga: BLOKADA,
        tekst: `Nie da się policzyć salda wpłat: ${saldo.blad}`,
        kotwica: '#platnosci',
      });
    }
  } catch { /* jw. */ }

  try {
    // 5. SUMA POZYCJI vs KWOTA OCZEKIWANA. Bariera arytmetyczna faktury odmowi z dokladnie
    //    tego samego powodu — lepiej zobaczyc to teraz niz w odmowie bez wyjasnienia.
    const suma = podsumowaniePozycji(zamowienie);
    if (!suma.zgadzaSie) {
      sprawy.push({
        klucz: 'pozycje',
        waga: BLOKADA,
        tekst: `Suma pozycji (${suma.sumaZl ?? '—'} zł) NIE ZGADZA SIĘ z kwotą oczekiwaną od klienta `
          + `(${suma.oczekiwanaZl ?? zamowienie.kwota_brutto} zł) — faktura zostanie odrzucona.`,
        kotwica: '#pozycje',
      });
    }
  } catch { /* jw. */ }

  try {
    // 6. ROZJAZD ZE SKLEPEM. Panel mowi „Wyslane", sklep dalej „W trakcie realizacji" —
    //    czyli klient nie dostal maila i widzi u siebie nieaktualny stan. Blokada, bo panel
    //    sam z tego nie wyjdzie: ponowienie wymaga kliknięcia (POST /sync-sklep).
    if (zamowienie.sync_woo_blad) {
      // ⚠️ BRZMIENIE PO KANALE, NIE PO NAZWIE KOLUMNY. Slad bledu siedzi w jednej kolumnie
      // (`sync_woo_blad`), bo pasek „Do zalatwienia" jest jeden — ale „nie dojechal do
      // sklepu" przy zamowieniu z Allegro wysyla czlowieka szukac usterki w WooCommerce,
      // gdzie tego zamowienia NIE MA. Rozpoznanie wspolnym predykatem (domain/wysylka.js),
      // nigdy wlasna kopia `startsWith('allegro_')`.
      const gdzie = czyKanalAllegro(zamowienie) ? 'do Allegro' : 'do sklepu';
      sprawy.push({
        klucz: 'sync-sklep',
        waga: BLOKADA,
        tekst: `Status nie dojechał ${gdzie}: ${zamowienie.sync_woo_blad}`,
        kotwica: '#status',
      });
    }
  } catch { /* jw. */ }

  // Blokady przed uwagami — i to NIE jest kosmetyka: pasek czyta sie od gory, wiec to, co
  // zatrzymuje robote, ma stac pierwsze. Sprawy dokladamy w kolejnosci SEKCJI na karcie
  // (przesylka → faktura → anulowanie → platnosci → pozycje), wiec bez tego kroku uwaga
  // o niedoplacie wyprzedzalaby blokade sumy pozycji.
  // W obrebie tej samej wagi kolejnosc dodawania zostaje nietknieta.
  return [...sprawy.filter((s) => s.waga === BLOKADA), ...sprawy.filter((s) => s.waga === UWAGA)];
}
