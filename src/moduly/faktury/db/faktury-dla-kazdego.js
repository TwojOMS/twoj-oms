// Wybór firmy, bez migracji i bez pamięci podręcznej. Brak wpisu zachowuje dotychczasowe działanie.
const KLUCZ = 'faktury.dla_kazdego';

export function czyFakturaDlaKazdego(db) {
  return db?.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ)?.wartosc === 'tak';
}

export function zapiszFakturaDlaKazdego(db, wlaczone) {
  db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, zmienione_at = excluded.zmienione_at`)
    .run(KLUCZ, wlaczone ? 'tak' : 'nie', new Date().toISOString());
}

export const ZDANIE_KASA = 'Faktura nie zastępuje paragonu: jeśli Twoja firma ma obowiązek kasy fiskalnej, sprzedaż osobom prywatnym nadal ewidencjonujesz na kasie. Zapytaj biuro, zanim włączysz.';
