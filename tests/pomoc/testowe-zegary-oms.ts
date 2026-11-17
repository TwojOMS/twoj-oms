import { uruchomZegary as uruchomZegaryRdzenia } from '../../src/core/zegary.ts';
import type { Zegar } from '../../src/core/kontrakty.ts';
import { zegarPrzesylek, zegarPodjazdow } from '../../src/moduly/wysylka/zegary.ts';
import { zegarPolleraWiadomosci, zegarCzuwaczaFormulki } from '../../src/moduly/wiadomosci/zegary.ts';
import { zegarKsef, zegarArchiwumSprzedazy } from '../../src/moduly/faktury/zegary.ts';
import { zegarKosztow } from '../../src/moduly/koszty/zegary.ts';
import {zegarKampanii,zegarReklam} from '../../src/moduly/marketing/zegary.ts';
import { zegarOstrzezen } from '../../src/moduly/zdrowie/zegary.ts';

// Adapter dawnych argumentów testów. Wysylka korzysta z produkcyjnych otoczek
// manifestu, uruchomienie interwałów z tego samego rdzenia co pełna aplikacja.
export function uruchomZegary(o: any) {
  const zegary: Zegar[] = [];
  const log = o.log ?? console.error;
  for (const [nazwa, odstepMs] of [['poller', 120000]] as const) {
    if (o[nazwa]) zegary.push({ nazwa, odstepMs, przebieg: async () => { await o[nazwa].przebieg(); } });
  }
  const puls=o.puls??{ok:()=>{},blad:()=>{}};
  if(o.czuwaczKsef)zegary.push(zegarKsef({czuwacz:o.czuwaczKsef,puls,odstepMs:3600000,log}));
  if(o.czuwaczOstrzezen)zegary.push(zegarOstrzezen({czuwacz:o.czuwaczOstrzezen,puls,odstepMs:3600000,log}));
  if(o.czuwaczKosztow)zegary.push(zegarKosztow({czuwacz:o.czuwaczKosztow,odstepMs:3600000,log}));
  if(o.czuwaczArchiwumSprzedazy)zegary.push(zegarArchiwumSprzedazy({czuwacz:o.czuwaczArchiwumSprzedazy,odstepMs:3600000,log}));
  if (o.czuwaczPrzesylek) zegary.push(zegarPrzesylek({ czuwacz: o.czuwaczPrzesylek,
    odstepMs: 3600000, log, puls: o.puls ?? { ok: () => {}, blad: () => {} } }));
  if (o.czuwaczPodjazdow) zegary.push(zegarPodjazdow({ czuwacz: o.czuwaczPodjazdow, odstepMs: 600000, log }));
  if (o.pollerWiadomosci) zegary.push(zegarPolleraWiadomosci({ pollerWiadomosci:o.pollerWiadomosci,log }));
  if (o.czuwaczFormulki) zegary.push(zegarCzuwaczaFormulki({ czuwaczFormulki:o.czuwaczFormulki,log }));
  if(o.czuwaczKampanii)zegary.push(zegarKampanii({czuwaczKampanii:o.czuwaczKampanii,log}));
  if(o.czuwaczReklam)zegary.push(zegarReklam({czuwaczReklam:o.czuwaczReklam,log}));
  return uruchomZegaryRdzenia(zegary, { ustawInterwal: o.ustawInterwal, log });
}
