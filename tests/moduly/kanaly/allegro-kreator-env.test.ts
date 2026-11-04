import {expect,it} from 'vitest';
import {zbudujAplikacje} from '../../../src/core/aplikacja.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {modulyPiaskownicy} from '../../../deploy/proba/atrapy/index.mjs';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {zalozKonto} from '../../../src/core/bezpieczenstwo/konta.js';
import {podpisz} from '../../../src/core/bezpieczenstwo/sesja.js';
import {wczytajSekret} from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import type {ModulOms} from '../../../src/core/kontrakty.ts';

it('kanał Allegro z .env bez daty startu (_OD) nadal otwiera swoją stronę',async()=>{
 const http=async()=>{throw Error('brak sieci');};
 const env={OMS_USER:'serwis',OMS_PASS:'fixture',OMS_TRYB:'proba',OMS_KANALY:'[]',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:'/tmp/prz132-proformy',OMS_ETYKIETY_KATALOG:'/tmp/prz132-etykiety'};
 const m=createModulKanaly([{klucz:'rynek',typ:'allegro',prefiks:'RYNEK',etykieta:'Rynek Półcień'}] as any,true,{fetchImpl:http as any,autoryzacjaAtrapy:{http,softwareStatementId:'',redirectUri:'http://localhost/x',userAgent:'Fixture/1 (+https://example.invalid)'}} as any);
 const kanal={...m,konfiguracja:()=>m.konfiguracja(env)};
 const db=openOmsDb();const a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?kanal:x) as ModulOms[],env,teraz:()=>new Date('2026-11-01T12:00:00Z'),log:()=>{}});
 try{
  zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
  const r=await a.app.inject({method:'GET',url:'/ustawienia/integracje/allegro/rynek',headers:{accept:'text/html',cookie:'sesja_oms_proba='+podpisz('admin',wczytajSekret(db),Date.now())}});
  expect(r.statusCode).toBe(200);
 }finally{await a.app.close();db.close();}
});
