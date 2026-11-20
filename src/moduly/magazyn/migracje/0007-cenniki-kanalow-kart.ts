import type { DatabaseSync } from 'node:sqlite';
import type { Migracja } from '../../../core/kontrakty.ts';

// Cennik kanału wybrany na karcie dla jednego konta (karta × konto → cennik kanału). Wygrywa z cennikiem OMS karty,
// więc konto bez powiązania z tym cennikiem OMS (albo karta bez cennika OMS) dalej może mieć własny wybór.
// Osobna tabela zamiast dawnej `karty_cenniki_kont`: migracja 0006 przepisała jej wiersze na cenniki OMS
// „Wyjątek N”, więc ponowny odczyt dałby te same wybory drugi raz. Dawna tabela zostaje, nieczytana.
// Wyłącznie dokładanie, niczego nie przepisujemy — ponowienie migracji nic nie zmienia.
const TABELA = `CREATE TABLE IF NOT EXISTS karty_cenniki_kanalow (
  karta_id INTEGER NOT NULL REFERENCES karty_produktow(id) ON DELETE CASCADE,
  konto TEXT NOT NULL CHECK (length(trim(konto)) > 0),
  cennik_kanalu TEXT NOT NULL CHECK (length(trim(cennik_kanalu)) > 0),
  zmieniono_at TEXT NOT NULL,
  aktor_login TEXT,
  PRIMARY KEY (karta_id, konto)
)`;

export const migracjaCennikowKanalowKart: Migracja = {
  numer: 7,
  nazwa: 'cennik kanału wybrany na karcie dla konta',
  wykonaj: (db: DatabaseSync) => {
    db.exec(TABELA);
  },
};
