import type { DatabaseSync } from 'node:sqlite';
import type { Migracja } from '../../../core/kontrakty.ts';

// Próg niskiego stanu karty: przy stanie ≤ progu OMS ostrzega. NULL = karta bez progu (tak zostają wszystkie
// stare karty), 0 = „ostrzegaj przy zerze i poniżej”. Kolumna w rdzeniu, bo `karty_produktow` należy do rdzenia.
//
// Bez CHECK: strażnik migracji (`core/baza.ts`) nie pozwala dokładać ograniczeń do istniejącej tabeli.
// Liczbę całkowitą ≥ 0 pilnuje jedyna droga zapisu kart (`wartoscPola` w `oms/db/magazyn.js`).
//
// Wyłącznie addytywna i odporna na ponowienie: kolumna już jest → nic. Wycofanie wydania zostawia pustą
// kolumnę, której stary obraz nie zna i nie czyta.
const KOLUMNA = 'prog_niskiego_stanu';

export const migracjaProguNiskiegoStanu: Migracja = {
  numer: 21,
  nazwa: 'prog niskiego stanu karty',
  wykonaj(db: DatabaseSync) {
    const sa = new Set(
      db
        .prepare('PRAGMA table_info(karty_produktow)')
        .all()
        .map((k) => (k as { name: string }).name),
    );
    if (!sa.has(KOLUMNA)) db.exec(`ALTER TABLE karty_produktow ADD COLUMN ${KOLUMNA} INTEGER`);
  },
};
