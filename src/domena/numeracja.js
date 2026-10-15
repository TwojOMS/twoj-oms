// Wlasna seria numeracji zamowien wprowadzanych recznie: R/RRRR/NNN.
//
// Decyzja wlasciciela (spec Etap 3, punkt 4): od razu widac, ze zamowienie jest spoza
// sklepu — w panelu, na liscie przewozowym i w rozmowie z klientem — i numer nie moze
// zderzyc sie z tym, ktory sklep dopiero nada.
const WZORZEC = /^R\/(\d{4})\/(\d+)$/;

/** `formatujNumer(2026, 7)` → `'R/2026/007'`. Powyzej 999 numer ROSNIE, nie urywa sie. */
export function formatujNumer(rok, kolejny) {
  return `R/${rok}/${String(kolejny).padStart(3, '0')}`;
}

export function rokZNumeru(numer) {
  const m = WZORZEC.exec(String(numer ?? ''));
  return m ? Number(m[1]) : null;
}

export function kolejnyZNumeru(numer) {
  const m = WZORZEC.exec(String(numer ?? ''));
  return m ? Number(m[2]) : null;
}

/**
 * `zrodlo_id` zapisywany w bazie dla zamowienia recznego (db/zamowienia-reczne.js).
 *
 * ⚠️ NIE WOLNO uzywac samej pozycji w roku (1, 2, 3...) — `UNIQUE (sklep, zrodlo_id)`
 * w schema.sql nie wie NIC o latach, a licznik pozycji zeruje sie z rokiem
 * (nastepnyNumerReczny). Pierwsze zamowienie 2027 mialoby wiec ta sama pozycje co
 * pierwsze zamowienie 2026 — ten sam `zrodlo_id` — i INSERT rzucalby surowym bledem
 * SQLite operatorowi w twarz, dokladnie tak, jak potwierdzil recenzent.
 *
 * Kodowanie `rok * 100000 + kolejny`: mnoznik 100000 zostawia PIEC CYFR na pozycje
 * w roku, czyli do 99 999 zamowien rocznie — sto razy wiecej, niz kiedykolwiek pokaze
 * format numeru R/RRRR/NNN (formatujNumer rosnie powyzej 999, wiec pozycja MOZE
 * przekroczyc trzy cyfry; nie moze tylko przekroczyc pieciu). Rok (dzis ~2026,
 * czterocyfrowy) nigdy nie "wjedzie" na cudzy zakres pozycji, bo musialby dla tego
 * urosnac o 100 000 lat. To NIE jest hash: to odwracalna projekcja (rok, kolejny) →
 * liczba, ktora da sie odczytac z powrotem bez pomocniczych funkcji
 * (rok = Math.floor(x / 100000), kolejny = x % 100000) — przydatne przy recznym
 * SELECT-cie w SQLite, gdyby ktos kiedys musial to zdebugowac z linii polecen.
 */
export function zrodloIdReczne(rok, kolejny) {
  return rok * 100_000 + kolejny;
}
