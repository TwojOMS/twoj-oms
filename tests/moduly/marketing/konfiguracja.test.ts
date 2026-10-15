import type {ModulOms} from '../../../src/core/kontrakty.ts';
import {it,expect} from 'vitest';
import {konfiguracjaMarketingu} from '../../../src/moduly/marketing/konfiguracja.ts';
import {createModulMarketing} from '../../../src/moduly/marketing/modul.ts';
import {zbudujOms} from '../../pomoc/zbuduj-oms.ts';
import {MODULY} from '../../../src/moduly/lista.ts';
import {tmpdir} from 'node:os';
it('META_KONTA zachowuje historyczną aktywację obu połówek i odmowę złego konta',()=>{
 expect(konfiguracjaMarketingu({}).meta).toBeNull();
 expect(()=>konfiguracjaMarketingu({META_KONTA:'act_1'})).toThrow('META_TOKEN');
 expect(()=>konfiguracjaMarketingu({META_TOKEN:'fixture'})).toThrow('META_KONTA');
 expect(()=>konfiguracjaMarketingu({META_TOKEN:'fixture',META_KONTA:'1'})).toThrow(/nie wygląda na konto reklamowe/);
 expect(konfiguracjaMarketingu({META_TOKEN:'fixture',META_KONTA:'act_101, act_202'}).meta).toEqual({token:'fixture',konta:['act_101','act_202']});
});
it('produkcyjna kompozycja rejestruje dwa godzinne zegary z rzeczywistych usług, próba odmawia kluczy',async()=>{
 const env={OMS_USER:'operator',OMS_PASS:'fixture',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:tmpdir(),OMS_ETYKIETY_KATALOG:tmpdir(),META_TOKEN:'fixture',META_KONTA:'act_101'};
 const moduly=MODULY.map(m=>m.nazwa==='marketing'?createModulMarketing({fabryki:{createMeta:()=>({dzienneStatystyki:async()=>[]})}}):m) as readonly ModulOms[];
 const a=await zbudujOms({moduly,env});
 try{expect(a.zegary.filter(z=>/Kampanii|Reklam/.test(z.nazwa)).map(z=>[z.nazwa,z.odstepMs])).toEqual([['czuwaczKampanii',3600000],['czuwaczReklam',3600000]]);}
 finally{await a.app.close();a.db.close();}
 await expect(zbudujOms({moduly,env:{...env,OMS_TRYB:'proba'}})).rejects.toThrow(/META_TOKEN/);
});
