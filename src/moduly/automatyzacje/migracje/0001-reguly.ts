import type { Migracja } from '../../../core/kontrakty.ts';

// PRZ-108.07 (zmiana B planu automatyzacji, właściciel 21.10): reguły „zdarzenie → warunki → akcja”, historia włączeń
// i dziennik wykonań. Migracja ADDYTYWNA — trzy nowe tabele, żadna istniejąca nie zmienia się ani o kolumnę.
//  • UNIQUE (regula_id, przedmiot) jest bezpiecznikiem „najwyżej jeden mail z jednej reguły na zamówienie”: dwa
//    zegary, restart w trakcie ani podwójne wykrycie nie dadzą drugiego wiersza (strażnik dopuszcza UNIQUE i FK na
//    NOWYCH tabelach — zabrania ich tylko na tabelach sprzed migracji).
//  • Zakresy (opóźnienie 0–10 080 min, limit 1–200, stan) sprawdza domena (domena/automatyzacje.js), nie CHECK —
//    zmiana zakresu nie wymaga wtedy migracji.
//  • Wycofanie kodu zostawia puste tabele.
export const migracjaRegul: Migracja = {
  numer: 1,
  nazwa: 'reguły automatyzacji, historia włączeń i dziennik wykonań',
  wykonaj(db) {
    db.exec(`CREATE TABLE automatyzacje_reguly (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nazwa TEXT NOT NULL,
      zdarzenie TEXT NOT NULL,
      zdarzenie_json TEXT NOT NULL DEFAULT '{}',
      warunki_json TEXT NOT NULL DEFAULT '{}',
      kursor_json TEXT,
      akcja TEXT NOT NULL,
      akcja_json TEXT NOT NULL DEFAULT '{}',
      opoznienie_min INTEGER NOT NULL DEFAULT 0,
      limit_na_godzine INTEGER NOT NULL DEFAULT 20,
      wlaczona INTEGER NOT NULL DEFAULT 0,
      granica_at TEXT,
      granica_json TEXT,
      wstrzymana_powod TEXT,
      utworzona_at TEXT NOT NULL,
      zmieniona_at TEXT NOT NULL,
      zmienil_login TEXT,
      usunieta_at TEXT
    );
    CREATE TABLE automatyzacje_przelaczenia (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      regula_id INTEGER NOT NULL REFERENCES automatyzacje_reguly(id),
      wlaczona INTEGER NOT NULL,
      konto_login TEXT,
      at TEXT NOT NULL
    );
    CREATE TABLE automatyzacje_wykonania (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      regula_id INTEGER NOT NULL REFERENCES automatyzacje_reguly(id),
      przedmiot TEXT NOT NULL,
      zamowienie_id INTEGER NOT NULL REFERENCES zamowienia(id) ON DELETE CASCADE,
      przesylka_id INTEGER,
      stan TEXT NOT NULL,
      powod TEXT,
      powod_kod TEXT,
      zdarzenie_at TEXT NOT NULL,
      adresat TEXT,
      szablon TEXT,
      proby INTEGER NOT NULL DEFAULT 0,
      nastepna_proba_at TEXT,
      wykryte_at TEXT NOT NULL,
      termin_at TEXT NOT NULL,
      zakonczone_at TEXT,
      UNIQUE (regula_id, przedmiot)
    );
    CREATE INDEX automatyzacje_wykonania_kolejka ON automatyzacje_wykonania(stan, termin_at);
    CREATE INDEX automatyzacje_wykonania_zamowienie ON automatyzacje_wykonania(zamowienie_id);
    CREATE INDEX automatyzacje_przelaczenia_regula ON automatyzacje_przelaczenia(regula_id);`);
  },
};
