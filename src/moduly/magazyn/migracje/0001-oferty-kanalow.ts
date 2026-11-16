import type { Migracja } from '../../../core/kontrakty.ts';

// Oferty wystawiane z OMS-u na kanał.
// Moduł `magazyn`: dwie nowe tabele, odwołanie do `karty_produktow` bez jej zmiany. Wyłącznie dokładanie,
// odporna na ponowienie (`IF NOT EXISTS`).
//
// `oferty_kanalow` — rejestr ofert: jedna oferta OMS na kartę i konto kanału (indeks częściowy), kolejne wiersze
// tylko przez przejęcie (`pochodzenie = 'przejeta'`); unikalna para (konto kanału, id zewnętrzne). Tryb:
// przejęta → `obserwowana`, z OMS → `zarzadzana`. Ostatnio wysłane pola, skrót treści, ilość i cena oraz
// ostatni odczyt z kanału (stan, ilość, cena, zamrożone pola) służą porównaniom pętli; cena czekająca na
// potwierdzenie ma własną kolumnę. Wiersz kartę wskazuje bez kaskady: oferta nie znika po cichu, a przy wycofanej
// karcie pętla ofert zdejmuje ją z kanału. Kwoty w groszach.
//
// `oferty_ustawienia_kont` — ustawienia ofert konta kanału, wiersz per klucz konta. Bez klucza obcego, bo konta
// z env nie mają wiersza w `kanaly_sprzedazy`; brak wiersza = wartości domyślne. Oferty są domyślnie wstrzymane
// (`oferty_czynne = 0`) dla każdego konta, istniejącego i nowego. Stała ilość nie ma wartości domyślnej
// (NULL = nieustawiona). Narzut w punktach bazowych (1250 = 12,5%), próg potwierdzenia ceny 20%.
// Dalej: czas wysyłki, cennik dostaw, VAT domyślny, producent i osoba odpowiedzialna.
const OFERTY = `CREATE TABLE IF NOT EXISTS oferty_kanalow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  karta_id INTEGER NOT NULL REFERENCES karty_produktow(id),
  kanal TEXT NOT NULL CHECK (length(trim(kanal)) > 0),
  id_zewnetrzne TEXT NOT NULL CHECK (length(trim(id_zewnetrzne)) > 0),
  pochodzenie TEXT NOT NULL CHECK (pochodzenie IN ('oms', 'przejeta')),
  tryb TEXT NOT NULL CHECK (tryb IN ('obserwowana', 'zarzadzana')),
  stan TEXT NOT NULL DEFAULT 'szkic'
    CHECK (stan IN ('szkic', 'do_wyslania', 'wyslana', 'sprawdzana', 'aktywna', 'nieaktywna', 'problem', 'blad')),
  problemy_json TEXT CHECK (problemy_json IS NULL OR (json_valid(problemy_json) AND json_type(problemy_json) = 'array')),
  wyslane_pola_json TEXT CHECK (wyslane_pola_json IS NULL OR json_valid(wyslane_pola_json)),
  wyslany_skrot TEXT,
  wyslana_ilosc INTEGER CHECK (wyslana_ilosc IS NULL OR wyslana_ilosc >= 0),
  wyslana_cena_gr INTEGER CHECK (wyslana_cena_gr IS NULL OR wyslana_cena_gr >= 0),
  wyslano_at TEXT,
  odczyt_ilosc INTEGER CHECK (odczyt_ilosc IS NULL OR odczyt_ilosc >= 0),
  odczyt_cena_gr INTEGER CHECK (odczyt_cena_gr IS NULL OR odczyt_cena_gr >= 0),
  odczyt_status TEXT,
  odczyt_zamrozone_json TEXT CHECK (odczyt_zamrozone_json IS NULL OR json_valid(odczyt_zamrozone_json)),
  odczyt_zarchiwizowana INTEGER CHECK (odczyt_zarchiwizowana IS NULL OR odczyt_zarchiwizowana IN (0, 1)),
  odczytano_at TEXT,
  cena_do_potwierdzenia_gr INTEGER CHECK (cena_do_potwierdzenia_gr IS NULL OR cena_do_potwierdzenia_gr >= 0),
  liczba_prob INTEGER NOT NULL DEFAULT 0 CHECK (liczba_prob >= 0),
  nastepna_proba_at TEXT,
  blad TEXT,
  utworzono_at TEXT NOT NULL,
  zmieniono_at TEXT NOT NULL,
  UNIQUE (kanal, id_zewnetrzne)
)`;

const USTAWIENIA = `CREATE TABLE IF NOT EXISTS oferty_ustawienia_kont (
  klucz TEXT PRIMARY KEY CHECK (length(trim(klucz)) > 0),
  oferty_czynne INTEGER NOT NULL DEFAULT 0 CHECK (oferty_czynne IN (0, 1)),
  narzut_bp INTEGER NOT NULL DEFAULT 0 CHECK (narzut_bp BETWEEN 0 AND 100000),
  prog_potwierdzenia_bp INTEGER NOT NULL DEFAULT 2000 CHECK (prog_potwierdzenia_bp BETWEEN 1 AND 100000),
  stala_ilosc INTEGER CHECK (stala_ilosc IS NULL OR stala_ilosc BETWEEN 1 AND 1000000),
  czas_wysylki_dni INTEGER CHECK (czas_wysylki_dni IS NULL OR czas_wysylki_dni BETWEEN 0 AND 365),
  cennik_dostaw TEXT,
  stawka_vat TEXT CHECK (stawka_vat IS NULL OR stawka_vat IN ('23', '8', '5', '0', 'zw')),
  producent_id TEXT,
  osoba_odpowiedzialna_id TEXT,
  zmieniono_at TEXT NOT NULL,
  aktor_login TEXT
)`;

export const migracjaOfertKanalow: Migracja = {
  numer: 1,
  nazwa: 'rejestr ofert kanalow i ustawienia ofert kont',
  wykonaj(db) {
    db.exec(OFERTY);
    db.exec('CREATE INDEX IF NOT EXISTS oferty_kanalow_zegar ON oferty_kanalow (stan, nastepna_proba_at)');
    db.exec('CREATE INDEX IF NOT EXISTS oferty_kanalow_karta ON oferty_kanalow (karta_id, kanal)');
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS oferty_kanalow_jedna_oms ON oferty_kanalow (karta_id, kanal)
      WHERE pochodzenie = 'oms'`);
    db.exec(USTAWIENIA);
  },
};
