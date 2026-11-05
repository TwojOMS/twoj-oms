import type { Migracja } from '../../../core/kontrakty.ts';

// PRZ-152.G10a — druk proformy (zgoda właściciela 05.11.2026 na tę migrację). Osobna tabela, a nie kolumna
// „rodzaj” w `kolejka_druku_faktur`: tamta ma `faktura_id NOT NULL REFERENCES faktury(id)`, a jej
// przebudowa ruszałaby istniejące wiersze (nieaddytywna). Kolumny jak w kolejce faktur, z kolumnami
// zajęcia od razu w definicji.
//
// Wyłącznie addytywna i odporna na ponowienie (`IF NOT EXISTS`). Wycofanie wydania zostawia pustą,
// nieużywaną tabelę — stary obraz jej nie zna i nie czyta.
export const migracjaKolejkiDrukuProform: Migracja = {
  numer: 9,
  nazwa: 'kolejka druku proform',
  wykonaj(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS kolejka_druku_proform (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proforma_id INTEGER NOT NULL REFERENCES proformy(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'oczekuje',
  proby INTEGER NOT NULL DEFAULT 0,
  ostatni_blad TEXT,
  nastepna_proba_at TEXT,
  utworzone_at TEXT NOT NULL,
  wydrukowane_at TEXT,
  zajete_przez TEXT,
  zajete_at TEXT
)`);
    db.exec(`CREATE INDEX IF NOT EXISTS kolejka_druku_proform_status_proba
  ON kolejka_druku_proform (status, nastepna_proba_at)`);
  },
};
