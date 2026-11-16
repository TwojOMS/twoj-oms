import type { DatabaseSync } from 'node:sqlite';
import type { Migracja } from '../../../core/kontrakty.ts';

// Rejestr ofert dostaje stan ilości, konto bufor i próg skoku, a moduł tabele zatwierdzeń stanów i przepięć
// powiązań. Wyłącznie dokładanie; nowe kolumny istniejących tabel bez CHECK — pilnuje ich repozytorium
// (`src/oms/db/oferty-kanalow.ts`). Domyślne wartości = zachowanie sprzed tej migracji: `ilosc_z_oms = 0`,
// czyli żadna istniejąca oferta nie dostaje ilości z OMS.

const TABELE = [
  `CREATE TABLE IF NOT EXISTS stany_zatwierdzenia (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    przelaczenie_id INTEGER NOT NULL,
    zatwierdzil TEXT,
    zatwierdzono_at TEXT NOT NULL,
    ofert INTEGER NOT NULL CHECK (ofert >= 0),
    skrot TEXT NOT NULL CHECK (length(trim(skrot)) > 0)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_stany_zatwierdzenia_przelaczenie ON stany_zatwierdzenia(przelaczenie_id)',
  `CREATE TABLE IF NOT EXISTS stany_przepiecia (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kanal TEXT NOT NULL CHECK (length(trim(kanal)) > 0),
    produkt_id TEXT NOT NULL CHECK (length(trim(produkt_id)) > 0),
    wariant_id TEXT,
    z_karty INTEGER,
    na_karte INTEGER,
    ilosc_wstecz INTEGER NOT NULL CHECK (ilosc_wstecz >= 0),
    konto_login TEXT,
    utworzono_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_stany_przepiecia_z_karty ON stany_przepiecia(z_karty)',
  'CREATE INDEX IF NOT EXISTS idx_stany_przepiecia_na_karte ON stany_przepiecia(na_karte)',
] as const;

const KOLUMNY_OFERT: readonly (readonly [string, string])[] = [
  ['ilosc_z_oms', 'ALTER TABLE oferty_kanalow ADD COLUMN ilosc_z_oms INTEGER NOT NULL DEFAULT 0'],
  ['ilosc_wyslana_at', 'ALTER TABLE oferty_kanalow ADD COLUMN ilosc_wyslana_at TEXT'],
  ['stan_karty_wyslany', 'ALTER TABLE oferty_kanalow ADD COLUMN stan_karty_wyslany INTEGER'],
  ['ilosc_w_toku_json', 'ALTER TABLE oferty_kanalow ADD COLUMN ilosc_w_toku_json TEXT'],
  ['ilosc_problem_json', 'ALTER TABLE oferty_kanalow ADD COLUMN ilosc_problem_json TEXT'],
  ['odczyt_ilosc_kanalu', 'ALTER TABLE oferty_kanalow ADD COLUMN odczyt_ilosc_kanalu INTEGER'],
];

const KOLUMNY_USTAWIEN: readonly (readonly [string, string])[] = [
  ['bufor_szt', 'ALTER TABLE oferty_ustawienia_kont ADD COLUMN bufor_szt INTEGER NOT NULL DEFAULT 0'],
  ['prog_skoku_szt', 'ALTER TABLE oferty_ustawienia_kont ADD COLUMN prog_skoku_szt INTEGER NOT NULL DEFAULT 5'],
];

function dodajBrakujace(db: DatabaseSync, tabela: string, kolumny: readonly (readonly [string, string])[]): void {
  const sa = new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map((k) => (k as { name: string }).name));
  for (const [kolumna, sql] of kolumny) if (!sa.has(kolumna)) db.exec(sql);
}

export const migracjaStanowKanalow: Migracja = {
  numer: 4,
  nazwa: 'stany kanałów: ilość z OMS w rejestrze, bufor i próg skoku, zatwierdzenia i przepięcia',
  wykonaj: (db: DatabaseSync) => {
    for (const sql of TABELE) db.exec(sql);
    dodajBrakujace(db, 'oferty_kanalow', KOLUMNY_OFERT);
    dodajBrakujace(db, 'oferty_ustawienia_kont', KOLUMNY_USTAWIEN);
  },
};
