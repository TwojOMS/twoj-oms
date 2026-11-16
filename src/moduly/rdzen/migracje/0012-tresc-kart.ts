import type { Migracja } from '../../../core/kontrakty.ts';

// Model treści karty produktu. Wyłącznie dokładanie: kolumny NULL na istniejących
// tabelach (bez nowych ograniczeń), cztery nowe tabele i oznaczenie istniejących pól jako `zastane`.
// Odporność jak 0011: kolumna tylko gdy jej brak, tabele i indeksy IF NOT EXISTS, INSERT OR IGNORE.
//
// Reguła importu (`importMozeZapisac` w src/domena/zrodla-pol.js): pole z wierszem źródła reczne = 1 jest
// chronione zawsze; poza tym import zapisuje pole puste albo takie, którego źródłem jest on sam lub połączenie
// dalej na liście, albo źródło spoza tej listy.
// Pustość w SQL niżej musi być taka sama jak `polePuste` w JS (pilnuje test).

const KOLUMNY: readonly [string, string, string][] = [
  // {"sekcje":[{"elementy":[…]}]}; NULL = brak sekcji, stare `opis` zostaje.
  ['karty_produktow', 'opis_sekcje_json', 'ALTER TABLE karty_produktow ADD COLUMN opis_sekcje_json TEXT'],
  // Klucz rodzica ze sklepu z prefiksem połączenia, np. 'woo_sklep:812'.
  ['karty_produktow', 'grupa_wariantow', 'ALTER TABLE karty_produktow ADD COLUMN grupa_wariantow TEXT'],
  // Znacznik „współtworzone z AI”, 0/1, NULL = nieznane.
  ['karty_produktow', 'ai_wspoltworzone', 'ALTER TABLE karty_produktow ADD COLUMN ai_wspoltworzone INTEGER'],
  // Kolumna TEXT, ale trzyma JSON: {"typ":"TEXT","tekst":"…"} albo {"typ":"ATTACHMENTS",…}.
  // Poprawność JSON pilnuje zapis — CHECK na istniejącej tabeli byłby nowym ograniczeniem.
  ['karty_produktow', 'informacja_bezpieczenstwa', 'ALTER TABLE karty_produktow ADD COLUMN informacja_bezpieczenstwa TEXT'],
  // Wznowienie importu treści idzie po ofercie: kiedy pobrano treść i jaki znacznik zmiany miała oferta.
  ['produkty_sklepowe', 'tresc_pobrana_at', 'ALTER TABLE produkty_sklepowe ADD COLUMN tresc_pobrana_at TEXT'],
  ['produkty_sklepowe', 'tresc_zmieniona_at', 'ALTER TABLE produkty_sklepowe ADD COLUMN tresc_zmieniona_at TEXT'],
];

const TABELE = `
CREATE INDEX IF NOT EXISTS karty_produktow_grupa ON karty_produktow (grupa_wariantow) WHERE grupa_wariantow IS NOT NULL;

CREATE TABLE IF NOT EXISTS karty_zrodla_pol (
  karta_id     INTEGER NOT NULL REFERENCES karty_produktow(id) ON DELETE CASCADE,
  pole         TEXT    NOT NULL CHECK (length(trim(pole)) > 0),
  zrodlo       TEXT    NOT NULL CHECK (length(trim(zrodlo)) > 0),
  reczne       INTEGER NOT NULL DEFAULT 0 CHECK (reczne IN (0, 1)),
  zmieniono_at TEXT    NOT NULL,
  PRIMARY KEY (karta_id, pole),
  CHECK (zrodlo NOT IN ('reczne', 'zastane', 'api') OR reczne = 1)
);

CREATE TABLE IF NOT EXISTS zdjecia_kart (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  karta_id       INTEGER NOT NULL REFERENCES karty_produktow(id) ON DELETE CASCADE,
  kolejnosc      INTEGER NOT NULL CHECK (kolejnosc >= 0),
  zrodlo         TEXT    NOT NULL CHECK (length(trim(zrodlo)) > 0),
  adres_zrodlowy TEXT,
  plik           TEXT,
  sha256         TEXT CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  typ            TEXT CHECK (typ IS NULL OR typ IN ('image/jpeg', 'image/png', 'image/webp')),
  rozmiar        INTEGER CHECK (rozmiar IS NULL OR rozmiar > 0),
  szerokosc      INTEGER CHECK (szerokosc IS NULL OR szerokosc > 0),
  wysokosc       INTEGER CHECK (wysokosc IS NULL OR wysokosc > 0),
  utworzono_at   TEXT    NOT NULL,
  CHECK (plik IS NOT NULL OR adres_zrodlowy IS NOT NULL),
  CHECK ((plik IS NULL) = (sha256 IS NULL)),
  CHECK (plik IS NULL OR (typ IS NOT NULL AND rozmiar IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS zdjecia_kart_karta ON zdjecia_kart (karta_id, kolejnosc);
CREATE INDEX IF NOT EXISTS zdjecia_kart_sha ON zdjecia_kart (sha256) WHERE sha256 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS zdjecia_kart_karta_sha ON zdjecia_kart (karta_id, sha256) WHERE sha256 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS zdjecia_kart_karta_odnosnik ON zdjecia_kart (karta_id, adres_zrodlowy) WHERE plik IS NULL;

CREATE TABLE IF NOT EXISTS karty_dane_kanalu (
  karta_id               INTEGER NOT NULL REFERENCES karty_produktow(id) ON DELETE CASCADE,
  typ_kanalu             TEXT    NOT NULL CHECK (length(trim(typ_kanalu)) > 0),
  polaczenie             TEXT    NOT NULL CHECK (length(trim(polaczenie)) > 0),
  oferta_id              TEXT    NOT NULL,
  produkt_id             TEXT,
  kategoria_id           TEXT,
  kategoria_sciezka_json TEXT CHECK (kategoria_sciezka_json IS NULL OR json_valid(kategoria_sciezka_json)),
  parametry_json         TEXT CHECK (parametry_json IS NULL OR json_valid(parametry_json)),
  ai_wspoltworzone       INTEGER CHECK (ai_wspoltworzone IS NULL OR ai_wspoltworzone IN (0, 1)),
  oferta_zmieniona_at    TEXT,
  pobrano_at             TEXT    NOT NULL,
  PRIMARY KEY (karta_id, typ_kanalu)
);
CREATE INDEX IF NOT EXISTS karty_dane_kanalu_oferta ON karty_dane_kanalu (polaczenie, oferta_id);

CREATE TABLE IF NOT EXISTS kanaly_kategorie (
  polaczenie     TEXT NOT NULL,
  kategoria_id   TEXT NOT NULL,
  sciezka_json   TEXT NOT NULL CHECK (json_valid(sciezka_json)),
  parametry_json TEXT CHECK (parametry_json IS NULL OR json_valid(parametry_json)),
  pobrano_at     TEXT NOT NULL,
  PRIMARY KEY (polaczenie, kategoria_id)
);
`;

// Pustość jak `polePuste`: tekst z samych spacji, \t, \n, \r to brak; wymiary i waga <= 0 to brak;
// cena 0 zł to wartość. Bez `paczkomat` i `wycofana` — to nie treść z kanału.
const NIEPUSTY_TEKST = (k: string) => `trim(coalesce(${k}, ''), ' ' || char(9, 10, 13)) <> ''`;
const WARUNKI: readonly [string, string][] = [
  ['nazwa', NIEPUSTY_TEKST('nazwa')],
  ['sku', NIEPUSTY_TEKST('sku')],
  ['opis', NIEPUSTY_TEKST('opis')],
  ['kategoria_glowna', NIEPUSTY_TEKST('kategoria_glowna')],
  ['stawka_vat', NIEPUSTY_TEKST('stawka_vat')],
  ['ean', NIEPUSTY_TEKST('ean')],
  ['cena_gr', 'cena_gr IS NOT NULL'],
  ['szerokosc_mm', 'szerokosc_mm > 0'],
  ['wysokosc_mm', 'wysokosc_mm > 0'],
  ['glebokosc_mm', 'glebokosc_mm > 0'],
  ['waga_g', 'waga_g > 0'],
];
const ZASTANE = `INSERT OR IGNORE INTO karty_zrodla_pol (karta_id, pole, zrodlo, reczne, zmieniono_at)
SELECT id, pole, 'zastane', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (
${WARUNKI.map(([pole, warunek]) => `  SELECT id, '${pole}' AS pole FROM karty_produktow WHERE ${warunek}`).join('\n  UNION ALL\n')}
)`;

export const migracjaTresciKart: Migracja = {
  numer: 12,
  nazwa: 'tresc karty produktu',
  wykonaj(db) {
    for (const tabela of new Set(KOLUMNY.map(([t]) => t))) {
      const sa = new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map((k) => (k as { name: string }).name));
      for (const [t, kolumna, sql] of KOLUMNY) if (t === tabela && !sa.has(kolumna)) db.exec(sql);
    }
    db.exec(TABELE);
    db.exec(ZASTANE);
  },
};
