import {
  zapiszNumerKsef, zapiszNieudanyOdczytKsef, zapiszWeryfikacjeAllegro, zapiszPytanieOWeryfikacje,
} from '../db/faktury.js';
import { dopiszLog, ostatniWpisLogu, pobierzZamowienie } from '../../../oms/db/zamowienia.js';
// ⚠️ TA SAMA BRAMKA, CO PRZY PRZYCISKU NA KARCIE — nigdy wlasna kopia warunkow. Patrz
// `wyslijDoAllegroJesliWolno` nizej.
import { wolnoWyslacDoAllegro } from '../../../domena/allegro-faktura.js';
import { createPoNumerzeKsef } from './po-numerze-ksef.js';
import {
  warunekCzekaNaKsefSql, KOLUMNA_ZLECONA_Z_PANELU_SQL, czyWierszWZakresieKsef,
} from '../../../domena/ksef-oczekiwanie.js';
import {
  statusWeryfikacji, WARUNEK_WERYFIKACJA_NIEROZSTRZYGNIETA_SQL,
} from '../../../domena/allegro-faktura.js';
import { LIMIT_ZADANIA_MS as LIMIT_ZADANIA_INFAKTU_MS } from '../../../oms/infakt/client.js';
import { LIMIT_ZAPYTANIA_PRZESYLEK_MS } from '../../../oms/allegro/client.js';
import { wolnoPytac, poOdpowiedzi } from '../../../domena/bezpiecznik-weryfikacji.js';
import { stanWeryfikacji, zapiszStanWeryfikacji } from '../../../oms/db/stan-weryfikacji.js';

// ⚠️⚠️ TO NIE JEST `services/czuwacz-kosztow.js` — tamten pobiera z KSeF faktury, na ktorych
// jestesmy NABYWCA (zakladka KOSZTY). Ten pyta inFakt o numer KSeF naszej faktury SPRZEDAZOWEJ.
//
// Czuwacz KSeF. ⚠️⚠️ TEN PRZEBIEG NIE WYSYLA NICZEGO I NIGDY NIE BEDZIE — WYLACZNIE PYTA,
// czy dokument jest juz w KSeF, bo do Allegro ma pojsc faktura niosaca ten numer na sobie.
//
// Wystawienie faktury dalej NIGDY jej nie wysyla (`wystaw()` w infakt/client.js nie zna
// `send_to_ksef`). Od 06.08.2026 panel wysyla, ale WYLACZNIE ze swiadomego zatwierdzenia
// czlowieka na zakladce faktur (POST /faktury/ksef/wyslij → services/wysylka-ksef.js), nigdy
// z automatu. Wlasciciel wysyla takze sam, recznie w inFakcie — wiec czuwacz i tak nie ma
// prawa zakladac, KTO wyslal: pyta o fakt, a nie o wlasny slad.
//
// Chodzi CO GODZINE, CALA DOBE. Wlasciciel powiedzial, ze w nocy nie musi — ale okno godzinowe
// znaczyloby TRZECIE miejsce w kodzie liczace czas Warszawy, a ten projekt przejechal sie na
// strefach dwa razy (kursor `date_modified` i data proformy w UTC). Odpytujemy WYLACZNIE
// faktury czekajace na KSeF, wiec w typowa noc lista jest pusta i czuwacz nie robi nic.
const teraz = () => new Date().toISOString();

// ⚠️ WARUNEK POCHODZI ZE WSPOLNEJ DEFINICJI (domain/ksef-oczekiwanie.js) i to jest poprawka
// z recenzji Partii 2 (W4+W5). Tu stala jego wlasna kopia, a pasek spraw na karcie mial druga,
// SZERSZA — wiec panel meldowal blokade przy dokumencie, o ktory czuwacz nigdy nie zapytal
// (faktura bez numeru) i przy zamowieniu, ktorego nikt nie kupil (anulowane). Dwie kopie
// warunku rozjezdzaja sie przy pierwszej zmianie reguly; jest jedna, a test pilnuje zgodnosci
// obu jej postaci.
//
// ⚠️ TO JEST ZAWEZENIE ODCZYTU, A NIE ROZPOZNANIE KANALU. Rozpoznaje `czyWierszWZakresieKsef`
// nizej — a ono kanal rozstrzyga `czyKanalAllegro`, tak jak wymaga tego reszta panelu
// (domain/wysylka.js). SQL zawezajacy jest tu po to, zeby przebieg nie wciagal co godzine
// wszystkich faktur sklepowych, jakie kiedykolwiek powstaly: dokument, ktorego nikt do KSeF nie
// wyslal i ktory nie ma dokad pojechac, zostanie bez numeru NA ZAWSZE, wiec bez tego warunku
// lista rosla by w nieskonczonosc razem z archiwum.
//
// ⚠️⚠️ ZAKRES POSZERZONY 06.08.2026 O DRUGA GALAZ — dokumenty, ktorych wysylke do KSeF ZLECIL
// PANEL (wiersz w `wysylki_ksef`). Ruch przez to ROSNIE, wiec podloga i sufit nizej sa teraz
// WAZNIEJSZE, a nie mniej wazne. Przyrost jest jednak ograniczony z gory i to nie przypadkiem:
// wiersz wpada do zakresu wylacznie po SWIADOMEJ wysylce z panelu i wypada z niego, gdy tylko
// inFakt nada numer (~70 s po zleceniu) albo gdy minie podloga.

// ⚠️⚠️ PODLOGA — poprawka z recenzji Partii 2 (W1). Bez niej wiersz, ktory numeru KSeF NIGDY
// nie dostanie (pomylka, korekta, urlop, dokument skasowany w inFakcie), zostawal w zapytaniu
// NA ZAWSZE: 24 wywolania na dobe, 8760 rocznie, PER WIERSZ. Przy dwoch takich wierszach
// miesiecznie po roku daje to ~576 bezuzytecznych wywolan na dobe, po trzech latach ~1730 —
// czyli zapytanie rosnace liniowo i nigdy nie malejace.
//
// 30 DNI, bo po tym czasie rozstrzyga CZLOWIEK, nie czuwacz. Dokument, ktorego wlasciciel nie
// wyslal do KSeF przez miesiac, nie czeka juz na automat: albo zostal skasowany, albo wymaga
// korekty, albo o nim zapomniano — i wtedy woła o niego pasek spraw na karcie (ten NIE MA
// podlogi i swiecic nie przestaje, patrz domain/sprawy-karty.js). Krotszy prog gasilby pytania
// przy fakturach z normalnego urlopu; dluzszy nie zmienia juz nic poza kosztem.
//
// ⚠️⚠️ LICZONA OD ZDARZENIA WEJSCIOWEGO WLASCIWEJ GALEZI, A NIE ZAWSZE OD WYSTAWIENIA FAKTURY
// (poprawka z recenzji Zadania 11, K1). Do tej poprawki stalo tu golo `f.utworzona_at >= ?` —
// a dla galezi drugiej zdarzeniem wejsciowym jest WYSYLKA (`wysylki_ksef.zlecona_at`), nie
// wystawienie dokumentu. Zakladka „FAKTURY" jest MIESIECZNA, wiec wysylanie dokumentow
// z zeszlego miesiaca to zwykly tryb pracy wlasciciela: KAZDA faktura wystawiona dawniej niz
// 30 dni i wyslana z panelu DZIS wypadala z zapytania juz w chwili wysylki, a `ksef_numer`
// zostawal NULL-em na zawsze. I to PO CICHU: sprawa „czeka na KSeF" na karcie wymaga
// `ksef_odczyt = 'ok'`, a te kolumne pisze WYLACZNIE ten czuwacz.
//
// Ograniczenie z gory sie NIE ZMIENIA: dalej najwyzej 30 dni × 24 pytania NA DOKUMENT, tylko
// liczone od wlasciwego momentu.
//
// ⚠️ POROWNANIE TEKSTOWE dat ISO — takie same, jakiego uzywa kursor pollera. Dziala, bo obie
// strony sa w tym samym formacie i tej samej strefie (`new Date().toISOString()`).
export const PODLOGA_DNI = 30;

// ⚠️ SUFIT NA JEDEN PRZEBIEG. Petla jest SEKWENCYJNA, a limit pojedynczego zadania inFaktu
// to 60 s — bez tego jeden przebieg przy dluzszej awarii inFaktu przekraczalby godzine
// i wchodzil na kolejny. 50 x 60 s = 50 min, czyli caly najgorszy przypadek miesci
// sie w godzinie miedzy tyknieciami zegara. Realna lista jest jednocyfrowa (kilka faktur allegrowych
// na tydzien), wiec ten sufit widac wylacznie po awarii, gdy zaleglosc urosla — i wtedy tez
// nic nie przepada: reszte bierze nastepny przebieg.
export const LIMIT_PRZEBIEGU = 50;

// ⚠️⚠️ PODLOGA JEST TU, A NIE WE WSPOLNYM WARUNKU — i to jest decyzja, nie przeoczenie.
// `warunekCzekaNaKsefSql()` ma odpowiadac IDENTYCZNIE jak predykat `czekaNaKsef`
// (domain/ksef-oczekiwanie.js; pilnuje tego tests/oms/ksef-oczekiwanie.test.js), a pasek spraw
// na karcie podlogi MIEC NIE MOZE: sprawa ma swiecic takze wtedy, gdy czuwacz przestal pytac —
// to jest jedyne wyjscie z tego stanu (niezmiennik 4.9). Podloga jest wiec DLAWIENIEM ODCZYTU
// tego przebiegu, a nie czescia definicji „faktura czeka na KSeF", i dlatego nie ma jej
// odpowiednika w predykacie.
//
// ⚠️⚠️ DWA STEMPLE, BO DWIE GALEZIE MAJA DWA ROZNE ZDARZENIA WEJSCIOWE. Galaz allegrowa wchodzi
// przez WYSTAWIENIE dokumentu (`f.utworzona_at`), galaz „panel zlecil wysylke" — przez samo
// ZLECENIE (`wysylki_ksef.zlecona_at`). Uzasadnienie i awaria, ktora to naprawia, stoja przy
// `PODLOGA_DNI` wyzej. `OR`, a nie `CASE`: wiersz moze nalezec do obu galezi naraz i wtedy
// wystarczy, ze MLODSZY z dwoch stempli miesci sie w podlodze.
//
// ⚠️⚠️ PORZADEK PO DACIE OSTATNIEGO PYTANIA, A NIE PO DACIE WYSTAWIENIA — dokladnie ta sama
// poprawka, ktora dostala juz druga petla (recenzja Partii 3, W6), i z tego samego powodu.
// `ORDER BY f.utworzona_at` zakladalo, ze wiersz OBSLUZONY WYPADA ze zbioru; wiersz, ktory
// numeru NIE DOSTANIE (organ odrzucil, dokument skasowany), nie wypada az do podlogi. Zakladka
// faktur wysyla HURTOWO, wiec jedna partia >= `LIMIT_PRZEBIEGU` takich dokumentow zajmowalaby
// KAZDY slot przez 30 dni, a faktura wyslana pozniej nie zostalaby zapytana ANI RAZU.
//
// `ksef_sprawdzona_at` nadaje sie na to kryterium, bo pisza je OBIE sciezki — i udany odczyt,
// i nieudany (db/faktury.js). `NULLS FIRST` (w SQLite to zarazem domyslna kolejnosc rosnaca)
// znaczy „jeszcze nie pytalismy = na poczatek". Data wystawienia zostaje kryterium POMOCNICZYM
// i rozstrzyga remisy, wiec na pierwszym przebiegu kolejnosc jest dokladnie ta, co dawniej:
// od najstarszej, czyli od tej, o ktora upomina sie pasek spraw. Kolejka jest CYKLICZNA.
// PRZ-101.08: funkcja, bo warunek zna klucze Allegro z konfiguracji dopiero po budowie aplikacji.
const doSprawdzeniaSql = () => `
  SELECT f.id, f.infakt_uuid, f.zamowienie_id, z.sklep, ${KOLUMNA_ZLECONA_Z_PANELU_SQL}
  FROM faktury f
  JOIN zamowienia z ON z.id = f.zamowienie_id
  WHERE ${warunekCzekaNaKsefSql()}
    AND (
      f.utworzona_at >= ?
      OR EXISTS (SELECT 1 FROM wysylki_ksef w WHERE w.uuid = f.infakt_uuid AND w.zlecona_at >= ?)
    )
  ORDER BY f.ksef_sprawdzona_at NULLS FIRST, f.utworzona_at
  LIMIT ?
`;

// ⚠️⚠️ DRUGI KROK PRZEBIEGU: WYSLANIE PLIKU DO ALLEGRO NIE JEST KONCEM OPERACJI (Zadanie 10).
// Allegro sprawdza plik antywirusem — WAITING → ACCEPTED albo REJECTED — a REJECTED znaczy,
// ze kupujacy faktury NIE MA, choc kolumna `allegro_wyslana_at` jest wypelniona i panel bez
// tego kroku twierdzilby, ze ma.
//
// ⚠️ TO JEST DZIS PROBA, A NIE PEWNE ZRODLO — i to jest ZMIERZONE (notatka 2026-08-05, §2):
// `GET .../invoices` oddaje 400 na kazde nasze zamowienie, wiec klient zwraca PUSTA LISTE,
// `statusWeryfikacji` daje `null`, a `zapiszWeryfikacjeAllegro` NIC NIE PISZE i przebieg idzie
// dalej. Pierwszym zrodlem prawdy jest odpowiedz na `PUT .../file` (services/faktura-allegro.js).
// Gdy zasob zacznie odpowiadac, ten krok ozyje SAM, bez zmiany w kodzie.
//
// ⚠️ ZAKRES ZE WSPOLNEJ DEFINICJI (domain/allegro-faktura.js), tak samo jak warunek KSeF wyzej.
// ACCEPTED i REJECTED sa KONCOWE — pytanie o nie to setki wywolan miesiecznie bez ani jednej
// nowej informacji.
//
// ⚠️⚠️ PODLOGA I SUFIT, DOKLADNIE Z TEGO SAMEGO POWODU, CO W PIERWSZEJ PETLI (recenzja Partii 2,
// W1) — i tutaj stawka jest WYZSZA, bo zasob oddaje dzis 400, wiec KAZDA wyslana faktura zostaje
// w stanie WAITING NA ZAWSZE. Bez podlogi zapytanie rosloby liniowo razem z archiwum wysylek
// i nigdy nie malalo: 24 wywolania na dobe per wiersz, w nieskonczonosc. Po podlodze rozstrzyga
// CZLOWIEK — pasek spraw na karcie melduje niepotwierdzony plik juz po dobie i nie przestaje
// (domain/sprawy-karty.js), wiec z tego stanu jest wyjscie takze wtedy, gdy czuwacz przestal pytac.
//
// ⚠️⚠️ PORZADEK PO DACIE OSTATNIEGO PYTANIA, A NIE PO DACIE WYSLANIA (recenzja Partii 3, W6).
//
// Do 06.08.2026 stalo tu `ORDER BY f.allegro_wyslana_at` — i zakladalo, ze wiersz OBSLUZONY
// WYPADA ze zbioru. DZIS NIE WYPADA: `GET .../invoices` oddaje 400 (notatka 2026-08-05, §2),
// wiec `zapiszWeryfikacjeAllegro` nic nie pisze, status zostaje `WAITING`, a wiersz siedzi
// w zapytaniu az do podlogi — 30 dni. Przy WIECEJ NIZ 50 wyslanych fakturach czuwacz pytal
// w kolko o TE SAME najstarsze 50, a nowsze NIE BYLY PYTANE ANI RAZU: faktura wyslana dzis
// czekalaby na rozstrzygniecie do konca podlogi, po czym wypadlaby nie zapytana ani raz.
//
// `NULLS FIRST` (w SQLite to zarazem domyslna kolejnosc rosnaca) znaczy „jeszcze nie pytalismy
// = na poczatek". Data wyslania zostaje kryterium POMOCNICZYM i rozstrzyga remisy — dzieki
// temu na pierwszym przebiegu, gdy wszystkie kolumny sa puste, kolejnosc jest dokladnie ta,
// co dawniej: od najdawniej wyslanej, czyli od tej, o ktora upomina sie pasek spraw.
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

// ⚠️⚠️ SUFIT DRUGIEJ PETLI I JEDEN WSPOLNY BUDZET CZASU. Obie petle sa SEKWENCYJNE i chodza
// W JEDNYM PRZEBIEGU, a straznik „jeden przebieg naraz" (nizej) znaczy, ze przebieg dluzszy niz
// odstep zegara PO PROSTU GUBI tykniecia — czuwacz zamiast co godzine chodzilby co dwie.
// Najgorszy przypadek liczymy wiec dla CALEGO przebiegu, nie dla pojedynczej petli:
//
//   50 faktur × 60 s (limit zadania inFaktu) + 50 faktur × 5 s (limit odczytu z Allegro)
//   = 50 min + 4 min 10 s = 54 min 10 s < 60 min
//
// Ta arytmetyka NIE JEST komentarzem: `NAJDLUZSZY_PRZEBIEG_MS` liczy ja z prawdziwych stalych
// obu klientow, a bootstrap.js odmawia startu panelu, gdy wynik nie miesci sie miedzy tyknieciami
// zegara. Podniesienie ktoregokolwiek limitu bez policzenia skutku ma polozyc panel przy starcie,
// a nie po cichu rozjechac zegar czuwacza na produkcji.
export const LIMIT_WERYFIKACJI = 50;

// ⚠️ Krok „lustro luk KSeF" (2026-08-29) mieszkał tu JEDEN DZIEŃ jako trzeci krok
// przebiegu i wyprowadził się do services/czuwacz-ostrzezen.js razem z lustrem terminów
// płatności — suma najgorszych przypadków przestała mieścić się między tyknięciami
// (54:10 + luki 5:00 + terminy 11:00 > 60:00). Uzasadnienie w nagłówku tamtego pliku.
export const NAJDLUZSZY_PRZEBIEG_MS = LIMIT_PRZEBIEGU * LIMIT_ZADANIA_INFAKTU_MS
  + LIMIT_WERYFIKACJI * LIMIT_ZAPYTANIA_PRZESYLEK_MS;

/**
 * ⚠️ ZAKRES: faktury majace numer dokumentu i nie majace jeszcze numeru KSeF, przy zamowieniu,
 * o ktorego fakture kupujacy poprosil (`chce_fakture = 1`) — i to w DWOCH rozlacznych sytuacjach
 * (domain/ksef-oczekiwanie.js):
 *
 *  1. zamowienie z KANALU Allegro — dokument ma DOKAD pojechac, gdy numer sie pojawi;
 *  2. dokument, ktorego wysylke do KSeF ZLECIL PANEL (wiersz w `wysylki_ksef`) — numer trzeba
 *     dociagnac takze dla faktury sklepowej, bo inaczej zakladka „FAKTURY" pokazuje „brak KSeF"
 *     przy dokumencie, ktory wlasnie stamtad wyszedl, i pokazuje to juz zawsze.
 *
 * Faktura sklepowa, ktorej panel nie wysylal, dalej NIE JEST pytana: numeru w bazie nie dostanie
 * nigdy, wiec pytanie o nia to setki wywolan miesiecznie bez ani jednej nowej informacji.
 */
export function createCzuwaczKsef({
  db, infakt, klienciKanalow = {}, limit = LIMIT_PRZEBIEGU, limitWeryfikacji = LIMIT_WERYFIKACJI,
  // ⚠️ PARTIA 4: AUTOMAT WYSYLKI FAKTURY DO KUPUJACEGO (07.08.2026, prosba wlasciciela po
  // pierwszej recznej wysylce: „trzeba to rzeczywiscie wrzucic na automat"). Domyslnie BRAK —
  // panel bez kanalu Allegro (albo bez inFaktu) zachowuje sie DOKLADNIE jak dotad.
  fakturaAllegro = null,
}) {
  // ⚠️⚠️ JEDEN PRZEBIEG NARAZ — ten sam strażnik, co w pollerze (services/poller.js), i z tego
  // samego powodu. `setInterval` tyka co godzine niezaleznie od tego, czy poprzedni przebieg
  // sie skonczyl. Limit pojedynczego zadania inFaktu to 60 s, a petla nizej jest SEKWENCYJNA,
  // wiec przy dluzszej awarii inFaktu przebieg przekracza godzine — i bez tej blokady zaczyna
  // sie PIETRZENIE: po dobie 24 rownolegle petle walace w padajace API. `.catch` przy zegarze
  // tego nie zatrzyma, bo przebieg wcale nie odrzuca.
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
   * numer KSeF. Docelowy przeplyw z Planu B: „wieczorem wysylasz faktury do KSeF w inFakcie,
   * panel to zauwaza i SAM przesyla PDF do Allegro, z numerem KSeF na dokumencie".
   *
   * ⚠️⚠️ TO JEST NAJBARDZIEJ NIEODWRACALNA OPERACJA W CALYM PANELU WYKONYWANA BEZ CZLOWIEKA.
   * Dokument laduje na koncie kupujacego i panel nie ma czym go stamtad zabrac; skasowanie
   * faktury w inFakcie NIE zabiera jej kupujacemu z rak. Dlatego:
   *
   *  - automat NIE MA WLASNEJ BRAMKI. Pyta DOKLADNIE te sama funkcje, co przycisk na karcie
   *    (`wolnoWyslacDoAllegro` w domain/allegro-faktura.js) i idzie DOKLADNIE ta sama usluga
   *    (services/faktura-allegro.js). Druga, luzniejsza regula po stronie czuwacza bylaby
   *    dziura, ktorej nikt by nie zobaczyl — bo przycisk dalej zachowywalby sie poprawnie;
   *  - `bezKsef` NIE JEST tu przekazywane i przekazywane byc nie ma. Furtka „wyslij bez numeru
   *    KSeF" zostaje WYLACZNIE reczna: automat uzywajacy jej odbieralby wlascicielowi decyzje,
   *    ktorej nie da sie cofnac;
   *  - ochrona przed duplikatem stoi tam, gdzie stala: `zajmijWysylkeDoAllegro` zaklada zamek
   *    w bazie PRZED pierwszym bajtem do sieci. Automat nie oslabia jej ani nie powiela.
   *
   * ⚠️ NIGDY NIE RZUCA. Awaria wysylki nie ma prawa zatrzymac czuwacza — ani dla tej faktury,
   * ani dla pozostalych. Numer KSeF jest juz zapisany i jest to fakt NIEZALEZNY od losu pliku:
   * dokument jest u organu bez wzgledu na to, czy kupujacy dostal PDF.
   */
  // ⚠️ NASTEPSTWO ZAPISU NUMERU MIESZKA W services/po-numerze-ksef.js — WSPOLNIE z karta
  // zamowienia, ktora tez zapisuje `ksef_numer` (services/ksef-doczytanie.js). Do 14.08.2026
  // ta funkcja stala TUTAJ i byla jedynym miejscem, ktore po znalezieniu numeru wysylalo
  // fakture kupujacemu — a karta zapisywala numer, nie robiac nic dalej, i wycinala fakture
  // z kolejki czuwacza NA ZAWSZE (`ksef_numer IS NULL` w domain/ksef-oczekiwanie.js).
  const { wyslijDoAllegroJesliWolno } = createPoNumerzeKsef({ db, fakturaAllegro });

  async function jedenPrzebieg() {
    const podloga = new Date(Date.now() - PODLOGA_DNI * 24 * 60 * 60 * 1000).toISOString();
    // ⚠️ FILTR DZIALA WYLACZNIE NA GALAZ ALLEGROWA (`czyWierszWZakresieKsef`), a rozpoznanie
    // kanalu zostaje w nim WSPOLNYM predykatem — nigdy wlasna kopia `startsWith('allegro_')`.
    // Bezwarunkowy `.filter(czyKanalAllegro)` stal tu do 06.08.2026 i po poszerzeniu zakresu
    // wycinalby dokladnie te wiersze, ktore druga galaz doklada: kazda fakture sklepowa.
    // ⚠️ TA SAMA PODLOGA WCHODZI DWA RAZY — raz na stempel wystawienia, raz na stempel zlecenia
    // wysylki (patrz komentarz przy `doSprawdzeniaSql`). Ma to byc DOKLADNIE ta sama wartosc:
    // dwie liczone osobno rozjechalyby sie o czas wykonania zapytania.
    const doSprawdzenia = db.prepare(doSprawdzeniaSql())
      .all(podloga, podloga, limit)
      .filter(czyWierszWZakresieKsef);
    let znalezione = 0;

    for (const f of doSprawdzenia) {
      // ⚠️ IZOLACJA NA FAKTURE, NIE NA PRZEBIEG. Jedna faktura skasowana w inFakcie oddaje 404
      // i bez tego `try` — postawionego wokol POJEDYNCZEJ faktury, a nie wokol calej petli —
      // zatrzymywalaby czuwacza dla wszystkich pozostalych: co godzine, na zawsze, a jedynym
      // sladem bylby `console.error` w kontenerze. Ta sama regula, co przy pollerach.
      try {
        const dane = await infakt.pobierzFakture(f.infakt_uuid);
        zapiszNumerKsef(db, f.id, { ksefNumer: dane.ksefNumer, sprawdzonaAt: teraz() });
        if (dane.ksefNumer) {
          znalezione += 1;
          dopiszLog(db, f.zamowienie_id, { akcja: 'ksef', wynik: `dokument jest w KSeF (${dane.ksefNumer})` });
          // ⚠️ DOPIERO TERAZ, PO ZAPISIE NUMERU. Bramka wysylki czyta `ksef_numer` z BAZY,
          // wiec wolanie przed `zapiszNumerKsef` odbijaloby sie od „faktura nie jest jeszcze
          // w KSeF" — czyli automat nie odpalilby sie NIGDY, i to bez ani jednego sladu.
          await wyslijDoAllegroJesliWolno(f.zamowienie_id);
        }
      } catch (e) {
        // ⚠️ FAKT „PYTALISMY" ZAPISUJEMY TAKZE PO NIEUDANYM ODCZYCIE, i to jest poprawka
        // z recenzji Partii 2 (W6). Dopoki jedyny zapis siedzial wewnatrz `try`, faktura
        // z wiecznym 404 miala `ksef_sprawdzona_at = NULL` NA ZAWSZE — nie do odroznienia od
        // „nigdy nie pytalismy", czyli od zdechlego czuwacza.
        //
        // `ksef_odczyt` niesie druga polowe: pytanie bylo, a co z niego wyszlo.
        //
        // ⚠️ 404 TO NIE JEST „NIE WIEMY", TYLKO WIEDZA (recenzja Partii 2, K4): inFakt tego
        // dokumentu NIE ZNA, bo ktos go tam skasowal. Do tej pory ta wiedza ladowala wylacznie
        // w logu, a sprawa na karcie dalej wskazywala wyjscie, ktorego w panelu nie ma. Teraz
        // zmienia TRESC sprawy na wyjscie, ktore jest: „Skasowalem te fakture w inFakcie".
        //
        // Status bierzemy z pola `status` bledu (domain/bledy.js: `bladOperatora` niesie je
        // przy kazdej odmowie HTTP), a NIE z dopasowania „404" w tekscie komunikatu — tresc
        // komunikatu jest dla czlowieka i wolno ja zmienic bez uprzedzenia.
        const odczyt = e?.status === 404 ? 'nieznana' : 'blad';
        zapiszNieudanyOdczytKsef(db, f.id, { sprawdzonaAt: teraz(), odczyt });
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

    await zweryfikujPliki(podloga);

    return { sprawdzone: doSprawdzenia.length, znalezione };
  }

  /**
   * ⚠️ DRUGI KROK TEGO SAMEGO PRZEBIEGU, a nie drugi zegar — i to jest decyzja. Osobny zegar
   * znaczylby drugiego straznika „jeden przebieg naraz" i druga podloge do pilnowania, a obie
   * petle pytaja o TE SAMA fakture w dwoch kolejnych etapach jej zycia (najpierw numer KSeF,
   * potem los pliku u kupujacego). Cena jest policzona wyzej przy `NAJDLUZSZY_PRZEBIEG_MS`.
   *
   * ⚠️ PODLOGA WSPOLNA Z PIERWSZA PETLA — ta sama wartosc, ten sam moment obliczenia. Dwie
   * podlogi liczone osobno rozjechalyby sie o czas trwania pierwszej petli (do 50 minut).
   */
  async function zweryfikujPliki(podloga) {
    for (const f of db.prepare(DO_WERYFIKACJI).all(podloga, limitWeryfikacji)) {
      // ⚠️⚠️ BEZPIECZNIK PRZED STEMPLEM, i to jest cala jego mechanika (spec 2026-08-28).
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
      // ⚠️⚠️ ODNOTOWUJEMY ZAJECIE SIE WIERSZEM ZANIM COKOLWIEK ZROBIMY (recenzja Partii 3, W6),
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
        // Dwa mozliwe ksztalty odpowiedzi — patrz `statusWeryfikacji` (domain/allegro-faktura.js).
        // Przy dzisiejszym 400 lista jest pusta, `status` wychodzi `null`, a zapis NIC NIE RUSZA.
        const status = statusWeryfikacji(nasza);
        zapiszWeryfikacjeAllegro(db, f.id, status);
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
