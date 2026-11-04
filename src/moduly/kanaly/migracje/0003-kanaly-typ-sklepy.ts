import type {Migracja} from '../../../core/kontrakty.ts';

// PRZ-132.02 (E4, baza konfiguratorów): kanał zna swój typ, aplikację Allegro, przez którą go połączono, a sklep
// WooCommerce z panelu ma adres i mapowanie w osobnej tabeli 1:1 po kluczu.
// - `typ` bez CHECK, celowo (PRZ-133: następne typy bez przebudowy tabeli). Dopuszczalne wartości pilnuje kod
//   (`TYPY_KANALOW`, `czyTypKanalu` z src/domena/moduly-kanalow.ts). Istniejące wiersze dostają DEFAULT 'allegro'.
// - `aplikacja`: 'device' albo 'dcr' dla nowych połączeń z panelu; NULL = wiersz sprzed migracji, czytany jak dziś
//   (DCR dla panelu, env dla env) — plan PRZ-132, rozdział 3.1.
// Addytywna: dwie kolumny z DEFAULT/NULL i nowa tabela; żaden istniejący wiersz się nie zmienia. Każde ADD COLUMN
// chronione PRAGMA table_info, jak automatyzacje/0003 i 0004 — odporna na ponowne uruchomienie.
export const migracjaTypuKanaluISklepow:Migracja={
 numer:3,nazwa:'typ kanalu, aplikacja Allegro i dane sklepow',
 wykonaj(db){
  const kolumny=new Set(db.prepare('PRAGMA table_info(kanaly_sprzedazy)').all().map(k=>(k as {name:string}).name));
  if(!kolumny.has('typ'))db.exec("ALTER TABLE kanaly_sprzedazy ADD COLUMN typ TEXT NOT NULL DEFAULT 'allegro'");
  if(!kolumny.has('aplikacja'))db.exec('ALTER TABLE kanaly_sprzedazy ADD COLUMN aplikacja TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS kanaly_sklepy (
   klucz TEXT PRIMARY KEY REFERENCES kanaly_sprzedazy(klucz),
   adres TEXT NOT NULL UNIQUE,
   ustawienia_json TEXT NOT NULL CHECK(json_valid(ustawienia_json)),
   sprawdzono_at TEXT,
   zmieniono_at TEXT NOT NULL
  )`);
 },
};
