import {afterEach, expect, it} from 'vitest';
import {zbudujAplikacje} from '../../../src/core/aplikacja.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {modulyDla} from '../../../src/moduly/lista.ts';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {zalozKonto} from '../../../src/core/bezpieczenstwo/konta.js';
import {podpisz} from '../../../src/core/bezpieczenstwo/sesja.js';
import {wczytajSekret} from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import {MODUL_WOO} from '../../../src/domena/modul-woo.ts';
import {bladOperatora} from '../../../src/domena/bledy.js';
import {scopesAllegro} from '../../pomoc/allegro-konfigurator.ts';
import {modulyPiaskownicy} from '../../../deploy/proba/atrapy/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';

let a, db, katalog;
afterEach(async()=>{await a?.app.close();db?.close();if(katalog)fs.rmSync(katalog,{recursive:true,force:true});});
const powod='Granica nie może wyciąć zamówień istniejącego kanału.';
const aktor={id:0,login:'fixture'};
async function setup(typ, awaria=false){
 katalog=fs.mkdtempSync(path.join(tmpdir(),'aktywacja-granica-prz160p2-'));
 const env={OMS_TRYB:'produkcja',OMS_KANALY:'[]',OMS_USER:'serwis',OMS_PASS:'fixture',OMS_SPRZEDAWCA_NIP:'9990001002',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:path.join(katalog,'proformy'),OMS_ETYKIETY_KATALOG:path.join(katalog,'etykiety')};
 const m=createModulKanaly([],false,{fetchImpl:async()=>Response.json(typ==='erli'?{id:1000001,name:'Pracownia Półcień'}:[])});
 db=openOmsDb();
 a=await zbudujAplikacje({db,env,moduly:modulyDla(env).map(x=>x.nazwa==='kanaly'?m:x),teraz:()=>new Date('2026-11-13T12:00:00Z'),log:()=>{},
  nadpisania:awaria?{'raporty.poAktywacjiKanalu':()=>{throw new Error('prywatna awaria bazy');}}:{}});
 zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
 const cookie='sesja_oms='+podpisz('admin',wczytajSekret(db),Date.now());
 let klucz;
 if(typ==='erli'){
  const s=a.usluga('kanaly','sklepyErli');
  const w=await s.operacja('nowe','dane',{wersja:0,nazwa:'Pracownia Półcień',adresApi:'https://sandbox.erli.dev/svc/shop-api',kluczApi:'fixture-polcien'},aktor);
  expect(w.ok).toBe(true);klucz=w.klucz;
  expect((await s.operacja(klucz,'sprawdz',{wersja:1},aktor)).ok).toBe(true);
 }else{
  const s=a.usluga('kanaly','sklepyWoo');
  const w=s.utworzSzkic({nazwa:'Pracownia Półcień',adres:'https://polcien.example',ck:'ck_fixture',cs:'cs_fixture',od:'2026-11-13'},aktor);
  expect(w.ok).toBe(true);klucz=w.dane.klucz;
  expect((await s.sprawdz(klucz)).ok).toBe(true);
  const k=db.prepare('SELECT * FROM kanaly_sprzedazy WHERE klucz=?').get(klucz);
  expect(s.zapiszMapowanie(klucz,{instancje:{},bramkiPobrania:[]},k.wersja,aktor).ok).toBe(true);
 }
 db.prepare("INSERT INTO zamowienia(sklep,zrodlo_id,numer,kwota_brutto,utworzone_at) VALUES (?,1,'FIXTURE/1','10.00','2020-01-01T12:00:00Z')").run(klucz);
 const kanal=()=>db.prepare('SELECT * FROM kanaly_sprzedazy WHERE klucz=?').get(klucz);
 const przed=kanal();
 const konfiguracja=db.prepare('SELECT * FROM konfiguracja_integracji').all();
 const root=typ==='woo'?MODUL_WOO.konfigurator.sciezka:'/ustawienia/integracje/erli';
 const aktywuj=()=>a.app.inject({method:'POST',url:`${root}/${klucz}/aktywuj`,payload:{wersja:przed.wersja,od:'2026-11-13'},headers:{cookie,origin:'http://localhost',accept:'text/html'}});
 return {aktywuj,kanal,przed,konfiguracja};
}
it.each(['erli','woo'])('%s: odmowa granicy daje 409 w formularzu i wycofuje aktywację',async typ=>{
 const f=await setup(typ),r=await f.aktywuj();
 expect(r.statusCode).toBe(409);expect(r.body).toContain(powod);
 expect(r.body).toContain('name="wersja"');
 expect(f.kanal()).toEqual(f.przed);expect(f.kanal().autoryzacja).not.toBe('polaczone');
 expect(db.prepare('SELECT * FROM konfiguracja_integracji').all()).toEqual(f.konfiguracja);
 expect(db.prepare('SELECT * FROM granice_historii WHERE kanal=?').get(f.przed.raport)).toBeUndefined();
});
it.each(['erli','woo'])('%s: awaria daje ogólne 503 i wycofuje aktywację',async typ=>{
 const f=await setup(typ,true),r=await f.aktywuj();
 expect(r.statusCode).toBe(503);expect(r.body).toContain('Nie udało się wykonać operacji');
 expect(r.body).not.toContain('prywatna awaria bazy');expect(f.kanal()).toEqual(f.przed);
 expect(db.prepare('SELECT * FROM konfiguracja_integracji').all()).toEqual(f.konfiguracja);
});
it.each(['erli','woo'])('%s: przejęcie raportu historii daje 409 z powodem',async typ=>{
 const f=await setup(typ);
 a.usluga('raporty','config').regulySprzedazy.klasyfikacja.konta.set('konto-fixture',f.przed.raport);
 const r=await f.aktywuj();
 expect(r.statusCode).toBe(409);expect(r.body).toContain('Nowy kanał nie może przejąć raportu historii.');
 expect(f.kanal()).toEqual(f.przed);
});

async function setupAllegro(wyjatek){
 katalog=fs.mkdtempSync(path.join(tmpdir(),'aktywacja-allegro-prz160p2-'));
 const root='/ustawienia/integracje/allegro';
 let czas=new Date('2026-11-13T12:00:00Z'),flow='';
 const http=async u=>{
  if(u.endsWith('/device'))return Response.json({device_code:'fixture-device',user_code:'FIXTURE',verification_uri:'https://allegro.pl/skojarz',expires_in:600,interval:5});
  if(u.endsWith('/token'))return Response.json({access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600,scope:scopesAllegro.join(' ')});
  if(u.endsWith('/me'))return Response.json({id:'1000001',login:'polcien_test'});
  if(u.includes('/order/checkout-forms?'))return Response.json({checkoutForms:[],totalCount:0});
  throw new Error('Nieoczekiwane API atrapy');
 };
 const env={OMS_TRYB:'produkcja',OMS_KANALY:'[]',OMS_USER:'serwis',OMS_PASS:'fixture',OMS_SPRZEDAWCA_NIP:'9990001002',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:path.join(katalog,'proformy'),OMS_ETYKIETY_KATALOG:path.join(katalog,'etykiety')};
 const m=createModulKanaly([],false,{fetchImpl:u=>http(String(u)),autoryzacjaAtrapy:{http,softwareStatementId:'',redirectUri:'http://localhost'+root+'/oauth/powrot',userAgent:'Fixture/1 (+https://example.invalid)'}});
 env.OMS_TRYB='proba';
 const kanalModul={...m,konfiguracja:()=>m.konfiguracja(env)};
 db=openOmsDb();
 a=await zbudujAplikacje({db,env,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?kanalModul:x),teraz:()=>czas,log:()=>{},nadpisania:{'raporty.poAktywacjiKanalu':()=>{throw wyjatek;}}});
 zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
 const cookie='sesja_oms_proba='+podpisz('admin',wczytajSekret(db),Date.now());
 async function req(method,url,payload){
  const r=await a.app.inject({method,url,payload,headers:{cookie:cookie+'; '+flow,origin:'http://localhost',accept:'text/html'}});
  const c=[r.headers['set-cookie']??[]].flat().find(c=>c.startsWith('oms_allegro_flow='));if(c)flow=c.split(';')[0];
  return r;
 }
 expect((await req('POST',root+'/aplikacja-urzadzenia',{srodowisko:'produkcja',clientId:'fixture-id',clientSecret:'fixture-secret'})).statusCode).toBe(200);
 const page=await req('GET',root+'/nowe');
 const formularzId=page.body.match(/name="formularzId" value="([^"]+)"/)[1];
 const draft=await req('POST',root+'/szkice',{formularzId,nazwa:'Pracownia Półcień',od:'2026-11-13',srodowisko:'produkcja'});
 expect(draft.statusCode).toBe(303);
 const klucz=draft.headers.location.split('/').pop();
 const kanal=()=>db.prepare('SELECT * FROM kanaly_sprzedazy WHERE klucz=?').get(klucz);
 const post=(akcja,dane={})=>req('POST',`${root}/${klucz}/${akcja}`,{wersja:kanal().wersja,...dane});
 const start=await post('autoryzacja');expect(start.statusCode).toBe(200);
 const probaId=start.body.match(/name="probaId" value="([^"]+)"/)[1];
 czas=new Date(czas.getTime()+6000);
 expect((await post('zgoda',{probaId})).statusCode).toBe(200);
 expect((await post('potwierdz',{probaId})).statusCode).toBe(303);
 return {kanal,aktywuj:()=>post('aktywuj',{probaId,potwierdz:'tak',pobieraj:'nie'})};
}
it.each([
 ['odmowa granicy',()=>bladOperatora(powod,{kod:'konflikt'}),409],
 ['awaria',()=>new Error('prywatna awaria bazy'),503],
 ['inny błąd operatora',()=>bladOperatora('prywatna awaria bazy',{kod:'walidacja'}),503],
 ['zwykły Error z kodem konflikt',()=>Object.assign(new Error('prywatna awaria bazy'),{kod:'konflikt'}),503],
 ['obiekt bez Error',()=>({dlaOperatora:true,kod:'konflikt',message:'prywatna awaria bazy'}),503],
])('allegro: %s — właściwy status i wycofanie aktywacji',async(_nazwa,wyjatek,status)=>{
 const f=await setupAllegro(wyjatek()),przed=f.kanal();
 const tokeny=db.prepare('SELECT * FROM tokeny_kanalu').all();
 const r=await f.aktywuj();
 expect(r.statusCode).toBe(status);
 if(status===409)expect(r.body).toContain(powod);
 else expect(r.body).toContain('Nie udało się');
 expect(r.body).not.toContain('prywatna awaria bazy');
 expect(f.kanal()).toEqual(przed);expect(f.kanal().autoryzacja).not.toBe('polaczone');
 expect(db.prepare('SELECT * FROM tokeny_kanalu').all()).toEqual(tokeny);
});
