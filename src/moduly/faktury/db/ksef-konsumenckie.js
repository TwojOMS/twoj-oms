// PRZ-102.26: wybór właściciela dla całej firmy, bez migracji i bez pamięci podręcznej.
const KLUCZ = 'ksef.konsumenckie';

export function czyWysylacKonsumenckie(db) {
  return db?.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ)?.wartosc === '1';
}

export function zapiszKonsumenckie(db, wlaczone) {
  db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, zmienione_at = excluded.zmienione_at`)
    .run(KLUCZ, wlaczone ? '1' : '0', new Date().toISOString());
}
