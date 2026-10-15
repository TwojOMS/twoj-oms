-- Baseline: schemat produkcji OMS-u w punkcie zamrożenia, z kopii otwartej tylko do odczytu.
-- NIE EDYTOWAĆ — zmiany schematu idą kolejnymi migracjami.

CREATE TABLE allegro_odpowiedzi (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kanal       TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  rodzaj      TEXT NOT NULL,
  tresc       TEXT NOT NULL,
  zapisany_at TEXT NOT NULL,
  wyslany_at  TEXT,
  blad        TEXT
);

CREATE TABLE allegro_sprawy (
  kanal        TEXT NOT NULL,
  issue_id     TEXT NOT NULL,
  typ          TEXT,
  status       TEXT,
  buyer_login  TEXT,
  zamowienie_id TEXT,
  opened_date  TEXT,
  pobrany_at   TEXT NOT NULL,
  PRIMARY KEY (kanal, issue_id)
);

CREATE TABLE allegro_watki (
  kanal                    TEXT NOT NULL,
  thread_id                TEXT NOT NULL,
  interlocutor_login       TEXT,
  last_message_date_time   TEXT,
  typ                      TEXT,
  przeczytany              INTEGER NOT NULL DEFAULT 0,
  ostatnia_od_kupujacego   INTEGER NOT NULL DEFAULT 0,
  ostatnia_tresc           TEXT,
  pobrany_at               TEXT NOT NULL,
  PRIMARY KEY (kanal, thread_id)
);

CREATE TABLE allegro_wiadomosci (
  kanal         TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  od_kupujacego INTEGER NOT NULL DEFAULT 0,
  tresc         TEXT,
  utworzona_at  TEXT,
  PRIMARY KEY (kanal, thread_id, message_id)
);

CREATE TABLE allegro_zamkniecia (
  kanal TEXT NOT NULL,
  thread_id TEXT NOT NULL,

  zamkniete_do TEXT NOT NULL,

  zamkniete_at TEXT NOT NULL,
  PRIMARY KEY (kanal, thread_id)
);

CREATE TABLE archiwum_sprzedazy (
  uuid         TEXT PRIMARY KEY NOT NULL,
  rodzaj       TEXT NOT NULL CHECK (rodzaj IN ('vat', 'korekta')),
  numer        TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  sale_date    TEXT,
  odcisk       TEXT NOT NULL,
  sciezka_pdf  TEXT NOT NULL,
  zapisany_at  TEXT NOT NULL,
  skasowana_at TEXT
);

CREATE TABLE cele (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nazwa         TEXT NOT NULL,




  konto_id      INTEGER REFERENCES konta(id),

  rytm          TEXT NOT NULL,



  cel_ile       INTEGER CHECK (cel_ile IS NULL OR cel_ile >= 1),



  miernik       TEXT NOT NULL DEFAULT 'reczny',
  od_dnia       TEXT,
  do_dnia       TEXT,
  czynny        INTEGER NOT NULL DEFAULT 1,
  utworzony_at  TEXT NOT NULL,
  zmieniony_at  TEXT NOT NULL
);

CREATE TABLE cele_zdarzenia (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,



  cel_id      INTEGER NOT NULL REFERENCES cele(id),


  dzien       TEXT NOT NULL,
  ile         INTEGER NOT NULL DEFAULT 1,




  konto_id    INTEGER REFERENCES konta(id),
  notatka     TEXT,
  zapisane_at TEXT NOT NULL
);

CREATE TABLE dane_miesieczne (
  miesiac           TEXT PRIMARY KEY,
  zus_spoleczne     TEXT,
  zus_zdrowotna     TEXT,
  zus_fundusz_pracy TEXT,
  zus_razem         TEXT,
  pit5_zaplacony    TEXT,
  vat7_zaplacony    TEXT,
  kpir_przychod     TEXT,
  kpir_koszty       TEXT,
  zwroty_brutto     TEXT,
  uwagi             TEXT,
  zmienione_at      TEXT NOT NULL
);

CREATE TABLE faktury (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zamowienie_id INTEGER NOT NULL REFERENCES zamowienia(id) ON DELETE CASCADE,
  infakt_uuid TEXT,
  numer TEXT,
  ksef_status TEXT,
  blad_opis TEXT,
  utworzona_at TEXT NOT NULL, ksef_numer TEXT, ksef_sprawdzona_at TEXT, ksef_odczyt TEXT, allegro_invoice_id TEXT, allegro_wyslana_at TEXT, allegro_weryfikacja TEXT, allegro_zgloszenie_at TEXT, allegro_pytana_at TEXT,
  UNIQUE (zamowienie_id)
);

CREATE TABLE faktury_po_terminie (
  uuid          TEXT PRIMARY KEY,
  numer         TEXT,
  payment_date  TEXT,
  pozostalo_gr  INTEGER,
  sprawdzona_at TEXT NOT NULL
);

CREATE TABLE firmy_reczne (
  nazwa      TEXT PRIMARY KEY NOT NULL,
  sprzedawca TEXT NOT NULL,
  kategoria  TEXT NOT NULL,
  typ        TEXT NOT NULL CHECK (typ IN ('zmienny', 'staly', 'drobne')),
  dodana_at  TEXT NOT NULL
);

CREATE TABLE granice_historii (
  kanal   TEXT PRIMARY KEY,
  do_dnia TEXT NOT NULL,
  zrodlo  TEXT NOT NULL,
  uwaga   TEXT
);

CREATE TABLE kampania_ga4_dni (
  kod TEXT NOT NULL,
  dzien TEXT NOT NULL,
  sesje INTEGER NOT NULL DEFAULT 0,
  uzytkownicy INTEGER NOT NULL DEFAULT 0,



  sesje_meta INTEGER NOT NULL DEFAULT 0,

  odslony_promo INTEGER NOT NULL DEFAULT 0,
  pobrane_at TEXT NOT NULL,
  PRIMARY KEY (kod, dzien)
);

CREATE TABLE kampania_meta_dni (
  kod TEXT NOT NULL,
  dzien TEXT NOT NULL,
  wydatek TEXT NOT NULL,
  wyswietlenia INTEGER NOT NULL DEFAULT 0,
  zasieg INTEGER NOT NULL DEFAULT 0,
  klikniecia INTEGER NOT NULL DEFAULT 0,
  klikniecia_linku INTEGER NOT NULL DEFAULT 0,
  pobrane_at TEXT NOT NULL,
  PRIMARY KEY (kod, dzien)
);

CREATE TABLE kampania_zrodla (
  zrodlo TEXT PRIMARY KEY,
  ostatnia_proba_at TEXT,
  ostatni_sukces_at TEXT,
  ostatni_blad TEXT
);

CREATE TABLE kampanie (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kod TEXT NOT NULL UNIQUE,
  nazwa TEXT,
  od_dnia TEXT NOT NULL,
  do_dnia TEXT NOT NULL,
  sklep TEXT,
  cel_uzyc INTEGER
, meta_kampanie TEXT, ga4_wlasciwosc TEXT, ga4_sciezka TEXT, fale_json TEXT);

CREATE TABLE kategorie_kosztow (



  nip       TEXT PRIMARY KEY NOT NULL,
  kategoria TEXT NOT NULL,
  typ       TEXT NOT NULL CHECK (typ IN ('zmienny', 'staly', 'drobne')),
  zmienione_at TEXT NOT NULL
);

CREATE TABLE klienci (
  id INTEGER PRIMARY KEY AUTOINCREMENT,



  klucz TEXT NOT NULL UNIQUE,
  nazwa TEXT NOT NULL,


  nip TEXT,


  b2b INTEGER NOT NULL DEFAULT 0,


  rabat_procent INTEGER NOT NULL DEFAULT 0,
  faktura_json TEXT,
  wysylka_json TEXT,
  chce_fakture INTEGER NOT NULL DEFAULT 0,
  metoda_wysylki TEXT NOT NULL DEFAULT 'dpd',



  koszt_dostawy_brutto TEXT NOT NULL DEFAULT '0.00',
  platnosc TEXT NOT NULL DEFAULT 'przelew',



  termin_platnosci TEXT,
  komentarz TEXT,
  aktywny INTEGER NOT NULL DEFAULT 1,
  utworzone_at TEXT NOT NULL,
  zmienione_at TEXT NOT NULL
, rozliczenie_zbiorcze INTEGER NOT NULL DEFAULT 0, prog_darmowej_dostawy_gr INTEGER, oplata_obslugi_gr INTEGER, oplata_kurierska_gr INTEGER);

CREATE TABLE kolejka_druku (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  przesylka_id INTEGER NOT NULL REFERENCES przesylki(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'oczekuje',
  proby INTEGER NOT NULL DEFAULT 0,
  ostatni_blad TEXT,




  nastepna_proba_at TEXT,
  utworzone_at TEXT NOT NULL,
  wydrukowane_at TEXT
);

CREATE TABLE kolejka_druku_faktur (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  faktura_id INTEGER NOT NULL REFERENCES faktury(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'oczekuje',
  proby INTEGER NOT NULL DEFAULT 0,
  ostatni_blad TEXT,
  nastepna_proba_at TEXT,
  utworzone_at TEXT NOT NULL,
  wydrukowane_at TEXT
, zajete_przez TEXT, zajete_at TEXT);

CREATE TABLE konta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT NOT NULL UNIQUE,

  imie TEXT NOT NULL,
  hash_hasla TEXT NOT NULL,


  rola TEXT NOT NULL,
  czynne INTEGER NOT NULL DEFAULT 1,
  admin INTEGER NOT NULL DEFAULT 0,
  utworzone_at TEXT NOT NULL
);

CREATE TABLE koszty (
  ksef_number      TEXT PRIMARY KEY NOT NULL,
  numer_dokumentu  TEXT NOT NULL,
  sprzedawca_nip   TEXT,
  sprzedawca_nazwa TEXT,
  data_wystawienia TEXT NOT NULL,
  data_trwalego_zapisu TEXT NOT NULL,















  netto  TEXT NOT NULL,
  vat    TEXT NOT NULL,
  brutto TEXT NOT NULL,
  waluta TEXT NOT NULL,
  rodzaj TEXT NOT NULL,
  ma_zalacznik INTEGER NOT NULL DEFAULT 0,





  sciezka_xml TEXT,
  sciezka_pdf TEXT,
  pobrany_at  TEXT NOT NULL
, zrodlo TEXT NOT NULL DEFAULT 'ksef' CHECK (zrodlo IN ('ksef', 'reczne')), kategoria_dokumentu TEXT, typ_dokumentu TEXT CHECK (typ_dokumentu IS NULL OR typ_dokumentu IN ('zmienny', 'staly', 'drobne')));

CREATE TABLE koszty_odrzucone (




  ksef_number      TEXT PRIMARY KEY NOT NULL,


  numer_dokumentu  TEXT,
  data_trwalego_zapisu TEXT,

  powod            TEXT NOT NULL,
  metadane_json    TEXT NOT NULL,



  odrzucony_at     TEXT NOT NULL,
  ostatnia_proba_at TEXT NOT NULL
);

CREATE TABLE ksef_luki (
  uuid          TEXT PRIMARY KEY,
  numer         TEXT,
  invoice_date  TEXT,
  sprawdzona_at TEXT NOT NULL
);

CREATE TABLE log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zamowienie_id INTEGER,
  at TEXT NOT NULL,
  akcja TEXT NOT NULL,
  wynik TEXT
, kto TEXT);

CREATE TABLE logowania (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  login TEXT NOT NULL,
  usluga TEXT NOT NULL,
  ip TEXT,
  wynik TEXT NOT NULL
);

CREATE TABLE migracje_jednorazowe (
  nazwa        TEXT PRIMARY KEY NOT NULL,
  wykonana_at  TEXT NOT NULL
);

CREATE TABLE okresy_rozliczeniowe (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  klient_klucz TEXT NOT NULL,
  rok INTEGER NOT NULL,
  miesiac INTEGER NOT NULL,
  stan TEXT NOT NULL DEFAULT 'otwarty',
  infakt_uuid TEXT,
  numer TEXT,
  ksef_status TEXT,
  blad_opis TEXT,



















  utworzona_at TEXT,
  zamkniety_at TEXT,
  utworzony_at TEXT NOT NULL,
  UNIQUE (klient_klucz, rok, miesiac)
);

CREATE TABLE ostrzezenia_odrzucone (
  klucz          TEXT PRIMARY KEY,
  odrzucone_at   TEXT NOT NULL,
  odrzucone_przez TEXT
);

CREATE TABLE oznaczenia_zaplaty (
  uuid TEXT PRIMARY KEY NOT NULL,
  zlecone_at TEXT NOT NULL,
  powod TEXT NOT NULL CHECK (powod IN (
    'pobranie_doreczone', 'sprzatanie', 'juz_zaplacona', 'brak_daty', 'nieznana_w_infakcie')),
  data_zaplaty TEXT
);

CREATE TABLE platnosci (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zamowienie_id INTEGER NOT NULL REFERENCES zamowienia(id) ON DELETE CASCADE,
  kwota TEXT NOT NULL,


  data TEXT,
  metoda TEXT,
  uwaga TEXT,
  zrodlo TEXT NOT NULL,
  utworzona_at TEXT NOT NULL
);

CREATE TABLE platnosci_okresu (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  okres_rozliczeniowy_id INTEGER NOT NULL REFERENCES okresy_rozliczeniowe(id) ON DELETE CASCADE,
  kwota TEXT NOT NULL,
  data TEXT,
  metoda TEXT,
  uwaga TEXT,
  zrodlo TEXT NOT NULL,
  utworzona_at TEXT NOT NULL
);

CREATE TABLE podjazdy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  podglad_id TEXT NOT NULL REFERENCES podjazdy_podglady(id),
  grupa_id TEXT NOT NULL,
  command_id TEXT NOT NULL UNIQUE,
  kanal TEXT NOT NULL,
  przewoznik TEXT NOT NULL,
  adres_json TEXT NOT NULL,
  termin_json TEXT NOT NULL,
  stan TEXT NOT NULL CHECK (stan IN ('zarezerwowany', 'oczekuje', 'nieznany', 'potwierdzony', 'odrzucony')),
  pickup_id TEXT,
  carrier_pickup_id TEXT,
  pickup_carrier TEXT,
  kto TEXT,
  utworzony_at TEXT NOT NULL,
  ostatnia_proba_at TEXT,
  nastepne_sprawdzenie_at TEXT,
  sprawdzenie_token TEXT,
  blad_opis TEXT,
  UNIQUE (podglad_id, grupa_id)
);

CREATE TABLE podjazdy_podglady (
  id TEXT PRIMARY KEY NOT NULL,
  kto TEXT,
  snapshot_json TEXT NOT NULL,
  wygasa_at TEXT NOT NULL,
  utworzony_at TEXT NOT NULL
);

CREATE TABLE podjazdy_przesylki (
  podjazd_id INTEGER NOT NULL REFERENCES podjazdy(id) ON DELETE CASCADE,
  przesylka_id INTEGER NOT NULL REFERENCES przesylki(id),
  shipment_id TEXT NOT NULL,
  numer_listu TEXT,
  aktywna_rezerwacja INTEGER NOT NULL DEFAULT 1 CHECK (aktywna_rezerwacja IN (0, 1)),
  PRIMARY KEY (podjazd_id, przesylka_id)
);

CREATE TABLE pozycje (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zamowienie_id INTEGER NOT NULL REFERENCES zamowienia(id) ON DELETE CASCADE,
  nazwa TEXT NOT NULL,
  sku TEXT,
  ilosc INTEGER NOT NULL,
  cena_brutto TEXT NOT NULL,



  brutto_linii TEXT,
  vat TEXT
, cena_netto TEXT, netto_linii TEXT, zrodlo TEXT NOT NULL DEFAULT 'sklep', zrodlo_id INTEGER, zdjecie_url TEXT, produkt_id INTEGER, oferta_id TEXT, wariant_id TEXT, cena_katalogowa TEXT);

CREATE TABLE produkty_sklepowe (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kanal          TEXT NOT NULL,




  produkt_id     TEXT NOT NULL,


  wariant_id     TEXT NOT NULL DEFAULT '',




  wzor_id        INTEGER REFERENCES wzory(id) ON DELETE SET NULL,
  nazwa          TEXT NOT NULL,
  sku_sklepu     TEXT,
  cena_gr        INTEGER,
  kategorie_json TEXT,







  zdjecia_json   TEXT,
  adres          TEXT,
  rozmiar_tekst  TEXT,




  kategoria_glowna_zrodla TEXT,



  opis_zrodlowy  TEXT,


  status_publikacji TEXT,
  odczytane_at   TEXT NOT NULL,


  zniknal_at     TEXT, atrybuty_json TEXT, miniatura TEXT,
  UNIQUE (kanal, produkt_id, wariant_id)
);

CREATE TABLE proformy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zamowienie_id INTEGER NOT NULL REFERENCES zamowienia(id) ON DELETE CASCADE,




  numer TEXT NOT NULL,









  rok INTEGER NOT NULL,
  miesiac INTEGER NOT NULL,

  kolejny INTEGER NOT NULL,








  kwota_brutto TEXT NOT NULL,


  plik_sciezka TEXT,



  uniewazniona_at TEXT,
  utworzona_at TEXT NOT NULL
);

CREATE TABLE przesylki (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zamowienie_id INTEGER NOT NULL REFERENCES zamowienia(id) ON DELETE CASCADE,
  kurier TEXT NOT NULL,
  status TEXT NOT NULL,
  numer_listu TEXT,
  etykieta_sciezka TEXT,
  odpowiedz_surowa TEXT,
  status_kuriera TEXT,
  status_kuriera_at TEXT,
  status_kuriera_pobrany_at TEXT,
  status_kuriera_blad TEXT,
  blad_opis TEXT,
  sync_woo_blad TEXT,


  etykieta_reczna INTEGER,
  utworzona_at TEXT NOT NULL
, etykieta_zpl_sciezka TEXT, kolejnosc INTEGER NOT NULL DEFAULT 1, adres_uzyty TEXT, nadana_recznie INTEGER, id_przesylki_kuriera TEXT, zrodlo_numeru TEXT, carrier_allegro TEXT, status_kuriera_kod TEXT, ukryta_at TEXT, ukryta_przez TEXT, przejeta_at TEXT, przejecie_zdarzenie_at TEXT, przejecie_zrodlo TEXT, przejecie_kod TEXT);

CREATE TABLE reklamy_google_dni (
  polaczenie_id INTEGER NOT NULL REFERENCES reklamy_polaczenia(id),
  dzien TEXT NOT NULL,
  kampania_id TEXT NOT NULL,
  nazwa TEXT,
  koszt TEXT NOT NULL,
  klikniecia INTEGER NOT NULL DEFAULT 0,
  wyswietlenia INTEGER NOT NULL DEFAULT 0,
  waluta TEXT,
  pobrane_at TEXT NOT NULL,
  PRIMARY KEY (polaczenie_id, dzien, kampania_id)
);

CREATE TABLE reklamy_google_transakcje (
  polaczenie_id INTEGER NOT NULL REFERENCES reklamy_polaczenia(id),
  dzien TEXT NOT NULL,
  kampania_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  przychod TEXT NOT NULL,
  waluta TEXT,
  pobrane_at TEXT NOT NULL,
  PRIMARY KEY (polaczenie_id, transaction_id)
);

CREATE TABLE reklamy_meta_dni (
  polaczenie_id INTEGER NOT NULL REFERENCES reklamy_polaczenia(id),
  dzien TEXT NOT NULL,
  kampania_id TEXT NOT NULL,
  nazwa TEXT,
  wydatek TEXT NOT NULL,
  klikniecia INTEGER NOT NULL DEFAULT 0,
  klikniecia_linku INTEGER NOT NULL DEFAULT 0,
  wyswietlenia INTEGER NOT NULL DEFAULT 0,
  waluta TEXT,
  pobrane_at TEXT NOT NULL,
  PRIMARY KEY (polaczenie_id, dzien, kampania_id)
);

CREATE TABLE reklamy_meta_kampanie (
  polaczenie_id INTEGER NOT NULL REFERENCES reklamy_polaczenia(id),
  kampania_id TEXT NOT NULL,
  nazwa TEXT,
  effective_status TEXT,
  budzet_dzienny TEXT,
  budzet_calosciowy TEXT,
  budzety_json TEXT,
  waluta TEXT,
  pobrane_at TEXT NOT NULL,
  PRIMARY KEY (polaczenie_id, kampania_id)
);

CREATE TABLE reklamy_polaczenia (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  typ TEXT NOT NULL CHECK (typ IN ('ga4', 'meta', 'google_ads')),
  konto_id TEXT NOT NULL,
  kanal TEXT,
  regula_id TEXT NOT NULL DEFAULT 'zrodlo_id' CHECK (regula_id IN ('zrodlo_id', 'numer')),
  waluta TEXT,
  strefa TEXT,
  sekret_ref TEXT,
  utworzone_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (typ, konto_id)
);

CREATE TABLE reklamy_zrodla (
  polaczenie_id INTEGER PRIMARY KEY REFERENCES reklamy_polaczenia(id),
  ostatnia_proba_at TEXT,
  ostatni_sukces_at TEXT,
  kod_bledu TEXT
);

CREATE TABLE sekret_sesji (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sekret TEXT NOT NULL,
  zmieniony_at TEXT NOT NULL
);

CREATE TABLE slownik_kategorii_kosztow (
  kategoria TEXT PRIMARY KEY NOT NULL,
  typ       TEXT NOT NULL CHECK (typ IN ('zmienny', 'staly', 'drobne')),
  dodana_at TEXT NOT NULL
);

CREATE TABLE sprzedaz_historyczna (
  apilo_id            TEXT PRIMARY KEY,
  platform_account_id INTEGER,
  numer               TEXT,


  dzien               TEXT NOT NULL,
  utworzone_at        TEXT NOT NULL,
  brutto              TEXT NOT NULL,
  waluta              TEXT NOT NULL DEFAULT 'PLN',
  status              INTEGER,
  payment_status      INTEGER,


  tagi_json           TEXT,
  klient_email        TEXT,
  klient_nazwa        TEXT,
  faktura             INTEGER NOT NULL DEFAULT 0,
  pobrane_at          TEXT NOT NULL
, zrodlo TEXT NOT NULL DEFAULT 'apilo', status_zrodla TEXT);

CREATE TABLE sprzedaz_historyczna_pozycje (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  apilo_id      TEXT NOT NULL REFERENCES sprzedaz_historyczna(apilo_id) ON DELETE CASCADE,
  nazwa         TEXT NOT NULL,
  sku           TEXT,

  original_code TEXT,
  ilosc         INTEGER NOT NULL,
  brutto_linii  TEXT NOT NULL,
  typ           INTEGER NOT NULL
);

CREATE TABLE stan_archiwum_sprzedazy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  podloga_zrobiona_at TEXT,
  ostatnie_udane_at   TEXT,
  ostatni_blad        TEXT,
  ostatni_blad_at     TEXT
);

CREATE TABLE stan_importu (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  ostatni_dzien TEXT,
  ostatni_id    TEXT,
  zakonczony_at TEXT,
  blad          TEXT
);

CREATE TABLE stan_importu_sklepu (
  sklep           TEXT PRIMARY KEY,
  od_dnia         TEXT,
  do_dnia         TEXT,
  ostatnia_strona INTEGER,
  zakonczony_at   TEXT,
  blad            TEXT
);

CREATE TABLE stan_kosztow (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  kursor TEXT,
  ostatnie_udane_at TEXT,
  ostatni_blad TEXT,



  ostatni_blad_at TEXT
);

CREATE TABLE stan_pollera (
  sklep TEXT PRIMARY KEY,
  zsynchronizowane_do TEXT,
  ostatni_przebieg_at TEXT,
  ostatni_blad TEXT
, ostatni_blad_od_at TEXT, ostatni_blad_rodzaj TEXT, ostatni_blad_prob INTEGER);

CREATE TABLE stan_weryfikacji_allegro (
  kanal             TEXT PRIMARY KEY NOT NULL,

  kolejne_puste     INTEGER NOT NULL DEFAULT 0,



  ostatnia_proba_at TEXT,



  bezpiecznik_od    TEXT
);

CREATE TABLE tokeny_kanalu (
  kanal TEXT PRIMARY KEY NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  wygasa_at TEXT,
  refresh_wygasa_at TEXT,
  ostatni_blad TEXT,
  zaktualizowane_at TEXT
);

CREATE TABLE tokeny_ksef (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  access_do TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  refresh_do TEXT NOT NULL,
  ostatni_blad TEXT,
  zaktualizowane_at TEXT NOT NULL
);

CREATE TABLE uprawnienia (
  konto_id INTEGER NOT NULL REFERENCES konta(id) ON DELETE CASCADE,
  ekran TEXT NOT NULL,
  PRIMARY KEY (konto_id, ekran)
);

CREATE TABLE ustawienia (
  klucz        TEXT PRIMARY KEY NOT NULL,
  wartosc      TEXT NOT NULL,
  zmienione_at TEXT NOT NULL
);

CREATE TABLE wdt_numery (
  rok INTEGER NOT NULL,
  miesiac INTEGER NOT NULL,
  kolejny INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (rok, miesiac)
);

CREATE TABLE wiadomosci (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zamowienie_id INTEGER NOT NULL,



  temat_id TEXT NOT NULL,
  adresat TEXT NOT NULL,


  temat TEXT NOT NULL,


  zalacznik TEXT,
  wyslana_at TEXT NOT NULL,
  kto TEXT
);

CREATE TABLE wysylki_ksef (
  uuid TEXT PRIMARY KEY NOT NULL,
  zlecona_at TEXT NOT NULL,
  numer TEXT
);

CREATE TABLE wzory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,



  sku           TEXT UNIQUE,
  nazwa         TEXT NOT NULL,


  szerokosc_mm  INTEGER,
  wysokosc_mm   INTEGER,






  kategoria_glowna TEXT,



  paczkomat     TEXT,






  opis          TEXT,
  folder_nas    TEXT,
  utworzony_at  TEXT NOT NULL,
  zmieniony_at  TEXT NOT NULL
);

CREATE TABLE zamowienia (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sklep TEXT NOT NULL,
  zrodlo_id INTEGER NOT NULL,
  numer TEXT NOT NULL,
  klient_json TEXT,
  dostawa_json TEXT,
  metoda_wysylki TEXT NOT NULL DEFAULT 'nieznana',
  kwota_pobrania TEXT,
  chce_fakture INTEGER NOT NULL DEFAULT 0,
  nip TEXT,
  kwota_brutto TEXT NOT NULL,
  koszt_dostawy_brutto TEXT,
  status_woo TEXT,
  oplacone_at TEXT,
  oplacone_recznie INTEGER NOT NULL DEFAULT 0,
  anulowane INTEGER NOT NULL DEFAULT 0,
  w_realizacji_at TEXT,
  zwrot_at TEXT,
  zwrot_powod TEXT,
  surowe_json TEXT,
  utworzone_at TEXT NOT NULL,
  zmienione_at TEXT, dostawa_reczna_json TEXT, klient_reczny_json TEXT, chce_fakture_reczne INTEGER, anulowane_recznie INTEGER, wysylka_reczna_json TEXT, uwagi TEXT, koszt_dostawy_netto TEXT, pozycje_reczne_json TEXT, wyslane_at TEXT, sync_woo_blad TEXT, metoda_platnosci TEXT, zamowienie_zrodlowe_id INTEGER, pobranie INTEGER NOT NULL DEFAULT 0, punkt_odbioru TEXT, punkt_odbioru_opis TEXT, okres_rozliczeniowy_id INTEGER, do_siedziby_klienta INTEGER, indywidualne INTEGER, karta_id TEXT, status_realizacji TEXT, komentarz_wewnetrzny TEXT, potwierdzenie_wyslane_at TEXT, b2b INTEGER NOT NULL DEFAULT 0, termin_platnosci TEXT, rabat_procent INTEGER NOT NULL DEFAULT 0, metoda_wysylki_nazwa TEXT, kupony_json TEXT, atrybucja_json TEXT,
  UNIQUE (sklep, zrodlo_id)
);

CREATE TABLE zdjecia_ofert (
  oferta_id TEXT PRIMARY KEY NOT NULL,
  zdjecie_url TEXT,
  sprawdzone_at TEXT NOT NULL,
  blad TEXT
);

CREATE TABLE zwroty (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zamowienie_id INTEGER NOT NULL REFERENCES zamowienia(id) ON DELETE CASCADE,


  data TEXT NOT NULL,

  kwota TEXT NOT NULL,


  kwota_dostawy TEXT,
  powod TEXT,

  pieniadze_oddane_at TEXT,


  korekta_zlecona_at TEXT,
  korekta_referencja TEXT,
  korekta_uuid TEXT,
  korekta_numer TEXT,
  korekta_blad TEXT,
  utworzony_at TEXT NOT NULL
);

CREATE TABLE zwroty_pozycje (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zwrot_id INTEGER NOT NULL REFERENCES zwroty(id) ON DELETE CASCADE,
  klucz_pozycji TEXT NOT NULL,
  nazwa TEXT NOT NULL,
  ilosc INTEGER NOT NULL,
  kwota TEXT NOT NULL
);

CREATE UNIQUE INDEX allegro_formulka_raz
  ON allegro_odpowiedzi (kanal, thread_id) WHERE rodzaj = 'formulka';

CREATE INDEX allegro_odpowiedzi_watek ON allegro_odpowiedzi (kanal, thread_id);

CREATE INDEX allegro_watki_data ON allegro_watki (last_message_date_time DESC);

CREATE INDEX allegro_wiadomosci_watek
  ON allegro_wiadomosci (kanal, thread_id, utworzona_at);

CREATE INDEX idx_archiwum_sprzedazy_data ON archiwum_sprzedazy (invoice_date);

CREATE INDEX idx_cele_zdarzenia_cel_dzien ON cele_zdarzenia (cel_id, dzien);

CREATE INDEX idx_historia_dzien ON sprzedaz_historyczna(dzien);

CREATE INDEX idx_historia_pozycje ON sprzedaz_historyczna_pozycje(apilo_id);

CREATE INDEX idx_koszty_nip ON koszty (sprzedawca_nip);

CREATE INDEX idx_koszty_wystawienie ON koszty (data_wystawienia);

CREATE INDEX idx_logowania_at ON logowania(at DESC);

CREATE INDEX idx_produkty_sklepowe_kanal ON produkty_sklepowe (kanal);

CREATE INDEX idx_produkty_sklepowe_wzor ON produkty_sklepowe (wzor_id);

CREATE INDEX idx_reklamy_google_dzien ON reklamy_google_dni(dzien);

CREATE INDEX idx_reklamy_google_tx_dzien ON reklamy_google_transakcje(dzien);

CREATE INDEX idx_reklamy_meta_dzien ON reklamy_meta_dni(dzien);

CREATE INDEX idx_zwroty_pozycje_zwrot ON zwroty_pozycje(zwrot_id);

CREATE INDEX idx_zwroty_zamowienie ON zwroty(zamowienie_id);

CREATE UNIQUE INDEX klienci_nip ON klienci (nip) WHERE nip IS NOT NULL;

CREATE UNIQUE INDEX platnosci_jedna_ze_sklepu
  ON platnosci (zamowienie_id) WHERE zrodlo = 'sklep';

CREATE UNIQUE INDEX podjazdy_przesylki_jedna_aktywna
  ON podjazdy_przesylki (przesylka_id) WHERE aktywna_rezerwacja = 1;

CREATE INDEX pozycje_zamowienie ON pozycje (zamowienie_id);

CREATE UNIQUE INDEX proformy_kolejny ON proformy (rok, miesiac, kolejny);

CREATE UNIQUE INDEX proformy_numer ON proformy (numer);

CREATE INDEX proformy_zamowienie ON proformy (zamowienie_id);

CREATE UNIQUE INDEX przesylki_kolejnosc_zywa ON przesylki (zamowienie_id, kolejnosc) WHERE status <> 'blad';

CREATE INDEX wiadomosci_zamowienie ON wiadomosci (zamowienie_id);

CREATE UNIQUE INDEX zamowienia_karta_id ON zamowienia(karta_id) WHERE karta_id IS NOT NULL;

CREATE UNIQUE INDEX zamowienia_numer_reczny
  ON zamowienia (numer) WHERE sklep = 'reczne';

CREATE INDEX zamowienia_okres_rozliczeniowy ON zamowienia (okres_rozliczeniowy_id);

CREATE UNIQUE INDEX zwroty_korekta_numer_zamowienia
  ON zwroty (zamowienie_id, korekta_numer) WHERE korekta_numer IS NOT NULL;
