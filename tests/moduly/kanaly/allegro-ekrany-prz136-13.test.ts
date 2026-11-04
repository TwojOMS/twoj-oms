// PRZ-136.13: ekran konta Allegro i kreator mówią tym samym językiem co lista „Moje połączenia”.
import {afterEach,expect,it} from 'vitest';
import {zbudujAplikacje,type Aplikacja} from '../../../src/core/aplikacja.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {modulyPiaskownicy,nadpisaniaPiaskownicy} from '../../../deploy/proba/atrapy/index.mjs';
import {KANALY} from '../../../scripts/demo-dane-firma.mjs';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {zalozKonto} from '../../../src/core/bezpieczenstwo/konta.js';
import {podpisz} from '../../../src/core/bezpieczenstwo/sesja.js';
import {wczytajSekret} from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import {scopesAllegro} from '../../pomoc/allegro-konfigurator.ts';
import type {ModulOms} from '../../../src/core/kontrakty.ts';

const root='/ustawienia/integracje/allegro';
let a:Aplikacja,db:ReturnType<typeof openOmsDb>;
afterEach(async()=>{await a?.app.close();db?.close();});

/** atrapa: konto „allegro” z pliku konfiguracji demo (bez tokenów), z nadpisaniami usług jak w piaskownicy. */
async function setup(atrapa=false){
 let czas=new Date('2026-11-01T12:00:00Z');
 const http=async(u:string)=>{
  if(u.endsWith('/device'))return Response.json({device_code:'DEVICE-POLCIEN',user_code:'POLCIEN-123',verification_uri:'https://allegro.pl/skojarz',expires_in:600,interval:5});
  if(u.endsWith('/token'))return Response.json({access_token:'ACCESS-POLCIEN',refresh_token:'REFRESH-POLCIEN',expires_in:3600,scope:scopesAllegro.join(' ')});
  if(u.endsWith('/me'))return Response.json({id:'1000001',login:'polcien_test'});
  if(u.includes('/order/checkout-forms?'))return Response.json({checkoutForms:[],totalCount:0});
  throw Error('Nieoczekiwane API');
 };
 const env={OMS_USER:'serwis',OMS_PASS:'fixture',OMS_TRYB:'proba',OMS_KANALY:atrapa?JSON.stringify(KANALY):'[]',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:'/tmp/prz13613-proformy',OMS_ETYKIETY_KATALOG:'/tmp/prz13613-etykiety'};
 db=openOmsDb();
 if(atrapa){
  // Okablowanie jak w piaskownicy (uruchomPiaskownice): atrapy kanałów przychodzą nadpisaniami usług, nie z env.
  a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env) as ModulOms[],env,nadpisania:nadpisaniaPiaskownicy({db,env,log:()=>{}}),teraz:()=>czas,log:()=>{}});
 }else{
  const m=createModulKanaly([],false,{fetchImpl:u=>http(String(u)),autoryzacjaAtrapy:{http,softwareStatementId:'',redirectUri:'http://localhost'+root+'/oauth/powrot',userAgent:'Fixture/1 (+https://example.invalid)'}});
  a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?m:x) as ModulOms[],env,teraz:()=>czas,log:()=>{}});
 }
 zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
 const cookie='sesja_oms_proba='+podpisz('admin',wczytajSekret(db),Date.now());let flow='';
 async function req(method:'GET'|'POST',url:string,payload?:Record<string,unknown>){
  const r=await a.app.inject({method,url,headers:{accept:'text/html',cookie:cookie+'; '+flow,...(method==='POST'?{origin:'http://localhost'}:{})},payload});
  const c=[r.headers['set-cookie']??[]].flat().find(c=>c.startsWith('oms_allegro_flow='));if(c)flow=c.split(';')[0];
  return r;
 }
 if(!atrapa)expect((await req('POST',root+'/aplikacja-urzadzenia',{srodowisko:'produkcja',clientId:'polcien-id',clientSecret:'SECRET-POLCIEN'})).statusCode).toBe(200);
 const repo=a.usluga<any>('kanaly','repozytoriumKanalow');
 const post=(k:string,akcja:string,dane:Record<string,unknown>={})=>req('POST',root+'/'+k+'/'+akcja,{wersja:String(repo.pobierz(k).wersja),...dane});
 async function polaczone(){
  const page=await req('GET',root+'/nowe');const formularzId=page.body.match(/name="formularzId" value="([^"]+)"/)![1];
  const r=await req('POST',root+'/szkice',{formularzId,nazwa:'Allegro Półcień',od:'2026-11-01',srodowisko:'produkcja'});
  const k=r.headers.location!.split('/').pop()!;
  const start=await post(k,'autoryzacja');const probaId=start.body.match(/name="probaId" value="([^"]+)"/)![1];
  czas=new Date(czas.getTime()+6000);await post(k,'zgoda',{probaId});
  expect((await post(k,'potwierdz',{probaId})).statusCode).toBe(303);
  expect((await post(k,'aktywuj',{probaId,potwierdz:'tak',pobieraj:'nie'})).statusCode).toBe(303);
  expect(repo.pobierz(k).autoryzacja).toBe('polaczone');
  return k;
 }
 return {req,polaczone,ustawCzas:(d:Date)=>{czas=d;}};
}
/** Etykieta stanu wiersza listy „Moje połączenia” dla danego konta. */
async function stanNaLiscie(req:(m:'GET',u:string)=>Promise<any>,klucz:string){
 const r=await req('GET','/ustawienia/integracje');expect(r.statusCode).toBe(200);
 const wiersz=r.body.split('<li class="pol-wiersz').find((w:string)=>w.includes(root+'/'+klucz+'"')||w.includes('Allegro Półcień'));
 expect(wiersz).toBeTruthy();
 return wiersz.match(/class="pol-kropka" aria-hidden="true"><\/span>([^<]+)<\/span>/)![1];
}
const stanNaEkranie=(html:string)=>html.match(/data-stan-konta>([^<]+)</)?.[1];

it('kreator: powrót do „Moje połączenia”, zakładka „Dodaj integrację”, bez powtórzonej listy kont',async()=>{
 const f=await setup();const k=await f.polaczone();
 const r=await f.req('GET',root+'/nowe');expect(r.statusCode).toBe(200);
 expect(r.body).toContain('<a href="/ustawienia/integracje">← Moje połączenia</a>');
 expect(r.body).not.toContain('← Integracje');
 expect(r.body).toMatch(/href="\/ustawienia\/integracje\/katalog" aria-current="page">Dodaj integrację/);
 expect(r.body).not.toContain('<h2>Połączenia Allegro</h2>');
 expect(r.body).not.toContain('href="'+root+'/'+k+'"');
});

it('konto połączone: link do listy, bez kroków, stan jak na liście, data „dziś”, tytuł = nazwa konta',async()=>{
 const f=await setup();const k=await f.polaczone();
 // PRZ-146.06: aktywacja sama robi test połączenia — nadpisujemy jego wpis znanym czasem.
 db.prepare('INSERT OR REPLACE INTO kanaly_diagnostyka (kanal,ostatnia_proba_at,ostatni_sukces_at,blad) VALUES (?,?,?,0)').run(k,'2026-11-01T12:00:00Z','2026-11-01T12:00:00Z');
 f.ustawCzas(new Date('2026-11-01T15:30:00Z'));
 const r=await f.req('GET',root+'/'+k);expect(r.statusCode).toBe(200);
 expect(r.body).toContain('<a href="/ustawienia/integracje">← Moje połączenia</a>');
 expect(r.body).not.toContain('Połączenia Allegro</a>');
 expect(r.body).not.toContain('aria-label="Kroki konfiguracji"');
 const lista=await stanNaLiscie(f.req,k);expect(lista).toBe('Działa');
 expect(stanNaEkranie(r.body)).toBe(lista);
 expect(r.body).toContain('dziś 13:00');
 expect(r.body).not.toMatch(/2026-11-01 13:00:\d\d/);
 expect(r.body).toMatch(/<title>Allegro Półcień(\s|<| —)/);
 expect(r.body).not.toContain('<title>Allegro — ');
 // PRZ-141.01 (N12, N7): link do drugiego konta stoi w karcie „Połączenie” z opisem, wstęp stanu bez pogrubienia z klasy.
 expect(r.body).toMatch(/<section class="ust-sekcja">\s*<h2>Połączenie<\/h2>[\s\S]*?class="allegro-kolejne">[^<]*<a href="[^"]*\/nowe">Podłącz kolejne konto Allegro<\/a>[\s\S]*?<\/p>\s*<\/section>/);
 expect(r.body).not.toMatch(/<\/section>\s*<p><a href="[^"]*\/nowe">/);
 expect(r.body).toContain('<p class="ust-wstep"><strong data-stan-konta>');
});

it('konto z pliku konfiguracji piaskownicy: bez kroków, stan jak na liście, bez „z konfiguracji”',async()=>{
 const f=await setup(true);
 const r=await f.req('GET',root+'/allegro');expect(r.statusCode).toBe(200);
 expect(r.body).not.toContain('aria-label="Kroki konfiguracji"');
 const lista=await stanNaLiscie(f.req,'allegro');
 expect(stanNaEkranie(r.body)).toBe(lista);
 expect(r.body).not.toContain('Niepołączone');
 expect(r.body.slice(r.body.indexOf('<div class="allegro-konfiguracja">')).match(/.{0,120}(z konfiguracji|z pliku konfiguracji).{0,40}/)?.[0]).toBeUndefined();
});
