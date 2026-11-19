import type { DatabaseSync } from 'node:sqlite';
import type { Migracja } from '../../../core/kontrakty.ts';

// Ręczna cena karty w jednym kanale. `kanal` to klucz KONTA (jak `produkty_sklepowe.kanal`), bo narzut jest
// per konto i ręczna cena go zastępuje dla tego konta. Brak wiersza = cena z karty z narzutem konta, więc
// usunięcie wiersza („wróć do narzutu”) jest dozwolone — to ustawienie, nie dane księgowe; ślad zmian cen
// w kanałach prowadzi osobny dziennik.
//
// Tabela należy do rdzenia, bo do rdzenia należy `karty_produktow` (klucz obcy z ON DELETE CASCADE działa,
// bo baza włącza foreign_keys przy otwarciu). CHECK `typeof = 'integer'`: kolumna INTEGER przyjęłaby 10.5
// jako REAL, a grosze muszą być liczbą całkowitą. UNIQUE (karta, konto) robi z drugiego zapisu zastąpienie
// i daje indeks odczytu cen karty. Wyłącznie dokładanie.

const CENY_KANALOW = `CREATE TABLE IF NOT EXISTS ceny_kanalow_kart (
  karta_id INTEGER NOT NULL REFERENCES karty_produktow(id) ON DELETE CASCADE,
  kanal TEXT NOT NULL,
  cena_gr INTEGER NOT NULL CHECK (typeof(cena_gr) = 'integer' AND cena_gr > 0),
  kto TEXT NOT NULL,
  zmieniono_at TEXT NOT NULL,
  UNIQUE (karta_id, kanal)
)`;

export const migracjaCenKanalowKart: Migracja = {
  numer: 19,
  nazwa: 'ceny-kanalow-kart',
  wykonaj(db: DatabaseSync) {
    db.exec(CENY_KANALOW);
  },
};
