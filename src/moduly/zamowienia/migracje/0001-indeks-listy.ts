import type { Migracja } from '../../../core/kontrakty.ts';

// PRZ-051 — indeks listy zamówień i dwa indeksy, bez których start i lista rosły kwadratowo.
//
// ⚠️ `lista_stan` TO NIE DRUGA KOPIA REGUŁ, tylko zapisane odpowiedzi reguł domeny dla
// każdego zamówienia (domena/klasyfikacja-listy.js) — z nich liczniki zakładek liczy COUNT,
// a stronę wybiera LIMIT. Utrzymuje ją oms/db/indeks-listy.js; uzasadnienie i drogi
// odświeżania stoją tam.
//
// ⚠️ `przesylki(zamowienie_id)` i `platnosci(zamowienie_id)`: obie tabele miały dotąd tylko
// indeksy CZĘŚCIOWE (`WHERE status <> 'blad'`, `WHERE zrodlo = 'sklep'`), których planista
// SQLite nie użyje dla warunku bez tego samego predykatu. Pomiar PRZ-051 na 15 000 zamówień:
// uzupełnienie `wyslane_at` przy starcie 32,5 s, przeniesienie wpłat 4,0 s — każde
// niewysłane zamówienie przeglądało całą tabelę paczek. Indeksy zwykłe, nie unikalne:
// migracja tylko dokłada (strażnik migracji).
//
// ⚠️ `zamowienia(metoda_platnosci)`: pole wyboru „Płatność" nad listą bierze metody z bazy
// (`metodyPlatnosciWBazie`, DISTINCT). Kolumna leży w wierszu ZA `surowe_json`, więc bez
// indeksu każde otwarcie listy czytało strony przepełnienia całej tabeli — 15 000 zamówień:
// 129–157 ms; z indeksem 3–5 ms (pomiar PRZ-051).
//
// ⚠️ `zamowienia(julianday(utworzone_at), sklep)` — indeks na dacie złożenia z planu PRZ-051,
// w POSTACI, KTÓREJ UŻYWA ZAPYTANIE: bezpiecznik kanałów (moduł zdrowia, każde /health i każde
// otwarcie listy) porównuje `julianday(utworzone_at)` z oknem 30 dni. Zwykły indeks na kolumnie
// nie obsłuży wyrażenia. Pomiar na 50 000 zamówień ze 100 dni: 230 ms → 4 ms. (Przy 30 dniach
// historii zapytanie było tanie bez indeksu — pierwszy wiersz każdego kanału był świeży — więc
// koszt ujawnia się dopiero z wiekiem bazy.) `julianday` bez 'now' jest deterministyczne.
//
// ⚠️ `zamowienia(id) WHERE pobranie = 1 OR wysylka_reczna_json IS NOT NULL` — ostrzeżenie
// o pobraniach (oms/db/ostrzezenia.js, `pobraniaBezGotowki`) przeglądało przy każdym otwarciu
// listy wszystkie faktury z ich zamówieniami; warunek indeksu jest DOSŁOWNIE warunkiem tego
// zapytania, więc planista czyta tylko zamówienia za pobraniem. 50 000 zamówień: 35 → 0,1 ms.
export const migracjaIndeksuListy: Migracja = {
  numer: 1,
  nazwa: 'indeks listy zamówień i indeksy zamowienie_id przesyłek i wpłat',
  wykonaj(db) {
    db.exec(`
      CREATE TABLE lista_stan (
        zamowienie_id INTEGER PRIMARY KEY,
        utworzone_at TEXT NOT NULL,
        status TEXT NOT NULL,
        robocze_od INTEGER,
        po_terminie_od INTEGER,
        wazne_do INTEGER NOT NULL,
        dzien TEXT,
        wysylka TEXT,
        indywidualne INTEGER,
        sklep TEXT,
        platnosc TEXT,
        szukaj_tekst TEXT NOT NULL,
        szukaj_cyfry TEXT NOT NULL,
        blad TEXT
      );
      CREATE INDEX lista_stan_porzadek ON lista_stan (utworzone_at DESC, zamowienie_id DESC);
      CREATE INDEX lista_stan_status ON lista_stan (status, utworzone_at DESC, zamowienie_id DESC);
      CREATE INDEX lista_stan_robocze ON lista_stan (robocze_od);
      CREATE INDEX lista_stan_termin ON lista_stan (po_terminie_od);
      CREATE INDEX lista_stan_wazne ON lista_stan (wazne_do);
      CREATE TABLE lista_brudne (zamowienie_id INTEGER PRIMARY KEY);
      CREATE TABLE lista_meta (klucz TEXT PRIMARY KEY, wartosc TEXT);
      CREATE INDEX przesylki_zamowienie ON przesylki (zamowienie_id);
      CREATE INDEX platnosci_zamowienie ON platnosci (zamowienie_id);
      CREATE INDEX zamowienia_metoda_platnosci ON zamowienia (metoda_platnosci);
      CREATE INDEX zamowienia_julianday_utworzenia ON zamowienia (julianday(utworzone_at), sklep);
      CREATE INDEX zamowienia_pobranie ON zamowienia (id) WHERE pobranie = 1 OR wysylka_reczna_json IS NOT NULL;
    `);
  },
};
