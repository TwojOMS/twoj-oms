import type {Migracja} from '../../../core/kontrakty.ts';
export const migracjaZalacznikow: Migracja = {
  numer: 1,
  nazwa: 'manifest załączników odpowiedzi Allegro',
  wykonaj(db) {
    db.exec(`CREATE TABLE allegro_odpowiedzi_zalaczniki (
      id INTEGER PRIMARY KEY,
      odpowiedz_id INTEGER NOT NULL REFERENCES allegro_odpowiedzi(id),
      nazwa TEXT NOT NULL,
      mime TEXT NOT NULL,
      rozmiar INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      allegro_id TEXT,
      stan TEXT NOT NULL DEFAULT 'przygotowany' CHECK (stan IN ('przygotowany','zadeklarowany','wgrany','blad')),
      blad TEXT
    );
    CREATE INDEX allegro_odpowiedzi_zalaczniki_dowod ON allegro_odpowiedzi_zalaczniki(odpowiedz_id);`);
  },
};
