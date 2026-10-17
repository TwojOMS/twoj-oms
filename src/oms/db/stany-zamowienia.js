// PRZ-091: „brak na stanie” na karcie zamówienia — odczyt, bez żadnego zapisu.
//
// Pozycja → karta rozstrzyga TA SAMA reguła co stan magazynu (`zuzycieZZamowien` → `kartaPozycji` z domeny),
// na tych samych pozycjach efektywnych (po ręcznych poprawkach) i z tym samym warunkiem granicy włączenia.
// Dzięki temu karta zamówienia nie może pokazać braku na karcie produktu, której to zamówienie wcale nie zdjęło.
import { stanyKart, kartyLustraZ } from './stany-magazynowe.js';
import { zuzycieZZamowien } from '../../domena/stany-magazynowe.js';
import { nalozNadpisaniaPozycji } from '../../domena/pozycje-reczne.js';

/**
 * Karty produktów na minusie, które zdejmuje TO zamówienie: `[{ karta_id, nazwa, stan, ilosc }]`.
 * Pusta lista, gdy stany są wyłączone, zamówienie anulowane, złożone przed włączeniem albo nic nie jest na minusie.
 */
export function brakiNaStanieZamowienia(db, zamowienieId) {
  const stany = stanyKart(db);
  if (!stany.wlaczone) return [];
  const z = db.prepare(`SELECT id, numer, sklep, anulowane, anulowane_recznie, status_woo, utworzone_at, pozycje_reczne_json
    FROM zamowienia WHERE id = ? AND julianday(utworzone_at) >= julianday(?)`).get(Number(zamowienieId), stany.granica);
  if (!z) return [];
  const pozycje = nalozNadpisaniaPozycji(
    db.prepare('SELECT * FROM pozycje WHERE zamowienie_id = ? ORDER BY id').all(z.id), z.pozycje_reczne_json);
  const { zuzycie } = zuzycieZZamowien([{ zamowienie: z, pozycje }], kartyLustraZ(db));
  const nazwa = db.prepare('SELECT nazwa FROM karty_produktow WHERE id = ?');
  const braki = [];
  for (const [kartaId, ilosc] of zuzycie) {
    const stan = stany.stany.get(kartaId)?.stan ?? 0;
    if (stan < 0) braki.push({ karta_id: kartaId, nazwa: nazwa.get(kartaId)?.nazwa ?? `karta ${kartaId}`, stan, ilosc });
  }
  return braki.sort((a, b) => a.stan - b.stan || a.karta_id - b.karta_id);
}
