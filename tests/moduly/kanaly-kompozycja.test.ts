import {it,expect,vi,afterEach} from 'vitest';
import {createModulKanaly} from '../../src/moduly/kanaly/modul.ts';
import {openOmsDb} from '../../src/oms/db/db.ts';
import {zapiszTokeny} from '../../src/oms/db/tokeny.js';
import {zbudujAplikacje} from '../../src/core/aplikacja.ts';
import {modulRdzen} from '../../src/moduly/rdzen/modul.ts';
import type {ModulOms} from '../../src/core/kontrakty.ts';

afterEach(()=>vi.unstubAllGlobals());
const definicje=[{klucz:'polnoc',typ:'woo',prefiks:'SKLEP_POLNOC'},{klucz:'poludnie',typ:'woo',prefiks:'SKLEP_POLUDNIE'}] as const;
const mapa=JSON.stringify({instancje:{1:{metoda:'dpd'}},poPozycji:[]});
const env={SKLEP_POLNOC_URL:'https://polnoc.invalid',SKLEP_POLNOC_CK:'fikcyjny',SKLEP_POLNOC_CS:'fikcyjny',SKLEP_POLNOC_MAPOWANIE:mapa,SKLEP_POLNOC_OD:'2026-01-01',
 SKLEP_POLUDNIE_URL:'https://poludnie.invalid',SKLEP_POLUDNIE_CK:'fikcyjny',SKLEP_POLUDNIE_CS:'fikcyjny',SKLEP_POLUDNIE_MAPOWANIE:mapa,SKLEP_POLUDNIE_OD:'2026-08-01'};
const zam=(id:number,data:string)=>({id,number:String(id),status:'processing',total:'10.00',date_created_gmt:data,date_modified_gmt:'2026-09-01T10:00:00',
 billing:{},shipping:{},shipping_lines:[{method_id:'flat_rate',instance_id:'1'}],line_items:[],meta_data:[]});
function buduj(m:ReturnType<typeof createModulKanaly>,db:ReturnType<typeof openOmsDb>,konfiguracja:ReturnType<typeof m.konfiguracja>,log:(...tekst:string[])=>void=()=>{}){
 return m.zbuduj({db,konfiguracja,teraz:()=>new Date(),log,usluga:()=>{throw Error('Brak usługi ustawienia.widokIntegracji');}});
}
it('dwa prawdziwe klienty Woo: awaria pierwszego nie blokuje zapisu drugiego, każdy ma własne OD',async()=>{
 const api=vi.fn(async(input:any)=>{
  const url=new URL(String(input));
  if(url.hostname==='polnoc.invalid')return new Response('{"message":"awaria pierwszego"}',{status:500});
  return new Response(JSON.stringify([zam(1,'2026-07-01T10:00:00'),zam(2,'2026-09-01T10:00:00')]),{headers:{'X-WP-TotalPages':'1'}});
 });vi.stubGlobal('fetch',api);
 const db=openOmsDb();
 try{
  const m=createModulKanaly(definicje),log=vi.fn();const z=buduj(m,db,m.konfiguracja(env),log);
  await expect(z.zegary![0].przebieg()).resolves.toBeUndefined();
  expect(log.mock.calls).toEqual([['poller:','Sklep odpowiedział 500: awaria pierwszego']]);
  expect(db.prepare('SELECT sklep,numer,kwota_brutto FROM zamowienia').all()).toEqual([{sklep:'poludnie',numer:'2',kwota_brutto:'10.00'}]);
  const urls=api.mock.calls.map(([u])=>new URL(String(u)));
  expect(urls.map(u=>[u.hostname,u.searchParams.get('modified_after')])).toEqual([['polnoc.invalid','2026-01-01T00:00:00'],['poludnie.invalid','2026-08-01T00:00:00']]);
  expect(db.prepare("SELECT ostatni_blad FROM stan_pollera WHERE sklep='polnoc'").get()).toMatchObject({ostatni_blad:expect.stringContaining('awaria pierwszego')});
  expect(db.prepare("SELECT zsynchronizowane_do,ostatni_blad FROM stan_pollera WHERE sklep='poludnie'").get()).toMatchObject({zsynchronizowane_do:'2026-09-01T10:00:00',ostatni_blad:null});
 }finally{db.close();}
});
it('rzeczywisty zegar doczepia pobieranie zdjęć Allegro także po błędzie Woo',async()=>{
 const api=vi.fn(async(input:any)=>{
  const url=new URL(String(input));
  if(url.hostname==='polnoc.invalid')return new Response('{"message":"awaria pierwszego"}',{status:500});
  if(url.pathname==='/order/checkout-forms')return new Response('{"checkoutForms":[],"count":0,"totalCount":0}');
  if(url.pathname==='/sale/product-offers/oferta-1')return new Response('{"images":["https://img.invalid/produkt.jpg"]}');
  throw Error(`Nieoczekiwane API: ${url.pathname}`);
 });vi.stubGlobal('fetch',api);const db=openOmsDb();
 try{
  db.exec("INSERT INTO zamowienia(id,sklep,zrodlo_id,numer,kwota_brutto,utworzone_at) VALUES(1,'rynek',1,'A-1','10.00','2026-09-01'); INSERT INTO pozycje(zamowienie_id,oferta_id,nazwa,ilosc,cena_brutto) VALUES(1,'oferta-1','Produkt',1,'10.00')");
  zapiszTokeny(db,'rynek',{accessToken:'fikcyjny',refreshToken:'fikcyjny-refresh',wygasaAt:'2099-01-01',refreshWygasaAt:'2099-01-01'});
  const m=createModulKanaly([definicje[0],{klucz:'rynek',typ:'allegro',prefiks:'RYNEK'}]);
  const log=vi.fn();const z=buduj(m,db,m.konfiguracja({...env,RYNEK_CLIENT_ID:'fikcyjny',RYNEK_CLIENT_SECRET:'fikcyjny',RYNEK_USER_AGENT:'Fixture/1.0 (+https://fixture.invalid)',RYNEK_OD:'2026-05-01',RYNEK_API:'https://rynek.invalid'}),log);
  await expect(z.zegary![0].przebieg()).resolves.toBeUndefined();
  expect(log.mock.calls).toEqual([['poller:','Sklep odpowiedział 500: awaria pierwszego']]);
  expect(db.prepare("SELECT zdjecie_url,blad FROM zdjecia_ofert WHERE oferta_id='oferta-1'").get()).toMatchObject({zdjecie_url:'https://img.invalid/produkt.jpg',blad:null});
  const url=new URL(String(api.mock.calls.find(([u])=>String(u).includes('/order/checkout-forms'))![0]));
  expect(url.searchParams.get('lineItems.boughtAt.gte')).toContain('2026-05-01');
 }finally{db.close();}
});
it('z.trasy rejestruje endpoint i używa renderera ustawień dla rzeczywistego braku kanałów',async()=>{
 const db=openOmsDb();const renderer=vi.fn((_req,reply,d)=>reply.send(d));
 const provider:ModulOms<null>={nazwa:'ustawienia',wersja:'1.0.0',wymaga:['rdzen'],migracje:[],menu:[],uprawnienia:[],konfiguracja:()=>null,
  zbuduj:()=>({uslugi:{widokIntegracji:renderer}})};
 let a:Awaited<ReturnType<typeof zbudujAplikacje>>|undefined;
 try{
  a=await zbudujAplikacje({db,moduly:[modulRdzen,createModulKanaly([]),provider] as ModulOms[],
   env:{OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000'}});
  const r=await a.app.inject({method:'POST',url:'/ustawienia/kanaly/rynek/wiazanie'});
  expect(r.statusCode).toBe(503);expect(r.json()).toEqual({blad:'Panel nie ma podpiętych kanałów Allegro.'});
  expect(a.usluga('kanaly','wiazanieKanalow')).toBeNull();expect(a.usluga('ustawienia','widokIntegracji')).toBe(renderer);
  expect(renderer).toHaveBeenCalledOnce();expect(renderer.mock.calls[0][2]).toEqual({blad:'Panel nie ma podpiętych kanałów Allegro.'});
 }finally{await a?.app.close();db.close();}
});
it.each([false,true])('jawny brak PRZ-032 w prawdziwej kompozycji rdzen+kanaly, skonfigurowane Allegro=%s',async(allegro)=>{
 const db=openOmsDb();let aplikacja:Awaited<ReturnType<typeof zbudujAplikacje>>|undefined;
 try{
  const m=createModulKanaly(allegro?[{klucz:'rynek',typ:'allegro',prefiks:'RYNEK'}]:[]);
  aplikacja=await zbudujAplikacje({db,moduly:[modulRdzen,m] as ModulOms[],env:{OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',
   ...(allegro?{RYNEK_CLIENT_ID:'fikcyjny',RYNEK_CLIENT_SECRET:'fikcyjny',RYNEK_USER_AGENT:'Fixture/1.0 (+https://fixture.invalid)',RYNEK_OD:'2026-01-01'}:{})}});
  const r=await aplikacja.app.inject({method:'POST',url:'/ustawienia/kanaly/nieznany/wiazanie'});
  expect(r.statusCode).toBe(503);
  expect(r.json()).toEqual({blad:'Widok ustawień integracji jest niedostępny.'});
  expect(r.body).not.toContain('ustawienia.widokIntegracji');
  expect(r.body).not.toContain('Usługa');expect(r.body).not.toContain('nie jest zbudowany');
 }finally{await aplikacja?.app.close();db.close();}
});
