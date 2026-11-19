import type { DatabaseSync } from 'node:sqlite';
import type { Migracja } from '../../../core/kontrakty.ts';

// Cena zakupu netto karty z datą „obowiązuje od” — historia, nie jedna wartość: marża starego zamówienia
// ma się liczyć z ceny z tamtego dnia. Osobna tabela, a nie kolumna karty, bo karty czyta wiele
// `SELECT *` karmiących kanały i API — cena zakupu jest wewnętrzna i nie może tam trafić.
//
// CHECK `typeof = 'integer'`: kolumna INTEGER w SQLite przyjmie 12.3 jako REAL — tu grosze muszą być
// liczbą całkowitą. GLOB łapie datę w złym formacie u źródła (reguła porównuje daty jako napisy).
// UNIQUE (karta, dzień) robi z drugiego zapisu tego samego dnia zastąpienie i daje indeks wyszukiwania
// ceny na dzień — osobny indeks na tych samych kolumnach byłby kopią. Tylko PLN i tylko netto, z założenia.
// ON DELETE CASCADE działa, bo baza włącza foreign_keys przy otwarciu. Wyłącznie dokładanie.

const CENY_ZAKUPU = `CREATE TABLE IF NOT EXISTS ceny_zakupu_kart (
  id INTEGER PRIMARY KEY,
  karta_id INTEGER NOT NULL REFERENCES karty_produktow(id) ON DELETE CASCADE,
  cena_netto_gr INTEGER NOT NULL CHECK (typeof(cena_netto_gr) = 'integer' AND cena_netto_gr >= 0),
  obowiazuje_od TEXT NOT NULL CHECK (obowiazuje_od GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  wpisano_at TEXT NOT NULL,
  kto TEXT,
  zrodlo TEXT NOT NULL CHECK (zrodlo IN ('karta', 'hurt')),
  UNIQUE (karta_id, obowiazuje_od)
)`;

export const migracjaCenZakupu: Migracja = {
  numer: 18,
  nazwa: 'ceny-zakupu',
  wykonaj(db: DatabaseSync) {
    db.exec(CENY_ZAKUPU);
  },
};
