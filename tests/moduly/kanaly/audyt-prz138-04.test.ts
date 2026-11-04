import {afterEach,expect,it} from 'vitest';
import {zbudujAplikacje,type Aplikacja} from '../../../src/core/aplikacja.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {modulyPiaskownicy} from '../../../deploy/proba/atrapy/index.mjs';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {zalozKonto} from '../../../src/core/bezpieczenstwo/konta.js';
import {podpisz} from '../../../src/core/bezpieczenstwo/sesja.js';
import {wczytajSekret} from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import type {ModulOms} from '../../../src/core/kontrakty.ts';

const root='/ustawienia/integracje/allegro';
let a:Aplikacja,db:ReturnType<typeof openOmsDb>;
const otwarte:{a:Aplikacja,db:ReturnType<typeof openOmsDb>}[]=[];
afterEach(async()=>{for(const o of otwarte.splice(0)){await o.a.app.close();o.db.close();}});
async function setup(start:string){
 const czas=new Date(start);
 const http=async(u:string)=>{
  if(u.endsWith('/me'))return Response.json({id:'1000001',login:'polcien_test'});
  throw Error('Nieoczekiwane API');
 };
 const env={OMS_USER:'serwis',OMS_PASS:'fixture',OMS_TRYB:'proba',OMS_KANALY:'[]',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:'/tmp/prz138-proformy',OMS_ETYKIETY_KATALOG:'/tmp/prz138-etykiety'};
 const m=createModulKanaly([],false,{fetchImpl:u=>http(String(u)),autoryzacjaAtrapy:{http,softwareStatementId:'',redirectUri:'http://localhost'+root+'/oauth/powrot',userAgent:'Fixture/1 (+https://example.invalid)'}});
 const kanal={...m,konfiguracja:()=>m.konfiguracja(env)};
 db=openOmsDb();a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?kanal:x) as ModulOms[],env,teraz:()=>czas,log:()=>{}});
 otwarte.push({a,db});
 zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
 const cookie='sesja_oms_proba='+podpisz('admin',wczytajSekret(db),Date.now());
 let flow='';
 async function req(method:'GET'|'POST',url:string,payload?:Record<string,unknown>){
  const r=await a.app.inject({method,url,headers:{accept:'text/html',cookie:cookie+'; '+flow,...(method==='POST'?{origin:'http://localhost'}:{})},payload});
  const c=[r.headers['set-cookie']??[]].flat().find(c=>c.startsWith('oms_allegro_flow='));if(c)flow=c.split(';')[0];
  return r;
 }
 const strona=async()=>{
  const r=await req('GET',root+'/nowe');expect(r.statusCode).toBe(200);
  return {body:r.body,input:r.body.match(/<input\b[^>]*type="date"[^>]*>/)?.[0],formularzId:r.body.match(/name="formularzId" value="([^"]+)"/)![1]};
 };
 const szkic=async(od:string)=>{
  const {formularzId}=await strona();
  return req('POST',root+'/szkice',{formularzId,nazwa:'Pracownia Półcień',od,srodowisko:'produkcja'});
 };
 return {strona,szkic};
}

// U23 dla kreatora Allegro: granica dnia w Warszawie (zima UTC+1) i 29 lutego (rok przestępny 2028).
it.each([
 ['2026-11-03T22:30:00Z','2026-11-03','2025-11-03'],
 ['2026-11-03T23:30:00Z','2026-11-04','2025-11-04'],
 ['2028-02-29T22:30:00Z','2028-02-29','2027-02-28'],
 ['2028-02-29T23:30:00Z','2028-03-01','2027-03-01'],
])('U23: pole daty kreatora Allegro ma warszawskie min/max przy %s',async(czas,max,min)=>{
 const {input}=await (await setup(czas)).strona();
 expect(input).toBeDefined();
 expect(input).toContain(`min="${min}"`);
 expect(input).toContain(`max="${max}"`);
});
it('29.02 w roku przestępnym jest przyjęte przez /szkice, 29.02.2027 odrzucone',async()=>{
 const f=await setup('2028-02-29T22:30:00Z');
 const ok=await f.szkic('2028-02-29');
 expect(ok.statusCode,ok.body).toBe(303);
 const zle=await (await setup('2028-02-29T22:30:00Z')).szkic('2027-02-29');
 expect(zle.statusCode).toBe(400);
 expect(zle.body).toContain('dzień z ostatnich 12 miesięcy');
});
it('data z jutra (po warszawskiej północy) jest odrzucona na granicy dnia',async()=>{
 const f=await setup('2028-02-29T22:30:00Z');
 expect((await f.szkic('2028-03-01')).statusCode).toBe(400);
 const g=await setup('2028-02-29T23:30:00Z');
 expect((await g.szkic('2028-03-01')).statusCode).toBe(303);
});
