import type { DatabaseSync } from 'node:sqlite';
import type { Migracja } from '../../../core/kontrakty.ts';

// Cennik dostaw dobierany do rozmiaru produktu.
// Wyłącznie dokładanie: kolumna `cenniki_json` na `oferty_ustawienia_kont` (lista reguł konta) i tabela
// `karty_cenniki_kont` (wyjątek cennika na karcie, per konto; znika z kartą). Stara kolumna `cennik_dostaw` zostaje
// bez zmian — przepisujemy ją do jednej reguły „wszystko” tylko tam, gdzie `cenniki_json` jest jeszcze puste,
// więc ponowienie migracji niczego nie nadpisuje.
const WYJATKI = `CREATE TABLE IF NOT EXISTS karty_cenniki_kont (
  karta_id INTEGER NOT NULL REFERENCES karty_produktow(id) ON DELETE CASCADE,
  konto TEXT NOT NULL CHECK (length(trim(konto)) > 0),
  cennik TEXT NOT NULL CHECK (length(trim(cennik)) > 0),
  zmieniono_at TEXT NOT NULL,
  aktor_login TEXT,
  PRIMARY KEY (karta_id, konto)
)`;

const PRZEPISZ_STARY = `UPDATE oferty_ustawienia_kont
  SET cenniki_json = json_array(json_object('cennik', trim(cennik_dostaw)))
  WHERE cenniki_json IS NULL AND length(trim(coalesce(cennik_dostaw, ''))) > 0`;

export const migracjaCennikowDostaw: Migracja = {
  numer: 3,
  nazwa: 'cenniki dostaw: reguły rozmiaru konta i wyjątek cennika na karcie',
  wykonaj: (db: DatabaseSync) => {
    const sa = new Set(db.prepare('PRAGMA table_info(oferty_ustawienia_kont)').all().map((k) => (k as { name: string }).name));
    if (!sa.has('cenniki_json')) db.exec('ALTER TABLE oferty_ustawienia_kont ADD COLUMN cenniki_json TEXT');
    db.exec(WYJATKI);
    db.exec(PRZEPISZ_STARY);
  },
};
