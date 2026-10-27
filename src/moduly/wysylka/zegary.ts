import type { Zegar } from '../../core/kontrakty.ts';
import { odmianaNazwyProgramu } from '../../domena/nazwa-programu.js';

type Puls = { ok: (n: string) => void; blad: (n: string, e: unknown) => void };
// PRZ-118.09: `program` — usługa `infakt` modułu faktur (klient albo program); jego nazwa w logu rozliczania pobrań
// (bez programu albo bez opisu — inFakt, jak przed zmianą).
export function zegarPrzesylek(o: { czuwacz: { przebieg: () => Promise<any> }; odstepMs: number;
  puls: Puls; log: (...tekst: string[]) => void; program?: unknown }): Zegar {
  const nazwa = odmianaNazwyProgramu(o.program);
  return { nazwa: 'czuwaczPrzesylek', odstepMs: o.odstepMs, przebieg: async () => {
    try {
      const wynik = await o.czuwacz.przebieg();
      if (wynik?.pominiety) {
        o.log('czuwacz przesyłek: poprzedni przebieg JESZCZE TRWA — to tyknięcie przepada.');
        return;
      }
      o.puls.ok('czuwaczPrzesylek');
      if (wynik?.bledy) o.log(`czuwacz przesyłek: ${wynik.bledy} paczek z błędem statusu u kuriera `
        + '(szczegóły w logu zamówień i na kartach).');
      const pob = wynik?.pobrania;
      if (pob?.bledy || pob?.bezDaty) o.log(`czuwacz przesyłek, rozliczanie pobrań: ${pob.bledy ?? 0} nieudanych zleceń `
        + `do ${nazwa.dopelniacz}, ${pob.bezDaty ?? 0} bez znanej daty zapłaty — te faktury zostają `
        + 'NIEOPŁACONE i wymagają ręcznej zmiany statusu (szczegóły w logu zamówień).');
      if (pob?.ponadSufit) o.log(`czuwacz przesyłek, rozliczanie pobrań: ${pob.ponadSufit} dokument(ów) NIE ZMIEŚCIŁO `
        + 'się w sufit tego przebiegu — czekają na następne tyknięcie zegara. Nic nie '
        + 'przepadło, ale jeśli ta linia wraca co godzinę, zaległość rośnie szybciej, '
        + 'niż panel ją odrabia.');
      const not = wynik?.notatki;
      if (not?.wyslane || not?.bledy) o.log(`czuwacz przesyłek, notatki z numerem listu: ${not.wyslane ?? 0} ponowionych, `
        + `${not.bledy ?? 0} dalej nie doszło (spróbuje za godzinę, przez 48 h od nadania).`);
    } catch (e) {
      o.puls.blad('czuwaczPrzesylek', e);
      o.log('czuwacz przesyłek:', e instanceof Error ? e.message : String(e));
    }
  } };
}

export function zegarPodjazdow(o: { czuwacz: { przebieg: () => Promise<any> }; odstepMs: number;
  log: (...tekst: string[]) => void }): Zegar {
  return { nazwa: 'czuwaczPodjazdow', odstepMs: o.odstepMs, przebieg: async () => {
    try {
      const w = await o.czuwacz.przebieg();
      if (w?.bledy) o.log(`czuwacz podjazdów: ${w.bledy} błędów odczytu`);
    } catch (e) { o.log('czuwacz podjazdów:', e instanceof Error ? e.message : String(e)); }
  } };
}
