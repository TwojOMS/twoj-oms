import { stanFaktury } from './faktura-stan.js';
import { czyKanalAllegro } from './wysylka.js';
import { anulowaneEfektywnie } from './status-reczny.js';

// JEDNA definicja „faktury czekającej na KSeF" — dla czuwacza (services/czuwacz-ksef.js)
// i dla paska spraw na karcie (domain/sprawy-karty.js).
//
// ⚠️ POWSTAŁA Z ROZJAZDU, KTÓRY JUŻ SIĘ WYDARZYŁ (recenzja Partii 2, W4+W5). Czuwacz pytał
// wyłącznie o faktury z numerem dokumentu i UUID-em; pasek zapalał blokadę przy każdej
// fakturze „wystawionej" — czyli TAKŻE przy wierszu bez numeru (inFakt potrafi oddać sukces
// bez pola `number`; widok ma na to osobny przypadek). O taki wiersz czuwacz nie zapyta
// NIGDY, a pasek po dobie meldował „Faktura  czeka na KSeF od …" — z pustym numerem, na
// zawsze. Osobno: zamówienie anulowane po wystawieniu faktury dostawało dwie blokady, w tym
// jedną nieprawdziwą („kupujący jej jeszcze nie ma", choć nic nie kupił).
//
// Dwie kopie warunku rozjeżdżają się przy pierwszej zmianie reguły, więc tu jest jedna —
// w dwóch postaciach (SQL i predykat), a test tests/oms/ksef-oczekiwanie.test.js pilnuje,
// że dają IDENTYCZNĄ odpowiedź na całym zestawie granicznych przypadków.

/**
 * Część WSPÓLNA obu gałęzi: dokument istnieje, numeru KSeF nie ma, a zamówienie żyje
 * i o fakturę prosiło. Aliasy: `f` = faktury, `z` = zamowienia.
 *
 * ⚠️ `IS NOT` zamiast `<>`: `<>` na NULL-u daje NULL (czyli fałsz), więc odrzucałoby każdą
 * fakturę z pustym `ksef_status` — a to jest właśnie stan normalnej, wystawionej faktury.
 */
const WSPOLNE_SQL = `
  f.ksef_numer IS NULL
  AND f.infakt_uuid IS NOT NULL
  AND f.numer IS NOT NULL              -- rezerwacja bez numeru to jeszcze nie dokument
  AND f.allegro_wyslana_at IS NULL     -- wysłana bez numeru KSeF: kupujący fakturę MA
  AND f.ksef_status IS NOT 'w_toku'
  AND f.ksef_status IS NOT 'do_wyjasnienia'
  AND z.chce_fakture = 1
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
 * sklep o kluczu `allegrowy` (zmierzone w node:sqlite 06.08.2026).
 */
const GALAZ_ALLEGRO_SQL = `z.sklep LIKE 'allegro\\_%' ESCAPE '\\'`;

/**
 * ⚠️⚠️ GAŁĄŹ 2 (od 06.08.2026): DOKUMENT, KTÓREGO WYSYŁKĘ DO KSeF ZLECIŁ PANEL. Do tego dnia
 * czuwacz pytał WYŁĄCZNIE o kanały Allegro, bo tylko tam numer miał komu służyć; faktura
 * sklepowa nie miała DOKĄD pojechać, więc jej `ksef_numer` zostawał NULL-em na zawsze i pytanie
 * o niego byłoby setkami wywołań miesięcznie bez odbiorcy. Zakładka „FAKTURY" to zmieniła:
 * panel sam wysyła dokumenty do KSeF (ze świadomego zatwierdzenia człowieka,
 * services/wysylka-ksef.js), więc bez tej gałęzi zakładka pokazywałaby „brak KSeF" przy
 * dokumencie, który właśnie stamtąd wyszedł — i pokazywałaby to już zawsze.
 *
 * ⚠️⚠️ ROZPOZNAJEMY TO PO WIERSZU W `wysylki_ksef`, A NIE PO TREŚCI WPISU W LOGU. Wiersz jest
 * FAKTEM zapisanym PRZED wywołaniem (rezerwacja, db/wysylki-ksef.js), kluczem jest `uuid`
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
 * `FROM faktury f JOIN zamowienia z` z `z.chce_fakture = 1`, a dokument okresu nie ma ANI
 * wiersza w `faktury`, ANI zamówienia: leży w `okresy_rozliczeniowe` (db/okresy.js), która nie
 * ma nawet kolumny `ksef_numer` — więc nie ma dokąd zapisać odpowiedzi. Skutek: numer KSeF dla
 * faktury okresu widać wyłącznie na zakładce „FAKTURY", prosto z inFaktu (services/faktury-widok.js),
 * i panel go u siebie NIE MA. Domknięcie tego wymaga osobnego zadania (kolumna na okresie
 * i druga ścieżka odczytu w czuwaczu) — NIE DA SIĘ tego załatwić poszerzeniem warunku tutaj.
 */
const GALAZ_ZLECONA_Z_PANELU_SQL = 'EXISTS (SELECT 1 FROM wysylki_ksef w WHERE w.uuid = f.infakt_uuid)';

/**
 * Warunek do klauzuli WHERE — część wspólna ORAZ jedna z dwóch rozłącznych gałęzi.
 */
export const WARUNEK_CZEKA_NA_KSEF_SQL = `
  ${WSPOLNE_SQL}
  AND (${GALAZ_ALLEGRO_SQL} OR ${GALAZ_ZLECONA_Z_PANELU_SQL})
`;

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
  return czyKanalAllegro(wiersz) || Boolean(wiersz?.zlecona_z_panelu);
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
 * odczycie zamówienia (db/zamowienia.js), tak samo jak `chce_fakture` przychodzi ze swojej.
 * Obiekt bez tego pola (fikstura, wywołanie z widoku) zachowuje się jak przed zmianą: znaczy
 * „panel tego dokumentu nie wysyłał".
 */
export function czekaNaKsef(zamowienie) {
  const f = zamowienie?.faktura;
  if (!f) return false;
  return stanFaktury(f) === 'wystawiona'
    && Boolean(f.numer)
    && Boolean(f.infakt_uuid)
    && !f.ksef_numer
    && !f.allegro_wyslana_at
    && Boolean(zamowienie.chce_fakture)
    && !anulowaneEfektywnie(zamowienie)
    && (czyKanalAllegro(zamowienie) || Boolean(f.ksef_zlecona_at));
}

/**
 * Doba, bo wlasciciel wysyla dokumenty do KSeF w ciagu dnia: 24 h mijaja dopiero wtedy,
 * gdy cos NAPRAWDE stanelo. Prog stal do 06.08.2026 wylacznie w `domain/sprawy-karty.js`;
 * od Zadania 11 pyta o to samo takze karta (przycisk „bez numeru KSeF"), a dwie kopie
 * liczby rozjechalyby sie tak samo, jak rozjechaly sie dwie kopie warunku (recenzja
 * Partii 2, W4+W5) — z tym, ze tu rozjazd znaczy przycisk do operacji NIEODWRACALNEJ
 * pokazany wczesniej, niz mowi sprawa, ktora go zapowiada.
 */
export const PROG_CZEKANIA_NA_KSEF_MS = 24 * 60 * 60 * 1000;

/**
 * Czy faktura czeka na numer KSeF DLUZEJ NIZ DOBE. Ten sam zakres, co `czekaNaKsef`,
 * plus uplyw czasu liczony od ZDARZENIA WEJSCIOWEGO tej galezi.
 *
 * ⚠️⚠️ NIE ZAWSZE OD WYSTAWIENIA DOKUMENTU — i to jest poprawka z recenzji calosci (Finding 2).
 * Do niej stalo tu golo `utworzona_at`, a galaz „panel zlecil wysylke" ma wlasne zdarzenie
 * wejsciowe: WYSYLKE (`ksef_zlecona_at`, kolumna `zlecona_at` z `wysylki_ksef`). Zakladka
 * „FAKTURY" jest MIESIECZNA, wiec wysylanie dokumentow z zeszlego miesiaca to zwykly tryb
 * pracy wlasciciela — faktura wystawiona 1 lipca i wyslana 5 sierpnia o 10:05 dostawala
 * CZERWONA BLOKADE („zgloszenie utknelo albo organ je odrzucil") juz przy pierwszym tyknieciu
 * czuwacza, o 10:07. Dwie minuty po najzupelniej normalnej wysylce — i tak przy WIEKSZOSCI
 * wysylek. To DOKLADNIE ta sama asymetria, ktora dla podlogi czuwacza zamknal commit e690379
 * (services/czuwacz-ksef.js, `PODLOGA_DNI`); prog doby zostal wtedy nietkniety.
 *
 * ⚠️ BIERZEMY STEMPEL PÓŹNIEJSZY Z DWOCH, a nie „ten wlasciwy dla galezi", i to jest celowe:
 * wiersz moze nalezec do OBU galezi naraz (faktura allegrowa, ktorej wysylke zlecil panel),
 * a wtedy zdarzeniem, na ktore czekamy, jest to, ktore zaszlo PÓŹNIEJ. Podloga czuwacza robi
 * lustrzana rzecz (`OR` na dwoch stemplach = wystarczy MLODSZY), i z tego samego powodu:
 * czekanie ma sie liczyc od momentu, w ktorym cos naprawde zaczelo czekac.
 *
 * ⚠️ NIGDY nie rzuca i nie zna sie na `ksef_odczyt` — to jest ROZNICA MERYTORYCZNA wobec
 * sprawy w pasku (domain/sprawy-karty.js), a nie przeoczenie. Sprawa OSKARZA czlowieka
 * („wyslij ten dokument do KSeF"), wiec musi stac na dowodzie od czuwacza; przycisk niczego
 * nie zarzuca, tylko OFERUJE wyjscie. Gdyby wymagal odpowiedzi czuwacza, znikalby dokladnie
 * wtedy, gdy czuwacz jest zdechly albo inFakt niedostepny — czyli w jedynej sytuacji, w ktorej
 * naprawde nie ma innego wyjscia ze stanu (niezmiennik 4.9).
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
