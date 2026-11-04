// PRZ-150.01: w piaskownicy kreator Woo przechodzi na adresie sklepu przykładowego bez sieci; obcy adres dalej
// zablokowany (C5); poza próbą bez zmian. Transport (fetchImpl) rzuca przy każdym wywołaniu i liczy wywołania.
import {afterEach,expect,it} from 'vitest';
import {zbudujAplikacje,type Aplikacja} from '../../../src/core/aplikacja.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {modulyPiaskownicy} from '../../../deploy/proba/atrapy/index.mjs';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {zalozKonto} from '../../../src/core/bezpieczenstwo/konta.js';
import {podpisz} from '../../../src/core/bezpieczenstwo/sesja.js';
import {wczytajSekret} from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import {MODUL_WOO} from '../../../src/domena/modul-woo.ts';
import type {ModulOms} from '../../../src/core/kontrakty.ts';
const root=MODUL_WOO.konfigurator.sciezka;
const PRZYKLADOWY='https://sklep-przykladowy.example.invalid';
let a:Aplikacja,db:ReturnType<typeof openOmsDb>;
afterEach(async()=>{await a?.app.close();db?.close();});
async function setup(proba:boolean){
 const env={OMS_USER:'serwis',OMS_PASS:'fixture',OMS_TRYB:'proba',OMS_KANALY:'[]',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:'/tmp/prz150-proformy',OMS_ETYKIETY_KATALOG:'/tmp/prz150-etykiety'};
 const calls:string[]=[];
 const m=createModulKanaly([],false,{fetchImpl:async u=>{calls.push(String(u));throw new TypeError('sieć niedostępna w teście');}});
 const config=createModulKanaly([]).konfiguracja(env);
 // Tryb modułu ustawia jego konfiguracja; bez jej wywołania moduł zostaje w trybie produkcji (ten sam wzór co woo-kreator-trasy).
 if(proba)m.konfiguracja(env);
 config.sklepy['przykladowy']={atrapa:true,baseUrl:PRZYKLADOWY} as any;
 db=openOmsDb();a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?{...m,konfiguracja:()=>config}:x) as ModulOms[],env,teraz:()=>new Date('2026-11-03T12:00:00Z'),log:()=>{}});
 zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
 const cookie='sesja_oms_proba='+podpisz('admin',wczytajSekret(db),Date.now());
 const req=(method:'GET'|'POST',path:string,payload?:Record<string,unknown>)=>a.app.inject({method,url:root+path,payload,headers:{accept:'text/html',cookie,...(method==='POST'?{origin:'http://localhost'}:{})}});
 async function klucze(adres:string,ck:string,cs:string){
  const p=await req('POST','/szkice',{nazwa:'Pracownia Półcień',adres});expect(p.statusCode).toBe(200);
  const formularzId=p.body.match(/name="formularzId" value="([^"]+)"/)?.[1];expect(formularzId).toBeTruthy();
  return req('POST','/nowy/klucze',{formularzId,wersja:0,ck,cs});
 }
 return {req,klucze,calls};
}
const sklepy=()=>db.prepare('SELECT adres FROM kanaly_sklepy').all();
const kluczeWBazie=()=>db.prepare('SELECT * FROM konfiguracja_integracji WHERE integracja LIKE ?').all('woo_klucze:%');

it('B: proba + adres sklepu przykładowego — kreator kończy się aktywacją bez żadnego żądania do sieci',async()=>{
 const f=await setup(true);
 // Użytkownik wpisuje adres tak, jak go widzi (bez schematu); dowolne klucze w formacie ck_/cs_.
 const w=await f.klucze('sklep-przykladowy.example.invalid','ck_dowolny123','cs_dowolny456');
 expect(w.statusCode).toBe(303);
 const path=String(w.headers.location).slice(root.length);
 expect(sklepy()).toEqual([{adres:PRZYKLADOWY}]);
 let r=await f.req('GET',path);expect(r.statusCode).toBe(200);expect(r.body).toContain('Połączenie ze sklepem działa.');
 const k=()=>db.prepare('SELECT * FROM kanaly_sprzedazy').get() as any;
 expect((await f.req('POST',path+'/sprawdz',{wersja:k().wersja})).statusCode).toBe(200);
 expect(r.body).toMatch(/name="instancja_1"/);
 expect((await f.req('POST',path+'/mapowanie',{wersja:k().wersja,instancja_1:'dpd',pobranie_decyzja:'1'})).statusCode).toBe(303);
 expect((await f.req('POST',path+'/data-startu',{wersja:k().wersja,od:'2026-11-01'})).statusCode).toBe(303);
 expect((await f.req('POST',path+'/aktywuj',{wersja:k().wersja})).statusCode).toBe(303);
 expect(k()).toMatchObject({autoryzacja:'polaczone'});
 expect(f.calls).toEqual([]);
});
it('B: klucze spoza formatu ck_/cs_ atrapa odrzuca jak sklep — nic nie zapisane, bez sieci',async()=>{
 const f=await setup(true);
 const w=await f.klucze(PRZYKLADOWY,'zly_klucz','cs_dowolny');
 expect(w.statusCode).toBe(503);expect(w.body).toContain('Sklep odrzucił klucze.');
 expect(sklepy()).toEqual([]);expect(kluczeWBazie()).toEqual([]);expect(f.calls).toEqual([]);
});
it.each([true,false])('B: zdanie z adresem sklepu przykładowego pod polem adresu tylko w próbie (proba=%s)',async proba=>{
 const f=await setup(proba);const r=await f.req('GET','/nowy');
 expect(r.body.includes(`W piaskownicy działa adres sklepu przykładowego: ${PRZYKLADOWY}.`)).toBe(proba);
});
it('C: proba + adres spoza sklepów przykładowych — dalej blokada C5 bez próby połączenia',async()=>{
 const f=await setup(true);
 const w=await f.klucze('https://sklep.example.test','ck_dowolny','cs_dowolny');
 expect(w.statusCode).toBe(400);
 expect(w.body).toContain('Piaskownica nie łączy się z prawdziwymi sklepami — działa tu tylko sklep przykładowy.');
 expect(sklepy()).toEqual([]);expect(kluczeWBazie()).toEqual([]);expect(f.calls).toEqual([]);
});
it('C: poza próbą nawet adres atrapy idzie zwykłym klientem przez transport (bez atrapy, bez blokady)',async()=>{
 const f=await setup(false);
 const w=await f.klucze(PRZYKLADOWY,'ck_dowolny','cs_dowolny');
 expect(w.statusCode).toBe(503);expect(w.body).not.toContain('Piaskownica');
 expect(f.calls.length).toBeGreaterThan(0);
 expect(f.calls.every(u=>u.startsWith(PRZYKLADOWY+'/'))).toBe(true);
 expect(sklepy()).toEqual([]);
});
