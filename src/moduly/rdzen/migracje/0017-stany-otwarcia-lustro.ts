import type { DatabaseSync } from 'node:sqlite';
import type { Migracja } from '../../../core/kontrakty.ts';

// PRZ-160 E4.01 — stany otwarcia (D52): jedna wartość na kartę i granicę włączenia; zero to stan zapisany,
// brak wiersza = „bez stanu”. Lustro sklepów (D60) dostaje ilość kanału, poziom prowadzenia stanu i chwilę
// odczytu — kolumny bez CHECK (ilość kanału może być ujemna). Wyłącznie dokładanie.

const STANY_OTWARCIA = `CREATE TABLE IF NOT EXISTS stany_otwarcia (
  karta_id INTEGER NOT NULL,
  granica TEXT NOT NULL,
  ilosc INTEGER NOT NULL CHECK (ilosc >= 0),
  zrodlo TEXT NOT NULL,
  konto_login TEXT,
  utworzono_at TEXT NOT NULL,
  PRIMARY KEY (karta_id, granica)
)`;

const KOLUMNY_LUSTRA: readonly (readonly [string, string])[] = [
  ['ilosc_kanalu', 'ALTER TABLE produkty_sklepowe ADD COLUMN ilosc_kanalu INTEGER'],
  ['stan_prowadzony', 'ALTER TABLE produkty_sklepowe ADD COLUMN stan_prowadzony TEXT'],
  ['ilosc_odczytana_at', 'ALTER TABLE produkty_sklepowe ADD COLUMN ilosc_odczytana_at TEXT'],
];

export const migracjaStanowOtwarciaLustra: Migracja = {
  numer: 17,
  nazwa: 'stany otwarcia kart i ilość kanału w lustrze sklepów',
  wykonaj(db: DatabaseSync) {
    db.exec(STANY_OTWARCIA);
    const sa = new Set(db.prepare('PRAGMA table_info(produkty_sklepowe)').all().map((k) => (k as { name: string }).name));
    for (const [kolumna, sql] of KOLUMNY_LUSTRA) if (!sa.has(kolumna)) db.exec(sql);
  },
};
