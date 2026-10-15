import type { Zegar } from './kontrakty.ts';

export function uruchomZegary(
  zegary: readonly Zegar[],
  { ustawInterwal = setInterval, log = (t: string) => console.error(t) }: { ustawInterwal?: typeof setInterval; log?: (t: string) => void } = {},
): ReturnType<typeof setInterval>[] {
  return zegary.map((z) => {
    let trwa = false;
    return ustawInterwal(async () => {
      if (trwa) { log(`zegar ${z.nazwa}: poprzedni przebieg jeszcze trwa — pomijam`); return; }
      trwa = true;
      try { await z.przebieg(); }
      catch (e) { log(`zegar ${z.nazwa}: ${e instanceof Error ? e.message : String(e)}`); }
      finally { trwa = false; }
    }, z.odstepMs);
  });
}
