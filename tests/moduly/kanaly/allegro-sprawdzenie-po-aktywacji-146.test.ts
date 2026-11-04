// PRZ-146.06 (B8): po udanej aktywacji OMS sam robi test połączenia („Sprawdź”); wynik w kanaly_diagnostyka.
import {afterEach,expect,it} from 'vitest';
import {zbudujAplikacje,type Aplikacja} from '../../../src/core/aplikacja.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {modulyPiaskownicy} from '../../../deploy/proba/atrapy/index.mjs';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {zalozKonto} from '../../../src/core/bezpieczenstwo/konta.js';
import {podpisz} from '../../../src/core/bezpieczenstwo/sesja.js';
import {wczytajSekret} from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import {scopesAllegro} from '../../pomoc/allegro-konfigurator.ts';
import type {ModulOms} from '../../../src/core/kontrakty.ts';

const root='/ustawienia/integracje/allegro';
let a:Aplikacja,db:ReturnType<typeof openOmsDb>;
afterEach(async()=>{await a?.app.close();db?.close();});

type Tryb='ok'|'odmowa'|'wisi'|'pozno';
async function setup(){
 let czas=new Date('2026-11-01T12:00:00Z'),tryb:Tryb='ok';const zRejestru:string[]=[];
 // Zapisane odpowiedzi Allegro (zmyślone konto „polcien_test”).
 const odpowiedz=(u:string)=>{
  if(u.endsWith('/device'))return Response.json({device_code:'DEVICE-POLCIEN',user_code:'POLCIEN-123',verification_uri:'https://allegro.pl/skojarz',expires_in:600,interval:5});
  if(u.endsWith('/token'))return Response.json({access_token:'ACCESS-POLCIEN',refresh_token:'REFRESH-POLCIEN',expires_in:3600,scope:scopesAllegro.join(' ')});
  if(u.endsWith('/me'))return Response.json({id:'1000001',login:'polcien_test'});
  if(u.includes('/order/checkout-forms?'))return Response.json({checkoutForms:[],totalCount:0});
  throw Error('Nieoczekiwane API');
 };
 const http=async(u:string)=>odpowiedz(u);
 // Klient kanału (rejestr) — tę drogę idzie test połączenia „Sprawdź”.
 const fetchImpl=async(u:unknown)=>{
  zRejestru.push(String(u));
  if(tryb==='wisi')return new Promise<Response>(()=>{});
  // PRZ-148.06: odpowiedź (odmowa) przychodzi dopiero po limicie trasy (300 ms) — test kończy się w tle.
  if(tryb==='pozno')return new Promise<Response>(z=>setTimeout(()=>z(Response.json({error:'invalid_token'},{status:401})),700));
  if(tryb==='odmowa')return Response.json({error:'invalid_token'},{status:401});
  return odpowiedz(String(u));
 };
 const env={OMS_USER:'serwis',OMS_PASS:'fixture',OMS_TRYB:'proba',OMS_KANALY:'[]',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:'/tmp/prz132-proformy',OMS_ETYKIETY_KATALOG:'/tmp/prz132-etykiety'};
 const m=createModulKanaly([],false,{fetchImpl:fetchImpl as typeof fetch,limitCzasuMs:300,autoryzacjaAtrapy:{http,softwareStatementId:'',redirectUri:'http://localhost'+root+'/oauth/powrot',userAgent:'Fixture/1 (+https://example.invalid)'}});
 const kanal={...m,konfiguracja:()=>m.konfiguracja(env)};
 db=openOmsDb();a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?kanal:x) as ModulOms[],env,teraz:()=>czas,log:()=>{}});
 zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
 let flow='';const cookie='sesja_oms_proba='+podpisz('admin',wczytajSekret(db),Date.now());
 async function req(method:'GET'|'POST',url:string,payload?:Record<string,unknown>){
  const r=await a.app.inject({method,url,headers:{accept:'text/html',cookie:cookie+'; '+flow,...(method==='POST'?{origin:'http://localhost'}:{})},payload});
  const c=[r.headers['set-cookie']??[]].flat().find(c=>c.startsWith('oms_allegro_flow='));if(c)flow=c.split(';')[0];
  expect(r.body).not.toMatch(/SECRET-POLCIEN|DEVICE-POLCIEN|ACCESS-POLCIEN|REFRESH-POLCIEN/);
  return r;
 }
 expect((await req('POST',root+'/aplikacja-urzadzenia',{srodowisko:'produkcja',clientId:'polcien-id',clientSecret:'SECRET-POLCIEN'})).statusCode).toBe(200);
 const repo=a.usluga<any>('kanaly','repozytoriumKanalow');
 const post=(k:string,akcja:string,dane:Record<string,unknown>={})=>req('POST',root+'/'+k+'/'+akcja,{wersja:String(repo.pobierz(k).wersja),...dane});
 /** Kroki 1–4 kreatora; zwraca odpowiedź POST /aktywuj. */
 async function aktywuj(t:Tryb){
  const page=await req('GET',root+'/nowe');const formularzId=page.body.match(/name="formularzId" value="([^"]+)"/)![1];
  const s=await req('POST',root+'/szkice',{formularzId,nazwa:'Pracownia Półcień',od:'2026-11-01',srodowisko:'produkcja'});expect(s.statusCode).toBe(303);
  const k=s.headers.location!.split('/').pop()!;
  const start=await post(k,'autoryzacja');const probaId=start.body.match(/name="probaId" value="([^"]+)"/)![1];
  czas=new Date(czas.getTime()+6000);await post(k,'zgoda',{probaId});
  expect((await post(k,'potwierdz',{probaId})).statusCode).toBe(303);
  tryb=t;
  const r=await post(k,'aktywuj',{probaId,potwierdz:'tak',pobieraj:'nie'});
  return {k,r};
 }
 const diagnostyka=(k:string)=>db.prepare('SELECT ostatnia_proba_at,ostatni_sukces_at,blad FROM kanaly_diagnostyka WHERE kanal=?').get(k) as {ostatnia_proba_at:string;ostatni_sukces_at:string|null;blad:number}|undefined;
 const wierszListy=async()=>{const html=(await req('GET','/ustawienia/integracje')).body;const i=html.indexOf('Pracownia Półcień');expect(i).toBeGreaterThan(-1);return html.slice(i,i+3000);};
 return {req,repo,aktywuj,diagnostyka,wierszListy,zRejestru};
}

it('sukces testu: wpis w kanaly_diagnostyka, lista pokazuje „Działa”, ekran konta ma czas testu',async()=>{
 const f=await setup(),{k,r}=await f.aktywuj('ok');
 expect(r.statusCode).toBe(303);expect(f.repo.pobierz(k).autoryzacja).toBe('polaczone');
 expect(f.zRejestru.some(u=>u.endsWith('/me'))).toBe(true);
 const d=f.diagnostyka(k);expect(d).toBeTruthy();expect(d!.blad).toBe(0);expect(d!.ostatni_sukces_at).toBeTruthy();
 expect(await f.wierszListy()).toMatch(/pol-stan[^>]*>.*Działa/s);
 const konto=(await f.req('GET',root+'/'+k)).body;expect(konto).not.toContain('Ostatni test połączenia się nie udał');
 expect(konto).toMatch(/Ostatni udany test połączenia<\/dt><dd>(?!Jeszcze nie wykonano)/);
});
it('błąd testu nie cofa aktywacji: konto połączone, wpis z błędem, komunikat na ekranie konta, lista „Wymaga uwagi”',async()=>{
 const f=await setup(),{k,r}=await f.aktywuj('odmowa');
 expect(r.statusCode).toBe(303);expect(f.repo.pobierz(k).autoryzacja).toBe('polaczone');
 const d=f.diagnostyka(k);expect(d).toBeTruthy();expect(d!.blad).toBe(1);expect(d!.ostatni_sukces_at).toBeNull();
 const konto=(await f.req('GET',root+'/'+k)).body;
 // Komunikat z testu połączenia (sprawdzPolaczenie) jako pasek błędu na ekranie konta.
 expect(konto).toMatch(/class="pas-blad" role="alert"><p>(Allegro odmówiło dostępu|Allegro nie odpowiada|Nie udało się odczytać konta lub zamówień Allegro)/);expect(konto).toContain('Ostatni test połączenia się nie udał');
 expect(await f.wierszListy()).toMatch(/pol-stan[^>]*>.*Wymaga uwagi/s);
});
it('przekroczenie limitu transportu: odpowiedź bez czekania w nieskończoność, bez wpisu sukcesu, konto aktywne, „Niesprawdzone”',async()=>{
 const f=await setup(),start=Date.now(),{k,r}=await f.aktywuj('wisi');
 expect(r.statusCode).toBe(303);expect(Date.now()-start).toBeLessThan(5000);
 expect(f.repo.pobierz(k).autoryzacja).toBe('polaczone');
 expect(f.diagnostyka(k)?.ostatni_sukces_at??null).toBeNull();
 const konto=(await f.req('GET',root+'/'+k)).body;expect(konto).not.toContain('role="alert"');
 expect(await f.wierszListy()).toMatch(/pol-stan[^>]*>.*Niesprawdzone/s);
});
// PRZ-148.06 (7): po limicie odpowiedź idzie bez wyniku, a test kończy się w tle i zapisuje wynik później.
it('PRZ-148.06: po limicie test w tle zapisuje wynik (błąd) później; ekran konta pokazuje go po odświeżeniu',async()=>{
 const f=await setup(),start=Date.now(),{k,r}=await f.aktywuj('pozno');
 expect(r.statusCode).toBe(303);expect(f.diagnostyka(k),'odpowiedź przed wynikiem testu').toBeUndefined();expect(Date.now()-start).toBeLessThan(5000);
 expect((await f.req('GET',root+'/'+k)).body).not.toContain('role="alert"');
 let d=f.diagnostyka(k);for(let i=0;i<60&&!d;i++){await new Promise(z=>setTimeout(z,50));d=f.diagnostyka(k);}
 expect(d,'wynik testu w tle').toBeTruthy();expect(d!.blad).toBe(1);expect(d!.ostatni_sukces_at).toBeNull();
 const konto=(await f.req('GET',root+'/'+k)).body;expect(konto).toContain('Ostatni test połączenia się nie udał');
 expect(konto).not.toContain('Połączenie sprawdzone');
 expect(await f.wierszListy()).toMatch(/pol-stan[^>]*>.*Wymaga uwagi/s);
});
it('PRZ-148.06: udany test po aktywacji daje jednorazowy komunikat „sprawdzone”',async()=>{
 const f=await setup(),{k}=await f.aktywuj('ok');
 const konto=(await f.req('GET',root+'/'+k)).body;
 expect(konto).toMatch(/class="pas-potwierdzenie" role="status"><p>Konto podłączone\. Połączenie sprawdzone — odczyt konta i zamówień działa\./);
 expect((await f.req('GET',root+'/'+k)).body).not.toContain('Połączenie sprawdzone');
});
it('PRZ-148.06: nieudany test po aktywacji nie daje komunikatu „sprawdzone”',async()=>{
 const f=await setup(),{k}=await f.aktywuj('odmowa');
 const konto=(await f.req('GET',root+'/'+k)).body;expect(konto).toContain('class="pas-blad"');expect(konto).not.toContain('Połączenie sprawdzone');
});
