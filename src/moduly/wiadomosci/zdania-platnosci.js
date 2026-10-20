// PRZ-102.17: zdania o płatności w mailach (Ustawienia → Szablony wiadomości → „Zdania o płatności").
//
// Jeden wiersz tabeli `ustawienia` (klucz `wiadomosci.zdania_platnosci`, JSON { klucz: tekst }), bez migracji — wzór
// jak szablony (oms/db/szablony-wiadomosci.js). W JSON-ie leżą tylko zdania ZMIENIONE; brak klucza = tekst domyślny.
// Usługi czytają zapis przy KAŻDYM złożeniu maila (services/wiadomosci.js, podgląd szablonu) — zmiana działa od
// następnego maila, bez restartu. Reguły treści w domena/zdania-platnosci.js; znaki sterujące odrzuca to samo
// wyrażenie, co podpis maili (PRZ-102.10).
import {
  KLUCZ_ZDAN, ZDANIA, DOMYSLNE_ZDANIA, czyZnaneZdanie, odczytajZdania, zdaniaDoMaila, regulaTresci,
  maksZdania, kolizjeEtykiet, ETYKIETY_Z_DWUKROPKIEM,
} from '../../domena/zdania-platnosci.js';
import { ZAKAZANE } from './podpis-maili.js';

const NIEWIDOCZNE = /\p{Cf}/u;

/**
 * Zdania zapisane w bazie TAK, JAK LEŻĄ: `{ klucz: tekst }` (puste, gdy nic nie zapisano albo wiersz jest uszkodzony).
 * Do scalania przy zapisie i do ekranu — NIE do maila (mail bierze `wczytajZdaniaPlatnosci`).
 */
export function wczytajZapisaneZdania(db) {
  const w = db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_ZDAN);
  return odczytajZdania(w?.wartosc ?? null);
}

/**
 * Zapisane zdania rozdzielone na te, które przechodzą DZISIEJSZE reguły (`dobre`), i odrzucone (`odrzucone`:
 * { klucz: powód }). Recenzja PRZ-102.17: zdanie zapisane przed zaostrzeniem reguł albo wpisane do bazy z pominięciem
 * formularza nie może wyjść do klienta — odczyt sprawdza je tym samym `sprawdzZdanie`, co zapis.
 */
export function zdaniaZReguly(zapisane) {
  const dobre = {}; const odrzucone = {};
  for (const [klucz, tekst] of Object.entries(zapisane)) {
    const { wartosc, blad } = sprawdzZdanie(klucz, tekst);
    if (blad) odrzucone[klucz] = blad;
    else if (wartosc) dobre[klucz] = wartosc;
  }
  // PRZ-102.19: zmienione etykiety przelewu, które brzmią jak inna etykieta, wracają do domyślnych. W pętli, bo powrót
  // jednej do domyślnej może zderzyć ją z inną zmienioną („Termin" → „Rachunek" przy odrzuconym „Rachunek" → „Konto {x}").
  for (;;) {
    const zderzone = Object.entries(kolizjeEtykiet(zdaniaDoMaila(dobre))).filter(([k]) => Object.hasOwn(dobre, k));
    if (!zderzone.length) break;
    for (const [k, powod] of zderzone) { delete dobre[k]; odrzucone[k] = powod; }
  }
  return { dobre, odrzucone };
}

/**
 * Zdania zmienione w panelu, które wolno wysłać. Zdanie odrzucone przez reguły = tekst domyślny w mailu i jedna linia
 * w logu (sam klucz, BEZ treści — treść pisał operator i nie musi trafiać do logu).
 */
// Recenzja PRZ-102.19 (D4): ostatni zalogowany zapis każdej bazy. Ten sam wiersz z tym samym odrzuconym zdaniem dawał
// linię w logu przy KAŻDYM mailu i każdym podglądzie karty; teraz raz na zmianę zapisu (i raz na start procesu).
const ZALOGOWANE = new WeakMap();

export function wczytajZdaniaPlatnosci(db, { log = (t) => console.error(t) } = {}) {
  const surowy = db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_ZDAN)?.wartosc ?? null;
  const { dobre, odrzucone } = zdaniaZReguly(odczytajZdania(surowy));
  const nowy = ZALOGOWANE.get(db) !== surowy;
  ZALOGOWANE.set(db, surowy);
  for (const klucz of nowy ? Object.keys(odrzucone) : []) {
    log(`wiadomości: zapisane zdanie o płatności „${klucz}” nie przechodzi reguł — w mailu idzie tekst domyślny (popraw w Ustawienia → Szablony wiadomości)`);
  }
  return dobre;
}

/** Komplet zdań do maila (zapisane i dozwolone + domyślne) — czytany przy każdym mailu. */
export const zdaniaPlatnosciTeraz = (db, opcje) => zdaniaDoMaila(wczytajZdaniaPlatnosci(db, opcje));

/**
 * Walidacja jednego pola formularza. Zwraca `{ wartosc, blad }`; `wartosc` = '' oznacza „tekst domyślny".
 * Nowe linie z pola tekstowego zamieniają się w odstęp (zdanie to jedna linia maila); inne znaki sterujące = odmowa.
 * Tekst równy domyślnemu też daje '' — nic nie zapisujemy, ekran dalej mówi „domyślne".
 */
export function sprawdzZdanie(klucz, surowa) {
  if (!czyZnaneZdanie(klucz)) return { wartosc: '', blad: 'Nieznane zdanie.' };
  // Recenzja PRZ-102.19 (W1): każdy odstęp z \p{Zs} (twarda spacja, spacja firetowa…) to jedna zwykła spacja, a znak
  // niewidoczny (\p{Cf}: spacja zerowej szerokości, miękki dywiz, znaczniki kierunku) = odmowa — przy zapisie i odczycie.
  let tekst = String(surowa ?? '').replace(/\r\n?|\n/gu, ' ').replace(/\p{Zs}+/gu, ' ').trim();
  if (ZAKAZANE.test(tekst) || NIEWIDOCZNE.test(tekst)) {
    return { wartosc: tekst, blad: 'Zdanie to zwykły tekst — bez tabulatorów, znaków sterujących i znaków niewidocznych (np. spacji zerowej szerokości).' };
  }
  // Po tych etykietach dwukropek stawia kod — wpisany obcinamy (ze spacjami przed nim), żeby nie wyszło „Rachunek:: …".
  if (ETYKIETY_Z_DWUKROPKIEM.includes(klucz)) tekst = tekst.replace(/\s*:+$/u, '');
  if (!tekst || tekst === DOMYSLNE_ZDANIA[klucz]) return { wartosc: '', blad: null };
  const blad = regulaTresci(klucz, tekst);
  return { wartosc: tekst, blad };
}

function zapiszStan(db, stan, teraz) {
  if (!Object.keys(stan).length) {
    db.prepare('DELETE FROM ustawienia WHERE klucz = ?').run(KLUCZ_ZDAN);
    return;
  }
  db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, zmienione_at = excluded.zmienione_at`)
    .run(KLUCZ_ZDAN, JSON.stringify(stan), teraz);
}

/**
 * Zapis formularza: każde pole obecne w `pola` (znane klucze) — sprawdzone wszystkie, zapis wszystkich albo żadnego.
 * `{ kod: 303 }` albo `{ kod: 400, bledy: { klucz: powód } }` (nic nie zapisane).
 * Odczyt–zmiana–zapis w jednej transakcji: pola spoza formularza zostają, jak były.
 */
export function zapiszZdaniaPlatnosci(db, pola, teraz = new Date().toISOString()) {
  const obecne = ZDANIA.map((z) => z.klucz).filter((k) => Object.hasOwn(pola ?? {}, k));
  if (!obecne.length) return { kod: 400, bledy: { _: 'Formularz nie zawiera żadnego zdania.' } };
  const sprawdzone = obecne.map((k) => ({ klucz: k, ...sprawdzZdanie(k, pola[k]) }));
  const bledy = Object.fromEntries(sprawdzone.filter((s) => s.blad).map((s) => [s.klucz, s.blad]));
  if (Object.keys(bledy).length) return { kod: 400, bledy };
  db.exec('BEGIN IMMEDIATE');
  try {
    const stan = { ...wczytajZapisaneZdania(db) };
    for (const s of sprawdzone) {
      if (s.wartosc) stan[s.klucz] = s.wartosc; else delete stan[s.klucz];
    }
    // PRZ-102.19: kolizje sprawdzone na KOMPLECIE po zapisie (pola spoza formularza też się liczą). Recenzja (D5): błąd
    // przy polach ZMIENIONYCH tym formularzem (obie strony zmienione — przy obu); gdy żadna nie jest zmieniona
    // (zderzenie zostało z dawnego zapisu), przy wszystkich zderzonych.
    const przed = zdaniaDoMaila(wczytajZapisaneZdania(db));
    const po = zdaniaDoMaila(stan);
    const zderzone = Object.entries(kolizjeEtykiet(po));
    if (zderzone.length) {
      db.exec('ROLLBACK');
      const zmienione = zderzone.filter(([k]) => obecne.includes(k) && po[k] !== przed[k]);
      return { kod: 400, bledy: Object.fromEntries(zmienione.length ? zmienione : zderzone) };
    }
    zapiszStan(db, stan, teraz);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { kod: 303 };
}

/** „Przywróć domyślne" jednego zdania. `false` = nieznany klucz. */
export function przywrocZdanie(db, klucz, teraz = new Date().toISOString()) {
  if (!czyZnaneZdanie(klucz)) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const { [klucz]: _usuniete, ...reszta } = wczytajZapisaneZdania(db);
    zapiszStan(db, reszta, teraz);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return true;
}

/**
 * Wiersze sekcji na ekranie: opis, wartość w polu (zapisana albo domyślna), czy zmienione, a dla zapisanego zdania,
 * które nie przechodzi reguł — `odrzucone` (powód), bo w mailu idzie wtedy tekst domyślny.
 */
export function zdaniaDoEkranu(zapisane, { wpisane = null, bledy = {} } = {}) {
  const { odrzucone } = zdaniaZReguly(zapisane);
  return ZDANIA.map((z) => ({
    ...z,
    wartosc: wpisane && Object.hasOwn(wpisane, z.klucz) ? String(wpisane[z.klucz] ?? '') : (zapisane[z.klucz] ?? z.domyslne),
    zmienione: Object.hasOwn(zapisane, z.klucz),
    maks: maksZdania(z),
    blad: bledy[z.klucz] ?? null,
    odrzucone: odrzucone[z.klucz] ?? null,
  }));
}
