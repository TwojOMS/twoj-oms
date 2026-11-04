import type { Migracja } from '../../../core/kontrakty.ts';
export const migracjaKanalowSprzedazy: Migracja = {
 numer:1, nazwa:'trwale kanaly sprzedazy Allegro',
 wykonaj(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS kanaly_sprzedazy (
   klucz TEXT PRIMARY KEY, nazwa TEXT NOT NULL CHECK(length(trim(nazwa)) BETWEEN 1 AND 80),
   srodowisko TEXT NOT NULL CHECK(srodowisko IN ('produkcja','sandbox')),
   zrodlo TEXT NOT NULL CHECK(zrodlo IN ('env','panel')),
   konto_id TEXT, login TEXT, raport TEXT NOT NULL,
   autoryzacja TEXT NOT NULL CHECK(autoryzacja IN ('brak','oczekuje_potwierdzenia','polaczone','wymaga_autoryzacji','odlaczone')),
   pobieranie TEXT NOT NULL CHECK(pobieranie IN ('wylaczone','wlaczone','zatrzymywanie')),
   od_utc TEXT NOT NULL, wersja INTEGER NOT NULL, generacja INTEGER NOT NULL, generacja_importu INTEGER NOT NULL,
   utworzono_at TEXT NOT NULL, zmieniono_at TEXT NOT NULL, aktor_id INTEGER NOT NULL, aktor_login TEXT NOT NULL,
   UNIQUE(srodowisko,konto_id)
  );
  CREATE TABLE IF NOT EXISTS kanaly_audit (
   id INTEGER PRIMARY KEY, kanal TEXT NOT NULL, operacja TEXT NOT NULL,
   wersja INTEGER NOT NULL, aktor_id INTEGER NOT NULL, aktor_login TEXT NOT NULL, zmieniono_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kanaly_blokady_zapisu (
   kanal TEXT PRIMARY KEY, zablokowane INTEGER NOT NULL CHECK(zablokowane IN (0,1)),
   aktor_id INTEGER NOT NULL, aktor_login TEXT NOT NULL, zmieniono_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kanaly_operacje_niejednoznaczne (
   id TEXT PRIMARY KEY, kanal TEXT NOT NULL, metoda TEXT NOT NULL, sciezka TEXT NOT NULL,
   stan TEXT NOT NULL DEFAULT 'do_sprawdzenia', zmieniono_at TEXT NOT NULL
  );`);
 },
};
