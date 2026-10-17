import type { Migracja } from '../../../core/kontrakty.ts';

// PRZ-090 — karta produktu zamiast „wzoru”: rejestr produktów dla dowolnego sklepu, nie dla jednej branży.
//
// ⚠️ WYŁĄCZNIE DOKŁADANIE. Tabela `wzory` i kolumna `produkty_sklepowe.wzor_id` ZOSTAJĄ w bazie i nikt ich już
// nie czyta — strażnik migracji nie wpuszcza usuwania ani zmiany nazw, a stary obraz po wycofaniu wydania czyta dokładnie
// je (zmiany zrobione po wydaniu zobaczy wtedy tylko nowy obraz). Kopia idzie z TYMI SAMYMI id, więc adresy kart,
// powiązania i zaznaczenia na liście nie zmieniają znaczenia.
//
// ⚠️ `karta_id` BEZ `REFERENCES`: nowy klucz obcy na istniejącej tabeli to nowe ograniczenie, którego kontrola
// addytywności nie przepuszcza (core/baza.ts). Karty się nie kasuje, więc `ON DELETE SET NULL` nie miałby czego robić.
//
// Wymiary: `szerokosc_mm` i `wysokosc_mm` przechodzą 1:1 (WooCommerce: width i length — domena/zapis-do-sklepu.js),
// `glebokosc_mm` (height) i `waga_g` są nowe i puste. Lustro dostaje to, co sklep podaje o wymiarach i wadze
// (`wymiary_json` z Woo `dimensions`, `waga_tekst` z `weight`) — źródło dla nowej karty przed rozmiarem z nazwy.
export const migracjaKartProduktow: Migracja = {
  numer: 4,
  nazwa: 'karty produktów (z wzorów) i powiązanie karta_id',
  wykonaj(db) {
    db.exec(`CREATE TABLE karty_produktow (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT UNIQUE,
      nazwa TEXT NOT NULL,
      szerokosc_mm INTEGER,
      wysokosc_mm INTEGER,
      glebokosc_mm INTEGER,
      waga_g INTEGER,
      kategoria_glowna TEXT,
      paczkomat TEXT,
      opis TEXT,
      utworzony_at TEXT NOT NULL,
      zmieniony_at TEXT NOT NULL
    )`);
    db.exec(`INSERT INTO karty_produktow (id, sku, nazwa, szerokosc_mm, wysokosc_mm, kategoria_glowna, paczkomat, opis,
        utworzony_at, zmieniony_at)
      SELECT id, sku, nazwa, szerokosc_mm, wysokosc_mm, kategoria_glowna, paczkomat, opis, utworzony_at, zmieniony_at
      FROM wzory ORDER BY id`);
    db.exec('ALTER TABLE produkty_sklepowe ADD COLUMN karta_id INTEGER');
    db.exec('ALTER TABLE produkty_sklepowe ADD COLUMN wymiary_json TEXT');
    db.exec('ALTER TABLE produkty_sklepowe ADD COLUMN waga_tekst TEXT');
    db.exec('UPDATE produkty_sklepowe SET karta_id = wzor_id WHERE wzor_id IS NOT NULL');
    db.exec('CREATE INDEX idx_produkty_sklepowe_karta ON produkty_sklepowe (karta_id)');
  },
};
