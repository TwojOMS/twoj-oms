import {
  zapiszNumerKsef,
  zapiszNieudanyOdczytKsef,
  zapiszWeryfikacjeAllegro,
  zapiszPytanieOWeryfikacje,
} from '../db/faktury.js';
import { dopiszLog, ostatniWpisLogu, pobierzZamowienie } from '../../../oms/db/zamowienia.js';
// ⚠️ TA SAMA BRAMKA, CO PRZY PRZYCISKU NA KARCIE — nigdy wlasna kopia warunkow. Patrz
// `wyslijDoAllegroJesliWolno` nizej.
import { wolnoWyslacDoAllegro } from '../../../domena/allegro-faktura.js';
import { createPoNumerzeKsef } from './po-numerze-ksef.js';
import { wysylkaKsef } from '../db/wysylki-ksef.js';
import {
  idDokumentu,
  idDokumentuSql,
  programDokumentuSql,
  czyDokumentProgramu,
  numerKsefDokumentu,
} from '../../../domena/dokument-programu.js';
import {
  warunekCzekaNaKsefSql,
  KOLUMNA_ZLECONA_Z_PANELU_SQL,
  czyWierszWZakresieKsef,
} from '../../../domena/ksef-oczekiwanie.js';
import { statusWeryfikacji, WARUNEK_WERYFIKACJA_NIEROZSTRZYGNIETA_SQL } from '../../../domena/allegro-faktura.js';
import { LIMIT_ZAPYTANIA_PRZESYLEK_MS } from '../../../oms/allegro/client.js';
import { wolnoPytac, poOdpowiedzi } from '../../../domena/bezpiecznik-weryfikacji.js';
import { stanWeryfikacji, zapiszStanWeryfikacji } from '../../../oms/db/stan-weryfikacji.js';
import { zProgramu } from '../../../integracje/program-fakturowy.ts';

// ⚠️⚠️ TO NIE JEST `moduly/koszty/services/czuwacz-kosztow.js` — tamten pobiera z KSeF faktury,
// na których jesteśmy NABYWCĄ (zakładka KOSZTY). Ten pyta program fakturowy o numer KSeF naszej
// faktury SPRZEDAŻOWEJ.
//
// Czuwacz KSeF. ⚠️⚠️ TEN PRZEBIEG NIE WYSYŁA NICZEGO DO KSeF I NIGDY NIE BĘDZIE — WYŁĄCZNIE PYTA,
// czy dokument jest już w KSeF, bo do Allegro ma pójść faktura niosąca ten numer na sobie.
//
// Wystawienie faktury dalej NIGDY jej nie wysyła (`wystaw()` w infakt/client.js nie zna
// `send_to_ksef`). Panel wysyła WYŁĄCZNIE ze świadomego zatwierdzenia człowieka na zakładce
// faktur (POST /faktury/ksef/wyslij → services/wysylka-ksef.js) albo z automatu KSeF, który operator sam włącza
// (services/ksef-automat.js — o ustalonej godzinie; przy TwojeFaktury services/ksef-automat-wbudowany.js — także
// „po wystawieniu”). Operator może też wysłać ręcznie w inFakcie — więc czuwacz nie ma prawa zakładać, KTO wysłał: pyta o fakt,
// a nie o własny ślad.
//
// Chodzi CO GODZINĘ, CAŁĄ DOBĘ. W nocy nie musiałby, ale okno godzinowe znaczyłoby kolejne
// miejsce w kodzie liczące czas Warszawy, a każde takie miejsce to okazja do błędu strefy.
// Odpytujemy WYŁĄCZNIE faktury czekające na KSeF, więc w typową noc lista jest pusta i czuwacz
// nie robi nic.
const teraz = () => new Date().toISOString();

// ⚠️ WARUNEK POCHODZI ZE WSPÓLNEJ DEFINICJI (domena/ksef-oczekiwanie.js). Własna kopia tutaj
// i druga, SZERSZA, przy pasku spraw na karcie rozjechały się: panel meldował blokadę przy
// dokumencie, o który czuwacz nigdy nie zapytał (faktura bez numeru), i przy zamówieniu, którego
// nikt nie kupił (anulowane). Dwie kopie warunku rozjeżdżają się przy pierwszej zmianie reguły;
// jest jedna, a test pilnuje zgodności obu jej postaci.
//
// ⚠️ TO JEST ZAWĘŻENIE ODCZYTU, A NIE ROZPOZNANIE KANAŁU. Rozpoznaje `czyWierszWZakresieKsef`
// niżej — a ono kanał rozstrzyga umiejętnością `plikFaktury` z rejestru kanałów
// (domena/moduly-kanalow.ts), tak jak reszta panelu. SQL zawężający jest tu po to, żeby przebieg
// nie wciągał co godzinę wszystkich faktur sklepowych, jakie kiedykolwiek powstały: dokument,
// którego nikt do KSeF nie wysłał i który nie ma dokąd pojechać, zostanie bez numeru NA ZAWSZE,
// więc bez tego warunku lista rosłaby w nieskończoność razem z archiwum.
//
// ⚠️⚠️ ZAKRES MA DRUGĄ GAŁĄŹ — dokumenty, których wysyłkę do KSeF ZLECIŁ PANEL (wiersz
// w `wysylki_ksef`). Ruch przez nią ROŚNIE, więc podłoga i sufit niżej są WAŻNIEJSZE, a nie
// mniej ważne. Przyrost jest jednak ograniczony z góry i to nie przypadkiem: wiersz wpada do
// zakresu wyłącznie po wysyłce z panelu i wypada z niego, gdy tylko program nada numer (zwykle
// w ciągu minut od zlecenia) albo gdy minie podłoga.

// ⚠️⚠️ PODŁOGA. Bez niej wiersz, który numeru KSeF NIGDY nie dostanie (pomyłka, korekta,
// urlop, dokument skasowany w inFakcie), zostawałby w zapytaniu NA ZAWSZE: 24 wywołania na dobę,
// 8760 rocznie, NA WIERSZ. Przy dwóch takich wierszach miesięcznie po roku daje to ~576
// bezużytecznych wywołań na dobę, po trzech latach ~1730 — czyli zapytanie rosnące liniowo
// i nigdy nie malejące.
//
// 30 DNI, bo po tym czasie rozstrzyga CZŁOWIEK, nie czuwacz. Dokument, którego nikt nie wysłał
// do KSeF przez miesiąc, nie czeka już na automat: albo został skasowany, albo wymaga korekty,
// albo o nim zapomniano — i wtedy woła o niego pasek spraw na karcie (ten NIE MA podłogi
// i świecić nie przestaje, patrz domena/sprawy-karty.js). Krótszy próg gasiłby pytania przy
// fakturach z normalnego urlopu; dłuższy nie zmienia już nic poza kosztem.
//
// ⚠️⚠️ LICZONA OD ZDARZENIA WEJŚCIOWEGO WŁAŚCIWEJ GAŁĘZI, A NIE ZAWSZE OD WYSTAWIENIA FAKTURY.
// Dla gałęzi drugiej zdarzeniem wejściowym jest WYSYŁKA (`wysylki_ksef.zlecona_at`), nie
// wystawienie dokumentu. Zakładka „FAKTURY" jest MIESIĘCZNA, więc wysyłanie dokumentów
// z zeszłego miesiąca to zwykły tryb pracy: przy podłodze liczonej od wystawienia KAŻDA
// faktura wystawiona dawniej niż 30 dni i wysłana z panelu DZIŚ wypadałaby z zapytania już
// w chwili wysyłki, a `ksef_numer` zostawałby NULL-em na zawsze. I to PO CICHU: sprawa „czeka
// na KSeF" na karcie wymaga `ksef_odczyt = 'ok'`, a tę kolumnę piszą wyłącznie odczyty numeru
// z programu (ten czuwacz i doczytanie przy karcie, services/ksef-doczytanie.js).
//
// Ograniczenie z góry się NIE ZMIENIA: dalej najwyżej 30 dni × 24 pytania NA DOKUMENT, tylko
// liczone od właściwego momentu.
//
// ⚠️ PORÓWNANIE TEKSTOWE dat ISO — takie samo, jakiego używa kursor pollera. Działa, bo obie
// strony są w tym samym formacie i tej samej strefie (`new Date().toISOString()`).
export const PODLOGA_DNI = 30;

// ⚠️ SUFIT NA JEDEN PRZEBIEG. Pętla jest SEKWENCYJNA, a limit pojedynczego zadania programu
// (np. inFaktu) to 60 s — bez tego jeden przebieg przy dłuższej awarii programu przekraczałby
// godzinę i wchodził na kolejny. 50 x 60 s = 50 min, czyli cały najgorszy przypadek mieści
// się w godzinie między tyknięciami zegara. Zwykle lista jest krótka (kilka dokumentów),
// więc ten sufit widać wyłącznie po awarii, gdy zaległość urosła — i wtedy też nic nie
// przepada: resztę bierze następny przebieg.
export const LIMIT_PRZEBIEGU = 50;

// ⚠️⚠️ PODLOGA JEST TU, A NIE WE WSPOLNYM WARUNKU — i to jest decyzja, nie przeoczenie.
// `warunekCzekaNaKsefSql()` ma odpowiadac IDENTYCZNIE jak predykat `czekaNaKsef`
// (domena/ksef-oczekiwanie.js; pilnuje tego tests/moduly/faktury/ksef-oczekiwanie.test.js), a pasek spraw
// na karcie podlogi MIEC NIE MOZE: sprawa ma swiecic takze wtedy, gdy czuwacz przestal pytac —
// to jest jedyne wyjscie z tego stanu (reguła: każdy stan ma wyjście). Podloga jest wiec DLAWIENIEM ODCZYTU
// tego przebiegu, a nie czescia definicji „faktura czeka na KSeF", i dlatego nie ma jej
// odpowiednika w predykacie.
//
// ⚠️⚠️ DWA STEMPLE, BO DWIE GALEZIE MAJA DWA ROZNE ZDARZENIA WEJSCIOWE. Galaz allegrowa wchodzi
// przez WYSTAWIENIE dokumentu (`f.utworzona_at`), galaz „panel zlecil wysylke" — przez samo
// ZLECENIE (`wysylki_ksef.zlecona_at`). Uzasadnienie i awaria, ktora to naprawia, stoja przy
// `PODLOGA_DNI` wyzej. `OR`, a nie `CASE`: wiersz moze nalezec do obu galezi naraz i wtedy
// wystarczy, ze MLODSZY z dwoch stempli miesci sie w podlodze.
//
// ⚠️⚠️ PORZĄDEK PO DACIE OSTATNIEGO PYTANIA, A NIE PO DACIE WYSTAWIENIA — tak samo jak w drugiej
// pętli i z tego samego powodu. Porządek po `f.utworzona_at` zakładałby, że wiersz OBSŁUŻONY
// WYPADA ze zbioru; wiersz, który numeru NIE DOSTANIE (organ odrzucił, dokument skasowany), nie
// wypada aż do podłogi. Zakładka faktur wysyła HURTOWO, więc jedna partia >= `LIMIT_PRZEBIEGU`
// takich dokumentów zajmowałaby KAŻDY slot przez 30 dni, a faktura wysłana później nie zostałaby
// zapytana ANI RAZU.
//
// `ksef_sprawdzona_at` nadaje sie na to kryterium, bo pisza je OBIE sciezki — i udany odczyt,
// i nieudany (db/faktury.js). `NULLS FIRST` (w SQLite to zarazem domyslna kolejnosc rosnaca)
// znaczy „jeszcze nie pytalismy = na poczatek". Data wystawienia zostaje kryterium POMOCNICZYM
// i rozstrzyga remisy, wiec na pierwszym przebiegu kolejnosc jest dokladnie ta, co dawniej:
// od najstarszej, czyli od tej, o ktora upomina sie pasek spraw. Kolejka jest CYKLICZNA.
// Funkcja, bo warunek zna klucze Allegro z konfiguracji dopiero po budowie aplikacji.
//
// `f.program` do `czyDokumentProgramu` w petli, a dokumenty modulu faktur OMS-u ida w kolejce PRZED
// dokumentami innego programu. Tych drugich czuwacz nie pyta i nie stempluje (`ksef_sprawdzona_at` zostaje pusty),
// wiec bez tego porzadku stalyby wiecznie na poczatku i zajmowalyby sloty `LIMIT_PRZEBIEGU` — ten sam zator, co wyzej.
const doSprawdzeniaSql = () => `
  SELECT f.id, f.program, ${idDokumentuSql('f')} AS dokument_id, f.zamowienie_id, z.sklep, ${KOLUMNA_ZLECONA_Z_PANELU_SQL}
  FROM faktury f
  JOIN zamowienia z ON z.id = f.zamowienie_id
  WHERE ${warunekCzekaNaKsefSql()}
    AND (
      f.utworzona_at >= ?
      OR EXISTS (SELECT 1 FROM wysylki_ksef w WHERE w.uuid = ${idDokumentuSql('f')} AND w.zlecona_at >= ?)
    )
  ORDER BY CASE WHEN ${programDokumentuSql('f')} = ? THEN 0 ELSE 1 END, f.ksef_sprawdzona_at NULLS FIRST, f.utworzona_at
  LIMIT ?
`;

// ⚠️⚠️ DRUGI KROK PRZEBIEGU: WYSŁANIE PLIKU DO ALLEGRO NIE JEST KOŃCEM OPERACJI.
// Allegro sprawdza plik antywirusem — WAITING → ACCEPTED albo REJECTED — a REJECTED znaczy,
// że kupujący faktury NIE MA, choć kolumna `allegro_wyslana_at` jest wypełniona i panel bez
// tego kroku twierdziłby, że ma.
//
// ⚠️ TO JEST DZIŚ PRÓBA, A NIE PEWNE ŹRÓDŁO — i to jest ZMIERZONE:
// `GET .../invoices` oddaje 400 na każde nasze zamówienie, więc klient zwraca PUSTĄ LISTĘ,
// `statusWeryfikacji` daje `null`, a `zapiszWeryfikacjeAllegro` NIC NIE PISZE i przebieg idzie
// dalej. Pierwszym źródłem prawdy jest odpowiedź na `PUT .../file` (services/faktura-allegro.js).
// Gdy zasób zacznie odpowiadać, ten krok ożyje SAM, bez zmiany w kodzie.
//
// ⚠️ ZAKRES ZE WSPÓLNEJ DEFINICJI (domena/allegro-faktura.js), tak samo jak warunek KSeF wyżej.
// ACCEPTED i REJECTED są KOŃCOWE — pytanie o nie to setki wywołań miesięcznie bez ani jednej
// nowej informacji.
//
// ⚠️⚠️ PODŁOGA I SUFIT, Z TEGO SAMEGO POWODU, CO W PIERWSZEJ PĘTLI — i tutaj stawka jest
// WYŻSZA, bo zasób oddaje dziś 400, więc KAŻDA wysłana faktura zostaje w stanie WAITING NA
// ZAWSZE. Bez podłogi zapytanie rosłoby liniowo razem z archiwum wysyłek i nigdy nie malało:
// 24 wywołania na dobę na wiersz, w nieskończoność. Po podłodze czuwacz przestaje pytać, a uwaga
// o niepotwierdzonym pliku na pasku spraw jest dziś wyciszona (domena/sprawy-karty.js).
//
// ⚠️⚠️ PORZĄDEK PO DACIE OSTATNIEGO PYTANIA, A NIE PO DACIE WYSŁANIA. Porządek po
// `f.allegro_wyslana_at` zakładałby, że wiersz OBSŁUŻONY WYPADA ze zbioru. DZIŚ NIE WYPADA:
// `zapiszWeryfikacjeAllegro` nic nie pisze, status zostaje `WAITING`, a wiersz siedzi
// w zapytaniu aż do podłogi — 30 dni. Przy WIĘCEJ NIŻ 50 wysłanych fakturach czuwacz pytałby
// w kółko o TE SAME najstarsze 50, a nowsze nie byłyby zapytane ANI RAZU.
//
// `NULLS FIRST` (w SQLite to zarazem domyślna kolejność rosnąca) znaczy „jeszcze nie pytaliśmy
// = na początek". Data wysłania jest kryterium POMOCNICZYM i rozstrzyga remisy — na pierwszym
// przebiegu, gdy wszystkie kolumny są puste, kolejność idzie od najdawniej wysłanej.
//
// Kolejka jest CYKLICZNA: po objechaniu wszystkich czuwacz wraca do najdawniej pytanej.
const DO_WERYFIKACJI = `
  SELECT f.id, f.allegro_invoice_id, f.zamowienie_id, z.sklep, z.zrodlo_id
  FROM faktury f
  JOIN zamowienia z ON z.id = f.zamowienie_id
  WHERE ${WARUNEK_WERYFIKACJA_NIEROZSTRZYGNIETA_SQL}
    AND f.allegro_wyslana_at >= ?
  ORDER BY f.allegro_pytana_at NULLS FIRST, f.allegro_wyslana_at
  LIMIT ?
`;

// ⚠️⚠️ SUFIT DRUGIEJ PĘTLI I JEDEN WSPÓLNY BUDŻET CZASU. Obie pętle są SEKWENCYJNE i chodzą
// W JEDNYM PRZEBIEGU, a strażnik „jeden przebieg naraz" (niżej) znaczy, że przebieg dłuższy niż
// odstęp zegara PO PROSTU GUBI tyknięcia — czuwacz zamiast co godzinę chodziłby co dwie.
// Najgorszy przypadek liczymy więc dla CAŁEGO przebiegu, nie dla pojedynczej pętli:
//
//   50 faktur × 60 s (limit zadania np. inFaktu) + 50 faktur × 5 s (limit odczytu z Allegro)
//   = 50 min + 4 min 10 s = 54 min 10 s < 60 min
//
// Ta arytmetyka NIE JEST komentarzem: `najdluzszyPrzebiegMs(limity)` liczy ją z limitów programu
// i klienta Allegro, a moduly/faktury/modul.ts odmawia startu panelu, gdy wynik nie mieści się
// między tyknięciami zegara. Podniesienie któregokolwiek limitu bez policzenia skutku ma położyć
// panel przy starcie, a nie po cichu rozjechać zegar czuwacza na produkcji.
export const LIMIT_WERYFIKACJI = 50;

// ⚠️ Krok „lustro luk KSeF" był tu krótko trzecim krokiem przebiegu i wyprowadził się do
// moduly/zdrowie/services/czuwacz-ostrzezen.js razem z lustrem terminów
// płatności — suma najgorszych przypadków przestała mieścić się między tyknięciami
// (54:10 + luki 5:00 + terminy 11:00 > 60:00). Uzasadnienie w nagłówku tamtego pliku.
// Ta sama arytmetyka z limitów WYBRANEGO programu fakturowego (`opis.limity`, core/kontrakty.ts) — strażnik
// startu w moduly/faktury/modul.ts liczy nią budżet programu, który naprawdę stoi za czuwaczem.
export function najdluzszyPrzebiegMs(limity) {
  return LIMIT_PRZEBIEGU * limity.zadanieMs + LIMIT_WERYFIKACJI * LIMIT_ZAPYTANIA_PRZESYLEK_MS;
}

/**
 * ⚠️ ZAKRES: faktury majace numer dokumentu i nie majace jeszcze numeru KSeF, przy zywym
 * zamowieniu — w DWOCH sytuacjach (domena/ksef-oczekiwanie.js):
 *
 *  1. zamowienie z KANALU Allegro, o ktorego fakture kupujacy poprosil (`chce_fakture = 1`) —
 *     dokument ma DOKAD pojechac, gdy numer sie pojawi;
 *  2. dokument, ktorego wysylke do KSeF ZLECIL PANEL (wiersz w `wysylki_ksef`) — numer trzeba
 *     dociagnac takze dla faktury sklepowej, bo inaczej zakladka „FAKTURY" pokazuje „brak KSeF"
 *     przy dokumencie, który właśnie stamtąd wyszedł, i pokazuje to już zawsze. Ta gałąź
 *     NIE pyta o `chce_fakture` — panel może wystawić fakturę także bez żądania klienta
 *     („faktura do każdego zamówienia"). Allegro bez żądania dostaje wtedy numer, ale na Allegro
 *     nie jedzie: zatrzymuje je `wolnoWyslacDoAllegro` (domena/allegro-faktura.js).
 *
 * Faktura sklepowa, ktorej panel nie wysylal, dalej NIE JEST pytana: numeru w bazie nie dostanie
 * nigdy, wiec pytanie o nia to setki wywolan miesiecznie bez ani jednej nowej informacji.
 */
// Numer KSeF czyta PROGRAM FAKTUROWY (`{ program }` albo stary `{ infakt }` przez `zProgramu`). Budżet
// przebiegu z `opis.limity` programu liczy `najdluzszyPrzebiegMs(limity)` wyżej — strażnik startu w modul.ts.
export function createCzuwaczKsef({
  db,
  program: programPodany = null,
  infakt = null,
  klienciKanalow = {},
  limit = LIMIT_PRZEBIEGU,
  limitWeryfikacji = LIMIT_WERYFIKACJI,
  // ⚠️ AUTOMAT WYSYŁKI FAKTURY DO KUPUJĄCEGO NA ALLEGRO, gdy pojawi się numer KSeF. Domyślnie
  // BRAK — panel bez kanału Allegro (albo bez programu fakturowego) nic kupującemu nie wysyła.
  fakturaAllegro = null,
  // Jedna linia na przebieg z liczba dokumentow innego programu, ktore czuwacz pominal.
  log = console.error,
  // Rozstrzyganie niepewnych wysyłek TwojeFaktury (services/ksef-rozstrzygniecie.js) — WYŁĄCZNIE program
  // wbudowany. Domyślnie brak: czuwacz inFaktu zachowuje się i pyta dokładnie jak dotąd.
  rozstrzyganie = null,
  // Warstwa 3 ochrony przed automatyczną wysyłką Fakturowni (magazyn w db/alarm-auto-ksef.js) — WYŁĄCZNIE
  // przy Fakturowni. Domyślnie brak: czuwacz inFaktu i TwojeFaktury zachowuje się dokładnie jak dotąd.
  alarmAutoKsef = null,
}) {
  const program = zProgramu({ program: programPodany, infakt });
  // Warstwa 3: dokument, którego wysyłki OMS NIE zlecał (brak wiersza w `wysylki_ksef`), a program mówi,
  // że poszedł do KSeF — konto Fakturowni wysyła samo. Dokument już jest; operator ma to zobaczyć (trwały alarm do
  // „Sprawdziłem” + wpis w historii zamówienia). Dławione ostatnim wpisem „ksef”: jeden stan = jeden wpis i jeden
  // dopisek alarmu, nie co godzinę. Błąd zapisu alarmu nie przerywa odczytu numeru.
  function zglosSamowolnaWysylke(f, dok, dane) {
    const gov = dane?.gov_status;
    if (gov == null || gov === '' || gov === 'not_connected' || gov === 'not_applicable') return;
    const wynik =
      `Fakturownia wysłała dokument do KSeF sama (stan: ${gov}) — OMS tego nie zlecał. ` +
      'Wyłącz automatyczną wysyłkę do KSeF w ustawieniach konta Fakturowni.';
    if (ostatniWpisLogu(db, f.zamowienie_id, 'ksef')?.wynik === wynik) return;
    dopiszLog(db, f.zamowienie_id, { akcja: 'ksef', wynik });
    try {
      alarmAutoKsef.dopisz({ dokument: dok, numer: dane?.number ?? null, gov_status: gov, oid: null });
    } catch (e) {
      log('ksef: nie zapisano alarmu automatycznej wysyłki Fakturowni', String(e?.message ?? e));
    }
  }
  // Identyfikator modulu faktur do porzadku kolejki w SQL. `zProgramu` oddaje program zawsze z opisem (surowy klient
  // inFaktu dostaje adapter), wiec `opis.id` jest tym samym, co porownuje `czyDokumentProgramu` w petli. Bez programu
  // `NULL` — porownanie nigdy nie jest prawdziwe i kolejka zostaje w dawnym porzadku.
  const idModulu = program?.opis?.id ?? null;
  // ⚠️⚠️ JEDEN PRZEBIEG NARAZ — ten sam strażnik, co w pollerze (moduly/kanaly/services/poller.js),
  // i z tego samego powodu. Zegar tyka co godzinę niezależnie od tego, czy poprzedni przebieg
  // się skończył. Limit pojedynczego zadania programu (np. inFaktu 60 s) i SEKWENCYJNA pętla
  // niżej znaczą, że przy dłuższej awarii programu przebieg przekracza godzinę — i bez tej blokady
  // zaczyna się PIĘTRZENIE: po dobie 24 równoległe pętle walące w padające API. `.catch` przy
  // zegarze tego nie zatrzyma, bo przebieg wcale nie odrzuca.
  //
  // ⚠️ ZWALNIANA W `finally`. Blokada zostawiona po bledzie wyciszylaby czuwacza NA ZAWSZE:
  // kazdy nastepny przebieg odbijalby sie od niej, bez ani jednego sladu (ta sama pulapka jest
  // opisana przy pollerze).
  let wTrakcie = false;

  async function przebieg() {
    if (wTrakcie) return { sprawdzone: 0, znalezione: 0, pominiety: true };
    wTrakcie = true;
    try {
      return await jedenPrzebieg();
    } finally {
      wTrakcie = false;
    }
  }

  /**
   * Wyslanie faktury do kupujacego na Allegro — AUTOMATEM, zaraz po tym, jak czuwacz zobaczyl
   * numer KSeF: faktury idą do KSeF w programie fakturowym, panel to zauważa i SAM przesyła
   * PDF do Allegro, z numerem KSeF na dokumencie.
   *
   * ⚠️⚠️ TO JEST NAJBARDZIEJ NIEODWRACALNA OPERACJA W CALYM PANELU WYKONYWANA BEZ CZLOWIEKA.
   * Dokument laduje na koncie kupujacego i panel nie ma czym go stamtad zabrac; skasowanie
   * faktury w inFakcie NIE zabiera jej kupujacemu z rak. Dlatego:
   *
   *  - automat NIE MA WLASNEJ BRAMKI. Pyta DOKLADNIE te sama funkcje, co przycisk na karcie
   *    (`wolnoWyslacDoAllegro` w domena/allegro-faktura.js) i idzie DOKLADNIE ta sama usluga
   *    (services/faktura-allegro.js). Druga, luzniejsza regula po stronie czuwacza bylaby
   *    dziura, ktorej nikt by nie zobaczyl — bo przycisk dalej zachowywalby sie poprawnie;
   *  - furtki „wyślij bez numeru KSeF” w panelu nie ma (domena/allegro-faktura.js): dokument
   *    bez numeru wysyła się ręcznie, poza panelem. Automat z taką furtką odbierałby
   *    operatorowi decyzję, której nie da się cofnąć;
   *  - ochrona przed duplikatem stoi tam, gdzie stala: `zajmijWysylkeDoAllegro` zaklada zamek
   *    w bazie PRZED pierwszym bajtem do sieci. Automat nie oslabia jej ani nie powiela.
   *
   * ⚠️ NIGDY NIE RZUCA. Awaria wysylki nie ma prawa zatrzymac czuwacza — ani dla tej faktury,
   * ani dla pozostalych. Numer KSeF jest juz zapisany i jest to fakt NIEZALEZNY od losu pliku:
   * dokument jest u organu bez wzgledu na to, czy kupujacy dostal PDF.
   */
  // ⚠️ NASTĘPSTWO ZAPISU NUMERU MIESZKA W services/po-numerze-ksef.js — WSPÓLNIE z kartą
  // zamówienia, która też zapisuje `ksef_numer` (services/ksef-doczytanie.js). Karta, która
  // zapisze numer i nic dalej nie zrobi, wycina fakturę z kolejki czuwacza NA ZAWSZE
  // (`ksef_numer IS NULL` w domena/ksef-oczekiwanie.js), a kupujący jej nie dostaje.
  const { wyslijDoAllegroJesliWolno } = createPoNumerzeKsef({ db, fakturaAllegro });

  async function jedenPrzebieg() {
    // Najpierw rozstrzygnięcie niepewnych wysyłek (może dać numer KSeF), dopiero potem odczyt numerów.
    // Awaria rozstrzygania nie zatrzymuje odczytu numerów.
    if (rozstrzyganie) {
      try {
        await rozstrzyganie.przebieg();
      } catch (e) {
        log('ksef: rozstrzyganie niepewnych wysyłek nie wyszło', String(e?.message ?? e));
      }
    }
    const podloga = new Date(Date.now() - PODLOGA_DNI * 24 * 60 * 60 * 1000).toISOString();
    // ⚠️ FILTR DZIALA WYLACZNIE NA GALAZ ALLEGROWA (`czyWierszWZakresieKsef`), a rozpoznanie
    // kanału zostaje w nim WSPÓLNYM predykatem — nigdy własna kopia `startsWith('allegro_')`.
    // Bezwarunkowy filtr po kanale Allegro wycinałby dokładnie te wiersze, które druga gałąź
    // dokłada: każdą fakturę sklepową.
    // ⚠️ TA SAMA PODLOGA WCHODZI DWA RAZY — raz na stempel wystawienia, raz na stempel zlecenia
    // wysylki (patrz komentarz przy `doSprawdzeniaSql`). Ma to byc DOKLADNIE ta sama wartosc:
    // dwie liczone osobno rozjechalyby sie o czas wykonania zapytania.
    const doSprawdzenia = db
      .prepare(doSprawdzeniaSql())
      .all(podloga, podloga, idModulu, limit)
      .filter(czyWierszWZakresieKsef);
    let znalezione = 0;
    let innyProgram = 0;

    for (const f of doSprawdzenia) {
      // Dokument innego programu niz modul faktur OMS-u — pomijamy, przebieg idzie dalej. Bez pytania
      // i bez zapisu: o numer KSeF tego dokumentu nie ma kogo zapytac.
      if (!czyDokumentProgramu(f, program)) {
        innyProgram += 1;
        continue;
      }
      // ⚠️ IZOLACJA NA FAKTURE, NIE NA PRZEBIEG. Jedna faktura skasowana w inFakcie oddaje 404
      // i bez tego `try` — postawionego wokol POJEDYNCZEJ faktury, a nie wokol calej petli —
      // zatrzymywalaby czuwacza dla wszystkich pozostalych: co godzine, na zawsze, a jedynym
      // sladem bylby `console.error` w kontenerze. Ta sama regula, co przy pollerach.
      try {
        const dok = idDokumentu(f);
        const dane = await program.pobierzFakture(dok);
        // TwojeFaktury oddaje `null` dla id, ktorego nie zna. To NIE jest 404 inFaktu („skasowany") — TF nie kasuje
        // dokumentow, wiec to niespojne id: odczyt „blad" z wpisem w historii, bez blokady „skasowana" na karcie,
        // ktora zwolnilaby zamowienie do ponownego wystawienia (druga faktura na te sama sprzedaz).
        if (dane == null) throw new Error('program faktur nie zna tego dokumentu');
        // `zlecona_z_panelu` to migawka sprzed pętli — panel mógł zlecić wysyłkę w trakcie
        // przebiegu, więc przed alarmem świeży odczyt rezerwacji z bazy.
        if (alarmAutoKsef && !f.zlecona_z_panelu && !wysylkaKsef(db, dok)) zglosSamowolnaWysylke(f, dok, dane);
        const numer = numerKsefDokumentu(dane);
        // Zapis tylko do wiersza, który dalej wskazuje pytany dokument — zamiana faktury mogła go
        // w trakcie pytania przepiąć na nową. Wtedy numer starej nie trafia nigdzie, a nowa poczeka na swój przebieg.
        const zapisano = zapiszNumerKsef(db, f.id, { ksefNumer: numer, sprawdzonaAt: teraz(), dokumentId: dok });
        if (numer && zapisano) {
          znalezione += 1;
          dopiszLog(db, f.zamowienie_id, { akcja: 'ksef', wynik: `dokument jest w KSeF (${numer})` });
          // ⚠️ DOPIERO TERAZ, PO ZAPISIE NUMERU. Bramka wysylki czyta `ksef_numer` z BAZY,
          // wiec wolanie przed `zapiszNumerKsef` odbijaloby sie od „faktura nie jest jeszcze
          // w KSeF" — czyli automat nie odpalilby sie NIGDY, i to bez ani jednego sladu.
          await wyslijDoAllegroJesliWolno(f.zamowienie_id);
        }
      } catch (e) {
        // ⚠️ FAKT „PYTALIŚMY" ZAPISUJEMY TAKŻE PO NIEUDANYM ODCZYCIE. Gdyby jedyny zapis siedział
        // wewnątrz `try`, faktura z wiecznym 404 miałaby `ksef_sprawdzona_at = NULL` NA ZAWSZE —
        // nie do odróżnienia od „nigdy nie pytaliśmy", czyli od zdechłego czuwacza.
        //
        // `ksef_odczyt` niesie drugą połowę: pytanie było, a co z niego wyszło.
        //
        // ⚠️ 404 TO NIE JEST „NIE WIEMY", TYLKO WIEDZA: program tego dokumentu NIE ZNA, bo ktoś
        // go tam skasował. Odczyt 'nieznana' zmienia TREŚĆ sprawy na karcie na wyjście, które
        // jest: odnotowanie skasowanej faktury w zakładce Faktury (domena/sprawy-karty.js).
        //
        // Status bierzemy z pola `status` błędu (klienci programów dokładają je do `bladOperatora`
        // z domena/bledy.js przy odmowie HTTP), a NIE z dopasowania „404" w tekście komunikatu —
        // treść komunikatu jest dla człowieka i wolno ją zmienić bez uprzedzenia.
        const odczyt = e?.status === 404 ? 'nieznana' : 'blad';
        // Wiersz przepięty w trakcie pytania na fakturę zastępczą: błąd dotyczy starej, nic nie piszemy.
        if (!zapiszNieudanyOdczytKsef(db, f.id, { sprawdzonaAt: teraz(), odczyt, dokumentId: idDokumentu(f) }))
          continue;
        // Log przy ZAMOWIENIU, nie tylko na konsoli: karta jest jedynym miejscem, w ktorym
        // czlowiek szuka historii tego dokumentu.
        //
        // ⚠️ DLAWIENIE POWTORZEN, bo ten blad UMIE SIE POWTARZAC W NIESKONCZONOSC: faktura
        // skasowana w inFakcie oddaje 404, a jej wiersz zostaje w zapytaniu NA ZAWSZE (numer
        // KSeF nigdy sie nie pojawi). Bez tego warunku karta dostawalaby 24 identyczne wpisy
        // na dobe i prawdziwa historia dokumentu utonelaby w nich w tydzien. Ta sama zasada,
        // co przy odczycie przesylek z Allegro: log rosnie od ZDARZEN, nie od PRZEBIEGOW.
        const wynik = `BŁĄD odczytu: ${e.message}`;
        if (ostatniWpisLogu(db, f.zamowienie_id, 'ksef')?.wynik !== wynik) {
          dopiszLog(db, f.zamowienie_id, { akcja: 'ksef', wynik });
        }
      }
    }

    if (innyProgram) {
      log(
        `czuwacz KSeF: pominięte dokumenty innego programu niż moduł faktur OMS-u: ${innyProgram} ` +
          '— o ich numer KSeF OMS nie pyta.',
      );
    }

    await zweryfikujPliki(podloga);

    return { sprawdzone: doSprawdzenia.length - innyProgram, znalezione };
  }

  /**
   * ⚠️ DRUGI KROK TEGO SAMEGO PRZEBIEGU, a nie drugi zegar — i to jest decyzja. Osobny zegar
   * znaczylby drugiego straznika „jeden przebieg naraz" i druga podloge do pilnowania, a obie
   * petle pytaja o TE SAMA fakture w dwoch kolejnych etapach jej zycia (najpierw numer KSeF,
   * potem los pliku u kupujacego). Cena jest policzona wyzej przy `najdluzszyPrzebiegMs(limity)`.
   *
   * ⚠️ PODLOGA WSPOLNA Z PIERWSZA PETLA — ta sama wartosc, ten sam moment obliczenia. Dwie
   * podlogi liczone osobno rozjechalyby sie o czas trwania pierwszej petli (do 50 minut).
   */
  async function zweryfikujPliki(podloga) {
    for (const f of db.prepare(DO_WERYFIKACJI).all(podloga, limitWeryfikacji)) {
      // ⚠️⚠️ BEZPIECZNIK PRZED STEMPLEM, i to jest cała jego mechanika.
      // Wiersz POMINIETY tutaj NIE dostaje `allegro_pytana_at`, wiec zostaje na czole kolejki
      // (`ORDER BY ... NULLS FIRST`) i sonda przy nastepnej dobie trafia w INNY wiersz niz
      // poprzednio. Zero bookkeepingu, rotacja zachowana.
      //
      // ⚠️ Przy otwartym bezpieczniku PIERWSZY wiersz przebiegu przestawia `ostatnia_proba_at`,
      // wiec kolejne wiersze TEGO SAMEGO przebiegu odpadaja juz tutaj. To jest cale ograniczenie
      // „jedno pytanie na kanal na dobe" — nie ma osobnego licznika do rozjechania.
      //
      // ⚠️ STAN CZYTANY W KAZDYM OBROCIE, nie raz przed petla: bez tego drugi wiersz widzialby
      // stan sprzed pytania pierwszego i przepuscil cala kolejke.
      const chwila = new Date(teraz());
      const stanKanalu = stanWeryfikacji(db, f.sklep);
      if (!wolnoPytac(stanKanalu, chwila)) continue;
      // ⚠️⚠️ ODNOTOWUJEMY ZAJĘCIE SIĘ WIERSZEM, ZANIM COKOLWIEK ZROBIMY,
      // a nie po udanym odczycie. Na tej dacie stoi porzadek zapytania wyzej, wiec wiersz,
      // ktory jej NIE dostanie, wraca na czolo kolejki przy KAZDYM przebiegu i glodzi wszystkie
      // za soba. Dotyczy to tak samo faktury z padajacym kanalem, jak i tej z kanalu, ktorego
      // panel juz nie zna — obie i tak zjadaja slot z `LIMIT`.
      zapiszPytanieOWeryfikacje(db, f.id, teraz());
      // Kanal, ktorego panel nie zna (klucz zniknal z konfiguracji, kanal jeszcze niepolaczony),
      // po prostu nie ma kogo zapytac. To NIE JEST blad tej faktury — reszta idzie dalej.
      const klient = klienciKanalow[f.sklep];
      if (!klient) continue;
      // ⚠️ IZOLACJA NA FAKTURE, NIE NA PRZEBIEG — ta sama regula, co w petli wyzej.
      try {
        const lista = await klient.pobierzFakturyZamowienia(f.zrodlo_id);
        // ⚠️⚠️ SYGNALEM DLA BEZPIECZNIKA JEST NIEPUSTA LISTA, a nie kod HTTP — i dlatego klient
        // zostaje nietkniety (`pobierzFakturyZamowienia` dalej ulaskawia 400 i oddaje `[]`).
        // Pytamy WYLACZNIE o faktury, ktore sami wyslalismy (`allegro_invoice_id IS NOT NULL`
        // jest czescia warunku kolejki), wiec dzialajacy zasob MUSI oddac co najmniej nasz wpis.
        //
        // ⚠️ RZUT NIE LICZY SIE JAKO PUSTKA — laduje w `catch` nizej i bezpiecznika NIE RUSZA.
        // Wyjatek znaczy blad INNY niz 400 (siec, 5xx), czyli nie dowodzi, ze zasob jest martwy;
        // liczenie go otwieraloby bezpiecznik z niewlasciwego powodu.
        zapiszStanWeryfikacji(db, f.sklep, poOdpowiedzi(stanKanalu, { pusta: lista.length === 0 }, chwila));
        // ⚠️ SZUKAMY NASZEGO WPISU PO IDENTYFIKATORZE ZGLOSZENIA. Allegro przyjmuje do 10 faktur
        // na zamowienie, wiec cudzy (albo starszy) wpis na tej liscie NIE MOWI NIC o naszym pliku.
        const nasza = lista.find((w) => w.id === f.allegro_invoice_id);
        // Dwa mozliwe ksztalty odpowiedzi — patrz `statusWeryfikacji` (domena/allegro-faktura.js).
        // Przy dzisiejszym 400 lista jest pusta, `status` wychodzi `null`, a zapis NIC NIE RUSZA.
        const status = statusWeryfikacji(nasza);
        // Zapis tylko do wiersza, który dalej niesie pytane zgłoszenie. Zamiana faktury mogła je w trakcie
        // wyzerować (stan D): status starego zgłoszenia nie ma wtedy żadnych skutków — ani zapisu, ani logu.
        if (!zapiszWeryfikacjeAllegro(db, f.id, status, f.allegro_invoice_id)) continue;
        // ⚠️ LOG ROSNIE OD ZDARZEN, NIE OD PRZEBIEGOW. `WAITING` co godzine to nie jest zdarzenie:
        // dopisywanie go daloby 24 identyczne wiersze na dobe i utopiloby prawdziwa historie
        // dokumentu w tydzien. Odnotowujemy WYLACZNIE rozstrzygniecie.
        if (status && status !== 'WAITING') {
          dopiszLog(db, f.zamowienie_id, { akcja: 'faktura-allegro', wynik: `weryfikacja Allegro: ${status}` });
        }
      } catch (e) {
        // ⚠️ DLAWIENIE POWTORZEN, tak samo jak przy odczycie z inFaktu wyzej: ten blad umie sie
        // powtarzac w nieskonczonosc (wiersz zostaje w zapytaniu az do podlogi), a karta jest
        // jedynym miejscem, w ktorym czlowiek szuka historii tego dokumentu.
        const wynik = `BŁĄD odczytu weryfikacji z Allegro: ${e.message}`;
        if (ostatniWpisLogu(db, f.zamowienie_id, 'faktura-allegro')?.wynik !== wynik) {
          dopiszLog(db, f.zamowienie_id, { akcja: 'faktura-allegro', wynik });
        }
      }
    }
  }

  return { przebieg };
}
