/**
 * Powiazanie dosylki z zamowieniem pierwotnym — widoczne z OBU stron.
 *
 * Widocznosc obustronna nie jest kosmetyka: bez niej nikt patrzacy na zamowienie pierwotne
 * nie dowie sie, ze cos do niego dojechalo, a reklamacja policzy sie drugi raz jako sprzedaz.
 */
export function powiazaniaDosylki(db, id) {
  const wiersz = db.prepare('SELECT zamowienie_zrodlowe_id FROM zamowienia WHERE id = ?').get(id);
  const pierwotne = wiersz?.zamowienie_zrodlowe_id
    ? db.prepare('SELECT id, numer FROM zamowienia WHERE id = ?').get(wiersz.zamowienie_zrodlowe_id) ?? null
    : null;
  const dosylki = db.prepare('SELECT id, numer FROM zamowienia WHERE zamowienie_zrodlowe_id = ? ORDER BY id').all(id);
  return { pierwotne, dosylki };
}
