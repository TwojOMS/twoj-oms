// PRZ-102.12 — zapis automatu wysyłki do KSeF w tabeli `ustawienia` (klucz → wartość, bez migracji).
//
// Ustawienia człowieka: `ksef.automat.wlaczony` ('1'/'0'), `ksef.automat.godzina` ('HH:MM', Warszawa),
// `ksef.automat.zmienil` (login). Stan automatu: `ksef.automat.ostatni_przebieg` (dzień `RRRR-MM-DD`) i
// `ksef.automat.wynik` (JSON ostatniego przebiegu). Reguły (kiedy wysyłać) — domena/ksef-automat.js.
import { GODZINA_DOMYSLNA } from '../../../domena/ksef-automat.js';

export const KLUCZE_AUTOMATU_KSEF = Object.freeze({
  wlaczony: 'ksef.automat.wlaczony',
  godzina: 'ksef.automat.godzina',
  zmienil: 'ksef.automat.zmienil',
  ostatni: 'ksef.automat.ostatni_przebieg',
  wynik: 'ksef.automat.wynik',
  wstrzymane: 'ksef.automat.wstrzymane',
});
const K = KLUCZE_AUTOMATU_KSEF;
const WZOR_GODZINY = /^([01]\d|2[0-3]):[0-5]\d$/;
const terazIso = () => new Date().toISOString();

const UPSERT = `INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
  ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, zmienione_at = excluded.zmienione_at`;

function parsujWynik(tekst) {
  if (!tekst) return null;
  try {
    const w = JSON.parse(tekst);
    return w && typeof w === 'object' ? w : null;
  } catch { return null; }
}

/**
 * Stan automatu. Brak wierszy = wyłączony, 20:00, bez przebiegu. Uszkodzona godzina w bazie wraca do domyślnej,
 * ale przełącznik czyta wyłącznie '1' — na braku danych automat NIE wysyła.
 */
export function wczytajAutomatKsef(db) {
  const zapis = {};
  const zmienione = {};
  for (const w of db.prepare("SELECT klucz, wartosc, zmienione_at FROM ustawienia WHERE klucz LIKE 'ksef.automat.%'").all()) {
    zapis[w.klucz] = w.wartosc;
    zmienione[w.klucz] = w.zmienione_at;
  }
  const godzina = WZOR_GODZINY.test(String(zapis[K.godzina] ?? '')) ? zapis[K.godzina] : GODZINA_DOMYSLNA;
  return {
    wlaczony: zapis[K.wlaczony] === '1',
    godzina,
    ostatniPrzebieg: zapis[K.ostatni] || null,
    zmienil: zapis[K.zmienil] != null ? { login: zapis[K.zmienil] || null, at: zmienione[K.zmienil] ?? null } : null,
    wynik: parsujWynik(zapis[K.wynik]),
    wstrzymane: parsujWstrzymane(zapis[K.wstrzymane]),
  };
}

function parsujWstrzymane(tekst) {
  if (!tekst) return [];
  try {
    const lista = JSON.parse(tekst);
    return Array.isArray(lista) ? lista.filter((w) => w && typeof w.uuid === 'string') : [];
  } catch { return []; }
}

const zapiszWstrzymane = (db, lista, kiedy) => db.prepare(UPSERT).run(K.wstrzymane, JSON.stringify(lista), kiedy);

/**
 * Poprawka po recenzji PRZ-102.12 (WAŻNE 1): faktura, którą inFakt ODRZUCIŁ (4xx) przy wysyłce z automatu.
 * Usługa zdejmuje wtedy rezerwację (dokumentu u organu na pewno nie ma), więc bez tej listy faktura wracałaby jutro
 * pierwsza i blokowała cały automat stopem na błędzie — dzień po dniu, do 61 dni. Automat ją pomija, dopóki człowiek
 * nie wyśle jej ręcznie (numer KSeF albo rezerwacja zdejmują wpis przy następnym przebiegu) albo nie kliknie „Zwolnij”.
 */
export function wstrzymajFakture(db, { uuid, numer, dzien, powod }, kiedy = terazIso()) {
  const lista = wczytajAutomatKsef(db).wstrzymane.filter((w) => w.uuid !== uuid);
  lista.push({ uuid, numer: numer ?? null, dzien, powod: powod ?? null });
  zapiszWstrzymane(db, lista, kiedy);
}

/** Zdjęcie wstrzymania (przycisk „Zwolnij” albo dokument już w KSeF). Zwraca, czy coś zdjęto. */
export function zwolnijWstrzymane(db, uuidy, kiedy = terazIso()) {
  const zdejmij = new Set([].concat(uuidy ?? []));
  const przed = wczytajAutomatKsef(db).wstrzymane;
  const po = przed.filter((w) => !zdejmij.has(w.uuid));
  if (po.length === przed.length) return false;
  zapiszWstrzymane(db, po, kiedy);
  return true;
}

/** Zapis ustawień z ekranu — jedną transakcją (przełącznik, godzina, kto i dzień ostatniego przebiegu razem). */
export function zapiszUstawieniaAutomatu(db, { wlaczony, godzina, ostatniPrzebieg, login }, kiedy = terazIso()) {
  const wpis = db.prepare(UPSERT);
  db.exec('BEGIN IMMEDIATE');
  try {
    wpis.run(K.wlaczony, wlaczony ? '1' : '0', kiedy);
    wpis.run(K.godzina, String(godzina), kiedy);
    wpis.run(K.zmienil, String(login ?? ''), kiedy);
    if (ostatniPrzebieg) wpis.run(K.ostatni, String(ostatniPrzebieg), kiedy);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * ⚠️⚠️ ZAJĘCIE DZISIEJSZEGO PRZEBIEGU — PRZED PIERWSZĄ WYSYŁKĄ. Sprawdź-i-zapisz w jednej transakcji
 * (`BEGIN IMMEDIATE`): gdy dzień jest już zajęty, oddaje `false` i niczego nie rusza. Restart panelu w trakcie
 * przebiegu nie wyśle więc drugi raz tego samego dnia, a dokumenty wystawione po przebiegu czekają do jutra.
 * Dokumenty w locie chroni dodatkowo rezerwacja `wysylki_ksef` (services/wysylka-ksef.js).
 */
export function zajmijPrzebieg(db, dzien, wynik, kiedy = terazIso()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const ostatni = db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(K.ostatni)?.wartosc ?? null;
    if (ostatni === dzien) {
      db.exec('ROLLBACK');
      return false;
    }
    const wpis = db.prepare(UPSERT);
    wpis.run(K.ostatni, dzien, kiedy);
    wpis.run(K.wynik, JSON.stringify(wynik), kiedy);
    db.exec('COMMIT');
    return true;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* transakcja już zamknięta */ }
    throw e;
  }
}

/** Wynik przebiegu (także częściowy — po każdym dokumencie, żeby restart nie zgubił tego, co już poszło). */
export function zapiszWynikAutomatu(db, wynik, kiedy = terazIso()) {
  db.prepare(UPSERT).run(K.wynik, JSON.stringify(wynik), kiedy);
}

/** Przy starcie: wynik „trwa” znaczy, że proces padł w trakcie — oznaczamy go jako przerwany. */
export function oznaczPrzerwanyPrzebieg(db, kiedy = terazIso()) {
  const { wynik } = wczytajAutomatKsef(db);
  if (wynik?.stan !== 'trwa') return false;
  zapiszWynikAutomatu(db, { ...wynik, stan: 'przerwany', koniecAt: wynik.koniecAt ?? null }, kiedy);
  return true;
}
