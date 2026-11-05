import {afterEach, expect, it} from 'vitest';
import {zbudujOms} from '../../pomoc/zbuduj-oms.ts';
import {modulRdzen} from '../../../src/moduly/rdzen/modul.ts';
import {modulWeb} from '../../../src/core/web/modul.ts';
import {zalozKonto, kontoPoLoginie, ustawUprawnienia} from '../../../src/core/bezpieczenstwo/konta.js';
import {jako, post} from '../../pomoc/konta-prz068.js';
import {registerTrasyWoo} from '../../../src/moduly/kanaly/trasy-woo.ts';
import {registerTrasyAllegro} from '../../../src/moduly/kanaly/trasy-allegro.ts';
import ejs from 'ejs';

const A='/ustawienia/integracje/allegro', W='/ustawienia/integracje/woocommerce';
const sekret='fikcyjny-sekret-g13-kn';
let p;
afterEach(async()=>{await p?.app.close();p?.db.close();p=null;});
async function panel(typ,{admin=true, awaria=false, woo={}}={}){
 const repo={lista:()=>[],listaTypu:()=>{if(awaria)throw Error(sekret);return [];},pobierz:()=>{throw Error(sekret);}};
 const modul={nazwa:'odmowy-test',wersja:'1.0.0',wymaga:['web'],migracje:[],menu:[],uprawnienia:[],konfiguracja:()=>null,
  zbuduj:ctx=>({trasy:app=>{
   if(typ==='woo')registerTrasyWoo(app,{db:ctx.db,repozytorium:repo,sklepyWoo:woo,envSklepy:[{klucz:'z-pliku',nazwa:'Sklep Testowy',adres:'https://sklep.example.test',od:'2026-11-01T00:00:00Z',mapowanie:{}}],teraz:()=>new Date('2026-11-05T12:00:00Z'),tryb:'produkcja'});
   else registerTrasyAllegro(app,{db:ctx.db,repozytoriumKanalow:repo,config:{clientSecret:sekret},aplikacjaAllegro:{stanAplikacji:()=>{throw Error(sekret);}}},()=>new Date());
  }})};
 p=await zbudujOms({moduly:[modulRdzen,modulWeb,modul],env:{OMS_USER:'operator',OMS_PASS:sekret}});
 zalozKonto(p.db,{login:'konto',imie:'Konto',haslo:'h',rola:admin?'administrator':'sprzedaz',admin});
 ustawUprawnienia(p.db,kontoPoLoginie(p.db,'konto').id,['ustawienia']);
 p.konto=jako(p.db,'konto');
 return p;
}
function sprawdz(r,status,tekst,typ,wroc){
 expect(r.statusCode,r.body).toBe(status);
 expect(r.headers['content-type']).toMatch(/^text\/html/);
 expect(r.body).toContain('<html');
 expect(r.body).toContain(`<p class="pasek-uwaga" role="alert">${ejs.escapeXML(tekst)}</p>`);
 expect(r.body).toContain(`<h1>Nie zapisano ustawień ${typ==='woo'?'sklepu WooCommerce':'Allegro'}</h1>`);
 expect(r.body).toContain(`<a class="btn" href="${wroc}">Wróć do ustawień połączenia</a>`);
 expect(r.body).not.toContain(sekret);
}
it.each(['woo','allegro'])('%s: wspólna odmowa 403 dla konta bez admina',async typ=>{
 await panel(typ,{admin:false});const root=typ==='woo'?W:A;
 sprawdz(await post(p.app,root+'/a%2Fb/nazwa',p.konto),403,`Tylko administrator może konfigurować ${typ==='woo'?'WooCommerce':'Allegro'}.`,typ,root+'/a%2Fb');
});
it.each(['woo','allegro'])('%s: wspólna odmowa 503 nie ujawnia wyjątku',async typ=>{
 await panel(typ,{awaria:true});const root=typ==='woo'?W:A;
 const r=await p.app.inject({url:root+(typ==='woo'?'/brak':'/nowe'),headers:p.konto});
 sprawdz(r,503,`Nie udało się wykonać operacji ${typ==='woo'?'WooCommerce':'Allegro'}. Odśwież ekran i sprawdź stan ${typ==='woo'?'sklepu':'połączenia'}.`,typ,root+(typ==='woo'?'/brak':'/nowe'));
});
it.each([['GET','/aplikacja?srodowisko=zle'],['POST','/aplikacja-urzadzenia'],['POST','/user-agent']])('Allegro: %s %s — brak środowiska',async(method,path)=>{
 await panel('allegro');
 const r=method==='POST'?await post(p.app,A+path,p.konto,{srodowisko:'zle',clientSecret:sekret}):await p.app.inject({url:A+path,headers:p.konto});
 sprawdz(r,400,'Wybierz środowisko Allegro: produkcja albo sandbox.','allegro',A+'/aplikacja');
});
it('Woo: nieaktualny formularz kluczy',async()=>{
 await panel('woo');sprawdz(await post(p.app,W+'/nowy/klucze',p.konto,{cs:sekret}),409,'Otwórz konfigurator ponownie.','woo',W+'/nowy');
});
it.each([['brak','Nie znaleziono sklepu. Odśwież ekran.'],['z-pliku','Ten sklep jest ustawiony w pliku konfiguracji (oms.env) — tam go zmień. Formularz niczego nie zapisał.']])('Woo: %s',async(k,tekst)=>{
 await panel('woo');sprawdz(await post(p.app,W+'/'+k+'/nazwa',p.konto),409,tekst,'woo',W+'/'+k);
});
it('Woo: limit 1000 szkiców',async()=>{
 await panel('woo');
 for(let i=0;i<1000;i++)expect((await post(p.app,W+'/szkice',p.konto,{nazwa:'Testowy',adres:'https://sklep.example.test'})).statusCode).toBe(200);
 sprawdz(await post(p.app,W+'/szkice',p.konto,{nazwa:'Testowy',adres:'https://sklep.example.test'}),503,'Otwórz konfigurator ponownie za chwilę.','woo',W+'/nowy');
},30000);
it('Woo: równoczesne wysłanie kluczy po nieudanej próbie',async()=>{
 const oczekujacy=[];let rozpoczeto,oba;
 const start=new Promise(r=>{rozpoczeto=r;}),dwa=new Promise(r=>{oba=r;});
 // Sterowana atrapa Promise: oba żądania muszą czekać na tę samą próbę.
 const proba={then(resolve){oczekujacy.push(resolve);rozpoczeto();if(oczekujacy.length===2)oba();}};
 await panel('woo',{woo:{sprawdzNowe:()=>proba}});
 const szkic=await post(p.app,W+'/szkice',p.konto,{nazwa:'Testowy',adres:'https://sklep.example.test'});
 expect(szkic.statusCode,szkic.body).toBe(200);
 const formularzId=szkic.body.match(/name="formularzId" value="([^"]+)"/)[1];
 const dane={formularzId,wersja:'0',ck:'fikcyjny-klucz',cs:sekret};
 const pierwszy=Promise.resolve(post(p.app,W+'/nowy/klucze',p.konto,dane));
 await Promise.race([start,pierwszy.then(r=>{throw Error(`Atrapa nie została wywołana: ${r.statusCode} ${r.body.slice(r.body.indexOf('role="alert"'),r.body.indexOf('role="alert"')+180)}`);})]);
 const drugi=post(p.app,W+'/nowy/klucze',p.konto,dane);
 const oczekiwanie=Promise.resolve(drugi);await dwa;
 for(const resolve of oczekujacy)resolve({ok:false,kod:'tymczasowy',komunikat:'Próba nieudana.'});
 await pierwszy;
 sprawdz(await oczekiwanie,409,'Odśwież konfigurator.','woo',W+'/nowy');
});
