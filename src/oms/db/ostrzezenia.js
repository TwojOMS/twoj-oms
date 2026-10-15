// src/oms/db/ostrzezenia.js
//
// Jedyna warstwa zapytań dwóch tabel ostrzeżeń strony głównej (schema.sql, 2026-08-29):
// `ostrzezenia_odrzucone` (kliknięcia „Ignoruj"/„Wycisz") i `ksef_luki` (lustro
// dokumentów do wysłania do KSeF, pisane przez czuwacza). Reguły — co alarmuje, co
// wygasa, jakie są klucze — mieszkają w domain/ostrzezenia.js, nie tutaj.

import { OSTATNIA_ZYWA_PACZKA } from '../../moduly/wysylka/db/ostatnia-paczka.js';

const teraz = () => new Date().toISOString();

/**
 * Zapis odrzucenia. `INSERT OR REPLACE`, bo powtórne „Wycisz" tego samego klucza ma
 * ODŚWIEŻYĆ datę — dla typu `integracja` odrzucenie wygasa po dobie, więc drugie
 * kliknięcie liczy się od nowa.
 */
export function odrzuc(db, klucz, { kto = null, kiedy = teraz() } = {}) {
  db.prepare(`
    INSERT INTO ostrzezenia_odrzucone (klucz, odrzucone_at, odrzucone_przez)
    VALUES (?, ?, ?)
    ON CONFLICT (klucz) DO UPDATE SET odrzucone_at = excluded.odrzucone_at,
      odrzucone_przez = excluded.odrzucone_przez
  `).run(klucz, kiedy, kto);
}

/** Mapa klucz → odrzucone_at. Mapa, bo domena pyta o pojedyncze klucze przy filtrze. */
export function odrzucenia(db) {
  const mapa = new Map();
  for (const w of db.prepare('SELECT klucz, odrzucone_at FROM ostrzezenia_odrzucone').all()) {
    mapa.set(w.klucz, w.odrzucone_at);
  }
  return mapa;
}

// Wspólny kształt podmiany lustra: DELETE + INSERT partii w JEDNEJ transakcji.
// Błędna partia (np. duplikat uuid) ma się odbić W CAŁOŚCI i zostawić poprzedni
// odczyt nietknięty — połowiczny zapis wyglądałby jak „mniej zaległości".
function podmienLustro(db, tabela, wstawKazdy) {
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM ${tabela}`).run();
    wstawKazdy();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Pełna podmiana lustra luk KSeF (dokumenty do wysłania, których nikt nie wysłał). */
export function podmienLukiKsef(db, luki, { sprawdzonaAt = teraz() } = {}) {
  const wstaw = db.prepare('INSERT INTO ksef_luki (uuid, numer, invoice_date, sprawdzona_at) VALUES (?, ?, ?, ?)');
  podmienLustro(db, 'ksef_luki', () => {
    for (const l of luki ?? []) wstaw.run(l.uuid, l.numer ?? null, l.invoiceDate ?? null, sprawdzonaAt);
  });
}

/** Bieżące luki — kolejność stabilna po dacie wystawienia (najstarsza pierwsza). */
export function lukiKsef(db) {
  return db.prepare('SELECT uuid, numer, invoice_date, sprawdzona_at FROM ksef_luki ORDER BY invoice_date, uuid').all();
}

/**
 * Pełna podmiana lustra faktur po terminie płatności (typ `faktura-termin`).
 * `pozostaloGr` to `left_to_pay` inFaktu — liczba całkowita w groszach.
 */
export function podmienPoTerminie(db, faktury, { sprawdzonaAt = teraz() } = {}) {
  const wstaw = db.prepare(
    'INSERT INTO faktury_po_terminie (uuid, numer, payment_date, pozostalo_gr, sprawdzona_at) VALUES (?, ?, ?, ?, ?)',
  );
  podmienLustro(db, 'faktury_po_terminie', () => {
    for (const f of faktury ?? []) {
      wstaw.run(f.uuid, f.numer ?? null, f.paymentDate ?? null, f.pozostaloGr ?? null, sprawdzonaAt);
    }
  });
}

/** Bieżące przeterminowane — najstarszy termin pierwszy (on jest treścią zdania). */
export function poTerminie(db) {
  return db.prepare(
    'SELECT uuid, numer, payment_date, pozostalo_gr, sprawdzona_at FROM faktury_po_terminie ORDER BY payment_date, uuid',
  ).all();
}

/**
 * Zwroty czekające na korektę w inFakcie (typ `zwrot-korekta`): zwrot przy zamówieniu,
 * które MA wiersz faktury, bez numeru korekty.
 *
 * ⚠️ TA SAMA granica, co `zwrotRozliczony` (domain/zwrot.js): o obowiązku korekty
 * rozstrzyga OBECNOŚĆ faktury (`z?.faktura` = wiersz istnieje), a o wystawieniu —
 * WYŁĄCZNIE `korekta_numer` (samo `korekta_zlecona_at` to rezerwacja, nie dokument;
 * zlecenie potrafi przepaść — patrz `korektaPrzepadla`).
 */
export function zwrotyBezKorekty(db) {
  return db.prepare(`
    SELECT w.id, w.zamowienie_id, w.data, w.utworzony_at, z.numer AS zamowienie_numer
    FROM zwroty w
    JOIN zamowienia z ON z.id = w.zamowienie_id
    WHERE w.korekta_numer IS NULL
      AND EXISTS (SELECT 1 FROM faktury f WHERE f.zamowienie_id = w.zamowienie_id)
    ORDER BY w.utworzony_at, w.id
  `).all();
}

/**
 * Kandydaci do ostrzeżenia „paczka za pobraniem wróciła, faktura czeka na korektę"
 * (typ `pobranie-korekta`): zamówienie z pobraniem, które MA wiersz faktury i NIE MA
 * jeszcze zarejestrowanego zwrotu, wraz z jego ostatnią żywą paczką.
 *
 * ⚠️ ZBIERA, NIE ROZSTRZYGA. Czy paczka jest bez gotówki, mówi `czyPaczkaBezGotowki`
 * przez `ostrzezeniaPobran` (domain/ostrzezenia.js) — ta sama zasada, co w czuwaczu
 * pobrań: etapu przesyłki NIE filtrujemy w SQL. Wierszy są tu dziesiątki, więc odsianie
 * u siebie nic nie kosztuje, a reguła pieniędzy zostaje JEDNA i widoczna.
 *
 * ⚠️ PREFILTR CZYTA OBIE KOLUMNY (`pobranie` ze sklepu ORAZ `wysylka_reczna_json`) —
 * dokładnie jak `KANDYDACI` w services/oznaczanie-pobran.js. Zamówienie przełączone
 * ręcznie na pobranie ma `pobranie = 0` i przy węższym warunku nigdy by tu nie trafiło.
 *
 * ⚠️ ZAREJESTROWANY ZWROT WYKLUCZA. Od chwili rejestracji o korektę upomina się typ
 * `zwrot-korekta` (`zwrotyBezKorekty` wyżej) — dwa wiersze o tej samej fakturze byłyby
 * szumem, a nie dwiema sprawami.
 *
 * `OSTATNIA_ZYWA_PACZKA` jest importowana, a nie przepisana: to ta sama klauzula, którą
 * czyta czuwacz pobrań i pas długów, i ma taka zostać (patrz jej docblock).
 */
export function pobraniaBezGotowki(db) {
  return db.prepare(`
    SELECT
      z.id AS zamowienie_id, z.numer AS zamowienie_numer, z.pobranie, z.wysylka_reczna_json,
      f.numer AS faktura_numer, f.infakt_uuid,
      p.status_kuriera, p.status_kuriera_kod, p.status_kuriera_at
    FROM faktury f
    JOIN zamowienia z ON z.id = f.zamowienie_id
    ${OSTATNIA_ZYWA_PACZKA}
    WHERE (z.pobranie = 1 OR z.wysylka_reczna_json IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM zwroty w WHERE w.zamowienie_id = z.id)
    ORDER BY z.id
  `).all();
}
