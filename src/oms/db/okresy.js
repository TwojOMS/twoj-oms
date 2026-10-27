// Warstwa bazy dla okresow rozliczeniowych klienta zbiorczego (spec 2026-08-01).
//
// Stany bierzemy z domain/okres-rozliczeniowy.js, a nie z wlasnej stalej obok: druga lista
// napisow rozjechalaby sie z domenowa przy pierwszej zmianie, a rozjazd byby CICHY —
// `okresPrzyjmujeZamowienia` po prostu przestalaby uznawac okres za otwarty i zamowienia
// przestalyby sie do niego dopisywac, bez ani jednego bledu.
import { STAN, stanFakturyOkresu } from '../../domena/okres-rozliczeniowy.js';
import { bladOperatora } from '../../domena/bledy.js';
import { idDokumentuSql } from '../../domena/dokument-programu.js';

const teraz = () => new Date().toISOString();

export function pobierzOkres(db, id) {
  return db.prepare('SELECT * FROM okresy_rozliczeniowe WHERE id = ?').get(id);
}

export function znajdzOkres(db, { klientKlucz, rok, miesiac }) {
  return db.prepare(
    'SELECT * FROM okresy_rozliczeniowe WHERE klient_klucz = ? AND rok = ? AND miesiac = ?',
  ).get(klientKlucz, rok, miesiac);
}

/**
 * Okres dla (klient, rok, miesiac) — zakladany, jesli jeszcze nie istnieje.
 *
 * ⚠️ IDEMPOTENTNIE i przez `INSERT OR IGNORE` + odczyt, a nie „sprawdz i wstaw":
 * poller i trasa recznego zapisu moga trafic tu jednoczesnie, a `UNIQUE` zamienilby
 * wyscig w surowy blad SQLite rzucony operatorowi w twarz.
 *
 * ⚠️ ...ale `OR IGNORE` polyka NIE TYLKO konflikt `UNIQUE` — polyka KAZDE naruszenie wiezu,
 * w tym `NOT NULL`. Wywolanie z pustym kluczem klienta albo bez miesiaca nie zapisaloby
 * NIC i oddaloby `undefined`, bo `klient_klucz = NULL` nie pasuje nawet do samego siebie.
 * Zamowienie dostaloby wtedy `okres_rozliczeniowy_id = undefined` i wypadlo z rozliczenia
 * zbiorczego po cichu — czyli klient nie dostalby za nie faktury. Brak wiersza PO wstawieniu
 * jest wiec bledem programisty i ma huknac TUTAJ, przy przyczynie, a nie kilka warstw dalej.
 *
 * ⚠️ PUSTY (lub sam bialy znak) `klientKlucz` NIE JEST tym samym co `NULL` — `NOT NULL`
 * go przepuszcza, `INSERT OR IGNORE` wiec nie ma czego polykac, i wiersz PO WSTAWIENIU
 * istnieje. Powyzsza straz nigdy by tego nie zlapala: powstalby okres bezimiennego klienta,
 * ktorego zaden klucz z konfiguracji nigdy nie odnajdzie — cichy blad dokladnie tego
 * rodzaju, przed ktorym ta funkcja ma bronic. Stad jawne odrzucenie PRZED INSERT-em.
 */
export function zapewnijOkres(db, { klientKlucz, rok, miesiac }) {
  if (typeof klientKlucz !== 'string' || klientKlucz.trim() === '') {
    throw new Error(
      `Nie udało się założyć okresu rozliczeniowego — pusty klucz klienta: ${JSON.stringify({ klientKlucz, rok, miesiac })}.`,
    );
  }
  db.prepare(
    'INSERT OR IGNORE INTO okresy_rozliczeniowe (klient_klucz, rok, miesiac, stan, utworzony_at)'
    + ' VALUES (?, ?, ?, ?, ?)',
  ).run(klientKlucz, rok, miesiac, STAN.OTWARTY, teraz());
  const okres = znajdzOkres(db, { klientKlucz, rok, miesiac });
  if (!okres) {
    throw new Error(
      'Nie udało się założyć okresu rozliczeniowego dla '
      + `${JSON.stringify({ klientKlucz, rok, miesiac })} — niekompletne dane okresu.`,
    );
  }
  return okres;
}

/** Identyfikatory zamowien okresu, w kolejnosci zlozenia — tak jak pojda na fakture. */
export function zamowieniaOkresu(db, id) {
  return db.prepare(
    'SELECT id FROM zamowienia WHERE okres_rozliczeniowy_id = ? ORDER BY utworzone_at, id',
  ).all(id).map((w) => w.id);
}

export function zamknijOkres(db, id) {
  db.prepare('UPDATE okresy_rozliczeniowe SET stan = ?, zamkniety_at = ? WHERE id = ?')
    .run(STAN.ZAMKNIETY, teraz(), id);
  return pobierzOkres(db, id);
}

/** Powrot do „otwarty" — po nieudanej probie wystawienia faktury (bariera, awaria inFaktu). */
export function otworzOkresPonownie(db, id) {
  db.prepare('UPDATE okresy_rozliczeniowe SET stan = ?, zamkniety_at = NULL WHERE id = ?')
    .run(STAN.OTWARTY, id);
  return pobierzOkres(db, id);
}

/**
 * Rezerwacja PRZED wywolaniem inFaktu — ten sam wzorzec, co `rozpocznijFakture`
 * w db/faktury.js. Kolumny nazywaja sie tak samo, wiec `stanFaktury()` z
 * domain/faktura-stan.js czyta ten wiersz bez zadnej adaptacji.
 *
 * ⚠️ Wiersz okresu istnieje od pierwszego zamowienia miesiaca (inaczej niz przy fakturze
 * pojedynczej, gdzie rezerwacja to `INSERT` odbijajacy sie od `UNIQUE`), wiec rezerwacja
 * jest tu zwyklym `UPDATE` — i dlatego MUSI byc WARUNKOWA. Sprawdzenie stanu w usludze
 * (services/faktura-okresu.js) nie wystarcza: miedzy nim a ta rezerwacja jest `await`
 * na `infakt.znajdzKlientaPoNip`, wiec dwa zadania zdazaja PRZEJSC STRAZ, zanim
 * ktorekolwiek cokolwiek zarezerwuje. To nie jest egzotyka „dwukliku" — to zwykle
 * przeplecenie dwoch zapytan w jednowatkowym Node, ktore przy fakturze na caly miesiac
 * konczy sie DWOMA dokumentami w inFakcie.
 *
 * Warunek powtarza to, co `stanFakturyOkresu` uznaje za „brak faktury": zadnej rezerwacji
 * (`ksef_status`), zadnego dokumentu (`infakt_uuid`, `numer`) i stan inny niz zafakturowany.
 * `stan` jest w tym warunku NIEZBEDNY, a nie ozdobny — odpowiedz inFaktu bez uuid-a i bez
 * numeru zostawia okres zafakturowany z PUSTYMI kolumnami faktury, wiec sam warunek
 * o kolumnach przepuscilby druga rezerwacje.
 *
 * Zero zmienionych wierszy znaczy „ktos nas ubiegl" — i musi byc ODMOWA, a nie ciche
 * przejscie dalej do `infakt.wystaw`.
 */
export function rozpocznijFaktureOkresu(db, id) {
  const wynik = db.prepare(
    "UPDATE okresy_rozliczeniowe SET ksef_status = 'w_toku', utworzona_at = ?"
    + ` WHERE id = ? AND ksef_status IS NULL AND ${idDokumentuSql()} IS NULL AND numer IS NULL`
    + ' AND stan <> ?',
  ).run(teraz(), id, STAN.ZAFAKTUROWANY);
  if (wynik.changes === 0) {
    throw bladOperatora(
      'Wystawianie faktury za ten okres zaczęło się już gdzie indziej (drugie kliknięcie albo '
      + 'druga karta) — panel nie wystawi drugiego dokumentu za ten sam miesiąc. Odśwież widok '
      + 'okresu i zobacz, czym skończyła się tamta próba.',
    );
  }
  return pobierzOkres(db, id);
}

// PRZ-118.03 — ten sam podwojny zapis co `zakonczFakture` w moduly/faktury/db/faktury.js:
// `program` + `dokument_id` zawsze, `infakt_uuid` tylko dla inFaktu, jedna instrukcja.
export function zakonczFaktureOkresu(db, id, { uuid, numer, ksefStatus }, { program = 'infakt' } = {}) {
  if (typeof program !== 'string' || !program) throw new Error('zakonczFaktureOkresu: brak nazwy programu fakturowego');
  db.prepare(
    'UPDATE okresy_rozliczeniowe SET program = ?, dokument_id = ?, infakt_uuid = ?, numer = ?, ksef_status = ?,'
    + ' blad_opis = NULL, stan = ? WHERE id = ?',
  ).run(program, uuid, program === 'infakt' ? uuid : null, numer, ksefStatus, STAN.ZAFAKTUROWANY, id);
  return pobierzOkres(db, id);
}

/**
 * Awaria JEDNOZNACZNA — dokumentu na pewno nie ma. Zwalniamy rezerwacje i otwieramy okres.
 *
 * ⚠️ `zamkniety_at` czyscimy razem ze stanem: po nieudanej probie okres ma wygladac
 * DOKLADNIE tak, jak przed nia. Data zamkniecia przy stanie „otwarty" to slad, ktory
 * czlowiek czyta jako „ktos ten miesiac juz zamykal" — a nikt go nie zamykal.
 */
export function zwolnijFaktureOkresu(db, id) {
  db.prepare(
    'UPDATE okresy_rozliczeniowe SET ksef_status = NULL, utworzona_at = NULL, blad_opis = NULL,'
    + ' stan = ?, zamkniety_at = NULL WHERE id = ?',
  ).run(STAN.OTWARTY, id);
  return pobierzOkres(db, id);
}

/**
 * Awaria NIEJEDNOZNACZNA (zerwane polaczenie albo 5xx PO wyslaniu zadania): dokument
 * w inFakcie MOGL powstac. Rezerwacja zostaje i blokuje ponowienie, bo drugie klikniecie
 * daloby drugi dokument. Rozstrzyga czlowiek, ktory sprawdzil w inFakcie.
 *
 * ⚠️ Okres ZOSTAJE zamkniety, celowo: skoro dokument mogl powstac, to nowe zamowienie
 * dopisane do tego miesiaca wypadloby poza fakture, ktora klient juz dostal.
 */
export function oznaczOkresDoWyjasnienia(db, id, opis) {
  db.prepare("UPDATE okresy_rozliczeniowe SET ksef_status = 'do_wyjasnienia', blad_opis = ? WHERE id = ?")
    .run(opis, id);
  return pobierzOkres(db, id);
}

/**
 * JEDYNE wyjscie ze stanu, ktorego panel sam nie rozstrzygnie — odpowiednik `odblokujFakture`
 * z db/faktury.js i istnieje z dokladnie tego samego powodu.
 *
 * Blokada po awarii niejednoznacznej jest sluszna, ale bez tej furtki okres zostawal
 * zablokowany NA ZAWSZE: ani `do_wyjasnienia`, ani `zawieszona` nie mialy zadnej drogi
 * wyjscia, a `zawieszona` powstaje przy ZWYKLYM restarcie panelu w trakcie wywolania
 * inFaktu. Jedynym ratunkiem byla reczna edycja pliku SQLite na produkcji — czyli dokladnie
 * to, przed czym panel ma chronic.
 *
 * Panel NIE WOLA inFaktu i niczego tam NIE KASUJE. To wylacznie odnotowanie faktu, ktory
 * czlowiek stwierdzil poza panelem („sprawdzilem, faktury za ten miesiac tam nie ma" albo
 * „byla i ja skasowalem"): zdejmujemy rezerwacje i otwieramy okres z powrotem.
 *
 * ⚠️ Odblokowujemy WYLACZNIE stany wymagajace decyzji czlowieka. Faktura wystawiona jest
 * nietykalna — zdjecie jej blokady zwolniloby okres, ktorego dokument NA PEWNO istnieje
 * w inFakcie (i wieczorem, w zbiorczej wysylce, pojedzie do KSeF), a nastepne klikniecie
 * daloby drugi. Stan CZYTAMY przez `stanFakturyOkresu`, nie przez `stanFaktury`: swiezy okres
 * ma puste kolumny faktury, wiec `stanFaktury` uznalby go za „wystawiony" i odmowilby
 * komunikatem o nieistniejacym dokumencie.
 */
export function odblokujFaktureOkresu(db, id) {
  const okres = pobierzOkres(db, id);
  if (!okres) throw bladOperatora('Nie ma takiego okresu rozliczeniowego.');
  const stan = stanFakturyOkresu(okres);
  if (stan === 'brak') {
    throw bladOperatora('Ten okres nie ma zablokowanej faktury — nie ma czego odblokowywać.');
  }
  if (stan === 'w_toku') {
    throw bladOperatora(
      'Wystawianie faktury za ten okres właśnie trwa — poczekaj, aż się skończy, zanim cokolwiek odblokujesz.',
    );
  }
  if (stan !== 'do_wyjasnienia' && stan !== 'zawieszona') {
    throw bladOperatora(
      `Faktura za ten okres jest wystawiona${okres.numer ? ` (${okres.numer})` : ''} — odblokowanie zdjęłoby `
      + 'blokadę z dokumentu, który na pewno istnieje w inFakcie, a kolejne kliknięcie wystawiłoby drugi. '
      + 'Chcesz ją anulować? Skasuj ją w inFakcie (albo, jeśli już poszła do KSeF, wystaw korektę) — '
      + 'panel tego za ciebie nie zrobi.',
    );
  }
  return zwolnijFaktureOkresu(db, id);
}

/**
 * Odpiecie zamowienia od okresu — WYJSCIE Z POMYLKI, ktorego ten modul nie mial do 17.08.2026.
 *
 * ⚠️ WARUNKIEM JEST PARA (okres, zamowienie), nie samo zamowienie — ten sam wzorzec, co
 * `usunWplateOkresu`. Identyfikator ze starej, otwartej karty albo z cudzego ekranu
 * odpinalby inaczej zamowienie z MIESIACA, na ktory operator wcale nie patrzy.
 *
 * ⚠️ Bariera „czy w ogole wolno odpinac" (stan faktury okresu) siedzi w `domain/zmiana-okresu.js`
 * i wola ja trasa. Tutaj jest wylacznie tozsamosc pary — warstwa `db/` nie zna stanow faktury.
 */
export function odepnijZamowienieOdOkresu(db, okresId, zamowienieId) {
  const z = db.prepare('SELECT id FROM zamowienia WHERE id = ? AND okres_rozliczeniowy_id = ?')
    .get(zamowienieId, okresId);
  if (!z) throw bladOperatora('To zamówienie nie należy do tego okresu rozliczeniowego.');
  db.prepare('UPDATE zamowienia SET okres_rozliczeniowy_id = NULL, zmienione_at = ? WHERE id = ?')
    .run(new Date().toISOString(), zamowienieId);
  return zamowienieId;
}

/**
 * Dopisanie zamowienia do okresu.
 *
 * ⚠️ NIE NADPISUJE CUDZEJ PRZYNALEZNOSCI. Przeniesienie miedzy miesiacami to decyzja o tym,
 * na ktorej fakturze zamowienie sie znajdzie — ma isc przez jawne odpiecie, a nie po cichu
 * jednym `UPDATE`. Warunek stoi W SQL-u (`okres_rozliczeniowy_id IS NULL`), nie tylko
 * w odczycie wyzej, zeby dwa rownolegle zadania nie przepchnely obu zmian.
 */
export function przypiszZamowienieDoOkresu(db, okresId, zamowienieId) {
  const wynik = db.prepare(
    'UPDATE zamowienia SET okres_rozliczeniowy_id = ?, zmienione_at = ?'
    + ' WHERE id = ? AND okres_rozliczeniowy_id IS NULL',
  ).run(okresId, new Date().toISOString(), zamowienieId);
  if (!wynik.changes) {
    throw bladOperatora(
      'Nie dopisano zamówienia do okresu — albo nie ma takiego zamówienia, albo jest już '
      + 'przypisane do jakiegoś miesiąca (wtedy najpierw je odepnij).',
    );
  }
  return zamowienieId;
}
