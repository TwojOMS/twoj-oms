import { bladOperatora } from '../../domena/bledy.js';
import { grosze, zl } from '../../domena/suma-pozycji.js';
import { pobierzOkres } from './okresy.js';

const teraz = () => new Date().toISOString();

// Porzadek jest CZESCIA REGULY, nie kosmetyka widoku: dataPokryciaWplat() oddaje date tej
// wplaty, ktora przekroczyla prog kwoty zamowienia, wiec nieustalona kolejnosc znaczylaby
// inna date „oplacenia" przy kazdym odczycie. Sortujemy po dacie WPLATY (a gdy jej brak —
// po czasie zapisu), potem po `id`, zeby dwie wplaty z tego samego dnia mialy porzadek
// stabilny i taki sam w tabeli na karcie, co w liczeniu.
const PORZADEK_WPLAT = 'COALESCE(data, utworzona_at), id';

export function platnosciZamowienia(db, zamowienieId) {
  return db.prepare(
    `SELECT * FROM platnosci WHERE zamowienie_id = ? ORDER BY ${PORZADEK_WPLAT}`,
  ).all(zamowienieId);
}

/**
 * Wpłaty WIELU zamówień jednym zapytaniem (PRZ-051) — mapa id → lista w TYM SAMYM porządku,
 * co `platnosciZamowienia`, bo od porządku zależy data opłacenia. Lista zamówień pytała
 * dotąd o wpłaty osobno przy każdym wierszu: kompilacja zapytania na wiersz była połową
 * kosztu otwarcia listy (pomiar PRZ-051). Wołający dzieli identyfikatory na porcje.
 */
export function platnosciDlaZamowien(db, zamowienieIds) {
  const mapa = new Map();
  if (!zamowienieIds.length) return mapa;
  const wiersze = db.prepare(
    `SELECT * FROM platnosci WHERE zamowienie_id IN (${zamowienieIds.map(() => '?').join(',')})
     ORDER BY zamowienie_id, ${PORZADEK_WPLAT}`,
  ).all(...zamowienieIds);
  for (const w of wiersze) {
    if (!mapa.has(w.zamowienie_id)) mapa.set(w.zamowienie_id, []);
    mapa.get(w.zamowienie_id).push(w);
  }
  return mapa;
}

// ⚠️ TU PRZEBIEGA GRANICA WLASNOSCI DANYCH (przewodnik OMS, 4.7). Ta funkcja jest wolana
// przez pollera przy KAZDEJ synchronizacji (co dwie minuty) i KAZDE jej zapytanie niesie
// `zrodlo = 'sklep'`. To jest cala ochrona wplat recznych: nie ma tu sciezki, ktora moglaby
// dotknac wiersza dopisanego przez czlowieka. Wplata reczna skasowana przez pollera to
// pieniadze, ktore znikaja z panelu bez sladu — a operator dowiaduje sie o tym dopiero
// wtedy, gdy panel zaczyna ostrzegac przy nadaniu paczki za zamowienie faktycznie oplacone.
//
// Kwota wplaty ze sklepu to kwota zamowienia W SKLEPIE (`kwota_brutto` z tej samej
// synchronizacji): Woo mowi „date_paid", czyli „zaplacone w calosci", i nic ponadto.
// Dzieki temu, gdy kwota zamowienia urosnie o cos, czego sklep nie zainkasowal, panel
// pokaze NIEDOPLATE — a nie po cichu uzna, ze klient zaplacil wiecej, niz zaplacil.
export function zsynchronizujWplateSklepu(db, zamowienieId, { oplacone_at, kwota, metoda }) {
  // Sklep cofnal zaplate (zwrot, wyzerowane date_paid) — wplata ze sklepu ma zniknac
  // razem z nia. Wplaty reczne zostaja: nikt ich w sklepie nie odwolal.
  if (!oplacone_at) {
    db.prepare("DELETE FROM platnosci WHERE zamowienie_id = ? AND zrodlo = 'sklep'").run(zamowienieId);
    return;
  }
  const istniejaca = db.prepare(
    "SELECT id FROM platnosci WHERE zamowienie_id = ? AND zrodlo = 'sklep'",
  ).get(zamowienieId);
  // Wiersz do aktualizacji wskazuje WYLACZNIE zapytanie wyzej (to ono niesie `zrodlo`),
  // wiec warunku nie powtarzamy tutaj drugi raz: dwie kopie tej samej granicy rozjechalyby
  // sie przy pierwszej zmianie, a do tego skutecznie ukrywalyby bledy tej pierwszej.
  if (istniejaca) {
    db.prepare('UPDATE platnosci SET kwota = ?, data = ?, metoda = ? WHERE id = ?')
      .run(String(kwota), oplacone_at, metoda ?? null, istniejaca.id);
    return;
  }
  db.prepare(
    'INSERT INTO platnosci (zamowienie_id, kwota, data, metoda, uwaga, zrodlo, utworzona_at)'
    + " VALUES (?,?,?,?,NULL,'sklep',?)",
  ).run(zamowienieId, String(kwota), oplacone_at, metoda ?? null, teraz());
}

/** Wplata dopisana przez czlowieka. Poller jej nie tyka — patrz komentarz wyzej. */
export function dodajWplateReczna(db, zamowienieId, { kwota, data, metoda = null, uwaga = null }) {
  db.prepare(
    'INSERT INTO platnosci (zamowienie_id, kwota, data, metoda, uwaga, zrodlo, utworzona_at)'
    + " VALUES (?,?,?,?,?,'reczna',?)",
  ).run(zamowienieId, String(kwota), data, metoda, uwaga, teraz());
  return { kwota: String(kwota), data, metoda, uwaga };
}

// WYJSCIE ze stanu, w ktory panel sam pozwala wejsc (przewodnik OMS, 4.9): omylkowo
// dopisana wplata reczna przewracalaby saldo zamowienia i — gdy domyka kwote — kazalaby
// panelowi uznac je za oplacone. Bez tej trasy jedynym wyjsciem bylby SQL na produkcji.
//
// ⚠️ Wplaty ZE SKLEPU usunac sie nie da i to nie jest niedorobka: nalezy do sklepu,
// a poller odtworzylby ja przy najblizszym przebiegu — panel obiecywalby skasowanie,
// ktore samo sie cofa po dwoch minutach.
//
// Wiersz szukamy po PARZE (id wplaty, id zamowienia): w swiezej bazie liczniki
// AUTOINCREMENT roznych tabel zbiegaja sie, wiec sam `id` przepuscilby pomylke argumentu
// w trasie (przewodnik OMS, sekcja 6, punkt 3).
export function usunWplateReczna(db, zamowienieId, platnoscId) {
  const w = db.prepare('SELECT * FROM platnosci WHERE id = ? AND zamowienie_id = ?')
    .get(platnoscId, zamowienieId);
  if (!w) throw bladOperatora('Nie ma takiej wpłaty przy tym zamówieniu.');
  if (w.zrodlo !== 'reczna') {
    throw bladOperatora(
      'Wpłaty ze sklepu nie da się usunąć z panelu — należy do sklepu i poller dopisałby ją'
      + ' z powrotem przy najbliższej synchronizacji. Jeśli ta wpłata jest błędna, popraw ją w sklepie.',
    );
  }
  db.prepare('DELETE FROM platnosci WHERE id = ?').run(platnoscId);
  return w;
}

// ⚠️ WPLATY OKRESU ZYJA W OSOBNEJ TABELI (`platnosci_okresu`, patrz schema.sql). Nie da sie
// ich trzymac w `platnosci`: tam `zamowienie_id` jest NOT NULL, a klient zbiorczy placi RAZ
// za caly miesiac — ta wplata nie nalezy do zadnego pojedynczego zamowienia.
//
// Zrodlo jest zawsze 'reczna' i to nie jest uproszczenie: sklep NIE WIE o fakturze
// zbiorczej, wiec nie ma tu odpowiednika pollera, ktory moglby cokolwiek dopisac albo
// skasowac. Kolumne trzymamy mimo to, zeby ksztalt byl ten sam co w `platnosci` i zeby
// pozniejsze zrodlo (np. import z banku) mialo gdzie sie zapisac.
// ⚠️ KWOTA JEST SPRAWDZANA PRZED INSERT-em, i to nie jest kosmetyka. `String(kwota)` na
// `undefined` zapisywalo w bazie napis 'undefined' — po czym KAZDY odczyt salda tego okresu
// rzucal (`grosze()` slusznie odmawia), a w panelu nie bylo trasy, ktora taka wplate usuwa.
// Jeden bledny zapis zatruwal miesiac NA ZAWSZE, a jedynym wyjsciem zostawal SQL na produkcji.
//
// Walidujemy przez `grosze()` — TE SAMA funkcje, ktora pozniej te kwote czyta. Wlasny
// `Number.isFinite` byby DRUGA kopia reguly i przepuscilby to, co `grosze()` odrzuca (albo
// odwrotnie). Odmowa jest otagowana `bladOperatora`, inaczej trasa zamieni ja w „blad
// techniczny panelu" i czlowiek nie dowie sie, co poprawic.
//
// Zero i kwoty ujemne odrzucamy WPROST, dokladnie jak `parsujWplate` w domain/platnosci.js:
// wplata na 0 zl nie jest zdarzeniem, a ujemna po cichu zmniejszalaby saldo okresu.
function sprawdzKwoteWplaty(kwota) {
  const kwotaGr = grosze(kwota, 'wpłata za okres rozliczeniowy');
  if (kwotaGr <= 0) throw bladOperatora('Kwota wpłaty musi być większa od zera.');
  return kwotaGr;
}

export function dodajWplateOkresu(db, okresId, { kwota, data, metoda, uwaga }) {
  const kwotaGr = sprawdzKwoteWplaty(kwota);
  // Wiez FK odbijalaby INSERT surowym „FOREIGN KEY constraint failed" — komunikatem
  // sterownika bazy, ktory operatorowi nie mowi NIC o tym, co poszlo nie tak.
  if (!pobierzOkres(db, okresId)) throw bladOperatora('Nie ma takiego okresu rozliczeniowego.');
  // ⚠️ Bindujemy `zl(kwotaGr)` — POLICZONA kwote, TA SAMA, ktora przeszla przez bariere
  // wyzej — a NIE `String(kwota)`, czyli surowy input. To byl caly blad: dla `kwota: true`
  // walidacja przechodzila (`grosze(true)` = 100 gr), ale stary `String(kwota)` zapisywal w
  // bazie napis „true", ktorego zaden kolejny odczyt salda juz nie parsuje — dokladnie ten
  // zatruty okres, przed ktorym `sprawdzKwoteWplaty` mial bronic. Ten sam wzorzec stosuje
  // `parsujWplate` w domain/platnosci.js.
  const wynik = db.prepare(
    'INSERT INTO platnosci_okresu (okres_rozliczeniowy_id, kwota, data, metoda, uwaga, zrodlo, utworzona_at)'
    + " VALUES (?, ?, ?, ?, ?, 'reczna', ?)",
  ).run(okresId, zl(kwotaGr), data ?? null, metoda ?? null, uwaga ?? null, teraz());
  // Oddajemy ZAPISANY wiersz (tak jak `dodajWplateReczna` oddaje swoj), i to odczytany
  // z bazy: trasa dostaje `id`, bez ktorego nie ma czego pokazac ani czego usunac.
  return wplataOkresu(db, Number(wynik.lastInsertRowid));
}

/** Jedna wplata okresu po `id` — wewnetrznie, do odczytu po zapisie i przed usunieciem. */
function wplataOkresu(db, platnoscId) {
  return db.prepare('SELECT * FROM platnosci_okresu WHERE id = ?').get(platnoscId);
}

// WYJSCIE ze stanu, w ktory panel sam pozwala wejsc (przewodnik OMS, 4.9) — odpowiednik
// `usunWplateReczna` wyzej i istnieje z dokladnie tego samego powodu: omylkowo dopisana
// wplata przewraca saldo miesiaca, a gdy domyka kwote, kaze panelowi uznac okres za oplacony.
//
// Wiersz szukamy po PARZE (id wplaty, id okresu), tak samo jak przy zamowieniu: w swiezej
// bazie liczniki AUTOINCREMENT roznych tabel zbiegaja sie, wiec sam `id` przepuscilby
// pomylke argumentu w trasie (przewodnik OMS, sekcja 6, punkt 3).
//
// Odmowy dla zrodla innego niz 'reczna' NIE MA, bo nie ma jeszcze czego odmawiac: sklep
// nie wie o fakturze zbiorczej, wiec zaden poller tych wierszy nie dopisuje ani nie kasuje
// (patrz komentarz przy `dodajWplateOkresu`). Gdy pojawi sie zrodlo automatyczne — np. import
// z banku — to jest miejsce, w ktorym trzeba je oslonic, tak jak `usunWplateReczna` oslania
// wplaty ze sklepu.
export function usunWplateOkresu(db, okresId, platnoscId) {
  const w = db.prepare('SELECT * FROM platnosci_okresu WHERE id = ? AND okres_rozliczeniowy_id = ?')
    .get(platnoscId, okresId);
  if (!w) throw bladOperatora('Nie ma takiej wpłaty przy tym okresie rozliczeniowym.');
  db.prepare('DELETE FROM platnosci_okresu WHERE id = ?').run(platnoscId);
  return w;
}

/**
 * Wplaty JEDNEGO okresu, po dacie WPLATY (a gdy jej brak — po czasie zapisu), potem po `id`.
 *
 * Porzadek jest taki sam jak w `platnosciZamowienia` i to jest wymog, nie kosmetyka: obie
 * listy wplat stoja w tym samym panelu, wiec nie moga czytac sie inaczej. Sortowanie po samym
 * `id` pokazywaloby wplaty w kolejnosci WPISYWANIA, czyli zaliczke z 1 sierpnia pod przelewem
 * z 10 sierpnia tylko dlatego, ze ktos dopisal ja pozniej.
 *
 * Kwoty wracaja jako NAPISY (kolumna TEXT) — dokladnie tak, jak przyszly. Sumowac je wolno
 * wylacznie przez `sumaWplatGrosze` z domain/platnosci.js (robi to `saldoOkresuGrosze`),
 * nigdy wlasnym `Number(a) + Number(b)`.
 */
export function wplatyOkresu(db, okresId) {
  return db.prepare(
    'SELECT * FROM platnosci_okresu WHERE okres_rozliczeniowy_id = ?'
    + ' ORDER BY COALESCE(data, utworzona_at), id',
  ).all(okresId);
}
