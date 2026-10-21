// PRZ-105: domyślna stawka VAT firmy (Ustawienia → Firma), bez migracji i bez pamięci podręcznej — wzór
// ksef-konsumenckie.js. Bez zmiennej w pliku konfiguracji: żadna dotąd nie istniała, więc zasada PRZ-092
// „plik wygrywa” nie ma tu czego chronić. Bez wpisu (i przy wpisie spoza listy) — STAWKA_VAT, czyli 23:
// instalacja, która niczego nie kliknie, wystawia faktury dokładnie jak przed PRZ-105.
import { STAWKA_VAT, czyStawkaVat } from '../../../domena/vat.js';

const KLUCZ = 'vat.stawka_domyslna';

export function czytajStawkeDomyslna(db) {
  const w = db?.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ)?.wartosc;
  return czyStawkaVat(w) ? String(w).trim() : STAWKA_VAT;
}

export function zapiszStawkeDomyslna(db, stawka) {
  if (!czyStawkaVat(stawka)) throw new Error(`Stawka VAT spoza listy: „${stawka}”.`);
  db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, zmienione_at = excluded.zmienione_at`)
    .run(KLUCZ, String(stawka).trim(), new Date().toISOString());
}
