import type { Zegar } from '../../core/kontrakty.ts';
import { POWOD_TRWA } from './services/czuwacz-kosztow.js';

export function zegarKosztow(o: { czuwacz: { przebieg: () => Promise<any> }; odstepMs: number; log: (...args: any[]) => void }): Zegar {
  return { nazwa: 'czuwaczKosztow', odstepMs: o.odstepMs, przebieg: async () => {
    try {
      const wynik = await o.czuwacz.przebieg();
      if (wynik?.pominiety) {
        if (wynik.powod === POWOD_TRWA) o.log('czuwacz kosztów: poprzedni przebieg JESZCZE TRWA — to tyknięcie przepada, a okno pobrania kosztów jest raz na dobę.');
        return;
      }
      if (wynik?.odrzuconych) o.log(`czuwacz kosztów: ${wynik.odrzuconych} dokument(y) odrzucone — NIE weszły do sumy miesiąca. Leżą w tabeli koszty_odrzucone razem z surowymi metadanymi z KSeF.`);
      if (wynik?.niedokonczone) o.log(`czuwacz kosztów: pobranie NIEDOKOŃCZONE — przeczytane okna: ${wynik.okien} z ${wynik.okienZaplanowanych}, reszta pojedzie następnym przebiegiem. Powód stoi w stanie kosztów (zakładka KOSZTY).`);
    } catch (e) { o.log('czuwacz kosztów:', e instanceof Error ? e.message : String(e)); }
  } };
}
