import type { ModulOms, Srodowisko } from '../core/kontrakty.ts';
import type { DatabaseSync } from 'node:sqlite';
import { zbudujAplikacje, sprawdzKonfiguracjeModulow } from '../core/aplikacja.ts';
import { openOmsDb } from './db/db.ts';
import { modulyDla } from '../moduly/lista.ts';
export { uruchomZegary } from '../core/zegary.ts';
export const ODSTEP_CZUWACZA_MS=3600000;
/** Ta sama kompozycja produktu, której używa główne uruchomienie. */
export async function zbudujOms(o: {env:Srodowisko;moduly?:readonly ModulOms[];db?:DatabaseSync;
  teraz?:()=>Date;log?:(...tekst:string[])=>void;nadpisania?:Readonly<Record<string,unknown>>}) {
  const moduly=o.moduly??modulyDla(o.env);
  sprawdzKonfiguracjeModulow(moduly,o.env);
  const db=o.db??openOmsDb(o.env.OMS_DB_PATH??':memory:',{moduly,teraz:o.teraz});
  try{return {...await zbudujAplikacje({...o,moduly,db}),db};}
  catch(e){if(!o.db)db.close();throw e;}
}
