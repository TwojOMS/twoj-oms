import {it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {Socket} from 'node:net';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {zbudujOms} from '../../../src/oms/bootstrap.ts';
import {modulyDla} from '../../../src/moduly/lista.ts';

it('neutralna naprawa pobrania działa przez startup starej plikowej bazy i jest idempotentna',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'prz030-pobranie-')),path=join(dir,'stara.sqlite');
 const env={OMS_DB_PATH:path,OMS_TRYB:'produkcja',OMS_KANALY:'[]',OMS_USER:'operator',OMS_PASS:'atrapa',
  OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:dir,OMS_ETYKIETY_KATALOG:dir};
 const proby:string[]=[];
 const fetchSpy=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{proby.push('fetch');throw Error('Pobranie: sieć zabroniona');});
 const socketSpy=vi.spyOn(Socket.prototype,'connect').mockImplementation(()=>{proby.push('socket');throw Error('Pobranie: sieć zabroniona');});
 let a:Awaited<ReturnType<typeof zbudujOms>>|undefined;
 try{
  const db=openOmsDb(path,{moduly:modulyDla(env)});
  let przed:any[];
  const reczne=JSON.stringify({metoda:'dpd_pobranie',pobranie:0,punkt:'XYZ',dodatkowe:{x:1}});
  const obce=JSON.stringify({metoda:'inpost',opis:'dpd_pobranie',pobranie:0});
  const zle='{"metoda":"dpd_pobranie"';
  try{
   const insert=db.prepare('INSERT INTO zamowienia(sklep,zrodlo_id,numer,kwota_brutto,utworzone_at,metoda_wysylki,pobranie,wysylka_reczna_json,indywidualne,uwagi) VALUES(?,?,?,?,?,?,?,?,?,?)');
   for(const [id,metoda,pobranie,reczna] of [
    [1,'dpd_pobranie',0,null],[2,'dpd',0,reczne],[3,'dpd_pobranie',0,zle],
    [4,'inpost',0,obce],[5,'dpd',1,'["dpd_pobranie"]'],[6,'dpd',0,null],
   ] as const)insert.run('reczne',id,`COD-${id}`,'456.78','2026-08-01',metoda,pobranie,reczna,0,'ZACHOWAĆ');
   przed=db.prepare('SELECT * FROM zamowienia ORDER BY id').all();
  }finally{db.close();}
  a=await zbudujOms({env});
  const po=a.db.prepare('SELECT * FROM zamowienia ORDER BY id').all();
  const oczekiwane=przed.map((r,index)=>index===0||index===2?{...r,metoda_wysylki:'dpd',pobranie:1}:index===1?
   {...r,wysylka_reczna_json:JSON.stringify({...JSON.parse(reczne),metoda:'dpd',pobranie:1})}:r);
  console.info('COD-PROOF',JSON.stringify({przed,po,oczekiwane}));
  expect(po).toEqual(oczekiwane);
  expect(proby).toEqual([]);
  await a.app.close();a.db.close();a=undefined;
  a=await zbudujOms({env});
  expect(a.db.prepare('SELECT * FROM zamowienia ORDER BY id').all()).toEqual(po);
 }finally{
  try{if(a){await a.app.close();a.db.close();}}
  finally{
   const niedozwolonaSiec=[...proby];fetchSpy.mockRestore();socketSpy.mockRestore();
   if(dirname(resolve(dir))!==resolve(tmpdir())||!basename(dir).startsWith('prz030-pobranie-'))throw Error('Nieprawidłowa własna fixture');
   rmSync(dir,{recursive:true,force:true});
   expect(niedozwolonaSiec).toEqual([]);
  }
 }
});
