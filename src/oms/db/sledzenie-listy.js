// Śledzenie zmian dla indeksu listy zamówień (PRZ-051).
//
// Wyzwalacze TEMP — żyją w połączeniu, nie w pliku bazy, więc nie są migracją i nie wchodzą
// w kontrolę schematu (baseline, strażnik migracji). Każdy zapis tym połączeniem w tabelach,
// które czyta odczyt listy (`zamowieniaPoId`), dopisuje identyfikator zamówienia do TRWAŁEJ
// tabeli `lista_brudne` W TEJ SAMEJ TRANSAKCJI, co sama zmiana: wycofany zapis wycofuje
// znacznik, a awaria procesu po zatwierdzeniu nie gubi go (następny proces go zastanie).
//
// ⚠️ Zakładane przy KAŻDYM otwarciu bazy przez `openOmsDb` (proces panelu, skrypty importu),
// zaraz po migracjach i PRZED uzupełnieniami startowymi — one też zmieniają zamówienia.
// Zapis połączeniem, które tego nie zrobiło (gołe `DatabaseSync`, ręczny SQL), wyłapuje
// sprawdzenie indeksu w tle po starcie procesu (oms/db/indeks-listy.js).
//
// ⚠️ Nowa tabela czytana przez odczyt listy MUSI trafić do TABELE_DZIECI — inaczej jej zmiana
// nie przeliczy zakładek do najbliższego sprawdzenia po starcie (test „każdy zapis…").
export const TABELE_DZIECI = ['pozycje', 'platnosci', 'przesylki', 'faktury', 'zwroty', 'zamowienia_status_wlasny'];

const OPERACJE = ['INSERT', 'UPDATE', 'DELETE'];

function wyzwalacz(nazwa, op, tabela, stary, nowy) {
  return `CREATE TEMP TRIGGER IF NOT EXISTS ${nazwa}_${op.toLowerCase()} AFTER ${op} ON ${tabela} BEGIN
    ${op !== 'INSERT' ? `INSERT OR IGNORE INTO lista_brudne (zamowienie_id) ${stary};` : ''}
    ${op !== 'DELETE' ? `INSERT OR IGNORE INTO lista_brudne (zamowienie_id) ${nowy};` : ''}
  END`;
}

const WYZWALACZE = [
  ...OPERACJE.map((op) => wyzwalacz('lista_zamowienia', op, 'zamowienia', 'VALUES (OLD.id)', 'VALUES (NEW.id)')),
  ...TABELE_DZIECI.filter(t => t !== 'zamowienia_status_wlasny').flatMap((t) => OPERACJE.map((op) => wyzwalacz(`lista_${t}`, op, t,
    'VALUES (OLD.zamowienie_id)', 'VALUES (NEW.zamowienie_id)'))),
  // ⚠️ `wysylki_ksef` CELOWO BEZ WYZWALACZA (recenzja PRZ-051): odczyt faktury dokleja z niej
  // `ksef_zlecona_at`, ale nie czyta tego żadna reguła indeksu (status, lista robocza, termin,
  // filtry, fraza) — wiersz listy i tak liczy się na żywo. Wyzwalacz kosztowałby skan całych
  // `faktury` po `infakt_uuid` przy każdym zapisie rezerwacji. Reguła, która zacznie czytać
  // to pole, musi go tu dopisać.
];

/** Zakłada wyzwalacze, jeśli baza ma tabele indeksu listy. Bezpieczne do wielokrotnego wołania. */
export function sledzZmianyListy(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lista_brudne'").get()) return false;
  for (const sql of WYZWALACZE) db.exec(sql);
  // Wąski skład modułów może mieć indeks z PRZ-051, ale nie nowszą migrację etapów.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='zamowienia_status_wlasny'").get()) {
    for (const op of OPERACJE) db.exec(wyzwalacz('lista_zamowienia_status_wlasny', op, 'zamowienia_status_wlasny',
      'VALUES (OLD.zamowienie_id)', 'VALUES (NEW.zamowienie_id)'));
  }
  return true;
}
