// Warstwa bazy dla kolejki wydruku etykiet na Zebrze. Wzorzec identyczny jak
// db/przesylki.js: funkcje operują na surowych wierszach, walidację i komunikaty dla
// operatora niosą wyjątki `bladOperatora`.
import { bladOperatora } from '../../../domena/bledy.js';
import { odroczenieMs } from '../../../domena/kolejka-druku-stan.js';

const teraz = () => new Date().toISOString();

function pobierzWiersz(db, id) {
  return db.prepare('SELECT * FROM kolejka_druku WHERE id = ?').get(id);
}

function wymagajWiersza(db, id) {
  const w = pobierzWiersz(db, id);
  if (!w) throw bladOperatora('Nie ma takiej pozycji w kolejce druku.');
  return w;
}

// CELOWO bez żadnego sprawdzenia „czy już coś czeka" — powtórny wydruk jest dozwolony
// i to NIE jest niedopatrzenie (patrz komentarz przy CREATE TABLE w schema.sql): etykieta
// może się zaciąć, rozmazać, zgubić. Każde wywołanie tworzy NOWY wiersz, w odróżnieniu
// od rozpocznijPrzesylke, gdzie druga próba jest zawsze błędem.
export function dodajDoKolejki(db, przesylkaId) {
  const wynik = db.prepare(
    "INSERT INTO kolejka_druku (przesylka_id, status, proby, utworzone_at) VALUES (?, 'oczekuje', 0, ?)",
  ).run(przesylkaId, teraz());
  return pobierzWiersz(db, Number(wynik.lastInsertRowid));
}

// Pozycje gotowe do wzięcia przez czuwacza (GET /kolejka-druku) — WYŁĄCZNIE 'oczekuje',
// którym minął czas odroczenia (albo go jeszcze nie było). 'wydrukowano' i 'porzucone'
// NIGDY nie mają tu wrócić: czuwacz odpytuje co 5 sekund, więc wydrukowana etykieta
// wracałaby na Zebrę w kółko, dopóki ktoś by tego nie zauważył (i nie zmarnował papieru).
//
// Pola w SELECT-cie (id, numerListu, zamowienie) to DOKŁADNIE te, których oczekuje
// czuwacz — patrz deploy/drukarka/czuwacz-etykiet.ps1 ($poz.id / $poz.numerListu /
// $poz.zamowienie). Nazwy MUSZĄ się zgadzać co do znaku, on definiuje kontrakt.
export function pozycjeDoWziecia(db, terazIso = teraz()) {
  return db.prepare(`
    SELECT k.id AS id, p.numer_listu AS numerListu, z.numer AS zamowienie
    FROM kolejka_druku k
    JOIN przesylki p ON p.id = k.przesylka_id
    JOIN zamowienia z ON z.id = p.zamowienie_id
    WHERE k.status = 'oczekuje' AND (k.nastepna_proba_at IS NULL OR k.nastepna_proba_at <= ?)
    ORDER BY k.utworzone_at ASC, k.id ASC
  `).all(terazIso);
}

// Ścieżka pliku ZPL dla danej pozycji kolejki — czytana z PRZESYŁKI, nie z samej pozycji
// (ZPL jest pobierany RAZ, przy nadaniu, patrz kurierzy/dpd.js i services/nadanie.js;
// kolejka_druku tylko wskazuje, KTÓRĄ przesyłkę wydrukować, a nie niesie własnej kopii pliku).
export function zplDlaPozycji(db, id) {
  const wynik = db.prepare(`
    SELECT p.etykieta_zpl_sciezka AS sciezka
    FROM kolejka_druku k JOIN przesylki p ON p.id = k.przesylka_id
    WHERE k.id = ?
  `).get(id);
  return wynik ?? null;
}

export function oznaczWydrukowano(db, id) {
  wymagajWiersza(db, id);
  db.prepare("UPDATE kolejka_druku SET status = 'wydrukowano', wydrukowane_at = ? WHERE id = ?").run(teraz(), id);
}

// Serce odporności czuwacza (patrz domain/kolejka-druku-stan.js). Awaria NIE zdejmuje
// pozycji z kolejki (status zostaje 'oczekuje') — zdejmuje ją WYŁĄCZNIE porzucPozycje,
// czyli decyzja operatora, nie automat. Odsunięcie kolejnej próby (nastepna_proba_at)
// jest OBOWIĄZKOWE: bez niego pozycja wracałaby do pozycjeDoWziecia natychmiast, a czuwacz
// odpytuje co 5 sekund — dopisywałby wpis do logu przy KAŻDYM cyklu.
export function oznaczBladDruku(db, id, powod) {
  const w = wymagajWiersza(db, id);
  const nowyProby = w.proby + 1;
  const nastepnaProba = new Date(Date.now() + odroczenieMs(nowyProby)).toISOString();
  db.prepare('UPDATE kolejka_druku SET proby = ?, ostatni_blad = ?, nastepna_proba_at = ? WHERE id = ?')
    .run(nowyProby, powod, nastepnaProba, id);
}

// JEDYNE wyjście ze stanu „pozycja ciągle się nie drukuje" — operator wie coś, czego
// panel nie wie (papier się skończył na stałe, drukarka jest odłączona na zawsze), więc
// panel nie ma prawa sam decydować, że próbuje w nieskończoność. Odpowiednik `Porzuć`
// na karcie zamówienia — panel nie może wchodzić w stan, z którego nie umie wyjść.
export function porzucPozycje(db, id) {
  wymagajWiersza(db, id);
  db.prepare("UPDATE kolejka_druku SET status = 'porzucone' WHERE id = ?").run(id);
}

// Stan pokazywany na karcie zamówienia: TYLKO najnowszy wiersz się liczy — starsze wiersze
// (np. już wydrukowane przed reprintem) są historią, nie aktualnym stanem.
export function ostatniaPozycjaDlaPrzesylki(db, przesylkaId) {
  return db.prepare('SELECT * FROM kolejka_druku WHERE przesylka_id = ? ORDER BY id DESC LIMIT 1').get(przesylkaId) ?? null;
}

// Zapytania wiązane przez moduł do jego kontekstu bazy; istniejące eksporty zachowują parytet testów.
export function createZapytania(db) {
  return {
    dodajDoKolejki: (...args) => dodajDoKolejki(db, ...args),
    pozycjeDoWziecia: (...args) => pozycjeDoWziecia(db, ...args),
    zplDlaPozycji: (...args) => zplDlaPozycji(db, ...args),
    oznaczWydrukowano: (...args) => oznaczWydrukowano(db, ...args),
    oznaczBladDruku: (...args) => oznaczBladDruku(db, ...args),
    porzucPozycje: (...args) => porzucPozycje(db, ...args),
    ostatniaPozycjaDlaPrzesylki: (...args) => ostatniaPozycjaDlaPrzesylki(db, ...args),
  };
}
