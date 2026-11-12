import {afterEach,expect,it,vi} from 'vitest';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {zbudujAplikacje} from '../../../src/core/aplikacja.ts';
import {modulRdzen} from '../../../src/moduly/rdzen/modul.ts';
import type {ModulOms} from '../../../src/core/kontrakty.ts';
import {ustawRejestrKanalow} from '../../../src/domena/moduly-kanalow.ts';

afterEach(()=>{vi.restoreAllMocks();ustawRejestrKanalow(null);});

it.each([
 {stan:{sklep:'erli_polcien',tor_importu:'inbox'},uwagi:['ERLI: kanał erli_polcien pobiera zamówienia zapasowym torem /inbox (API odpowiedziało 404 na /orders/changes).']},
 {stan:{sklep:'erli_polcien',tor_importu:'changes',uzgodnienie_blad:'2026-11-11T10:00:00.000Z odpowiedź API: WABIK_KLUCZA'},uwagi:['ERLI erli_polcien: uzgodnienie przerwane — 2026-11-11T10:00:00.000Z']},
 {stan:{sklep:'erli_polcien',uzgodnienie_blad:'odpowiedź API: WABIK_KLUCZA'},uwagi:['ERLI erli_polcien: uzgodnienie przerwane — chwila nieznana']},
 {stan:{sklep:'allegro_polcien'},uwagi:[]},
 {stan:{sklep:'woo_polcien'},uwagi:[]},
])('zdrowie kanałów pokazuje bezpieczną diagnostykę pollera: $stan',async({stan,uwagi})=>{
 const db=openOmsDb();let a:Awaited<ReturnType<typeof zbudujAplikacje>>|undefined;
 try{
  a=await zbudujAplikacje({db,moduly:[modulRdzen,createModulKanaly([])] as ModulOms[],env:{}});
  const poller=a.usluga<{stany:()=>any[]}>('kanaly','poller');
  vi.spyOn(poller,'stany').mockReturnValue([stan]);
  expect(a.zdrowie().uwagi).toEqual(uwagi);
  expect(a.zdrowie().uwagi.join(' ')).not.toContain('WABIK_KLUCZA');
 }finally{await a?.app.close();db.close();}
});
