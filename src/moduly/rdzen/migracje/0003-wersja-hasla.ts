import type { Migracja } from '../../../core/kontrakty.ts';

export const migracjaWersjaHasla: Migracja = {
  numer: 3,
  nazwa: 'wersja hasła konta — unieważnianie sesji',
  wykonaj(db) {
    db.exec('ALTER TABLE konta ADD COLUMN wersja_hasla INTEGER NOT NULL DEFAULT 0');
  },
};
