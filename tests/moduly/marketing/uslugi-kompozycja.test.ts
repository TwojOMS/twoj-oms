import {it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename,dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {utworzUslugiMarketingu} from '../../../src/moduly/marketing/uslugi.ts';
import {konfiguracjaMarketingu} from '../../../src/moduly/marketing/konfiguracja.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {zapiszPolaczenie,dni,stanPolaczenia} from '../../../src/oms/db/reklamy.js';
import {createMagazynSekretow} from '../../../src/moduly/marketing/uslugi/reklamy-sekrety.js';
it('nowa referencja GA4 dochodzi do klienta jako ścieżka pliku i rzeczywiście zapisuje lustro',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'prz028k-ga4-')),db=openOmsDb();
 try{
 const magazyn=createMagazynSekretow({katalog:dir});const ref=await magazyn.zapisz({typ:'ga4',polaczenieId:randomUUID(),tresc:'syntetyczny-klucz'});
 const p=zapiszPolaczenie(db,{typ:'ga4',kontoId:'123456789',kanal:'sklep-test',sekretRef:ref,waluta:'PLN',strefa:'Europe/Warsaw'} as any);
 const createGa4=vi.fn(({sciezkaKlucza})=>{
  expect(sciezkaKlucza).toBe(magazyn.sciezka(ref));expect(readFileSync(sciezkaKlucza,'utf8')).toBe('syntetyczny-klucz');
  return {raportReklam:async()=>({waluta:'PLN',dni:[{dzien:'2030-06-02',kampaniaId:'1',koszt:'10.00',klikniecia:2,wyswietlenia:10}],transakcje:[]})};
 });
 const u=utworzUslugiMarketingu({db,config:konfiguracjaMarketingu({OMS_REKLAMY_SEKRETY_DIR:dir}),fabryki:{createGa4},teraz:()=>new Date('2030-06-03T12:00:00Z')});
 expect(await u.czuwaczReklam.przebieg()).toEqual({sukcesy:1,bledy:0});expect(createGa4).toHaveBeenCalledOnce();
 expect(dni(db,{typ:'ga4',polaczenieId:p.id} as any)).toMatchObject([{dzien:'2030-06-02',koszt:'10.00'}]);
 expect(stanPolaczenia(db,p.id)?.kodBledu).toBeNull();
 }finally{db.close();if(dirname(resolve(dir))!==resolve(tmpdir())||!basename(dir).startsWith('prz028k-ga4-'))throw Error('Niewłaściwy tmp');rmSync(dir,{recursive:true,force:true});}
});
