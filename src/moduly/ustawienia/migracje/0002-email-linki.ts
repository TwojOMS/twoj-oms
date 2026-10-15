import type { Migracja } from '../../../core/kontrakty.ts';

/** PRZ-069: e-mail konta i jednorazowe linki do hasła. Wyłącznie nowe tabele (plan O2). */
export const migracjaEmailILinkow: Migracja = {
  numer: 2,
  nazwa: 'e-mail kont i linki do hasła',
  wykonaj(db) {
    db.exec(`CREATE TABLE konta_email (
      konto_id INTEGER PRIMARY KEY REFERENCES konta(id),
      email TEXT NOT NULL,
      zmieniono_at TEXT NOT NULL)`);
    db.exec('CREATE UNIQUE INDEX konta_email_lower ON konta_email(lower(email))');
    db.exec(`CREATE TABLE linki_hasla (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      konto_id INTEGER NOT NULL REFERENCES konta(id),
      hash_tokenu TEXT NOT NULL UNIQUE,
      cel TEXT NOT NULL CHECK (cel IN ('zaproszenie', 'reset')),
      utworzone_at TEXT NOT NULL,
      wygasa_at TEXT NOT NULL,
      uzyte_at TEXT,
      uniewaznione_at TEXT,
      utworzyl_konto_id INTEGER)`);
  },
};
