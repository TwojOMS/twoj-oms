import type { Zegar } from '../../core/kontrakty.ts';
import { POWOD_TRWA } from './services/czuwacz-archiwum-sprzedazy.js';

type Puls = { ok: (n: string) => void; blad: (n: string, e: unknown) => void };
export function zegarKsef(o: { czuwacz: { przebieg: () => Promise<any> }; puls: Puls;
  odstepMs: number; log: (...args: any[]) => void }): Zegar {
  return { nazwa: 'czuwaczKsef', odstepMs: o.odstepMs, przebieg: async () => {
    try {
      const wynik = await o.czuwacz.przebieg();
      if (wynik?.pominiety) {
        o.log('czuwacz KSeF: poprzedni przebieg JESZCZE TRWA — to tyknięcie przepada, '
          + 'czuwacz chodzi rzadziej niż co godzinę.');
        return;
      }
      o.puls.ok('czuwaczKsef');
    } catch (e) {
      o.puls.blad('czuwaczKsef', e);
      o.log('czuwacz KSeF:', e instanceof Error ? e.message : String(e));
    }
  } };
}

export function zegarArchiwumSprzedazy(o: { czuwacz: { przebieg: () => Promise<any> };
  odstepMs: number; log: (...args: any[]) => void }): Zegar {
  return { nazwa: 'czuwaczArchiwumSprzedazy', odstepMs: o.odstepMs, przebieg: async () => {
    try {
      const w = await o.czuwacz.przebieg();
      if (w?.pominiety && w.powod === POWOD_TRWA) o.log('archiwum sprzedaży: pominięty —', w.powod);
    } catch (e) { o.log('archiwum sprzedaży:', e instanceof Error ? e.message : String(e)); }
  } };
}

// Re-eksport dla modul.ts: jeden wiersz importu zamiast dwóch — dodatkowy wiersz przesunąłby linie odczytów env
// w modul.ts, które docs/konfiguracja.json trzyma z numerem linii (strażnik konfiguracji).
export { createAutomatKsef, ODSTEP_AUTOMATU_KSEF_MS } from './services/ksef-automat.js';

// PRZ-102.12: automat wysyłki do KSeF — tyka co minutę, sam rozstrzyga porę (domena/ksef-automat.js). Wyjątek nie
// ma prawa położyć zegara: usługa łapie awarie przebiegu sama, a tu zostaje siatka na awarię odczytu bazy.
export function zegarAutomatuKsef(o: { automat: { przebieg: () => Promise<any> }; odstepMs: number;
  log: (...args: any[]) => void }): Zegar {
  return { nazwa: 'automatKsef', odstepMs: o.odstepMs, przebieg: async () => {
    try { await o.automat.przebieg(); }
    catch (e) { o.log('automat KSeF:', e instanceof Error ? e.message : String(e)); }
  } };
}
