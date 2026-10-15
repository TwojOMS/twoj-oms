import type { Migracja } from '../../../core/kontrakty.ts';

/**
 * PRZ-068: role edytowane przez administratora. Wyłącznie nowe tabele; dane zakłada synchronizacja.
 * `osobista` = rola założona dla jednego konta (przejście albo stara trasa /uprawnienia) — tylko taką
 * stara trasa aktualizuje w miejscu (recenzja D8 r1; kolumna w migracji nr 1, bo gałąź nie była wydana).
 */
export const migracjaRol: Migracja = {
  numer: 1,
  nazwa: 'role i ekrany ról',
  wykonaj(db) {
    db.exec(`CREATE TABLE role (
      klucz TEXT PRIMARY KEY,
      nazwa TEXT NOT NULL UNIQUE,
      admin INTEGER NOT NULL DEFAULT 0,
      zablokowana INTEGER NOT NULL DEFAULT 0,
      osobista INTEGER NOT NULL DEFAULT 0,
      utworzone_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE role_ekrany (
      rola TEXT NOT NULL REFERENCES role(klucz),
      ekran TEXT NOT NULL,
      PRIMARY KEY (rola, ekran))`);
  },
};
