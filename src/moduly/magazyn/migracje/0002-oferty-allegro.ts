import type { DatabaseSync } from 'node:sqlite';
import type { Migracja } from '../../../core/kontrakty.ts';

// PRZ-160 E3.01 — wystawianie ofert Allegro z karty (plan PRZ-160 etap 3, rozdz. 4, E3.01). Wyłącznie dokładanie:
// sześć nowych tabel i kolumny bez CHECK na `oferty_ustawienia_kont`; odporna na ponowienie (`IF NOT EXISTS`,
// kolumny dodawane tylko, gdy ich brak). Rejestr ofert (`oferty_kanalow`) bez zmian schematu — D31 trzyma
// `ext:<external.id>` w istniejącej kolumnie `id_zewnetrzne`, a `UNIQUE (kanal, id_zewnetrzne)` z magazyn/0001
// odrzuca dwa szkice z tym samym znacznikiem na jednym koncie.
//
// Mapy (kategorie, reguły parametrów, marki) są per środowisko Allegro (`produkcja`/`sandbox`), bo identyfikatory
// kategorii i wartości słowników różnią się między środowiskami. Kategoria i marka karty to nazwy ze słowników
// `kategorie_kart` / `marki` — bez klucza obcego, bo zmiana nazwy w słowniku jest usunięciem i wstawieniem.
// GPSR marki (D28) jest per konto, bo producent i osoba odpowiedzialna są zasobami konta.
//
// `karty_allegro` — D37: nadpisania karty tylko dla Allegro (nazwa do 75 znaków, kategoria, parametry), znikają
// z kartą. `zdjecia_kart_allegro` — D32: adres zdjęcia wgranego na konto Allegro i znacznik AI z chwili wgrania;
// znika ze zdjęciem (synchronizacja treści, która podmienia zdjęcia, wymusza ponowne wgranie).
const TABELE = [
  `CREATE TABLE IF NOT EXISTS allegro_mapa_kategorii (
  kategoria_karty TEXT NOT NULL CHECK (length(trim(kategoria_karty)) > 0),
  srodowisko TEXT NOT NULL CHECK (srodowisko IN ('produkcja', 'sandbox')),
  kategoria_allegro_id TEXT NOT NULL CHECK (length(trim(kategoria_allegro_id)) > 0),
  sciezka_json TEXT CHECK (sciezka_json IS NULL OR (json_valid(sciezka_json) AND json_type(sciezka_json) = 'array')),
  potwierdzil TEXT,
  potwierdzono_at TEXT,
  PRIMARY KEY (kategoria_karty, srodowisko)
)`,
  `CREATE TABLE IF NOT EXISTS allegro_reguly_parametrow (
  srodowisko TEXT NOT NULL CHECK (srodowisko IN ('produkcja', 'sandbox')),
  kategoria_allegro_id TEXT NOT NULL CHECK (length(trim(kategoria_allegro_id)) > 0),
  parametr_id TEXT NOT NULL CHECK (length(trim(parametr_id)) > 0),
  rodzaj TEXT NOT NULL CHECK (rodzaj IN ('stala', 'pole', 'na_karcie')),
  wartosc_json TEXT CHECK (wartosc_json IS NULL OR json_valid(wartosc_json)),
  pole TEXT,
  przelicznik TEXT,
  potwierdzil TEXT,
  zmieniono_at TEXT NOT NULL,
  PRIMARY KEY (srodowisko, kategoria_allegro_id, parametr_id)
)`,
  `CREATE TABLE IF NOT EXISTS allegro_marki (
  marka TEXT NOT NULL CHECK (length(trim(marka)) > 0),
  srodowisko TEXT NOT NULL CHECK (srodowisko IN ('produkcja', 'sandbox')),
  parametr_id TEXT,
  wartosc_id TEXT,
  wartosc_tekst TEXT,
  kategorie_sprawdzone_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(kategorie_sprawdzone_json) AND json_type(kategorie_sprawdzone_json) = 'array'),
  potwierdzil TEXT,
  zmieniono_at TEXT NOT NULL,
  PRIMARY KEY (marka, srodowisko)
)`,
  `CREATE TABLE IF NOT EXISTS allegro_marki_gpsr (
  marka TEXT NOT NULL CHECK (length(trim(marka)) > 0),
  konto TEXT NOT NULL CHECK (length(trim(konto)) > 0),
  zrodlo TEXT NOT NULL CHECK (zrodlo IN ('konto', 'wybrany')),
  producent_id TEXT,
  osoba_odpowiedzialna_id TEXT,
  zmieniono_at TEXT NOT NULL,
  PRIMARY KEY (marka, konto)
)`,
  `CREATE TABLE IF NOT EXISTS karty_allegro (
  karta_id INTEGER PRIMARY KEY REFERENCES karty_produktow(id) ON DELETE CASCADE,
  nazwa TEXT CHECK (nazwa IS NULL OR length(trim(nazwa)) > 0),
  kategoria_id TEXT CHECK (kategoria_id IS NULL OR length(trim(kategoria_id)) > 0),
  parametry_json TEXT CHECK (parametry_json IS NULL OR json_valid(parametry_json)),
  produkt_id TEXT,
  zmieniono_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS zdjecia_kart_allegro (
  zdjecie_id INTEGER NOT NULL REFERENCES zdjecia_kart(id) ON DELETE CASCADE,
  konto TEXT NOT NULL CHECK (length(trim(konto)) > 0),
  adres TEXT NOT NULL CHECK (length(trim(adres)) > 0),
  ai INTEGER NOT NULL CHECK (ai IN (0, 1)),
  wygasa_at TEXT,
  wgrano_at TEXT NOT NULL,
  PRIMARY KEY (zdjecie_id, konto)
)`,
];

// Ustawienia konta dla Allegro (§1.6, E3.13): identyfikatory warunków zwrotów, reklamacji i gwarancji, lokalizacja
// wysyłki, „Aktywuj po sprawdzeniu” (D30 — domyślnie nie), domyślna informacja o bezpieczeństwie (≤ 5000 znaków,
// pilnuje zapis w kodzie) i nazwy słowników do ekranu. Bez CHECK — runner nie pozwala dodać go do starej tabeli.
const KOLUMNY_USTAWIEN: readonly (readonly [string, string])[] = [
  ['zwroty_id', 'ALTER TABLE oferty_ustawienia_kont ADD COLUMN zwroty_id TEXT'],
  ['reklamacje_id', 'ALTER TABLE oferty_ustawienia_kont ADD COLUMN reklamacje_id TEXT'],
  ['gwarancja_id', 'ALTER TABLE oferty_ustawienia_kont ADD COLUMN gwarancja_id TEXT'],
  ['lokalizacja_json', 'ALTER TABLE oferty_ustawienia_kont ADD COLUMN lokalizacja_json TEXT'],
  ['aktywuj_po_sprawdzeniu', 'ALTER TABLE oferty_ustawienia_kont ADD COLUMN aktywuj_po_sprawdzeniu INTEGER NOT NULL DEFAULT 0'],
  ['bezpieczenstwo_domyslne', 'ALTER TABLE oferty_ustawienia_kont ADD COLUMN bezpieczenstwo_domyslne TEXT'],
  ['slowniki_json', 'ALTER TABLE oferty_ustawienia_kont ADD COLUMN slowniki_json TEXT'],
];

export const migracjaOfertAllegro: Migracja = {
  numer: 2,
  nazwa: 'oferty Allegro: mapy kategorii, parametrów i marek, nadpisania karty, zdjęcia wgrane, ustawienia konta',
  wykonaj: (db: DatabaseSync) => {
    for (const sql of TABELE) db.exec(sql);
    const sa = new Set(db.prepare('PRAGMA table_info(oferty_ustawienia_kont)').all().map((k) => (k as { name: string }).name));
    for (const [kolumna, sql] of KOLUMNY_USTAWIEN) if (!sa.has(kolumna)) db.exec(sql);
  },
};
