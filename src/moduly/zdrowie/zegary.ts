import type { Zegar } from '../../core/kontrakty.ts';

export function zegarOstrzezen(o: { czuwacz: { przebieg: () => Promise<any> }; puls: any;
  odstepMs: number; log: (...args: any[]) => void }): Zegar {
  return { nazwa: 'czuwaczOstrzezen', odstepMs: o.odstepMs, przebieg: async () => {
    try {
      const wynik = await o.czuwacz.przebieg();
      if (wynik?.pominiety) {
        o.log('czuwacz ostrzeżeń: poprzedni przebieg JESZCZE TRWA — to tyknięcie przepada.');
        return;
      }
      o.puls?.ok('czuwaczOstrzezen');
    } catch (e) {
      o.puls?.blad('czuwaczOstrzezen', e);
      o.log('czuwacz ostrzeżeń:', e instanceof Error ? e.message : String(e));
    }
  } };
}
