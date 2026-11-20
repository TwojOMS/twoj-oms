import type { Zegar } from './kontrakty.ts';

export function uruchomZegary(
  zegary: readonly Zegar[],
  {
    ustawInterwal = setInterval,
    ustawTimeout = setTimeout,
    log = (t: string) => console.error(t),
  }: { ustawInterwal?: typeof setInterval; ustawTimeout?: typeof setTimeout; log?: (t: string) => void } = {},
): ReturnType<typeof setInterval>[] {
  return zegary.flatMap((z) => {
    let trwa = false;
    const tik = async () => {
      if (trwa) {
        log(`zegar ${z.nazwa}: poprzedni przebieg jeszcze trwa — pomijam`);
        return;
      }
      trwa = true;
      try {
        await z.przebieg();
      } catch (e) {
        log(`zegar ${z.nazwa}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        trwa = false;
      }
    };
    const uchwyty = [ustawInterwal(tik, z.odstepMs)];
    if (z.naStarcie) {
      // Ta sama flaga co interwał, więc start i pierwszy odstęp się nie nałożą. `unref` — sam przebieg startowy
      // nie trzyma procesu przy życiu; uchwyt wraca z resztą, więc zamknięcie przed startem go odwoła.
      const start = ustawTimeout(tik, 0);
      start.unref?.();
      uchwyty.push(start);
    }
    return uchwyty;
  });
}
