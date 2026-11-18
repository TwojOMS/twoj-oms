import { stanFaktury } from './faktura-stan.js';
import { umiejetnosciZamowienia, kanalyAllegro } from './moduly-kanalow.ts';
import { anulowaneEfektywnie } from './status-reczny.js';
import { idDokumentu, idDokumentuSql } from './dokument-programu.js';

// JEDNA definicja „faktury czekającej na KSeF" — dla czuwacza (moduly/faktury/services/czuwacz-ksef.js)
// i dla paska spraw na karcie (domena/sprawy-karty.js).
//
// ⚠️ POWSTAŁA Z ROZJAZDU, KTÓRY JUŻ SIĘ WYDARZYŁ. Czuwacz pytał
// wyłącznie o faktury z numerem dokumentu i UUID-em; pasek zapalał blokadę przy każdej
// fakturze „wystawionej" — czyli TAKŻE przy wierszu bez numeru (inFakt potrafi oddać sukces
// bez pola `number`; widok ma na to osobny przypadek). O taki wiersz czuwacz nie zapyta
// NIGDY, a pasek po dobie meldował „Faktura  czeka na KSeF od …" — z pustym numerem, na
// zawsze. Osobno: zamówienie anulowane po wystawieniu faktury dostawało dwie blokady, w tym
// jedną nieprawdziwą („kupujący jej jeszcze nie ma", choć nic nie kupił).
//
// Dwie kopie warunku rozjeżdżają się przy pierwszej zmianie reguły, więc tu jest jedna —
// w dwóch postaciach (SQL i predykat), a test tests/moduly/faktury/ksef-oczekiwanie.test.js pilnuje,
// że dają IDENTYCZNĄ odpowiedź na całym zestawie granicznych przypadków.

/**
 * Część WSPÓLNA obu gałęzi: dokument istnieje, numeru KSeF nie ma, a zamówienie żyje.
 * Aliasy: `f` = faktury, `z` = zamowienia.
 *
 * ⚠️ ŻĄDANIA FAKTURY (`z.chce_fakture = 1`) TU NIE MA — siedzi wyłącznie w gałęzi
 * Allegro (`warunekCzekaNaKsefSql`). Panel może wystawić fakturę do zamówienia, przy którym klient
 * o nią nie prosił („faktura do każdego zamówienia"), a dokument wysłany przez panel do KSeF musi
 * dostać numer bez względu na żądanie — inaczej zakładka „FAKTURY" pokazuje „brak KSeF" na zawsze.
 *
 * ⚠️ `IS NOT` zamiast `<>`: `<>` na NULL-u daje NULL (czyli fałsz), więc odrzucałoby każdą
 * fakturę z pustym `ksef_status` — a to jest właśnie stan normalnej, wystawionej faktury.
 */
const WSPOLNE_SQL = `
  f.ksef_numer IS NULL
  AND ${idDokumentuSql('f')} IS NOT NULL
  AND f.numer IS NOT NULL              -- rezerwacja bez numeru to jeszcze nie dokument
  AND f.allegro_wyslana_at IS NULL     -- wysłana bez numeru KSeF: kupujący fakturę MA
  AND f.ksef_status IS NOT 'w_toku'
  AND f.ksef_status IS NOT 'do_wyjasnienia'
  AND COALESCE(z.anulowane, 0) = 0
  AND COALESCE(z.anulowane_recznie, 0) = 0
`;

/**
 * GAŁĄŹ 1 (od zawsze): kanał Allegro — dokument ma DOKĄD pojechać, gdy numer się pojawi.
 *
 * ⚠️ TO JEST ZAWĘŻENIE ODCZYTU, A NIE ROZPOZNANIE KANAŁU. `LIKE` w SQLite jest dla ASCII
 * NIEWRAŻLIWE NA WIELKOŚĆ LITER, a `czyKanalAllegro` — wrażliwe, więc sędzią jest predykat
 * niżej, a wynik zapytania trzeba przefiltrować `czyWierszWZakresieKsef` (tak robi czuwacz).
 *
 * ⚠️ `ESCAPE` JEST OBOWIĄZKOWY. Podkreślnik w `LIKE` jest znakiem wieloznacznym, więc bez
 * niego wzorzec `allegro_%` przestaje być PREFIKSEM, a staje się WZORCEM — i łapie także
 * sklep o kluczu `allegrowy` (zmierzone w node:sqlite).
 */
const GALAZ_PREFIKSU_ALLEGRO_SQL = `z.sklep LIKE 'allegro\\_%' ESCAPE '\\'`;
// Druga galaz predykatu `czyKanalAllegro` — klucze kanalow `typ: 'allegro'` z konfiguracji.
// Klucz przeszedl WZOR_KLUCZA (`[a-z0-9_-]`), apostrof podwajamy mimo to. Pusty zbior = SQL sprzed zmiany.
// `IN` porownuje dokladnie (wielkosc liter), wiec filtr na wyniku zostaje tylko dla `LIKE`. Klucze z prefiksem
// lapie juz `LIKE`, wiec do `IN` ida tylko pozostale — instalacja z samymi `allegro_*` ma SQL sprzed zmiany.
const literal = (s) => `'${String(s).replaceAll("'", "''")}'`;
function galazAllegroSql(klucze) {
  const bezPrefiksu = klucze.filter((k) => !String(k).startsWith('allegro_'));
  return bezPrefiksu.length
    ? `(${GALAZ_PREFIKSU_ALLEGRO_SQL} OR z.sklep IN (${bezPrefiksu.map(literal).join(', ')}))`
    : GALAZ_PREFIKSU_ALLEGRO_SQL;
}

/**
 * ⚠️⚠️ GAŁĄŹ 2: DOKUMENT, KTÓREGO WYSYŁKĘ DO KSeF ZLECIŁ PANEL. Sama gałąź Allegro
 * wystarcza tylko tam, gdzie numer ma komu służyć; faktura sklepowa nie ma DOKĄD pojechać,
 * więc pytanie o jej `ksef_numer` bez powodu byłoby setkami wywołań miesięcznie bez odbiorcy.
 * Zakładka „FAKTURY” daje taki powód:
 * panel sam wysyła dokumenty do KSeF (ze świadomego zatwierdzenia człowieka,
 * moduly/faktury/services/wysylka-ksef.js), więc bez tej gałęzi zakładka pokazywałaby „brak KSeF" przy
 * dokumencie, który właśnie stamtąd wyszedł — i pokazywałaby to już zawsze.
 *
 * ⚠️⚠️ ROZPOZNAJEMY TO PO WIERSZU W `wysylki_ksef`, A NIE PO TREŚCI WPISU W LOGU. Wiersz jest
 * FAKTEM zapisanym PRZED wywołaniem (rezerwacja, moduly/faktury/db/wysylki-ksef.js), kluczem jest `uuid`
 * dokumentu w inFakcie — dokładnie to, co trzyma `faktury.infakt_uuid`. Zdanie w logu jest
 * tekstem DLA CZŁOWIEKA: wolno je przeredagować bez uprzedzenia, a `LIKE` po nim zawęziłby
 * wtedy zakres czuwacza do zera — bez błędu i bez śladu.
 *
 * ⚠️ Gałąź NIE PYTA O KANAŁ i to jest celowe: fakt wysyłki z panelu wystarcza sam — dokument
 * sklepowy potrzebuje numeru dokładnie tak samo jak allegrowy, choć nikt na niego u kupującego
 * nie czeka.
 *
 * ⚠️⚠️ ZNANA LUKA: FAKTURA OKRESU (dokument zbiorczy klienta dropshippingowego) TĄ GAŁĘZIĄ NIE
 * WCHODZI, choć panel naprawdę ją do KSeF wysyła. Warunek żyje w zapytaniu
 * `FROM faktury f JOIN zamowienia z`, a dokument okresu nie ma ANI
 * wiersza w `faktury`, ANI zamówienia: leży w `okresy_rozliczeniowe` (oms/db/okresy.js), która nie
 * ma nawet kolumny `ksef_numer` — więc nie ma dokąd zapisać odpowiedzi. Skutek: numer KSeF dla
 * faktury okresu widać wyłącznie na zakładce „FAKTURY", prosto z inFaktu (moduly/faktury/services/faktury-widok.js),
 * i panel go u siebie NIE MA. Domknięcie tego wymaga osobnego zadania (kolumna na okresie
 * i druga ścieżka odczytu w czuwaczu) — NIE DA SIĘ tego załatwić poszerzeniem warunku tutaj.
 */
const GALAZ_ZLECONA_Z_PANELU_SQL = `EXISTS (SELECT 1 FROM wysylki_ksef w WHERE w.uuid = ${idDokumentuSql('f')})`;

/**
 * Warunek do klauzuli WHERE — część wspólna ORAZ jedna z dwóch gałęzi:
 * `(kanał Allegro AND chce_fakture = 1) OR zlecona przez panel`.
 *
 * ⚠️ ŻĄDANIE FAKTURY TYLKO W GAŁĘZI ALLEGRO: tam numer służy do wysyłki faktury na Allegro, a ta
 * idzie wyłącznie na żądanie kupującego (domena/allegro-faktura.js, `wolnoWyslacDoAllegro`).
 * Gałąź panelu o żądanie nie pyta — dokument, który panel wysłał do KSeF, zawsze ma dostać numer.
 * Allegro bez żądania, ale zlecone przez panel, wchodzi gałęzią panelu i dostaje numer; na Allegro
 * i tak nie pojedzie, bo zatrzymuje je `wolnoWyslacDoAllegro`. Predykat `czekaNaKsef` — identycznie.
 *
 * ⚠️ FUNKCJA, NIE STAŁA: klucze Allegro z konfiguracji znane są dopiero po budowie
 * aplikacji, a stała liczyłaby się przy imporcie modułu — z pustym zbiorem.
 */
export function warunekCzekaNaKsefSql(klucze = kanalyAllegro()) {
  return `
  ${WSPOLNE_SQL}
  AND ((${galazAllegroSql(klucze)} AND z.chce_fakture = 1) OR ${GALAZ_ZLECONA_Z_PANELU_SQL})
`;
}

/**
 * Kolumna do listy SELECT-a: czy ten wiersz wszedł GAŁĘZIĄ „panel zlecił wysyłkę".
 *
 * ⚠️ MUSI BYĆ W KAŻDYM ZAPYTANIU UŻYWAJĄCYM WARUNKU WYŻEJ, bo bez niej `czyWierszWZakresieKsef`
 * nie odróżni gałęzi i wyrzuci z wyniku dokładnie te wiersze, które gałąź druga dokłada.
 */
export const KOLUMNA_ZLECONA_Z_PANELU_SQL = `${GALAZ_ZLECONA_Z_PANELU_SQL} AS zlecona_z_panelu`;

/**
 * Filtr NA WYNIKU zapytania — druga połowa gałęzi allegrowej, której SQL nie umie wyrazić.
 *
 * ⚠️ FILTR DOTYCZY WYŁĄCZNIE GAŁĘZI ALLEGROWEJ. `LIKE` jest dla ASCII niewrażliwe na wielkość
 * liter, więc sklep `ALLEGRO_A` wchodzi do zapytania, choć `czyKanalAllegro` mówi „nie" —
 * i ma z wyniku wypaść. Ale wiersz, który wszedł DRUGĄ gałęzią (panel zlecił jego wysyłkę),
 * o kanał nie pyta wcale: gdyby filtr działał bezwarunkowo, wycinałby każdą fakturę sklepową,
 * czyli dokładnie to, po co ta gałąź powstała.
 */
export function czyWierszWZakresieKsef(wiersz) {
  return umiejetnosciZamowienia(wiersz).plikFaktury || Boolean(wiersz?.zlecona_z_panelu);
}

/**
 * Czy faktura tego zamówienia czeka na numer KSeF. Ten sam warunek, co SQL wyżej.
 *
 * NIGDY nie rzuca dla dziwnych danych — wołają to i pasek spraw (który nie ma prawa zabrać
 * karty), i przebieg czuwacza.
 *
 * ⚠️ Anulowanie liczymy `anulowaneEfektywnie` (suma logiczna kolumny sklepowej i ręcznej),
 * a nie samym `z.anulowane` — inaczej ręczne anulowanie w panelu nie wypadałoby stąd wcale.
 * `chce_fakture` czytamy WPROST z kolumny, dokładnie tak jak SQL wyżej.
 *
 * ⚠️ DWIE GAŁĘZIE, TAK SAMO JAK W SQL-u WYŻEJ. „Panel zlecił wysyłkę do KSeF" przychodzi tu
 * jako `faktura.ksef_zlecona_at` — kolumna `zlecona_at` z `wysylki_ksef`, dokładana przy
 * odczycie zamówienia (oms/db/zamowienia.js), tak samo jak `chce_fakture` przychodzi ze swojej.
 * Obiekt bez tego pola (fikstura, wywołanie z widoku) zachowuje się jak przed zmianą: znaczy
 * „panel tego dokumentu nie wysyłał".
 *
 * ⚠️ `chce_fakture` należy WYŁĄCZNIE do gałęzi Allegro — tak samo jak w SQL-u wyżej.
 * Gałąź „panel zlecił wysyłkę" nie pyta o żądanie faktury.
 */
export function czekaNaKsef(zamowienie) {
  const f = zamowienie?.faktura;
  if (!f) return false;
  return (
    stanFaktury(f) === 'wystawiona' &&
    Boolean(f.numer) &&
    Boolean(idDokumentu(f)) &&
    !f.ksef_numer &&
    !f.allegro_wyslana_at &&
    !anulowaneEfektywnie(zamowienie) &&
    ((umiejetnosciZamowienia(zamowienie).plikFaktury && Boolean(zamowienie.chce_fakture)) || Boolean(f.ksef_zlecona_at))
  );
}

/**
 * Doba, bo dokumenty wysyła się do KSeF w ciągu dnia pracy: 24 h mijają dopiero wtedy,
 * gdy coś NAPRAWDĘ stanęło. Próg stoi tutaj, obok definicji, a nie w `domena/sprawy-karty.js`:
 * dwie kopie liczby rozjechałyby się tak samo, jak rozjechały się dwie kopie warunku
 * (nagłówek pliku).
 */
export const PROG_CZEKANIA_NA_KSEF_MS = 24 * 60 * 60 * 1000;

/**
 * Czy faktura czeka na numer KSeF DŁUŻEJ NIŻ DOBĘ. Ten sam zakres, co `czekaNaKsef`,
 * plus upływ czasu liczony od ZDARZENIA WEJŚCIOWEGO tej gałęzi.
 *
 * ⚠️⚠️ NIE ZAWSZE OD WYSTAWIENIA DOKUMENTU. Gałąź „panel zlecił wysyłkę” ma własne zdarzenie
 * wejściowe: WYSYŁKĘ (`ksef_zlecona_at`, kolumna `zlecona_at` z `wysylki_ksef`). Zakładka
 * „FAKTURY” jest MIESIĘCZNA, więc wysyłanie dokumentów z zeszłego miesiąca to zwykły tryb
 * pracy — faktura wysłana kilka tygodni po wystawieniu, liczona od `utworzona_at`, dostałaby
 * CZERWONĄ BLOKADĘ („zgłoszenie utknęło albo organ je odrzucił”) już przy pierwszym tyknięciu
 * czuwacza, minuty po najzupełniej normalnej wysyłce. To DOKŁADNIE ta sama asymetria, którą
 * zamyka podłoga czuwacza (moduly/faktury/services/czuwacz-ksef.js, `PODLOGA_DNI`).
 *
 * ⚠️ BIERZEMY STEMPEL PÓŹNIEJSZY Z DWÓCH, a nie „ten właściwy dla gałęzi”, i to jest celowe:
 * wiersz może należeć do OBU gałęzi naraz (faktura allegrowa, której wysyłkę zlecił panel),
 * a wtedy zdarzeniem, na które czekamy, jest to, które zaszło PÓŹNIEJ. Podłoga czuwacza robi
 * lustrzaną rzecz (`OR` na dwóch stemplach = wystarczy MŁODSZY), i z tego samego powodu:
 * czekanie ma się liczyć od momentu, w którym coś naprawdę zaczęło czekać.
 *
 * ⚠️ NIGDY nie rzuca i nie zna się na `ksef_odczyt` — to nie przeoczenie. Dowód od czuwacza
 * (`ksef_odczyt === 'ok'`) dokłada wywołujący: sprawa w pasku (domena/sprawy-karty.js)
 * OSKARŻA człowieka („wyślij ten dokument do KSeF”), więc musi stać na dowodzie. Sama
 * definicja czekania ma zostać od czuwacza wolna: coś, co niczego nie zarzuca, tylko OFERUJE
 * wyjście, a wymagałoby odpowiedzi czuwacza, znikałoby dokładnie wtedy, gdy czuwacz jest
 * zdechły albo inFakt niedostępny — czyli w jedynej sytuacji, w której naprawdę nie ma innego
 * wyjścia ze stanu (reguła: każdy stan ma wyjście).
 */
export function czekaNaKsefDluzejNizDobe(zamowienie, teraz = Date.now()) {
  if (!czekaNaKsef(zamowienie)) return false;
  const f = zamowienie?.faktura;
  const stemple = [f?.utworzona_at, f?.ksef_zlecona_at]
    .map((s) => Date.parse(s ?? ''))
    .filter((ms) => Number.isFinite(ms));
  if (!stemple.length) return false;
  return teraz - Math.max(...stemple) >= PROG_CZEKANIA_NA_KSEF_MS;
}
