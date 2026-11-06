import type { Migracja } from '../../../core/kontrakty.ts';

// PRZ-153.E5.1 — pola karty produktu dla API `/api/v1/produkty` (plan docs/plany/PRZ-153-api-v1.md):
// cena katalogowa w groszach, stawka VAT jako napis, EAN i znacznik wycofania (stare karty = 0, czyli czynne).
// Tabela `api_idempotencja` trzyma wynik zapisu dla nagłówka `Idempotency-Key`; klucz główny
// (klucz_id, klucz_zadania) — ochrona przed podwójnym wykonaniem jest w kluczu tabeli, nie w odczycie.
//
// Wyłącznie addytywna i odporna na ponowienie: kolumna już jest → nic, tabela `IF NOT EXISTS`.
// Wycofanie wydania zostawia puste kolumny i tabelę, których stary obraz nie zna i nie czyta.
const KOLUMNY_KARTY: readonly [string, string][] = [
  ['cena_gr', 'ALTER TABLE karty_produktow ADD COLUMN cena_gr INTEGER'],
  ['stawka_vat', 'ALTER TABLE karty_produktow ADD COLUMN stawka_vat TEXT'],
  ['ean', 'ALTER TABLE karty_produktow ADD COLUMN ean TEXT'],
  ['wycofana', 'ALTER TABLE karty_produktow ADD COLUMN wycofana INTEGER NOT NULL DEFAULT 0'],
];

export const migracjaKartApi: Migracja = {
  numer: 11,
  nazwa: 'pola karty i idempotencja api',
  wykonaj(db) {
    const sa = new Set(db.prepare('PRAGMA table_info(karty_produktow)').all()
      .map((k) => (k as { name: string }).name));
    for (const [kolumna, sql] of KOLUMNY_KARTY) if (!sa.has(kolumna)) db.exec(sql);
    db.exec(`CREATE TABLE IF NOT EXISTS api_idempotencja (
  klucz_id INTEGER NOT NULL,
  klucz_zadania TEXT NOT NULL,
  trasa TEXT NOT NULL,
  status INTEGER NOT NULL,
  cialo TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (klucz_id, klucz_zadania)
)`);
  },
};
