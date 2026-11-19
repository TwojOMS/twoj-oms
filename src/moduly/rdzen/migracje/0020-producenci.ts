import type { DatabaseSync } from 'node:sqlite';
import type { Migracja } from '../../../core/kontrakty.ts';

// Słownik producentów (GPSR): każdy produkt sprzedawany w UE ma mieć producenta z nazwą, adresem pocztowym
// i adresem elektronicznym. CHECK-i są drugą zaporą za walidacją domeny — wiersz bez adresu albo bez
// e-maila i www nie wejdzie nawet zapisem z pominięciem formularza.
//
// Producent domyślny to kolumna z częściowym indeksem UNIQUE, a nie klucz w `ustawienia`: klucz w ustawieniach
// nie ma klucza obcego, więc usunięty producent zostawiłby tam wiszący identyfikator. Indeks pilnuje, że
// domyślny jest najwyżej jeden.
//
// Przypisanie do marki w osobnej tabeli, nie kolumną w `marki`: zmiana nazwy marki robi DELETE + INSERT jej
// wiersza, kolumna ginęłaby przy każdej zmianie. Z tego samego powodu bez klucza obcego do `marki(nazwa)`.
// Klucz obcy do producenta bez ON DELETE: usunięcie producenta z markami ma się nie udać (baza włącza
// foreign_keys przy otwarciu). Wyłącznie dokładanie, powtórne wykonanie niczego nie zmienia.

const PRODUCENCI = `CREATE TABLE IF NOT EXISTS producenci (
  id INTEGER PRIMARY KEY,
  nazwa TEXT NOT NULL CHECK (length(trim(nazwa)) > 0),
  adres TEXT NOT NULL CHECK (length(trim(adres)) > 0),
  email TEXT,
  www TEXT,
  domyslny INTEGER NOT NULL DEFAULT 0 CHECK (domyslny IN (0, 1)),
  utworzono_at TEXT NOT NULL,
  zmieniono_at TEXT NOT NULL,
  CHECK (email IS NOT NULL OR www IS NOT NULL)
)`;

const JEDEN_DOMYSLNY = `CREATE UNIQUE INDEX IF NOT EXISTS producenci_jeden_domyslny
  ON producenci(domyslny) WHERE domyslny = 1`;

const MARKI_PRODUCENCI = `CREATE TABLE IF NOT EXISTS marki_producenci (
  marka TEXT PRIMARY KEY,
  producent_id INTEGER NOT NULL REFERENCES producenci(id),
  zmieniono_at TEXT NOT NULL
)`;

export const migracjaProducentow: Migracja = {
  numer: 20,
  nazwa: 'producenci',
  wykonaj(db: DatabaseSync) {
    db.exec(PRODUCENCI);
    db.exec(JEDEN_DOMYSLNY);
    db.exec(MARKI_PRODUCENCI);
  },
};
