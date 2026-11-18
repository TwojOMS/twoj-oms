// Domyślna stawka VAT firmy (Ustawienia → Firma), bez migracji i bez pamięci podręcznej — wzór
// ksef-konsumenckie.js. Bez zmiennej w pliku konfiguracji, więc zasada „plik wygrywa”
// nie ma tu czego chronić. Bez wpisu (i przy wpisie spoza listy) — STAWKA_VAT, czyli 23:
// instalacja, która niczego nie kliknie, wystawia faktury ze stawką 23%.
import { STAWKA_VAT, czyStawkaVat } from '../../../domena/vat.js';

const KLUCZ = 'vat.stawka_domyslna';

// „zw” jako domyślna wyłącznie z flagą `{ zw: true }` (program wbudowany). Bez flagi zapisane „zw”
// czyta się jak każdy wpis spoza listy — STAWKA_VAT — więc przy inFakcie nie dojdzie do faktury.
export function czytajStawkeDomyslna(db, opcje) {
  const w = db?.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ)?.wartosc;
  return czyStawkaVat(w, opcje) ? String(w).trim() : STAWKA_VAT;
}

export function zapiszStawkeDomyslna(db, stawka, opcje) {
  if (!czyStawkaVat(stawka, opcje)) throw new Error(`Stawka VAT spoza listy: „${stawka}”.`);
  db.prepare(
    `INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, zmienione_at = excluded.zmienione_at`,
  ).run(KLUCZ, String(stawka).trim(), new Date().toISOString());
}
