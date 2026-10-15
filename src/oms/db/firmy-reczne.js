import { bladOperatora } from '../../domena/bledy.js';
import { typKategorii } from './kategorie-kosztow.js';

// ⚠️⚠️ SLOWNIK FIRM, KTORYCH FAKTUR NIE MA W KSeF — i jedyny powod, dla ktorego formularz
// kosztu recznego ma TRZY POLA zamiast osmiu (2026-08-13, prosba wlasciciela: „wystarczy
// tabela z dopisywaniem fv: 1. Firma (pole wyboru np. facebook) 2. data 3. kwota — tyle").
//
// Za pozycja listy stoi komplet tego, czego operator NIE MA WPISYWAC: pelna nazwa sprzedawcy,
// kategoria kosztu i typ. Uzasadnienie ksztaltu tabeli (dwie nazwy, typ jako kopia) stoi przy
// `firmy_reczne` w schema.sql i nie ma go tu drugi raz.
//
// ⚠️ CZEGO TU NIE MA I MIEC NIE MA: kasowania firmy ani jej poprawiania. Wiersz kosztu trzyma
// nazwe sprzedawcy i kategorie WPROST (kopia, nie odnosnik), wiec skasowanie firmy nie
// popsuloby zadnego kosztu — ale tez niczego nie naprawia, a lista, ktora rosnie o jedna
// pozycje na kwartal, nie potrzebuje sprzataczki. Zle wpisana firma kosztuje jedna pozycje
// na liscie wyboru; zle wpisany koszt poprawia sie na ekranie poprawki.

// Trzy firmy, od ktorych faktury przychodza CO MIESIAC — czyli caly powod tej funkcji.
// Pelne nazwy sa takie, jak na fakturach; kategorie to rozstrzygniecie wlasciciela
// (13.08.2026), a nie domysl.
const STARTOWE = [
];

// ⚠️ `INSERT OR IGNORE`, nigdy `REPLACE` — ta sama granica, co przy kategoriach startowych
// (db/kategorie-kosztow.js): wgranie chodzi przy KAZDYM starcie kontenera, wiec `REPLACE`
// cofalby wlascicielowi kazda poprawke nazwy albo kategorii przy najblizszym wdrozeniu,
// po cichu i bez sladu.
export function wgrajFirmyStartowe(db) {
  const wstaw = db.prepare(
    'INSERT OR IGNORE INTO firmy_reczne (nazwa, sprzedawca, kategoria, typ, dodana_at)'
    + ' VALUES (?,?,?,?,?)',
  );
  const kiedy = new Date().toISOString();
  for (const [nazwa, sprzedawca, kategoria, typ] of STARTOWE) {
    wstaw.run(nazwa, sprzedawca, kategoria, typ, kiedy);
  }
}

export const wszystkieFirmyReczne = (db) => db.prepare(
  'SELECT nazwa, sprzedawca, kategoria, typ FROM firmy_reczne ORDER BY nazwa',
).all();

// `undefined` znaczy „takiej firmy nie ma na liscie" i tak ma to czytac wolajacy: o tym, ze
// jest to odmowa dla czlowieka, decyduje `naWierszReczny` (domain/koszt-reczny.js) — tam,
// gdzie stoi cala reszta sprawdzen wpisu recznego.
export const firmaReczna = (db, nazwa) => db.prepare(
  'SELECT nazwa, sprzedawca, kategoria, typ FROM firmy_reczne WHERE nazwa = ?',
).get(String(nazwa ?? '').trim());

// ⚠️ DOPISANIE FIRMY MA DOKLADNIE DWA POLA: nazwe i kategorie. Typ NIE JEST trzecim polem —
// dobiera sie go ze slownika kategorii, bo kategoria juz go zna (db/kategorie-kosztow.js).
// Trzecie pole znaczyloby, ze ta sama kategoria moze dostac tu inny typ niz w rozbiciu
// miesiaca — czyli rozjazd progu rentownosci wpisywany przez formularz.
//
// ⚠️ PELNA NAZWA SPRZEDAWCY = NAZWA Z LISTY. Startowe trzy pozycje maja te nazwy rozne
// („Facebook (Meta)" na liscie, „Meta Platforms Ireland Limited" na dokumencie), bo tak
// wygladaja ich faktury i wpisal je czlowiek, ktory je widzial. Formularz o pelna nazwe NIE
// PYTA: to byloby czwarte pole na ekranie, ktorego cala tresc brzmi „przepisz to samo".
export function dopiszFirmeReczna(db, nazwa, kategoria) {
  const nazwaFirmy = String(nazwa ?? '').trim();
  if (!nazwaFirmy) {
    throw bladOperatora('Podaj nazwę firmy — bez niej nie ma czego dopisać do listy.');
  }
  const nazwaKategorii = String(kategoria ?? '').trim();
  const typ = typKategorii(db, nazwaKategorii);
  if (!typ) {
    throw bladOperatora(
      `Panel nie zna kategorii „${nazwaKategorii}" — wybierz jedną z listy. Kategoria niesie `
      + 'typ kosztu (zmienny / stały / drobne), a bez niego wpis nie wszedłby do rozbicia.',
    );
  }
  db.prepare(
    'INSERT OR IGNORE INTO firmy_reczne (nazwa, sprzedawca, kategoria, typ, dodana_at)'
    + ' VALUES (?,?,?,?,?)',
  ).run(nazwaFirmy, nazwaFirmy, nazwaKategorii, typ, new Date().toISOString());
  return nazwaFirmy;
}
