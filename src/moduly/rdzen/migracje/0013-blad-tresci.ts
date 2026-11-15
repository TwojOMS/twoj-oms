import type { Migracja } from '../../../core/kontrakty.ts';

// PRZ-160.06b — trwały wpis błędu przy ofercie z przebiegu „Pobierz treść i zdjęcia ofert" (E1.04):
// krótki tekst po polsku (np. ile zdjęć pominięto i pierwszy powód) i chwila wpisu. Kartę czyta E1.07.
// Wyłącznie dokładanie, odporna na ponowienie: kolumna tylko gdy jej brak (wzór 0012).
const KOLUMNY: readonly [string, string][] = [
  ['tresc_blad', 'ALTER TABLE produkty_sklepowe ADD COLUMN tresc_blad TEXT'],
  ['tresc_blad_at', 'ALTER TABLE produkty_sklepowe ADD COLUMN tresc_blad_at TEXT'],
];

export const migracjaBleduTresci: Migracja = {
  numer: 13,
  nazwa: 'blad pobrania tresci oferty',
  wykonaj(db) {
    const sa = new Set(db.prepare('PRAGMA table_info(produkty_sklepowe)').all().map((k) => (k as { name: string }).name));
    for (const [kolumna, sql] of KOLUMNY) if (!sa.has(kolumna)) db.exec(sql);
  },
};
