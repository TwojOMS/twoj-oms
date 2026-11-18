import { sprawyZamowienia, przesylkaUkryta } from './przesylka-stan.js';
import { stanFaktury } from './faktura-stan.js';
import { anulowaneWymagaUwagi } from './status.js';
import { saldoWplat, platnoscPrzyOdbiorze } from './platnosci.js';
import { podsumowaniePozycji } from './tabela-pozycji.js';
import { modulZamowienia, umiejetnosciZamowienia } from './moduly-kanalow.ts';
import { konfliktNumeruErli, KONFLIKT_NUMERU_ERLI } from './erli-numer.js';
import { czekaNaKsef as czekaNaKsefDom, czekaNaKsefDluzejNizDobe } from './ksef-oczekiwanie.js';
import { NAZWA_ZAPASOWA } from './nazwa-programu.js';
// ⚠️ `weryfikacjaNierozstrzygnieta` nie jest tu używany — zniknął razem z wyciszoną uwagą
// „Allegro nie potwierdziło przyjęcia pliku" (uzasadnienie przy tamtym miejscu, niżej).
// Predykat ZOSTAJE w domena/allegro-faktura.js obok swojej postaci SQL, której używa
// zapytanie czuwacza, i ma ożyć razem z tą sprawą, gdy `GET .../invoices` zacznie odpowiadać.

// Pasek „Do załatwienia" na karcie zamówienia. Zbiera w JEDNO miejsce sprawy, które inaczej
// byłyby rozsypane po całej karcie jako identycznie wyglądające `.uwaga` — od
// „faktura do wyjaśnienia" po „zamówienie nieopłacone", które przy B2B jest normą.
//
// ⚠️ NIC tu nie jest liczone od nowa. Każda sprawa pochodzi z funkcji, która już istnieje
// i już rządzi czymś innym: `sprawyZamowienia` daje zdania sekcji przesyłek na karcie,
// `stanFaktury` stoi za odmową ponownego wystawienia, `saldoWplat` liczy saldo sekcji
// płatności, `podsumowaniePozycji` odpowiada tej samej arytmetyce, co bariera faktury. Gdyby
// pasek liczył cokolwiek sam, rozjechałby się z nimi przy pierwszej zmianie reguły — i zaczął
// kłamać o tym, czy jest co robić, dokładnie tam, gdzie operator na to patrzy najpierw.
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
 * NIGDY nie rzuca: uszkodzone dane mają pokazać kartę bez paska, a nie zamiast karty
 * pokazać 500 — dokładnie ta sama zasada, co przy `podsumowaniePozycji` (domena/tabela-pozycji.js).
 */
export function sprawyKarty(
  zamowienie,
  teraz = Date.now(),
  { nazwa = NAZWA_ZAPASOWA, gdzie = `w ${nazwa.miejscownik}` } = {},
) {
  // `nazwa` = odmiana nazwy programu fakturowego (domyślnie inFakt — domena/nazwa-programu.js).
  if (!zamowienie) return [];
  const sprawy = [];

  if (modulZamowienia(zamowienie).typ === 'erli' && konfliktNumeruErli(zamowienie)) {
    sprawy.push({ klucz: 'numer-kanalu', waga: UWAGA, tekst: KONFLIKT_NUMERU_ERLI, kotwica: '#przesylka' });
  }

  try {
    // 1. PRZESYLKI. Tekst bierzemy gotowy z domeny przesylek — przy wielu paczkach niesie
    //    juz „paczka N: ...", a bez tego operator nie wiedzialby, ktory list sprawdzic.
    for (const opis of sprawyZamowienia(zamowienie.przesylki, teraz)) {
      sprawy.push({ klucz: 'przesylka', waga: BLOKADA, tekst: opis, kotwica: '#przesylka' });
    }
  } catch {
    /* uszkodzony wiersz przesylki nie ma prawa zabrac calego paska */
  }

  try {
    // 2. FAKTURA. Wylacznie stany, z ktorych panel sam nie wyjdzie — faktura wystawiona
    //    ani jej brak nie sa zadna sprawa.
    const stan = stanFaktury(zamowienie.faktura, teraz);
    if (stan === 'do_wyjasnienia') {
      const powod = zamowienie.faktura?.blad_opis ? `: ${zamowienie.faktura.blad_opis}` : '';
      sprawy.push({
        klucz: 'faktura',
        waga: BLOKADA,
        tekst: `Faktura do wyjaśnienia${powod}. Sprawdź ${gdzie}, czy dokument powstał.`,
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

    // ⚠️ „CZEKA NA KSEF" TO STAN, W KTÓRYM PANEL UTKNĄŁBY NA ZAWSZE (reguła: każdy stan ma wyjście).
    // Dokument, którego nikt nie wyśle (pomyłka, korekta, nieobecność), zostawia kupującego
    // bez faktury — a panel milczy, bo z jego punktu widzenia „wszystko czeka": faktura JEST
    // wystawiona, więc żaden istniejący warunek wyżej się nie odzywa.
    //
    // Doba, bo dokumenty wysyła się do KSeF w ciągu dnia: 24 h mijają dopiero wtedy, gdy coś
    // naprawdę stanęło.
    //
    // ⚠️⚠️ TEKST WSKAZUJE TYLKO WYJŚCIA, KTÓRE ISTNIEJĄ. Zdanie odsyłające do przycisku, którego
    // w kodzie nie ma, spełnia regułę „każdy stan ma wyjście" WYŁĄCZNIE NAPISEM: człowiek czyta
    // instrukcję, szuka przycisku i go nie znajduje.
    //
    // ⚠️⚠️ SPRAWA STOI NA WYNIKU PYTANIA CZUWACZA (`ksef_odczyt = 'ok'`), A NIE NA UPŁYWIE
    // DOBY. Sam czas nie jest żadnym dowodem: przy zatrzymanym czuwaczu albo niedostępnym
    // inFakcie KAŻDA faktura starsza niż doba zapalałaby BLOKADĘ „wyślij dokument do KSeF"
    // komuś, kto JUŻ GO WYSŁAŁ. Panel oskarżałby wtedy człowieka o własną ślepotę.
    //
    // 'ok' znaczy: PYTALIŚMY i inFakt ODPOWIEDZIAŁ, że numeru KSeF tam nie ma. NULL („nikt nie
    // pytał") i 'blad' („pytanie nie doszło") nie znaczą NIC i sprawy nie zapalają.
    //
    // ⚠️ ZAKRES BIERZEMY ZE WSPÓLNEJ DEFINICJI (domena/ksef-oczekiwanie.js) — TEJ SAMEJ,
    // której używa zapytanie czuwacza. Własna kopia byłaby SZERSZA: zapalałaby blokadę przy
    // fakturze bez numeru dokumentu (o którą czuwacz nie zapyta nigdy, więc tekst szedłby
    // z pustą luką: „Faktura  czeka na KSeF od …") i przy zamówieniu ANULOWANYM, które ma już
    // swoją własną blokadę niżej.
    //
    // ⚠️ ZAKRES OBEJMUJE TAKŻE dokument, którego wysyłkę do KSeF zlecił PANEL, choćby ze sklepu.
    // Faktura sklepowa, której nikt z panelu nie wysłał, dalej nie jest żadną sprawą — nie ma
    // DOKĄD pojechać i numeru nie dostanie nigdy, więc blokada przy niej świeciłaby przy KAŻDEJ
    // fakturze sklepowej. Umiejętność kanału siedzi we wspólnym warunku oczekiwania na KSeF.
    //
    // ⚠️ TREŚĆ sprawy różne gałęzie mają RÓŻNĄ (patrz niżej): wyjścia, które panel wskazuje,
    // są przy fakturze allegrowej inne niż przy sklepowej.
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
        tekst:
          `Faktury ${numerFaktury} NIE MA JUŻ w ${nazwa.miejscownik} — dokument został tam skasowany, ` +
          'więc numeru KSeF nikt już nie przyniesie, a panel nie wystawi drugiej. ' +
          // ⚠️ ODNOTOWANIE STOI NA ZAKŁADCE FAKTURY. Zdanie musi kierować TAM, gdzie ta akcja
          // jest — sprawa odsyłająca do przycisku, którego na karcie nie ma, jest gorsza niż
          // brak sprawy.
          'Jeśli to ty ją skasowałeś, odnotuj to w zakładce Faktury („Faktura skasowana ' +
          `w ${nazwa.miejscownik}”) — zamówienie zwolni się do ponownego wystawienia.`,
        kotwica: '#faktura',
      });
    } else if (
      odczyt === 'ok' &&
      czekaNaKsefDluzejNizDobe(zamowienie, teraz) &&
      !(umiejetnosciZamowienia(zamowienie).plikFaktury && zamowienie.chce_fakture)
    ) {
      // ⚠️ Allegro BEZ żądania faktury, zlecone przez panel, też idzie tutaj — kupujący na nią
      // nie czeka, a wysyłkę takiej faktury do Allegro `wolnoWyslacDoAllegro` i tak zatrzymuje.
      // ⚠️⚠️ DOKUMENT, KTÓREGO WYSYŁKĘ DO KSeF ZLECIŁ PANEL, A NUMERU NIE MA OD DOBY. `czekaNaKsef`
      // obejmuje TAKŻE takie faktury (domena/ksef-oczekiwanie.js) — a sprawa musi wtedy mówić
      // CO INNEGO niż przy Allegro.
      //
      // Zdanie allegrowe niżej („kupujący jej jeszcze nie ma") byłoby tu podwójnie nieprawdziwe:
      // przy fakturze sklepowej nikt na nią u kupującego nie czeka, a przycisku wysyłki do Allegro
      // na tej karcie NIE MA. Sprawa wskazująca wyjście, którego nie ma, jest stanem bez wyjścia
      // (reguła: każdy stan ma wyjście).
      //
      // ⚠️ PANEL SAM NICZEGO NIE PONOWI i to jest cała treść tej sprawy: drugie zgłoszenie tego
      // samego dokumentu byłoby duplikatem u organu, po którym zostaje wyłącznie korekta
      // (moduly/faktury/db/wysylki-ksef.js). Jedynym następnym krokiem jest CZŁOWIEK w inFakcie.
      //
      // ⚠️⚠️ DATĘ W ZDANIU BIERZEMY Z ZLECENIA WYSYŁKI (`ksef_zlecona_at`), A NIE Z WYSTAWIENIA
      // DOKUMENTU. Podmiotem tego zdania jest WYSYŁKA Z PANELU, a nie faktura. Zakładka faktur
      // jest MIESIĘCZNA, więc wysyłanie dokumentów z zeszłego miesiąca to zwykły tryb pracy —
      // licząc od wystawienia, czekanie byłoby zawyżone o TYGODNIE. Kolumna przychodzi na tym
      // samym obiekcie (`zlecona_at` z `wysylki_ksef`, dokłada ją oms/db/zamowienia.js) i przy tej
      // gałęzi jest ZAWSZE wypełniona: to ona wpuściła zamówienie do `czekaNaKsef`.
      //
      // ⚠️⚠️ PRÓG DOBY: `czekaNaKsefDluzejNizDobe` liczy od PÓŹNIEJSZEGO z dwóch stempli
      // (wystawienie, zlecenie wysyłki). Licząc od samego wystawienia, faktura z zeszłego
      // miesiąca dostawałaby tę blokadę chwilę po najzupełniej normalnej wysyłce — zdanie
      // mówiłoby prawdę („panel zlecił o 10:05"), a blokada obok niego byłaby fałszem.
      sprawy.push({
        klucz: 'ksef',
        waga: BLOKADA,
        tekst:
          `Panel zlecił wysyłkę faktury ${numerFaktury} do KSeF, a numeru nie ma od ` +
          `${zamowienie.faktura?.ksef_zlecona_at} — ${nazwa.mianownik} odpowiada, że dokumentu tam jeszcze ` +
          `nie ma. Sprawdź ten dokument ${gdzie}: albo zgłoszenie utknęło, albo organ je ` +
          'odrzucił. Panel sam wysyłki NIE ponowi — drugie zgłoszenie byłoby duplikatem, ' +
          'którego nie da się skasować.',
        kotwica: '#faktura',
      });
    } else if (odczyt === 'ok' && czekaNaKsefDluzejNizDobe(zamowienie, teraz)) {
      // ⚠️ PRÓG DOBY BIERZEMY ZE WSPÓLNEJ DEFINICJI (domena/ksef-oczekiwanie.js,
      // `czekaNaKsefDluzejNizDobe`) — własna kopia liczby rozjechałaby się z nią przy pierwszej
      // zmianie.
      //
      // ⚠️ DATA W ZDANIU TO WYSTAWIENIE DOKUMENTU i tak ma zostac: przy fakturze allegrowej
      // podmiotem jest FAKTURA, ktora czeka na numer od chwili powstania (kupujacy jej nie ma).
      // Prog doby liczy sie natomiast od PÓŹNIEJSZEGO z dwoch stempli (ksef-oczekiwanie.js),
      // wiec gdy panel zlecil wysylke takiej faktury przed chwila, blokada milczy przez dobe
      // OD TEJ WYSYLKI — bo dopiero ona jest tym, na co teraz czekamy.
      //
      // ⚠️ `ksef_odczyt === 'ok'` jest warunkiem SPRAWY, nie samego progu (`czekaNaKsefDluzejNizDobe`
      // o odczyt nie pyta): sprawa OSKARŻA człowieka o niewysłanie dokumentu, więc musi stać
      // na dowodzie od czuwacza.
      sprawy.push({
        klucz: 'ksef',
        waga: BLOKADA,
        tekst:
          `Faktura ${numerFaktury} czeka na KSeF od ${zamowienie.faktura?.utworzona_at} ` +
          `— kupujący jej jeszcze nie ma. Wyślij ten dokument do KSeF w ${nazwa.miejscownik} albo, ` +
          'jeśli świadomie godzisz się na dokument bez tego numeru, wyślij go kupującemu ' +
          'przyciskiem „Wyślij do Allegro BEZ numeru KSeF” na tej karcie.',
        kotwica: '#faktura',
      });
    }

    // ⚠️⚠️ WYSŁANIE FAKTURY DO ALLEGRO NIE JEST KOŃCEM OPERACJI. Allegro sprawdza plik
    // antywirusem, a REJECTED znaczy, że kupujący faktury NIE MA — mimo że `allegro_wyslana_at`
    // jest wypełnione, log karty mówi „plik wysłany", a przycisk wysyłki odmawia ponowienia
    // („kupujący ma ją na koncie"). Bez tej sprawy panel twierdziłby, że kupujący fakturę dostał.
    //
    // ⚠️ WARUNEK TO GOŁE `REJECTED` — TEN SAM, przy którym `wolnoWyslacDoAllegro`
    // (domena/allegro-faktura.js) przepuszcza ponowienie. Zakres czuwacza
    // (`WARUNEK_WERYFIKACJA_NIEROZSTRZYGNIETA_SQL`) go nie obejmuje: REJECTED jest stanem końcowym.
    const fa = zamowienie.faktura;
    if (fa?.allegro_weryfikacja === 'REJECTED') {
      sprawy.push({
        klucz: 'faktura-allegro',
        waga: BLOKADA,
        // ⚠️ SPRAWA WSKAZUJE WYJŚCIE, KTÓRE NAPRAWDĘ ISTNIEJE: przy REJECTED `wolnoWyslacDoAllegro`
        // nie odmawia ponowienia, więc sprawa może NAZWAĆ przycisk, który na tej karcie jest.
        tekst:
          `Allegro ODRZUCIŁO plik faktury ${fa.numer ?? ''} — kupujący jej NIE MA, ` +
          `mimo że panel plik wysłał. Sprawdź dokument ${gdzie} i wyślij go jeszcze raz ` +
          'przyciskiem „Wyślij plik faktury do Allegro jeszcze raz” na tej karcie — ' +
          'ponowienie PODMIENIA plik przy tym samym zgłoszeniu, drugiego dokumentu nie zrobi.',
        kotwica: '#faktura',
      });
    }
    // ⚠️⚠️ NIE MA TU UWAGI „Allegro od … nie potwierdziło przyjęcia pliku faktury", zapalanej
    // przy `weryfikacjaNierozstrzygnieta` po dobie od `allegro_wyslana_at` — jest WYCISZONA.
    //
    // `GET /order/checkout-forms/{id}/invoices` oddaje 400 także na zamówieniu, które fakturę
    // JUŻ MA. Zasób jest dla nas niedostępny, więc `allegro_weryfikacja` NIE WYJDZIE Z `WAITING`
    // nigdy — a uwaga zapalałaby się przy KAŻDEJ wysłanej fakturze i zostawała na zawsze. Pasek,
    // na którym wisi wpis przy każdym zamówieniu, przestaje być narzędziem.
    //
    // ⚠️ ODPYTYWANIA W CZUWACZU NIE RUSZAMY (moduly/faktury/services/czuwacz-ksef.js) — gdy Allegro naprawi
    // zasób, stan zacznie się rozstrzygać SAM. WYCISZONA JEST SPRAWA NA PASKU, nie pętla.
    //
    // CO MA SIĘ STAĆ, GDY ZASÓB ZACZNIE ODPOWIADAĆ: pierwsza faktura, która wyjdzie z `WAITING`
    // na `ACCEPTED` albo `REJECTED`, jest dowodem, że źródło żyje. Wtedy — i dopiero wtedy —
    // ta uwaga ma tu wrócić (waga UWAGA, nie blokada: `PUT .../file` się udał, więc brakuje
    // potwierdzenia, a nie pliku), bo `WAITING` znowu będzie znaczył „jeszcze nie wiadomo",
    // a nie „nigdy się nie dowiemy".
    //
    // ⚠️ `REJECTED` WYŻEJ ZOSTAJE BLOKADĄ i wyciszenie go NIE DOTYCZY: przychodzi z odpowiedzi
    // na `PUT .../file`, a nie z zepsutego odczytu, i znaczy, że kupujący faktury NIE MA.
  } catch {
    /* jw. */
  }

  try {
    // 3. ANULOWANIE PO NADANIU ALBO PO WYSTAWIENIU FAKTURY. Sam status „Anulowane" wygląda
    //    jak sprawa zamknięta, a paczka może być w drodze, a dokument czekać w inFakcie na
    //    wysyłkę do KSeF.
    if (zamowienie.anulowane && zamowienie.status_woo !== 'cancelled' && modulZamowienia(zamowienie).typ === 'erli') {
      sprawy.push({
        klucz: 'anulowanie-kanalu',
        waga: UWAGA,
        tekst: 'Zamówienie anulowane w OMS — anuluj w panelu ERLI.',
        kotwica: '#status',
      });
    }
    if (anulowaneWymagaUwagi(zamowienie)) {
      // ⚠️⚠️ TYM SAMYM PREDYKATEM, CO `anulowaneWymagaUwagi`. Tamta funkcja liczy wyłącznie
      // paczki NIEUKRYTE (`przesylkaUkryta`); wybór treści na gołej liczbie wierszy przesyłek
      // znaczyłby, że zamówienie anulowane z JEDYNĄ paczką UKRYTĄ i wiszącą fakturą słusznie
      // zostaje sprawą — ale z powodu FAKTURY — a karta pisze „anulowane po nadaniu paczki"
      // i kotwiczy w `#przesylka`. Operator trafiałby w jedyną rzecz, którą człowiek już
      // zamknął, i mógłby nie dojść do dokumentu wymagającego korekty w KSeF. Drugi czytelnik
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
  } catch {
    /* jw. */
  }

  try {
    // 4. SALDO WPLAT. Niedoplata i nadplata sa OBIE jawne: pierwsza to pieniadze, ktorych
    //    nie ma, druga to pieniadze klienta, ktore trzeba oddac albo rozliczyc.
    const saldo = saldoWplat(zamowienie);
    // ⚠️ Przy pobraniu niedoplata NIE JEST sprawa — kurier zainkasuje przy doreczeniu.
    // Nadplata i blad arytmetyki zostaja: te znacza cos rownie zle przy kazdej metodzie.
    //
    // ⚠️ TAK SAMO PRZY ROZLICZENIU ZBIORCZYM — i tu stawka jest wyższa. Zamówienie należące
    // do okresu rozliczeniowego NIE MA WŁASNYCH PIENIĘDZY: klient płaci RAZ, za cały miesiąc,
    // a wpłata siedzi na okresie (tabela `platnosci_okresu`). Bez tego warunku KAŻDE zamówienie
    // okresu melduje „Niedopłata 100.00 zł z 100.00 zł" — na zawsze, bo tych pieniędzy na
    // zamówieniu nigdy nie będzie. Pasek spraw jest jedynym miejscem, w którym operator szuka
    // prawdziwych blokad, a dziesiątki stałych fałszywych alarmów miesięcznie po prostu go
    // wyłączają.
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
  } catch {
    /* jw. */
  }

  try {
    // 5. SUMA POZYCJI vs KWOTA OCZEKIWANA. Bariera arytmetyczna faktury odmowi z dokladnie
    //    tego samego powodu — lepiej zobaczyc to teraz niz w odmowie bez wyjasnienia.
    const suma = podsumowaniePozycji(zamowienie);
    if (!suma.zgadzaSie) {
      sprawy.push({
        klucz: 'pozycje',
        waga: BLOKADA,
        tekst:
          `Suma pozycji (${suma.sumaZl ?? '—'} zł) NIE ZGADZA SIĘ z kwotą oczekiwaną od klienta ` +
          `(${suma.oczekiwanaZl ?? zamowienie.kwota_brutto} zł) — faktura zostanie odrzucona.`,
        kotwica: '#pozycje',
      });
    }
  } catch {
    /* jw. */
  }

  try {
    // 6. ROZJAZD ZE SKLEPEM. Panel mówi „Wysłane", sklep dalej „W trakcie realizacji" —
    //    czyli klient nie dostał maila i widzi u siebie nieaktualny stan. Blokada, bo panel
    //    sam z tego nie wyjdzie: ponowienie wymaga kliknięcia (POST /zamowienia/:id/sync-sklep).
    if (zamowienie.sync_woo_blad) {
      // ⚠️ BRZMIENIE PO KANALE, NIE PO NAZWIE KOLUMNY. Slad bledu siedzi w jednej kolumnie
      // (`sync_woo_blad`), bo pasek „Do zalatwienia" jest jeden — ale „nie dojechal do
      // sklepu" przy zamowieniu z Allegro wysyla czlowieka szukac usterki w WooCommerce,
      // gdzie tego zamowienia NIE MA. Odmianę nazwy podaje opis modułu kanału.
      const gdzie = `do ${modulZamowienia(zamowienie).komunikaty.dopelniacz}`;
      sprawy.push({
        klucz: 'sync-sklep',
        waga: BLOKADA,
        tekst: `Status nie dojechał ${gdzie}: ${zamowienie.sync_woo_blad}`,
        kotwica: '#status',
      });
    }
  } catch {
    /* jw. */
  }

  // Blokady przed uwagami — i to NIE jest kosmetyka: pasek czyta sie od gory, wiec to, co
  // zatrzymuje robote, ma stac pierwsze. Sprawy dokladamy w kolejnosci SEKCJI na karcie
  // (przesylka → faktura → anulowanie → platnosci → pozycje), wiec bez tego kroku uwaga
  // o niedoplacie wyprzedzalaby blokade sumy pozycji.
  // W obrebie tej samej wagi kolejnosc dodawania zostaje nietknieta.
  return [...sprawy.filter((s) => s.waga === BLOKADA), ...sprawy.filter((s) => s.waga === UWAGA)];
}
