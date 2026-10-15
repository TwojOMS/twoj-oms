// Faktury KOSZTOWE pobrane z KSeF. Ten modul WYLACZNIE ZAPISUJE I CZYTA — zadnego wywolania
// do KSeF tu nie ma i nie bedzie (wysylka zyje w services/wysylka-ksef.js).
//
// Ksztalt wiersza przyjmowany przez `zapiszKoszt` pochodzi WPROST z `naWiersz`
// (domain/koszt-metadane.js) — jedynego miejsca, w ktorym odpowiedz KSeF zamienia sie
// w ksztalt panelu. Drugiego mapowania tutaj CELOWO NIE MA.

import { bladOperatora } from '../../domena/bledy.js';
import { zakresMiesiaca } from '../../domena/lista-faktur.js';
import { nowyKluczReczny, RODZAJ_RECZNY } from '../../domena/koszt-reczny.js';

const teraz = () => new Date().toISOString();

// ⚠️⚠️ W TEJ TABELI LEZA DWA RODZAJE WIERSZY I TYLKO JEDEN NALEZY DO CZUWACZA (2026-08-13).
//
// 'ksef'   — lustro KSeF-u: dokument przyszedl z metadanych i czuwacz nim rzadzi;
// 'reczne' — wpisal go czlowiek, bo tego kosztu w KSeF NIE MA I NIE BEDZIE (Facebook, Google,
//            Anthropic, zakupy zagraniczne, paragony).
//
// Jedna tabela jest DECYZJA (suma miesiaca, rozbicie na kategorie i przyszly raport zarzadczy
// maja miec jedna prawde o kosztach), a to jest jej cena: KAZDE zapytanie, ktore obsluguje
// czuwacza, musi konczyc sie warunkiem `zrodlo = 'ksef'`. Dotyczy to w szczegolnosci kolejki
// archiwum XML — bez tego warunku panel co noc pobieralby z KSeF dokument, ktorego tam nie ma,
// az do wyczerpania budzetu czasu, i zapisywalby przy nim sciezke do pliku, ktory nie powstal.
const ZRODLO_KSEF = 'ksef';
const ZRODLO_RECZNE = 'reczne';

// ⚠️⚠️ `INSERT OR IGNORE`, NIGDY `INSERT OR REPLACE`. REPLACE nie jest „aktualizacja pol":
// kasuje CALY wiersz i wstawia nowy, wiec zmiotlby `sciezka_xml`, `sciezka_pdf` i `pobrany_at`
// — czyli NASZA czesc wiersza, ktorej KSeF nie zna i nie odtworzy. A czuwacz przyrostowy
// z zalozenia widzi te same rekordy ponownie, gdy okno pobrania zachodzi na poprzednie, wiec
// nie jest to przypadek skrajny, tylko normalny przebieg: archiwum dokumentu kasowaloby sie
// samo, po cichu, przy najblizszym odswiezeniu.
//
// Zwracana wartosc (`changes === 1`) znaczy „to jest NOWY dokument" i na niej stoi licznik
// nowosci przy pobieraniu — nie na porownywaniu list w kodzie.
//
// ⚠️ `w.netto`, `w.vat` i `w.brutto` to NAPISY („1067.00") i takie ida do bazy — kolumny sa
// TEXT-em, bo suma kosztow liczy sie przez `grosze()`, nie na floatach (patrz schema.sql
// i naWiersz). Zadnego `Number(...)` po drodze: przepuszczenie kwoty przez liczbe tutaj
// cofneloby cala te decyzje w jednym miejscu, ktorego nikt by juz nie szukal.
export function zapiszKoszt(db, w) {
  const wynik = db.prepare(`
    INSERT OR IGNORE INTO koszty
      (ksef_number, numer_dokumentu, sprzedawca_nip, sprzedawca_nazwa, data_wystawienia,
       data_trwalego_zapisu, netto, vat, brutto, waluta, rodzaj, ma_zalacznik, pobrany_at,
       zrodlo)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    w.ksefNumber, w.numerDokumentu, w.sprzedawcaNip, w.sprzedawcaNazwa, w.dataWystawienia,
    w.dataTrwalegoZapisu, w.netto, w.vat, w.brutto, w.waluta, w.rodzaj, w.maZalacznik,
    teraz(),
    // ⚠️ ZRODLO WPISUJEMY JAWNIE, mimo `DEFAULT 'ksef'` w schemacie. To jest JEDYNA droga
    // zapisu dokumentu z KSeF, wiec zdanie „ten wiersz przyszedl z KSeF" ma stac tu, a nie
    // wynikac z wartosci domyslnej, ktora ktos kiedys zmieni przy okazji.
    ZRODLO_KSEF,
  );
  if (wynik.changes === 1) return true;
  // ⚠️⚠️ `changes === 0` MA DWA ZNACZENIA, A TYLKO JEDNO Z NICH JEST NIEGROZNE (recenzja, W1).
  //
  // `INSERT OR IGNORE` polyka nie tylko kolizje klucza glownego („ten dokument juz mamy"), ale
  // takze NARUSZENIE `NOT NULL`: dokument z pustym `numer_dokumentu`, `data_trwalego_zapisu`,
  // `waluta` albo `rodzaj` odbija sie od bazy rowniez z `changes: 0`. Bez tego sprawdzenia
  // `zapiszKoszt` oddawaloby wtedy `false`, czyli „juz byl": czuwacz policzylby zero nowych,
  // kursor pojechalby do przodu — i dokumentu nie ma ani nie bedzie, bo drugi raz w oknie
  // pobrania sie nie pojawi. Awaria calkowicie cicha, na cudzych pieniadzach.
  //
  // Jedno dodatkowe zapytanie na wiersz, i tylko na sciezce `changes === 0` — czyli przy
  // dokumentach widzianych ponownie, ktore i tak nic dalej nie robia.
  if (!db.prepare('SELECT 1 AS x FROM koszty WHERE ksef_number = ?').get(w.ksefNumber)) {
    throw bladOperatora(
      `Baza odrzuciła fakturę kosztową „${w.ksefNumber}" (dokument „${w.numerDokumentu ?? ''}") `
      + '— brakuje którejś z wymaganych wartości: numeru dokumentu, daty wystawienia, daty '
      + 'trwałego zapisu, kwot, waluty albo rodzaju.',
    );
  }
  return false;
}

// ⚠️ MIESIAC LICZY SIE PO DACIE WYSTAWIENIA, nie po dacie trwalego zapisu w KSeF ani po
// dacie pobrania. Dokument wystawiony 30.06 potrafi trafic do KSeF w lipcu, a do panelu
// jeszcze pozniej — do kosztow czerwca nalezy jednak CZERWIEC, bo tak liczy sie okres
// w raporcie zarzadczym.
//
// Kwoty wracaja stad jako NAPISY (kolumny TEXT) i tak maja trafic do sumowania: przez
// `grosze()`, na liczbach calkowitych.
//
// ⚠️ ZLY MIESIAC ODMAWIA, ZAMIAST ODDAC PUSTA LISTE (recenzja, W2). '2026-6', '06/2026' czy
// `undefined` dawaly wczesniej zero wierszy, czyli zdanie „w tym miesiacu nie bylo kosztow" —
// a to jest falsz, ktorego nikt nie ma jak zakwestionowac. Ta sama bramka i ten sam komunikat,
// co przy `dokumenty()` i `proformy()` w services/faktury-widok.js; format sprawdza `zakresMiesiaca`
// z domain/lista-faktur.js, a nie druga kopia tego samego wyrazenia regularnego.
//
// ⚠️ ZAKRES, A NIE `substr(data_wystawienia, 1, 7)`. Dwa powody, oba realne:
//   • `substr()` na kolumnie zabija indeks `idx_koszty_wystawienie` — kazde otwarcie zakladki
//     bylo pelnym skanem tabeli kosztow;
//   • data ze ZNACZNIKIEM CZASU. To ta sama pulapka, ktora `substr(...,1,10)` zjadl na
//     proformach (services/faktury-widok.js) — dokument z '2026-06-30T22:30:00Z' ma wpasc
//     do czerwca, a nie wypasc z kazdego miesiaca.
export function kosztyMiesiaca(db, miesiac) {
  const zakres = zakresMiesiaca(miesiac);
  if (!zakres) throw bladOperatora(`„${miesiac ?? ''}" to nie jest miesiąc w formacie RRRR-MM.`);
  return db.prepare(`
    SELECT * FROM koszty WHERE data_wystawienia >= ? AND data_wystawienia <= ?
    ORDER BY data_wystawienia ASC, numer_dokumentu ASC
  `).all(zakres.od, zakres.do + PO_KONCU_DNIA);
}

// Ogonek podnoszacy GORNA granice ponad kazdy znacznik czasu ostatniego dnia miesiaca:
// '2026-06-30T22:30:00Z' jest jako napis WIEKSZE od '2026-06-30', wiec bez niego wypadaloby
// z czerwca. Znak '~' (0x7E) stoi w porzadku bajtowym nad kazda cyfra, litera i spacja —
// czyli nad kazdym separatorem daty od godziny — a nadal PONIZEJ '2026-07-01', bo tam roznica
// zapada wczesniej, na numerze miesiaca. Porownanie zostaje zakresem, wiec indeks dziala.
const PO_KONCU_DNIA = '~';

// Jeden koszt po numerze KSeF — CALY wiersz (`SELECT *`), ten sam ksztalt, co `kosztyMiesiaca`
// i ten sam, ktory bierze `zarchiwizuj` oraz generator wizualizacji (pdf/koszt-pdf.js).
// Drugiego mapowania nie ma i miec nie ma. Brak dokumentu oddaje `undefined` — o tym, ze to
// odmowa dla operatora, a nie pusty PDF, decyduje services/wizualizacja-kosztu.js.
export const kosztPoNumerze = (db, ksefNumber) => db.prepare(
  'SELECT * FROM koszty WHERE ksef_number = ?',
).get(String(ksefNumber ?? ''));

// ⚠️⚠️ KOSZTY OTRZYMANE W MIESIACU — INNE KRYTERIUM NIZ `kosztyMiesiaca` WYZEJ, kryterium
// biura rachunkowego (spec 2026-09-02). Paczka dla biura ma pokazac, co panel OTRZYMAL
// w danym miesiacu, nie co sprzedawca WYSTAWIL: dokument z ostatnich dni miesiaca trafia
// do KSeF (dostaje date trwalego zapisu) dopiero na poczatku kolejnego, i to KOLEJNY
// miesiac ma go zobaczyc w paczce, mimo ze data wystawienia mowi inaczej.
//
// ⚠️ DWIE DATY, ZALEZNIE OD ZRODLA:
//   • 'ksef'   — `data_trwalego_zapisu`, czyli chwila nadania numeru KSeF (to, co KSeF
//     rozumie jako „dokument dotarl");
//   • 'reczne' — `data_wystawienia`, bo `data_trwalego_zapisu` wiersza recznego to chwila
//     WPISANIA go do panelu (patrz naglowek `zapiszRecznyKoszt` nizej), a nie zadna data
//     z KSeF — takiego wiersza KSeF nigdy nie widzial i nigdy nie zobaczy.
//
// ⚠️ ZAKRES + `PO_KONCU_DNIA` jak w `kosztyMiesiaca`: `data_trwalego_zapisu` niesie znacznik
// czasu, wiec zwykle porownanie z gorna granica miesiaca („2026-08-31") obcinaloby ostatni
// dzien. Ta sama pulapka, ten sam ogonek.
export function kosztyOtrzymaneWMiesiacu(db, miesiac) {
  const zakres = zakresMiesiaca(miesiac);
  if (!zakres) throw bladOperatora(`„${miesiac ?? ''}" to nie jest miesiąc w formacie RRRR-MM.`);
  const gorna = zakres.do + PO_KONCU_DNIA;
  // ⚠️ `substr(...,1,10)` W KOLUMNIE SORTUJACEJ, NIE W `WHERE`: to wylacznie normalizacja
  // klucza sortowania do samego dnia (data z KSeF niesie znacznik czasu, data reczna — nie),
  // zeby oba zrodla sortowaly sie po tym samym ksztalcie napisu. Filtrowanie wyzej idzie
  // ZAKRESEM po surowej kolumnie, wiec indeks przy nim dziala normalnie.
  return db.prepare(`
    SELECT *, CASE WHEN zrodlo = 'reczne' THEN substr(data_wystawienia, 1, 10)
      ELSE substr(data_trwalego_zapisu, 1, 10) END AS dzien_otrzymania
    FROM koszty
    WHERE (zrodlo = 'ksef'   AND data_trwalego_zapisu >= ? AND data_trwalego_zapisu <= ?)
       OR (zrodlo = 'reczne' AND data_wystawienia     >= ? AND data_wystawienia     <= ?)
    ORDER BY dzien_otrzymania ASC, numer_dokumentu ASC
  `).all(zakres.od, gorna, zakres.od, gorna);
}

// ⚠️ ILE DOKUMENTOW BIURO RACHUNKOWE NIE DOSTANIE W PACZCE TEGO MIESIACA — bo panel nie umial
// ich zapisac jako koszt (patrz naglowek `zapiszOdrzuconyKoszt` nizej). Miesiac liczy sie
// wylacznie po `data_trwalego_zapisu`: to jedyna data, ktora wiersz kwarantanny w ogole ma —
// metadane sa surowe i niepelne (stad w ogole trafily do kwarantanny), wiec pewnej daty
// wystawienia nie ma jak zalozyc.
export function odrzuconeWMiesiacu(db, miesiac) {
  const zakres = zakresMiesiaca(miesiac);
  if (!zakres) throw bladOperatora(`„${miesiac ?? ''}" to nie jest miesiąc w formacie RRRR-MM.`);
  return db.prepare(
    'SELECT COUNT(*) c FROM koszty_odrzucone WHERE data_trwalego_zapisu >= ? AND data_trwalego_zapisu <= ?',
  ).get(zakres.od, zakres.do + PO_KONCU_DNIA).c;
}

// NULL znaczy „nigdy jeszcze nie pobieralismy" — i to jest jedyny stan, w ktorym wolno
// zejsc do podlogi historii. Wiersza `stan_kosztow` na starcie NIE MA (nikt go nie zaklada
// pusto), wiec brak wiersza czytamy tak samo jak pusty kursor.
export const wczytajKursor = (db) => db.prepare('SELECT kursor FROM stan_kosztow WHERE id = 1').get()?.kursor ?? null;

// Zapis UDANEGO przebiegu: kursor rusza do przodu, a slad po poprzednim bledzie znika.
// Jedno wywolanie, nie dwa — kursor przesuniety bez skasowania bledu zostawialby panel
// z czerwonym komunikatem o awarii, ktora dawno minela.
export function zapiszKursor(db, iso) {
  db.prepare(`
    INSERT INTO stan_kosztow (id, kursor, ostatnie_udane_at, ostatni_blad, ostatni_blad_at)
      VALUES (1,?,?,NULL,NULL)
    ON CONFLICT(id) DO UPDATE SET kursor = excluded.kursor,
      ostatnie_udane_at = excluded.ostatnie_udane_at, ostatni_blad = NULL, ostatni_blad_at = NULL
  `).run(iso, teraz());
}

// ⚠️⚠️ UDANY PRZEBIEG BEZ ANI JEDNEGO DOKUMENTU TEZ JEST UDANY (recenzja, W1).
//
// `zapiszKursor` wyzej byl JEDYNYM zapisem `ostatnie_udane_at` i jedynym miejscem kasujacym
// `ostatni_blad` — a wola sie go tylko wtedy, gdy przebieg cokolwiek przeczytal. Spokojna doba
// bez faktur kosztowych zostawiala wiec `ostatnie_udane_at = null` i NIE GASILA awarii sprzed
// trzech tygodni. Ekran zakladki mowi wprost, ze „kiedy ostatnio sie udalo" jest wazniejsze niz
// „czy byl blad", wiec bylo to klamstwo dokladnie w tym miejscu, ktore odpowiada na pytanie
// „czy panel jeszcze pobiera koszty".
//
// ⚠️ KURSORA NIE DOTYKAMY, ANI W `VALUES`, ANI W `ON CONFLICT`. Nie ma czym go przesunac (zaden
// dokument nie wrocil), a przypisanie mu NULL-a z klauzuli VALUES cofneloby pobieranie do podlogi
// historii — ta sama pulapka, ktora opisuje `zapiszBladPobrania` nizej. Przy pierwszym w zyciu
// przebiegu wiersz powstaje z kursorem NULL, czyli „jeszcze nic nie pobralismy", i to jest prawda.
export function odnotujUdanyPrzebieg(db) {
  db.prepare(`
    INSERT INTO stan_kosztow (id, kursor, ostatnie_udane_at, ostatni_blad, ostatni_blad_at)
      VALUES (1,NULL,?,NULL,NULL)
    ON CONFLICT(id) DO UPDATE SET ostatnie_udane_at = excluded.ostatnie_udane_at,
      ostatni_blad = NULL, ostatni_blad_at = NULL
  `).run(teraz());
}

export const stanKosztow = (db) => db.prepare('SELECT * FROM stan_kosztow WHERE id = 1').get() ?? null;

// ⚠️ NIEUDANY PRZEBIEG NIE RUSZA KURSORA. `ON CONFLICT` podmienia WYLACZNIE `ostatni_blad`:
// gdyby zapisywal takze kursor (NULL z klauzuli VALUES), kazda pojedyncza awaria cofalaby
// pobieranie do podlogi historii — a przy powtarzajacym sie bledzie panel mielilby te sama
// historie w kolko i nigdy nie doszedl do biezacych dokumentow.
//
// ⚠️ ZE ZNACZNIKIEM CZASU (recenzja, D4). Sama tresc bledu nie mowi, czy awaria jest sprzed
// godziny, czy sprzed trzech tygodni — a to jest cala roznica miedzy „KSeF mial czkawke"
// a „panel nie pobiera kosztow od miesiaca i nikt tego nie zauwazyl". Znacznik gasnie razem
// z bledem przy najblizszym udanym przebiegu (`zapiszKursor` wyzej), zeby na ekranie nie
// zostala data awarii, ktorej juz nie ma.
export function zapiszBladPobrania(db, tresc) {
  db.prepare(`
    INSERT INTO stan_kosztow (id, kursor, ostatnie_udane_at, ostatni_blad, ostatni_blad_at)
      VALUES (1,NULL,NULL,?,?)
    ON CONFLICT(id) DO UPDATE SET ostatni_blad = excluded.ostatni_blad,
      ostatni_blad_at = excluded.ostatni_blad_at
  `).run(tresc, teraz());
}

// ⚠️⚠️ KWARANTANNA: DOKUMENT, KTOREGO PANEL NIE UMIAL ZAPISAC JAKO KOSZT.
//
// Wolane WYLACZNIE z czuwacza kosztow i wylacznie na odmowie DOTYCZACEJ DOKUMENTU (brak kwoty,
// odrzucenie wiersza przez baze) — nigdy na awarii technicznej. Uzasadnienie calego rozstrzygniecia
// stoi w naglowku services/czuwacz-kosztow.js i przy tabeli w schema.sql; tutaj tylko dwie rzeczy,
// ktore musza byc widoczne z miejsca zapisu:
//
//  1. ZAPISUJEMY CALE SUROWE METADANE. Kursor przejechal obok tego dokumentu, wiec KSeF nie
//     pokaze go juz w zadnym oknie przyrostowym — bez tej kopii dokument jest stracony.
//  2. `odrzucony_at` NIE RUSZA SIE przy ponownym spotkaniu tego samego dokumentu (odpowiada na
//     pytanie „od kiedy"), a `ostatnia_proba_at` — owszem („czy panel wciaz go widzi").
//
// ⚠️ BEZ NUMERU KSeF ODMAWIAMY GLOSNO. Numer jest tu kluczem glownym: `INSERT` z NULL-em
// przeszedlby (SQLite dopuszcza NULL w TEXT PRIMARY KEY) i NULL-i ze soba NIE SKLEJA, wiec
// ten sam dokument dokladalby nowy wiersz przy KAZDYM nocnym przebiegu — kwarantanna rosnaca
// w nieskonczonosc, w ktorej nie da sie odroznic jednego dokumentu od trzystu.
export function zapiszOdrzuconyKoszt(db, metadane, powod) {
  const ksefNumber = metadane?.ksefNumber;
  if (!ksefNumber) {
    throw bladOperatora(
      'KSeF przysłał dokument bez numeru KSeF — panel nie umie go ani zapisać jako koszt, '
      + 'ani odłożyć na bok, bo nie ma czym go zaadresować. Pobieranie przerwane.',
    );
  }
  const kiedy = teraz();
  db.prepare(`
    INSERT INTO koszty_odrzucone
      (ksef_number, numer_dokumentu, data_trwalego_zapisu, powod, metadane_json,
       odrzucony_at, ostatnia_proba_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(ksef_number) DO UPDATE SET
      powod = excluded.powod, metadane_json = excluded.metadane_json,
      ostatnia_proba_at = excluded.ostatnia_proba_at
  `).run(
    ksefNumber, metadane.invoiceNumber ?? null, metadane.permanentStorageDate ?? null,
    String(powod ?? ''), JSON.stringify(metadane), kiedy, kiedy,
  );
}

// ⚠️ TO JEST JEDYNE MIEJSCE, W KTORYM WIDAC DOKUMENTY POMINIETE W SUMIE MIESIACA. Pusta lista
// znaczy „suma kosztow jest kompletna"; niepusta — ze zestawienie z KSeF bedzie WIEKSZE niz
// suma w panelu, i to o konkretne, nazwane dokumenty. Ekran zakladki ma to pokazywac obok
// sumy, a nie chowac: liczba, ktorej nikt nie kwestionuje, jest gorsza niz widoczna dziura.
export const odrzuconeKoszty = (db) => db.prepare(
  'SELECT * FROM koszty_odrzucone ORDER BY odrzucony_at ASC, ksef_number ASC',
).all();

export const liczbaOdrzuconych = (db) => db.prepare('SELECT COUNT(*) c FROM koszty_odrzucone').get().c;

// ⚠️⚠️ WYJSCIE Z KWARANTANNY — bez niego cala tabela jest pulapka jednokierunkowa (recenzja, W4).
//
// Wolane po KAZDYM udanym zapisie kosztu o tym numerze, i to jest cale kryterium: dokument
// lezy w `koszty` albo lezy w `koszty_odrzucone`, nigdy w obu naraz. Dwa powody, oba zmierzone:
//
//  1. PO NAPRAWIE MAPOWANIA nic nie przerabialo surowych metadanych z powrotem na wiersz —
//     jedyna droga byloby RECZNE cofniecie kursora na cale miesiace, czyli dokladnie to,
//     czemu kolumna `metadane_json` miala zapobiec.
//  2. DOKUMENT ZAPISANY POPRAWNIE przy ponownym spotkaniu (okna pobrania ZACHODZA na siebie,
//     wiec to normalny przebieg, a nie przypadek skrajny) zostawial wiersz kwarantanny na
//     zawsze — a panel do konca swiata twierdzilby, ze w sumie miesiaca brakuje dokumentu,
//     ktory juz w niej jest. Trwale zapalone ostrzezenie przestaje cokolwiek znaczyc
//     i przykrywa NASTEPNA, prawdziwa dziure (ta sama lekcja, co przy `zapiszBladPobrania`).
//
// Brak wiersza to stan POPRAWNY i cichy: kasowanie leci po kazdym udanym zapisie, czyli
// w zdecydowanej wiekszosci przebiegow na pustej kwarantannie. Zwracamy liczbe skasowanych
// wierszy — 0 albo 1, bo numer KSeF jest kluczem glownym.
export function usunOdrzucony(db, ksefNumber) {
  if (!ksefNumber) return 0;
  return db.prepare('DELETE FROM koszty_odrzucone WHERE ksef_number = ?').run(ksefNumber).changes;
}

// ⚠️⚠️ KOLEJKA ARCHIWUM XML — STAN TABELY, A NIE LISTA „nowych z tego przebiegu".
//
// Czuwacz kosztow archiwizuje dokladnie te dokumenty, ktore nie maja jeszcze sciezki do pliku,
// i to jest CALA ksiegowosc stanu „do ponowienia". Dzieki temu dokument, ktorego nie udalo sie
// pobrac z KSeF albo zapisac na NAS-ie, wraca SAM przy najblizszym przebiegu — bez kolumny
// „probowac ponownie", ktora trzeba by czyscic (i ktorej nikt by nie czyscil).
//
// ⚠️ NAJNOWSZE NAJPIERW. Nocny przebieg ma zwykle kilka swiezych dokumentow, a przy backfillu
// od stycznia — setki zaleglych. Kolejnosc rosnaca kazalaby dokumentom z dzisiejszej nocy
// czekac za calym ogonem archiwum, czyli tygodniami; malejaca oddaje najpierw to, po co ktos
// siega, a zaleglosc drenuje sie od konca, po budzecie czasu na przebieg
// (services/czuwacz-kosztow.js).
//
// Oddajemy CALY wiersz (`SELECT *`), bo `zarchiwizuj` bierze surowy wiersz tabeli `koszty` —
// ten sam ksztalt, co `kosztyMiesiaca`. Drugiego mapowania nie ma i miec nie ma.
//
// ⚠️⚠️ `zrodlo = 'ksef'` NIE JEST TU OZDOBNIKIEM — to jest najwazniejszy warunek w tym pliku
// (2026-08-13). Wiersz WPISANY RECZNIE tez ma `sciezka_xml IS NULL` i zawsze bedzie mial, bo
// zadnego XML-a w KSeF dla niego nie ma. Bez tego warunku kazdy taki dokument wracalby do
// kolejki KAZDEJ NOCY: przebieg pytalby KSeF o numer „RECZNY-…", dostawal odmowe, liczyl ja
// do hamulca „trzy bledy z rzedu" — i tym samym blokowal archiwizacje dokumentow, ktore
// naprawde na nia czekaja. Zaplacone pobraniami z KSeF i czasem przebiegu, bez ani jednego
// pliku na dysku.
export const kosztyBezArchiwum = (db) => db.prepare(
  "SELECT * FROM koszty WHERE sciezka_xml IS NULL AND zrodlo = 'ksef'"
  + ' ORDER BY data_wystawienia DESC, ksef_number ASC',
).all();

// ⚠️ COALESCE, a nie zwykle przypisanie — ten sam wzorzec, co przy `zapiszNumerKsef`
// (db/faktury.js). Zapis SAMEGO PDF-a nie ma prawa skasowac sciezki do XML-a zapisanej
// wczesniej: XML jest oryginalem dokumentu i drugi raz z KSeF go nie pobierzemy za darmo.
//
// ⚠️ `zrodlo = 'ksef'` z tego samego powodu, co przy kolejce wyzej: sciezka do archiwum opisuje
// ORYGINAL POBRANY Z KSeF. Wiersz wpisany recznie zadnego oryginalu w KSeF nie ma, wiec zapis
// takiej sciezki przy nim bylby zdaniem nieprawdziwym — i do tego wyprowadzilby go z kolejki
// archiwum, w ktorej i tak nie ma prawa stac.
export function zapiszSciezki(db, ksefNumber, { xml = null, pdf = null }) {
  db.prepare(
    'UPDATE koszty SET sciezka_xml = COALESCE(?, sciezka_xml), sciezka_pdf = COALESCE(?, sciezka_pdf)'
    + " WHERE ksef_number = ? AND zrodlo = 'ksef'",
  ).run(xml, pdf, ksefNumber);
}

// ⚠️⚠️ RECZNE FAKTURY KOSZTOWE (2026-08-13) — koszty, ktorych w KSeF NIE MA I NIE BEDZIE:
// Facebook, Google, Anthropic, zakupy zagraniczne, paragony. Do 13.08 bylo to swiadomie poza
// zakresem (par. 8 specyfikacji); wlasciciel te decyzje zmienil.
//
// ⚠️ TEN SAM WIERSZ, TA SAMA TABELA, TE SAME KWOTY-NAPISY. Ksztalt przychodzi z
// `naWierszReczny` (domain/koszt-reczny.js) — jedynego miejsca, ktore sprawdza, czy to, co
// wpisal czlowiek, jest kosztem. Drugiej walidacji tutaj CELOWO NIE MA, tak samo jak nie ma
// drugiego mapowania odpowiedzi KSeF.
//
// ⚠️ `data_trwalego_zapisu` NIE JEST TU DATA Z KSeF, bo zadnej nie ma — stoi w niej chwila
// WPISANIA dokumentu. Kolumna jest `NOT NULL` (dokument z KSeF bez niej nie istnieje), a jej
// jedynym czytelnikiem poza ekranem jest kursor pobierania — ktory liczy sie WYLACZNIE
// z metadanych KSeF, nigdy z tej tabeli. Wiersz reczny nie ma wiec jak ruszyc kursora.
export function zapiszRecznyKoszt(db, w) {
  const klucz = nowyKluczReczny();
  const kiedy = teraz();
  db.prepare(`
    INSERT INTO koszty
      (ksef_number, numer_dokumentu, sprzedawca_nip, sprzedawca_nazwa, data_wystawienia,
       data_trwalego_zapisu, netto, vat, brutto, waluta, rodzaj, ma_zalacznik, pobrany_at,
       zrodlo, kategoria_dokumentu, typ_dokumentu)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)
  `).run(
    klucz, w.numerDokumentu, w.sprzedawcaNip, w.sprzedawcaNazwa, w.dataWystawienia,
    kiedy, w.netto, w.vat, w.brutto, w.waluta, RODZAJ_RECZNY, kiedy,
    ZRODLO_RECZNE, w.kategoriaDokumentu ?? null, w.typDokumentu ?? null,
  );
  return klucz;
}

// ⚠️⚠️ EDYCJA I USUNIECIE DOTYCZA WYLACZNIE WIERSZY RECZNYCH — `AND zrodlo = 'reczne'` w obu
// zapytaniach nizej jest warunkiem, nie ostroznoscia.
//
// Panel jest LUSTREM KSeF-u: dokumentu z KSeF nie wolno ani poprawic (jego tresc jest po
// stronie sprzedawcy — poprawiona u nas rozjechalaby sie z oryginalem, ktory zostal w KSeF),
// ani skasowac (wrocilby dopiero po recznym cofnieciu kursora o miesiace, bo okno przyrostowe
// juz obok niego przejechalo — a do tego czasu suma miesiaca bylaby zanizona bez sladu).
//
// ⚠️ ODMOWA JEST GLOSNA I ROZROZNIA DWA PRZYPADKI: „to dokument z KSeF" i „takiego dokumentu
// nie ma". Ciche `changes: 0` znaczyloby na ekranie „zapisano", a wiersz zostawalby bez zmian
// — czyli operator poprawilby kwote, zobaczyl stara i nie mial pojecia dlaczego.
function tylkoReczny(db, klucz, co) {
  const w = db.prepare('SELECT zrodlo FROM koszty WHERE ksef_number = ?').get(String(klucz ?? ''));
  if (!w) {
    throw bladOperatora(`Panel nie zna kosztu „${klucz ?? ''}" — nie ma czego ${co}.`);
  }
  if (w.zrodlo !== ZRODLO_RECZNE) {
    throw bladOperatora(
      `Ten dokument przyszedł z KSeF i panel nie pozwala go ${co}. Panel jest lustrem KSeF-u: `
      + 'treść dokumentu jest po stronie sprzedawcy, a skasowany wiersz wróciłby dopiero po '
      + 'ręcznym cofnięciu pobierania o miesiące — do tego czasu suma miesiąca byłaby zaniżona.',
    );
  }
}

export function zaktualizujRecznyKoszt(db, klucz, w) {
  tylkoReczny(db, klucz, 'poprawić');
  db.prepare(`
    UPDATE koszty SET numer_dokumentu = ?, sprzedawca_nip = ?, sprzedawca_nazwa = ?,
      data_wystawienia = ?, netto = ?, vat = ?, brutto = ?, waluta = ?,
      kategoria_dokumentu = ?, typ_dokumentu = ?
    WHERE ksef_number = ? AND zrodlo = 'reczne'
  `).run(
    w.numerDokumentu, w.sprzedawcaNip, w.sprzedawcaNazwa, w.dataWystawienia,
    w.netto, w.vat, w.brutto, w.waluta, w.kategoriaDokumentu ?? null, w.typDokumentu ?? null,
    String(klucz),
  );
}

export function usunRecznyKoszt(db, klucz) {
  tylkoReczny(db, klucz, 'usunąć');
  return db.prepare("DELETE FROM koszty WHERE ksef_number = ? AND zrodlo = 'reczne'")
    .run(String(klucz)).changes;
}

// ⚠️⚠️ KATEGORIA PRZYPIETA WPROST DO DOKUMENTU — wyjscie dla sprzedawcy BEZ polskiego NIP-u.
//
// Zwykla droga jest jedna i zostaje jedyna dla wszystkich, ktorzy NIP maja: kategoria dobiera
// sie po NIP-ie (db/kategorie-kosztow.js) i obejmuje wszystkie faktury tego sprzedawcy, takze
// starsze. Google, Meta czy Anthropic nie maja jednak jak trafic do tamtej mapy — jej kluczem
// GLOWNYM jest NIP — wiec bez tej drogi ich faktury zostawaly by w pasie „bez kategorii"
// na zawsze, mimo ze operator doskonale wie, do czego naleza.
//
// ⚠️ REGULA PIERWSZENSTWA MIESZKA W JEDNYM MIEJSCU (domain/lista-kosztow.js), a nie tutaj:
// kategoria dokumentu wygrywa z mapa po NIP-ie, bo jest bardziej szczegolowa. Ta funkcja
// wylacznie zapisuje decyzje.
//
// Dziala na KAZDYM wierszu, takze na dokumencie z KSeF: „dokument bez NIP-u" zdarza sie i tam
// (sprzedawca zagraniczny wystawiajacy przez polskiego posrednika), a rozdzielanie tego na dwie
// sciezki zaleznie od zrodla dawaloby dwie reguly na jedno pytanie.
export function przypnijKategorieDoDokumentu(db, klucz, kategoria, typ) {
  const nazwa = String(kategoria ?? '').trim();
  const wynik = db.prepare(
    'UPDATE koszty SET kategoria_dokumentu = ?, typ_dokumentu = ? WHERE ksef_number = ?',
  ).run(nazwa || null, nazwa ? typ : null, String(klucz ?? ''));
  if (wynik.changes === 0) {
    throw bladOperatora(
      `Panel nie zna kosztu „${klucz ?? ''}" — nie ma do czego przypiąć kategorii.`,
    );
  }
}
