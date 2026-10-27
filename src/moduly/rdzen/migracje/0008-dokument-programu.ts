import type { Migracja } from '../../../core/kontrakty.ts';

// PRZ-118.03 — program fakturowy jako kontrakt: dokument faktury (zamówienia i okresu) przestaje być
// z definicji dokumentem inFaktu. `program` mówi, który program go wystawił, `dokument_id` — jak go
// tam nazywa. Wiersze z `infakt_uuid` dostają `program = 'infakt'` i ten sam identyfikator; wiersz bez
// dokumentu (rezerwacja w toku, „do wyjaśnienia”, okres bez faktury) zostaje pusty w obu kolumnach.
//
// `infakt_uuid` zostaje i dalej jest zapisywany dla inFaktu (db/faktury.js, oms/db/okresy.js): obraz
// sprzed tej zmiany czyta tylko tę kolumnę, więc wycofanie wydania nie gubi faktur wystawionych po nim.
//
// Bez indeksu, bez wartości domyślnej, puste dozwolone — jak `infakt_uuid`. Odporna na ponowienie:
// kolumna już jest → jej nie dokłada; uzupełnienie dotyka tylko wierszy z pustym `dokument_id`,
// więc nie nadpisze identyfikatora zapisanego już przez nowy kod.
const TABELE = ['faktury', 'okresy_rozliczeniowe'] as const;

export const migracjaDokumentuProgramu: Migracja = {
  numer: 8,
  nazwa: 'program i identyfikator dokumentu faktury',
  wykonaj(db) {
    for (const tabela of TABELE) {
      const sa = new Set((db.prepare(`PRAGMA table_info(${tabela})`).all() as { name: string }[]).map((k) => k.name));
      if (!sa.has('program')) db.exec(`ALTER TABLE ${tabela} ADD COLUMN program TEXT`);
      if (!sa.has('dokument_id')) db.exec(`ALTER TABLE ${tabela} ADD COLUMN dokument_id TEXT`);
      db.exec(`UPDATE ${tabela} SET program = 'infakt', dokument_id = infakt_uuid
        WHERE infakt_uuid IS NOT NULL AND dokument_id IS NULL`);
    }
  },
};
