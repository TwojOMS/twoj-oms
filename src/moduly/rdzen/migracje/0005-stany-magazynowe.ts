import type { Migracja } from '../../../core/kontrakty.ts';

// PRZ-091 — stany magazynowe: ruchy ręczne i historia przełącznika „Włącz stany magazynowe” (Ustawienia → Magazyn).
//
// Rozchód z zamówień NIE ma tu tabeli — jest wyliczany z pozycji zamówień (domena/stany-magazynowe.js).
// `ruchy_magazynowe.klucz` UNIQUE to cała ochrona przed podwójnym kliknięciem i ponownym importem stanu otwarcia.
// Korekta to nowy ruch, nigdy zmiana ani usunięcie starego.
// Przełącznik: ostatni wiersz `magazyn_przelaczenia` mówi, czy stany są włączone; `utworzono_at` ostatniego
// włączenia jest granicą — liczą się zamówienia złożone od tej chwili. Brak wierszy = wyłączone (domyślnie).
export const migracjaStanowMagazynowych: Migracja = {
  numer: 5,
  nazwa: 'stany magazynowe: ruchy ręczne i przełącznik',
  wykonaj(db) {
    db.exec(`CREATE TABLE ruchy_magazynowe (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      karta_id INTEGER NOT NULL REFERENCES karty_produktow(id),
      ilosc INTEGER NOT NULL CHECK (ilosc <> 0),
      rodzaj TEXT NOT NULL CHECK (rodzaj IN ('otwarcie', 'przyjecie', 'korekta')),
      powod TEXT,
      konto_id INTEGER,
      konto_login TEXT,
      utworzono_at TEXT NOT NULL,
      klucz TEXT NOT NULL UNIQUE
    )`);
    db.exec('CREATE INDEX ruchy_magazynowe_karta ON ruchy_magazynowe (karta_id, utworzono_at)');
    db.exec(`CREATE TABLE magazyn_przelaczenia (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wlaczone INTEGER NOT NULL CHECK (wlaczone IN (0, 1)),
      konto_id INTEGER,
      konto_login TEXT,
      utworzono_at TEXT NOT NULL
    )`);
  },
};
