import type { Migracja } from '../../../core/kontrakty.ts';

// PRZ-153.E1.1 — klucze API `/api/v1` (plan docs/plany/PRZ-153-api-v1.md). W bazie wyłącznie sha256 klucza
// (`skrot`); klucz pokazany raz przy założeniu. `utworzyl_konto_id` bez REFERENCES: klucz to klucz maszyny
// i działa dalej, gdy konto twórcy wyłączono. Dziennik: `klucz_id` NULL = odmowa 401 (nieznany klucz).
//
// Wyłącznie addytywna i odporna na ponowienie (`IF NOT EXISTS`). Wycofanie wydania zostawia puste,
// nieużywane tabele — stary obraz ich nie zna i nie czyta.
export const migracjaKluczyApi: Migracja = {
  numer: 10,
  nazwa: 'klucze api',
  wykonaj(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS klucze_api (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nazwa TEXT NOT NULL,
  prefiks TEXT NOT NULL UNIQUE,
  skrot TEXT NOT NULL UNIQUE,
  zakresy TEXT NOT NULL,
  utworzyl_konto_id INTEGER,
  utworzony_at TEXT NOT NULL,
  wygasa_at TEXT,
  odwolany_at TEXT,
  ostatnio_uzyty_at TEXT,
  ostatnie_ip TEXT
)`);
    db.exec(`CREATE TABLE IF NOT EXISTS klucze_api_dziennik (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  klucz_id INTEGER,
  prefiks TEXT,
  at TEXT NOT NULL,
  metoda TEXT NOT NULL,
  sciezka TEXT NOT NULL,
  status INTEGER NOT NULL,
  ip TEXT
)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_klucze_api_dziennik_at ON klucze_api_dziennik (at)`);
  },
};
