import type { Zegar } from '../../core/kontrakty.ts';
import { ODSTEP_PONAWIANIA_STATUSU_MS } from './services/sync-sklep.js';

type Wynik = { kandydatow: number; wyslane: number; bledy: number };

/**
 * PRZ-117: ponawianie statusu, który nie dojechał do Allegro albo sklepu przez chwilową awarię (1496, 26.10.2026).
 * Cichy, gdy nie ma kandydatów; awaria przebiegu idzie do logu kontenera i nie zatrzymuje zegara.
 */
export function zegarPonawianiaStatusow(o: { sync: { ponowPrzejsciowe: (a: { teraz: Date }) => Promise<Wynik> };
  teraz: () => Date; log: (...tekst: string[]) => void }): Zegar {
  return { nazwa: 'ponawianieStatusow', odstepMs: ODSTEP_PONAWIANIA_STATUSU_MS, przebieg: async () => {
    try {
      const w = await o.sync.ponowPrzejsciowe({ teraz: o.teraz() });
      if (w.kandydatow) o.log(`ponawianie statusów: ${w.wyslane} dojechało, ${w.bledy} dalej nie (następna próba za 15 min).`);
    } catch (e) {
      o.log('ponawianie statusów:', e instanceof Error ? e.message : String(e));
    }
  } };
}
