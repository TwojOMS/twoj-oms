import { domyslneStatusy, sprawdzStatusy } from '../../domena/statusy-konfiguracja.js';
import { STATUSY_RECZNE } from '../../domena/status-reczny.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const pamiec = new WeakMap();
const pamiecZadania = new AsyncLocalStorage();
const rozpoznaniaTabeli = new WeakMap();
const KLUCZ = 'statusy.konfiguracja';
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
// Jedna migawka na żądanie, osobna dla równoległych żądań i baz. Poza HTTP odczyt jak dotąd.
export function wPamieciStatusowZadania(fn) {
  return pamiecZadania.run(new Map(), fn);
}
function konfiguracjaStatusow(db) {
  const zadanie = pamiecZadania.getStore();
  if (zadanie?.has(db)) return zadanie.get(db);
  const zapis = db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ);
  const konfiguracja = konfiguracjaZJson(db, zapis?.wartosc);
  zadanie?.set(db, konfiguracja);
  return konfiguracja;
}
export function statusyWKolejnosci(db) {
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
  pamiecZadania.getStore()?.delete(db);
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
