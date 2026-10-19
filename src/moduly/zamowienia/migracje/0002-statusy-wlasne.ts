import type { Migracja } from '../../../core/kontrakty.ts';

export const migracjaStatusowWlasnych: Migracja = {
  numer: 2,
  nazwa: 'ręczny etap własny zamówienia',
  wykonaj(db) {
    db.exec(`CREATE TABLE zamowienia_status_wlasny (
      zamowienie_id INTEGER PRIMARY KEY REFERENCES zamowienia(id) ON DELETE CASCADE,
      klucz TEXT NOT NULL,
      ustawione_at TEXT NOT NULL,
      kto TEXT
    );
    CREATE INDEX zamowienia_status_wlasny_klucz ON zamowienia_status_wlasny(klucz);`);
  },
};
