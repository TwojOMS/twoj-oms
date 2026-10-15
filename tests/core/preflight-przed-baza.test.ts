import {it,expect,vi} from 'vitest';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {Socket} from 'node:net';
import {createHash} from 'node:crypto';
import {uruchomOms} from '../../src/main.ts';
import {zbudujOms} from '../../src/oms/bootstrap.ts';
import type {Srodowisko} from '../../src/core/kontrakty.ts';
import {openOmsDb} from '../../src/oms/db/db.ts';
import {modulyDla} from '../../src/moduly/lista.ts';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

const przypadki=[
 ['GUS_URL',{GUS_URL:'file:///fixture.invalid'}],
 ['OMS_POLLER_MS',{OMS_POLLER_MS:'60001 '}],
 ['P_MAPOWANIE',{OMS_KANALY:'[{"klucz":"sklep","typ":"woo","prefiks":"P"}]',P_MAPOWANIE:'{błędny fixture JSON}'}],
] as const;
for(const [entry,start] of [
 ['uruchomOms',(env:Srodowisko)=>uruchomOms(env,'127.0.0.1')],
 ['zbudujOms',(env:Srodowisko)=>zbudujOms({env})],
] as const)for(const istnieje of [false,true])for(const [klucz,niepoprawne] of przypadki)
 it(`${entry}: odmowa ${klucz} przed DB, istniejąca=${istnieje}`,async()=>{
  const katalog=mkdtempSync(join(tmpdir(),'oms-w5-own-')),plik=join(katalog,'fixture.sqlite');
  const proby:string[]=[];
  const fetchSpy=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{proby.push('fetch');throw Error('W5: wychodząca sieć zabroniona');});
  const socketSpy=vi.spyOn(Socket.prototype,'connect').mockImplementation(()=>{proby.push('socket');throw Error('W5: wychodząca sieć zabroniona');});
  const env={OMS_TRYB:'produkcja',OMS_USER:'operator',OMS_PASS:'fixture',OMS_PORT:'0',OMS_DB_PATH:plik,
   OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:katalog,
   OMS_ETYKIETY_KATALOG:katalog,...niepoprawne};
  try{
   if(istnieje){
    const db=openOmsDb(plik,{moduly:modulyDla(env)});
    try{
     db.prepare('INSERT INTO ustawienia(klucz,wartosc,zmienione_at) VALUES(?,?,?)').run('w5-fixture','wartość do zachowania','2026-10-02T00:00:00.000Z');
     db.prepare('DELETE FROM stan_importu WHERE id=1').run();
     expect(db.prepare('SELECT COUNT(*) AS n FROM stan_importu').get()).toEqual({n:0});
    }finally{db.close();}
   }
   const przed=istnieje?readFileSync(plik):undefined;
   const odmowa=start(env);
   await expect(odmowa).rejects.toThrow(`OMS nie wystartuje — konfiguracja:`);
   await expect(odmowa).rejects.toThrow(klucz);
   const error=await odmowa.catch(e=>e as Error);
   expect(proby).toEqual([]);
   const powstal=existsSync(plik),po=powstal?readFileSync(plik):undefined;
   let singleton:number|undefined;
   if(powstal){
    const db=new DatabaseSync(plik,{readOnly:true});
    try{
     singleton=Number(db.prepare('SELECT COUNT(*) AS n FROM stan_importu WHERE id=1').get()!.n);
     if(istnieje)expect(db.prepare("SELECT wartosc,zmienione_at FROM ustawienia WHERE klucz='w5-fixture'").get())
      .toEqual({wartosc:'wartość do zachowania',zmienione_at:'2026-10-02T00:00:00.000Z'});
    }finally{db.close();}
   }
   console.info('W5-PROOF',JSON.stringify({entry,klucz,istnieje,error:(error as Error).message,powstal,singleton,
    shaPrzed:przed?sha(przed):null,shaPo:po?sha(po):null,identyczneBajty:przed&&po?przed.equals(po):null}));
   if(istnieje)expect(po!.equals(przed!)).toBe(true);
   else expect(powstal).toBe(false);
  }finally{
   fetchSpy.mockRestore();socketSpy.mockRestore();
   const cel=resolve(katalog),root=resolve(tmpdir());
   if(!cel.startsWith(root+'\\')&&!cel.startsWith(root+'/'))throw Error('Nieprawidłowy własny TEMP');
   rmSync(cel,{recursive:true,force:true});
  }
 });
