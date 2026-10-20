import { domyslneStatusy, sprawdzStatusy, statusIndywidualnyAktywny } from '../../domena/statusy-konfiguracja.js';
import { STATUSY_RECZNE } from '../../domena/status-reczny.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const pamiec = new WeakMap();
const pamiecZadania = new AsyncLocalStorage();
const rozpoznaniaTabeli = new WeakMap();
const KLUCZ = 'statusy.konfiguracja';
const kanalyIndywidualne = new WeakMap();
// ⚠️ „Czy są zamówienia indywidualne” NIE jest pytaniem na żądanie (PRZ-102.15b): kolumna nie ma
// indeksu, więc przy braku takich zamówień EXISTS przechodzi CAŁĄ tabelę zamówień — przy każdym
// żądaniu, wbrew strażnikowi PRZ-051 (tests/prz051/lista-http.test.js). Odpowiedź zapada raz na
// połączenie, a dalej dopisuje ją wyzwalacz TEMP (jak oms/db/sledzenie-listy.js, bez migracji) przy
// KAŻDYM zapisie tym połączeniem: poller, zamówienie ręczne, uzupełnienia startowe. Flaga jest
// jednokierunkowa — skasowanie ostatniego takiego zamówienia albo wycofana transakcja zostawiają
// status widoczny do restartu (pusta zakładka, nic nie ginie). Zapis innym połączeniem (ręczny
// SQL, skrypt) zobaczy następny start.
const historieIndywidualne = new WeakMap();
const FUNKCJA_HISTORII = 'oms_statusy_jest_indywidualne';
function sledzHistorieIndywidualnych(db) {
  // Połączenie bez `function` (opakowanie bazy, np. tylko do odczytu): bez wyzwalacza, jeden odczyt na połączenie.
  if (typeof db.function !== 'function') {
    const sa = Boolean(db.prepare('SELECT EXISTS(SELECT 1 FROM zamowienia WHERE indywidualne = 1) AS sa').get().sa);
    historieIndywidualne.set(db, sa);
    return;
  }
  db.function(FUNKCJA_HISTORII, () => { historieIndywidualne.set(db, true); return null; });
  for (const [nazwa, op] of [['insert', 'INSERT'], ['update', 'UPDATE OF indywidualne']]) {
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS statusy_indywidualne_${nazwa} AFTER ${op} ON zamowienia
      WHEN NEW.indywidualne = 1 BEGIN SELECT ${FUNKCJA_HISTORII}(); END`);
  }
  // Wyzwalacz przed odczytem: zapis między nimi i tak ustawi flagę.
  const sa = Boolean(db.prepare('SELECT EXISTS(SELECT 1 FROM zamowienia WHERE indywidualne = 1) AS sa').get().sa);
  historieIndywidualne.set(db, historieIndywidualne.get(db) === true || sa);
}
export function ustawKanalIndywidualnyStatusow(db, wlaczony) {
  kanalyIndywidualne.set(db, wlaczony);
  // Kanał włączony (produkcja): status i tak aktywny — zero zapytań, zero wyzwalaczy.
  if (wlaczony !== true && !historieIndywidualne.has(db)) sledzHistorieIndywidualnych(db);
}
function konfiguracjaZJson(db, wartosc) {
  // Wartość zamiast samej daty: dwa zapisy w tej samej milisekundzie też unieważniają pamięć.
  const poprzedni = pamiec.get(db);
  if (poprzedni && poprzedni.wartosc === wartosc) return poprzedni;
  const statusy = wartosc === undefined ? domyslneStatusy() : sprawdzStatusy(JSON.parse(wartosc).sort((a, b) => a.kolejnosc - b.kolejnosc));
  const wynik = Object.freeze(statusy.map(s => Object.freeze(s)));
  const konfiguracja = { wartosc, statusy: wynik,
    etykiety: Object.freeze(Object.fromEntries(wynik.map(s => [s.klucz, s.etykieta]))),
    wlasne: Object.freeze(wynik.filter(s => s.jak)),
    opcje: Object.freeze(wynik.filter(s => s.jak || STATUSY_RECZNE.includes(s.klucz)).map(({ klucz, etykieta }) => Object.freeze({ klucz, etykieta }))),
  };
  pamiec.set(db, konfiguracja);
  return konfiguracja;
}
// Jedna migawka na żądanie, osobna dla równoległych żądań i baz.
export function wPamieciStatusowZadania(fn) {
  return pamiecZadania.run({ konfiguracje: new Map() }, fn);
}
function konfiguracjaStatusow(db) {
  const zadanie = pamiecZadania.getStore();
  if (zadanie?.konfiguracje.has(db)) return zadanie.konfiguracje.get(db);
  const zapis = db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ);
  const pelna = konfiguracjaZJson(db, zapis?.wartosc);
  const kanal = kanalyIndywidualne.get(db) === true;
  // Połączenie bez modułu zamówień (skrypt, wąski skład): ten sam odczyt raz, przy pierwszym użyciu.
  if (!kanal && !historieIndywidualne.has(db)) sledzHistorieIndywidualnych(db);
  const aktywny = statusIndywidualnyAktywny(kanal, !kanal && historieIndywidualne.get(db) === true);
  const konfiguracja = aktywny ? pelna : { ...pelna,
    etykiety: Object.freeze(Object.fromEntries(Object.entries(pelna.etykiety).filter(([k]) => k !== 'indywidualne'))),
  };
  zadanie?.konfiguracje.set(db, konfiguracja);
  return konfiguracja;
}
export function statusyWKolejnosci(db) {
  // Ustawienia edytują pełny katalog nazw i kolorów, także statusów dodatkowych.
  return konfiguracjaStatusow(db).statusy;
}
export function etykietyStatusow(db) {
  return konfiguracjaStatusow(db).etykiety;
}
// Bez zapisu ustawień zachowujemy historyczny wygląd, łącznie z neutralnym Anulowane.
export function koloryStatusow(db) {
  const konfiguracja = konfiguracjaStatusow(db);
  return konfiguracja.wartosc === undefined ? undefined : konfiguracja.statusy;
}
export function opcjeStatusow(db) {
  return konfiguracjaStatusow(db).opcje;
}
export function zapiszStatusy(db, statusy) {
  const poprawne = sprawdzStatusy(statusy);
  db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc=excluded.wartosc, zmienione_at=excluded.zmienione_at`)
    .run(KLUCZ, JSON.stringify(poprawne), new Date().toISOString());
  pamiec.delete(db);
  pamiecZadania.getStore()?.konfiguracje.delete(db);
}

// Stare, wąskie składy modułów (np. sam rdzeń) nie mają migracji zamówień.
export function maTabeleStatusow(db) {
  let zapytanie = rozpoznaniaTabeli.get(db);
  if (!zapytanie) {
    zapytanie = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='zamowienia_status_wlasny'");
    rozpoznaniaTabeli.set(db, zapytanie);
  }
  return Boolean(zapytanie.get());
}

// Wspólny SELECT karty, listy, indeksu i historii klienta — żadnego zapytania na każdy wiersz.
export function kolumnyStatusow(db) {
  const etap = maTabeleStatusow(db)
    ? '(SELECT klucz FROM zamowienia_status_wlasny WHERE zamowienie_id = zamowienia.id)'
    : 'NULL';
  return `(SELECT wartosc FROM ustawienia WHERE klucz = 'statusy.konfiguracja') AS statusy_konfiguracja_json,
    ${etap} AS status_wlasny_klucz`;
}
export function zStatusamiWlasnymi(db, w) {
  const { statusy_konfiguracja_json, status_wlasny_klucz, ...wiersz } = w;
  const konfiguracja = konfiguracjaZJson(db, statusy_konfiguracja_json ?? undefined);
  return { ...wiersz, status_wlasny: status_wlasny_klucz ?? null,
    statusy_wlasne: konfiguracja.wlasne, opcje_statusow: konfiguracja.opcje,
    etykiety_statusow: konfiguracja.etykiety };
}
