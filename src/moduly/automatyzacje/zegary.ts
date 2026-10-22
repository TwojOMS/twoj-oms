import type { Zegar } from '../../core/kontrakty.ts';

/** PRZ-108.07: silnik reguł tyka co minutę (plan, sekcja 5). Przy zerze włączonych reguł — jedno SELECT, zero zapisów. */
export const ODSTEP_AUTOMATYZACJI_MS = 60_000;

type Silnik = { przebieg: () => Promise<{ wlaczonych?: number; zapisow?: number; pominiety?: boolean } | undefined> };

/**
 * Wyjątek przebiegu ląduje w logu i nie wywraca procesu. Normalnego przebiegu nie logujemy (1440 linii na dobę),
 * z wyjątkiem PIERWSZEGO po starcie — jedna linia jest dowodem w logu serwera, że zegar ruszył i ile zapisał.
 */
export function zegarAutomatyzacji({ silnik, log }: { silnik: Silnik; log: (...tekst: string[]) => void }): Zegar {
  let pierwszy = true;
  return { nazwa: 'automatyzacje', odstepMs: ODSTEP_AUTOMATYZACJI_MS, przebieg: async () => {
    try {
      const wynik = await silnik.przebieg();
      if (pierwszy && wynik && !wynik.pominiety) {
        pierwszy = false;
        log(`automatyzacje: zegar ruszył — włączonych reguł: ${wynik.wlaczonych ?? 0}`
          + (wynik.zapisow === undefined ? '' : `, zapisów: ${wynik.zapisow}`));
      }
    } catch (e) { log(`automatyzacje: ${e instanceof Error ? e.message : String(e)}`); }
  } };
}
