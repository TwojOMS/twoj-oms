import { zbudujAplikacje, type Aplikacja } from './aplikacja.ts';
import { uruchomZegary } from './zegary.ts';

/** Właściciel app, bazy i zegarów od rozpoczęcia startu do zamknięcia. */
export async function uruchomAplikacje(
  o: Parameters<typeof zbudujAplikacje>[0] & { host: string; port: number },
): Promise<{ aplikacja: Aplikacja; zamknij: () => Promise<void> }> {
  let aplikacja: Aplikacja | undefined;
  let uchwyty: ReturnType<typeof setInterval>[] = [];
  const przebiegi = new Set<Promise<void>>();
  let zamykanie: Promise<void> | undefined;
  const zamknij = (): Promise<void> => {
    if (zamykanie) return zamykanie;
    for (const uchwyt of uchwyty) clearInterval(uchwyt);
    uchwyty = [];
    zamykanie = (async () => {
      try {
        try { await aplikacja?.app.close(); }
        finally { await Promise.allSettled(przebiegi); }
      } finally { o.db.close(); }
    })();
    return zamykanie;
  };
  try {
    aplikacja = await zbudujAplikacje(o);
    await aplikacja.app.listen({ host: o.host, port: o.port });
    uchwyty = uruchomZegary(aplikacja.zegary.map((z) => ({
      ...z,
      przebieg: () => {
        // Promise.then obejmuje także synchroniczny wyjątek modułu.
        const przebieg = Promise.resolve().then(() => z.przebieg());
        przebiegi.add(przebieg);
        const usun = () => { przebiegi.delete(przebieg); };
        void przebieg.then(usun, usun);
        return przebieg;
      },
    })), { log: o.log });
    return { aplikacja, zamknij };
  } catch (e) {
    await zamknij();
    throw e;
  }
}
