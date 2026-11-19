import { czyPonizejProgu } from '../../domena/niski-stan.js';
import { stanyKart } from './stany-magazynowe.js';

export function kartyNiskiegoStanu(db) {
  const karty = db
    .prepare(
      'SELECT id, sku, nazwa, prog_niskiego_stanu AS prog FROM karty_produktow WHERE wycofana = 0 AND prog_niskiego_stanu IS NOT NULL',
    )
    .all();
  if (karty.length === 0) return [];

  const { wlaczone, stany } = stanyKart(db);
  if (!wlaczone) return [];
  return karty
    .map((karta) => ({ ...karta, stan: stany.get(karta.id)?.stan ?? 0 }))
    .filter(({ stan, prog }) => czyPonizejProgu(stan, prog))
    .sort((a, b) => a.stan - b.stan || a.id - b.id);
}
