import { wgrajKategorieStartowe } from './kategorie-kosztow.js';

/** Inicjalizacja danych, bez zmiany DDL i bez firmowych przypisań/dostawców. */
export function przygotujKoszty(db) {
  const wlasnaTransakcja = !db.isTransaction;
  if (wlasnaTransakcja) db.exec('BEGIN IMMEDIATE');
  try {
    wgrajKategorieStartowe(db);
    if (wlasnaTransakcja) db.exec('COMMIT');
  } catch (e) {
    if (wlasnaTransakcja && db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}
