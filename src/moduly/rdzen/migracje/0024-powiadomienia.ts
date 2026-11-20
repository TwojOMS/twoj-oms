import type { DatabaseSync } from 'node:sqlite';
import type { Migracja } from '../../../core/kontrakty.ts';

// Migawka powiadomień: lista spraw z regułami z `domena/ostrzezenia.js`, liczona w tle (zegar modułu zamówień),
// a nie przy każdym wejściu na stronę. Wiersz żyje, dopóki reguła go zwraca (`rozwiazane_at` NULL), potem leży
// w archiwum do końca retencji. Tekst i przycisk są kopią z ostatniego przebiegu — archiwum pokazuje sprawę,
// której reguła już nie zwraca, więc nie ma skąd ich wziąć na nowo.
//
// Przeczytania osobno dla konta (`powiadomienia_przeczytane`); ignorowanie zostaje wspólne dla firmy w
// `ostrzezenia_odrzucone` — bez drugiej tabeli, bo inaczej dwa zapisy tej samej decyzji mogłyby się rozjechać.
// Bez klucza obcego przeczytań do migawki: retencja kasuje oba wiersze w jednej transakcji, a klucz obcy
// z ON DELETE wymagałby `foreign_keys` przy każdym połączeniu (skrypty pomiaru otwierają bazę same).
//
// `powiadomienia_stan` — jeden wiersz (jak `stan_kosztow`): ostatni udany przebieg, jego czas i błąd ostatniego
// nieudanego. Błąd zostaje do następnego udanego przebiegu; migawka w tym czasie stoi, nie znika.
//
// Wyłącznie dokładanie, powtórne wykonanie niczego nie zmienia. Migracja zakłada puste tabele — pierwszy
// przebieg wpisze bieżące sprawy jako nowe (historii sprzed wydania nie ma).

const POWIADOMIENIA = `CREATE TABLE IF NOT EXISTS powiadomienia (
  klucz TEXT PRIMARY KEY,
  typ TEXT NOT NULL,
  tekst TEXT NOT NULL,
  title TEXT,
  href TEXT,
  etykieta_przycisku TEXT,
  etykieta_odrzucenia TEXT,
  pilne INTEGER NOT NULL DEFAULT 0 CHECK (pilne IN (0, 1)),
  pierwszy_raz_at TEXT NOT NULL,
  ostatnio_at TEXT NOT NULL,
  rozwiazane_at TEXT
)`;

const PRZECZYTANE = `CREATE TABLE IF NOT EXISTS powiadomienia_przeczytane (
  konto_id INTEGER NOT NULL,
  klucz TEXT NOT NULL,
  przeczytane_at TEXT NOT NULL,
  PRIMARY KEY (konto_id, klucz)
)`;

const STAN = `CREATE TABLE IF NOT EXISTS powiadomienia_stan (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  odswiezone_at TEXT,
  czas_ms INTEGER,
  blad TEXT,
  blad_at TEXT
)`;

export const migracjaPowiadomien: Migracja = {
  numer: 24,
  nazwa: 'powiadomienia',
  wykonaj(db: DatabaseSync) {
    db.exec(POWIADOMIENIA);
    db.exec('CREATE INDEX IF NOT EXISTS powiadomienia_rozwiazane ON powiadomienia(rozwiazane_at)');
    db.exec('CREATE INDEX IF NOT EXISTS powiadomienia_typ ON powiadomienia(typ)');
    db.exec(PRZECZYTANE);
    db.exec(STAN);
  },
};
