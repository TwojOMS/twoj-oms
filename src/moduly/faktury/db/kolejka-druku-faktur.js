// Warstwa bazy dla kolejki wydruku FAKTUR — Brother MFC-J6510DW po WiFi, druk przez
// sterownik Windows na komputerze z czuwaczem.
//
// ⚠️ DLACZEGO OSOBNO OD `db/kolejka-druku.js`, a nie jedna wspolna tabela: pelne uzasadnienie
// stoi przy CREATE TABLE w schema.sql. W skrocie — na komputerze produkcyjnym chodzi STARY
// czuwacz etykiet, ktory KAZDA pozycje z `/kolejka-druku` wysyla na Zebre w trybie RAW.
// Wspolna tabela znaczylaby PDF-a wyslanego jako ZPL. Nowy adres stary skrypt nigdy nie wola.
//
// ⚠️ REGULA ODRACZANIA JEST WSPOLNA (`odroczenieMs` z domain/kolejka-druku-stan.js) — powiela
// sie tu SQL, NIGDY regula. Druga kopia wykladniczego odroczenia rozjechalaby sie z pierwsza
// przy pierwszej zmianie i jedna z kolejek zaczelaby dobijac sie do panelu co 5 sekund.
import { bladOperatora } from '../../../domena/bledy.js';
import { odroczenieMs } from '../../../domena/kolejka-druku-stan.js';

const teraz = () => new Date().toISOString();

const pobierzWiersz = (db, id) => db.prepare('SELECT * FROM kolejka_druku_faktur WHERE id = ?').get(id);

function wymagajWiersza(db, id) {
  const w = pobierzWiersz(db, id);
  if (!w) throw bladOperatora('Nie ma takiej pozycji w kolejce druku faktur.');
  return w;
}

/**
 * ⚠️ CELOWO bez sprawdzenia „czy juz cos czeka" — powtorny wydruk jest DOZWOLONY: papier
 * sie zacial, wydruk wyszedl blady, klient chce drugi egzemplarz. Kazde klikniecie tworzy
 * NOWY wiersz. To ta sama decyzja, co przy etykietach.
 */
export function dodajFaktureDoKolejki(db, fakturaId) {
  const wynik = db.prepare(
    "INSERT INTO kolejka_druku_faktur (faktura_id, status, proby, utworzone_at) VALUES (?, 'oczekuje', 0, ?)",
  ).run(fakturaId, teraz());
  return pobierzWiersz(db, Number(wynik.lastInsertRowid));
}

/**
 * ⚠️⚠️ PROG WYGASNIECIA ZAJECIA. Komputer potrafi zasnac albo zostac wylaczony w polowie
 * wydruku — zadanie zajete NA ZAWSZE nie wydrukowaloby sie nigdy, i to bez sladu. Po tym
 * czasie wraca do puli.
 *
 * Cena tej decyzji jest znana: jesli tamto stanowisko zdazylo wydrukowac, ale nie zdazylo
 * potwierdzic, kartka wyjdzie DWA RAZY. Wybor jest swiadomy — papier jest odwracalny, brak
 * faktury u klienta nie jest. Piec minut to z zapasem wiecej, niz trwa pobranie PDF-u
 * z inFaktu i oddanie go do bufora wydruku (limit czuwacza to domyslnie 120 s).
 */
export const PROG_ZAJECIA_MS = 5 * 60 * 1000;

/**
 * Pozycje DO WZIECIA PRZEZ TO STANOWISKO — i jednoczesnie ICH ZAJECIE.
 *
 * ⚠️⚠️ TA FUNKCJA ZMIENIA STAN, mimo ze wola ja zwykly GET. To jest swiadome i konieczne:
 * czuwacz moze chodzic na WIECEJ NIZ JEDNYM komputerze (oba maja sterownik tej samej
 * drukarki WiFi). Gdyby odpytanie bylo czystym odczytem, KAZDE stanowisko dostaloby to samo
 * zadanie i faktura wyjechalaby tyle razy, ile stanowisk akurat dziala.
 *
 * Zajecie idzie JEDNYM UPDATE-em z warunkiem — tak samo, jak `zajmijWysylkeDoAllegro`
 * w db/faktury.js. Dwa rownolegle odpytania nie moga zajac tego samego wiersza, bo drugie
 * nie znajdzie juz wiersza spelniajacego warunek.
 *
 * ⚠️ Pola w SELECT-cie definiuja KONTRAKT ze skryptem czuwacza
 * (deploy/drukarka/czuwacz-faktur.ps1: $poz.id / $poz.numer / $poz.zamowienie) — nazwy
 * musza sie zgadzac co do znaku.
 */
export function fakturyDoWziecia(db, opcje = {}) {
  // Zgodnosc wsteczna z wolaniem `fakturyDoWziecia(db, '2999-01-01...')` — testy i stary
  // kod podawaly sam znacznik czasu.
  const { stanowisko = 'nieznane', terazIso = teraz(), prog = PROG_ZAJECIA_MS } = (
    typeof opcje === 'string' ? { terazIso: opcje } : opcje
  );
  const sierota = new Date(new Date(terazIso).getTime() - prog).toISOString();

  // ⚠️ NAJPIERW ZAJMUJEMY, POTEM CZYTAMY. Odwrotna kolejnosc (SELECT, potem UPDATE po id)
  // zostawialaby okno miedzy jednym a drugim — dokladnie to okno, przez ktore drugie
  // stanowisko zabraloby to samo zadanie.
  db.prepare(`
    UPDATE kolejka_druku_faktur SET zajete_przez = ?, zajete_at = ?
    WHERE status = 'oczekuje'
      AND (nastepna_proba_at IS NULL OR nastepna_proba_at <= ?)
      AND (zajete_przez IS NULL OR zajete_at IS NULL OR zajete_at < ?)
  `).run(stanowisko, terazIso, terazIso, sierota);

  return db.prepare(`
    SELECT k.id AS id, f.numer AS numer, z.numer AS zamowienie, z.id AS zamowienieId
    FROM kolejka_druku_faktur k
    JOIN faktury f ON f.id = k.faktura_id
    JOIN zamowienia z ON z.id = f.zamowienie_id
    WHERE k.status = 'oczekuje' AND k.zajete_przez = ? AND k.zajete_at = ?
    ORDER BY k.utworzone_at ASC, k.id ASC
  `).all(stanowisko, terazIso);
}

/**
 * Zamowienie, ktorego faktury dotyczy pozycja kolejki.
 *
 * ⚠️ POTRZEBNE, BO PANEL NIE TRZYMA KOPII PDF-U. Dokument pobiera sie z inFaktu NA SWIEZO
 * przy kazdym zadaniu (services/faktura.js) — kolejka wskazuje wiec, KTORA fakture
 * wydrukowac, a tresc leci ta sama droga, co przy „Pobierz PDF". Kopia na dysku klamalaby
 * po korekcie: z drukarki wyszedlby dokument, ktorego juz nie ma w inFakcie.
 */
export function zamowienieDlaPozycji(db, id) {
  const w = db.prepare(`
    SELECT f.zamowienie_id AS zamowienieId, f.numer AS numer
    FROM kolejka_druku_faktur k JOIN faktury f ON f.id = k.faktura_id
    WHERE k.id = ?
  `).get(id);
  return w ?? null;
}

export function oznaczFaktureWydrukowana(db, id) {
  wymagajWiersza(db, id);
  db.prepare("UPDATE kolejka_druku_faktur SET status = 'wydrukowano', wydrukowane_at = ? WHERE id = ?")
    .run(teraz(), id);
}

/**
 * Awaria NIE zdejmuje pozycji z kolejki (status zostaje 'oczekuje') — zdejmuje ja WYLACZNIE
 * `porzucFakture`, czyli decyzja czlowieka. Odsuniecie kolejnej proby jest OBOWIAZKOWE:
 * bez niego pozycja wracalaby natychmiast, a czuwacz pyta co kilka sekund.
 */
export function oznaczBladDrukuFaktury(db, id, powod) {
  const w = wymagajWiersza(db, id);
  const proby = w.proby + 1;
  const nastepna = new Date(Date.now() + odroczenieMs(proby)).toISOString();
  // ⚠️ ZAJECIE ZWALNIAMY OD RAZU. Bez tego zadanie po nieudanej probie czekaloby jeszcze
  // na wygasniecie zajecia (5 min) ZAMIAST wrocic po odroczeniu — a przy dwoch stanowiskach
  // to drugie nie moglo by go przejac, choc jego drukarka moze akurat dzialac.
  db.prepare(
    'UPDATE kolejka_druku_faktur SET proby = ?, ostatni_blad = ?, nastepna_proba_at = ?,'
    + ' zajete_przez = NULL, zajete_at = NULL WHERE id = ?',
  ).run(proby, powod, nastepna, id);
}

/**
 * JEDYNE wyjscie ze stanu „faktura ciagle sie nie drukuje" — panel nie ma prawa probowac
 * w nieskonczonosc, a czlowiek wie to, czego panel nie wie (drukarka odlaczona na stale).
 * Niezmiennik 4.9: panel nie moze wchodzic w stan, z ktorego nie umie wyjsc.
 */
export function porzucFakture(db, id) {
  wymagajWiersza(db, id);
  db.prepare("UPDATE kolejka_druku_faktur SET status = 'porzucone' WHERE id = ?").run(id);
}

/** Stan na karcie: liczy sie TYLKO najnowszy wiersz — starsze sa historia po powtorkach. */
export function ostatniaPozycjaDlaFaktury(db, fakturaId) {
  return db.prepare('SELECT * FROM kolejka_druku_faktur WHERE faktura_id = ? ORDER BY id DESC LIMIT 1')
    .get(fakturaId) ?? null;
}

export function createZapytania(db) {
  return {
    dodajFaktureDoKolejki: (...args) => dodajFaktureDoKolejki(db, ...args),
    fakturyDoWziecia: (...args) => fakturyDoWziecia(db, ...args),
    zamowienieDlaPozycji: (...args) => zamowienieDlaPozycji(db, ...args),
    oznaczFaktureWydrukowana: (...args) => oznaczFaktureWydrukowana(db, ...args),
    oznaczBladDrukuFaktury: (...args) => oznaczBladDrukuFaktury(db, ...args),
    porzucFakture: (...args) => porzucFakture(db, ...args),
    ostatniaPozycjaDlaFaktury: (...args) => ostatniaPozycjaDlaFaktury(db, ...args),
  };
}
