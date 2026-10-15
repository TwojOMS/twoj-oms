import { zdjecieLinii } from '../../domena/miniatury.js';
export function uzupelnijZdjeciaPozycji(db) {
  const braki = db.prepare(
    'SELECT DISTINCT z.id, z.surowe_json FROM zamowienia z JOIN pozycje p ON p.zamowienie_id = z.id'
    + " WHERE p.zdjecie_url IS NULL AND p.zrodlo = 'sklep' AND z.surowe_json IS NOT NULL",
  ).all();
  const wiersze = db.prepare("SELECT id FROM pozycje WHERE zamowienie_id = ? AND zrodlo = 'sklep' ORDER BY id");
  const zapisz = db.prepare('UPDATE pozycje SET zdjecie_url = ? WHERE id = ?');
  for (const w of braki) {
    let surowe = null;
    // Uszkodzony JSON pojedynczego zamowienia nie ma prawa zablokowac startu panelu.
    try { surowe = JSON.parse(w.surowe_json); } catch { continue; }
    const linie = surowe?.line_items;
    if (!Array.isArray(linie)) continue;
    const nasze = wiersze.all(w.id);
    if (nasze.length !== linie.length) continue;
    nasze.forEach((p, i) => zapisz.run(zdjecieLinii(linie[i]), p.id));
  }
}