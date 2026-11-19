import { pasujeDoStanu } from '../../domena/niski-stan.js';
import { stanyKart } from './stany-magazynowe.js';

function wybierzKartyWgStanu(db, rodzaj) {
  const karty = db
    .prepare(
      `SELECT id, sku, nazwa, prog_niskiego_stanu AS prog FROM karty_produktow
       WHERE (? = 'minus' OR wycofana = 0)
         AND (? <> 'niski' OR prog_niskiego_stanu IS NOT NULL)`,
    )
    .all(rodzaj, rodzaj);
  if (karty.length === 0) return [];

  const { wlaczone, stany } = stanyKart(db);
  if (!wlaczone) return [];
  return karty
    .map((karta) => ({ ...karta, stan: stany.get(karta.id)?.stan ?? 0 }))
    .filter(({ stan, prog }) => pasujeDoStanu(rodzaj, stan, prog))
    .sort((a, b) => a.stan - b.stan || a.id - b.id);
}

export function kartyNiskiegoStanu(db) {
  return wybierzKartyWgStanu(db, 'niski');
}

export function kartyWgStanu(db, rodzaj) {
  return wybierzKartyWgStanu(db, rodzaj).map(({ id }) => id);
}
