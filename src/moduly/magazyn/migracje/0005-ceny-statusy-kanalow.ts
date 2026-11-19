import type { DatabaseSync } from 'node:sqlite';
import type { Migracja } from '../../../core/kontrakty.ts';

// Rejestr ofert dostaje dwie flagi: „cenę prowadzi OMS” i „status prowadzi OMS”, a moduł dziennik zmian
// cen i statusów wysłanych do kanałów. Wyłącznie dokładanie.
//
// Dwie osobne kolumny, a nie jedna z flagami bitowymi: są symetryczne do `ilosc_z_oms`, bramka zapisu czyta
// je tak samo, a SQLite nie ma wygodnych operacji bitowych w filtrach. Bez CHECK w bazie — pilnuje ich
// repozytorium (`src/oms/db/oferty-kanalow.ts`). Domyślne 0 = zachowanie sprzed tej migracji: żadna
// istniejąca oferta nie dostaje ceny ani statusu z OMS.
//
// Dziennik nie ma klucza obcego do karty: wpis ma przeżyć usunięcie karty. `stara`/`nowa` to tekst — cena
// w groszach zapisana jako liczba w tekście albo status kanału (`publish`, `ENDED`); przy `steruj_cena`
// to '0'/'1'. Wpis `w_toku` powstaje przed wysłaniem, gdy wynik jeszcze nie jest znany.

const DZIENNIK = [
  `CREATE TABLE IF NOT EXISTS zmiany_w_kanalach (
    id INTEGER PRIMARY KEY,
    kanal TEXT NOT NULL,
    karta_id INTEGER,
    cel TEXT NOT NULL,
    pole TEXT NOT NULL CHECK (pole IN ('cena', 'status', 'steruj_cena')),
    stara TEXT,
    nowa TEXT,
    kto TEXT NOT NULL,
    at TEXT NOT NULL,
    wynik TEXT NOT NULL CHECK (wynik IN ('ok', 'blad', 'w_toku')),
    blad TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS zmiany_w_kanalach_karta ON zmiany_w_kanalach (karta_id, at)',
] as const;

const KOLUMNY_OFERT: readonly (readonly [string, string])[] = [
  ['cena_z_oms', 'ALTER TABLE oferty_kanalow ADD COLUMN cena_z_oms INTEGER NOT NULL DEFAULT 0'],
  ['status_z_oms', 'ALTER TABLE oferty_kanalow ADD COLUMN status_z_oms INTEGER NOT NULL DEFAULT 0'],
];

function dodajBrakujace(db: DatabaseSync, tabela: string, kolumny: readonly (readonly [string, string])[]): void {
  const sa = new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map((k) => (k as { name: string }).name));
  for (const [kolumna, sql] of kolumny) if (!sa.has(kolumna)) db.exec(sql);
}

export const migracjaCenStatusowKanalow: Migracja = {
  numer: 5,
  nazwa: 'ceny i statusy z OMS w rejestrze ofert, dziennik zmian w kanałach',
  wykonaj: (db: DatabaseSync) => {
    for (const sql of DZIENNIK) db.exec(sql);
    dodajBrakujace(db, 'oferty_kanalow', KOLUMNY_OFERT);
  },
};
