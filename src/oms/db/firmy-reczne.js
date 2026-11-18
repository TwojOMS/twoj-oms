import { bladOperatora } from '../../domena/bledy.js';
import { typKategorii } from './kategorie-kosztow.js';

// ⚠️⚠️ SLOWNIK FIRM, KTORYCH FAKTUR NIE MA W KSeF — i jedyny powod, dla ktorego formularz
// kosztu ręcznego ma TRZY POLA: firmę (pole wyboru), datę i kwotę.
//
// Za pozycja listy stoi komplet tego, czego operator NIE MA WPISYWAC: pelna nazwa sprzedawcy,
// kategoria kosztu i typ.
//
// ⚠️ CZEGO TU NIE MA I MIEC NIE MA: kasowania firmy ani jej poprawiania. Wiersz kosztu trzyma
// nazwe sprzedawcy i kategorie WPROST (kopia, nie odnosnik), wiec skasowanie firmy nie
// popsuloby zadnego kosztu — ale tez niczego nie naprawia, a lista, która rośnie
// rzadko, nie potrzebuje sprzątaczki. Zle wpisana firma kosztuje jedna pozycje
// na liscie wyboru; zle wpisany koszt poprawia sie na ekranie poprawki.

export const wszystkieFirmyReczne = (db) =>
  db.prepare('SELECT nazwa, sprzedawca, kategoria, typ FROM firmy_reczne ORDER BY nazwa').all();

// `undefined` znaczy „takiej firmy nie ma na liscie" i tak ma to czytac wolajacy: o tym, ze
// jest to odmowa dla czlowieka, decyduje `naWierszReczny` (domena/koszt-reczny.js) — tam,
// gdzie stoi cala reszta sprawdzen wpisu recznego.
export const firmaReczna = (db, nazwa) =>
  db
    .prepare('SELECT nazwa, sprzedawca, kategoria, typ FROM firmy_reczne WHERE nazwa = ?')
    .get(String(nazwa ?? '').trim());

// ⚠️ DOPISANIE FIRMY MA DOKLADNIE DWA POLA: nazwe i kategorie. Typ NIE JEST trzecim polem —
// dobiera sie go ze slownika kategorii, bo kategoria juz go zna (db/kategorie-kosztow.js).
// Trzecie pole znaczyloby, ze ta sama kategoria moze dostac tu inny typ niz w rozbiciu
// miesiaca — czyli rozjazd progu rentownosci wpisywany przez formularz.
//
// ⚠️ PEŁNA NAZWA SPRZEDAWCY = NAZWA Z LISTY. Tabela ma osobną kolumnę `sprzedawca` (nazwa jak
// na dokumencie może różnić się od krótkiej nazwy na liście), ale formularz o pełną nazwę NIE
// PYTA: to byłoby kolejne pole na ekranie, którego cała treść brzmi „przepisz to samo".
export function dopiszFirmeReczna(db, nazwa, kategoria) {
  const nazwaFirmy = String(nazwa ?? '').trim();
  if (!nazwaFirmy) {
    throw bladOperatora('Podaj nazwę firmy — bez niej nie ma czego dopisać do listy.');
  }
  const nazwaKategorii = String(kategoria ?? '').trim();
  const typ = typKategorii(db, nazwaKategorii);
  if (!typ) {
    throw bladOperatora(
      `Panel nie zna kategorii „${nazwaKategorii}" — wybierz jedną z listy. Kategoria niesie ` +
        'typ kosztu (zmienny / stały / drobne), a bez niego wpis nie wszedłby do rozbicia.',
    );
  }
  db.prepare(
    'INSERT OR IGNORE INTO firmy_reczne (nazwa, sprzedawca, kategoria, typ, dodana_at)' + ' VALUES (?,?,?,?,?)',
  ).run(nazwaFirmy, nazwaFirmy, nazwaKategorii, typ, new Date().toISOString());
  return nazwaFirmy;
}
