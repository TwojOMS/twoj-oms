// PRZ-157.11b: kroki 3 (metody dostawy) i 4 (nadawanie Przesyłek Erli) konfiguratora ERLI — na atrapie, bez sieci.
import {afterEach,expect,it} from 'vitest';
import {zbudujAplikacje,type Aplikacja} from '../../../src/core/aplikacja.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {modulyPiaskownicy} from '../../../deploy/proba/atrapy/index.mjs';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {zalozKonto} from '../../../src/core/bezpieczenstwo/konta.js';
import {podpisz} from '../../../src/core/bezpieczenstwo/sesja.js';
import {wczytajSekret} from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import {konfiguracjaKanalow} from '../../../src/moduly/kanaly/konfiguracja.ts';
import type {ModulOms} from '../../../src/core/kontrakty.ts';
import {transportErliPiaskownicy} from '../../../deploy/proba/atrapy/erli.mjs';
import {drogaErliDlaZamowienia} from '../../../src/moduly/kanaly/services/kanal-erli.ts';
import {createErliClient} from '../../../src/oms/erli/client.js';
const root='/ustawienia/integracje/erli',produkcja='https://erli.pl/svc/shop-api',klucz='atrapa-polcien';
const OSTRZEZENIE='zamówienia z tą metodą zatrzymają się przed nadaniem';
let a:Aplikacja,db:ReturnType<typeof openOmsDb>;
afterEach(async()=>{await a?.app.close();db?.close();});
// klienciKanalow: dziś mapa klientów kanałów (kompozycja) daje tylko Allegro — klienta ERLI podaje test.
type Opcje={zPliku?:boolean;bezMetodErli?:boolean;idMetody?:string;klienciKanalow?:Record<string,unknown>};
async function setup({zPliku=false,bezMetodErli=false,idMetody,klienciKanalow}:Opcje={}){
 const env={OMS_TRYB:'proba',OMS_KANALY:'[]',OMS_USER:'serwis',OMS_PASS:'fixture',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:'/srv/praca/kierownik-petla/tmp/157-12l/proformy',OMS_ETYKIETY_KATALOG:'/srv/praca/kierownik-petla/tmp/157-12l/etykiety'};
 const definicje=zPliku?[{klucz:'z-pliku',typ:'erli' as const,prefiks:'POLCIEN',etykieta:'Pracownia Półcień'}]:[];
 const zapytania:{url:string;metoda:string;body:string}[]=[];
 const atrapa=(u:any,i?:RequestInit)=>transportErliPiaskownicy({baza:()=>db,env,log:()=>{}})(u,i);
 const fetchImpl=async(u:any,i?:RequestInit)=>{
  const url=String(u),p=new URL(url).pathname;zapytania.push({url,metoda:i?.method??'GET',body:typeof i?.body==='string'?i.body:''});
  if(idMetody&&p.endsWith('/delivery/priceListsDetails'))return Response.json([{prices:[{deliveryMethod:{id:idMetody}}]}]);
  if(idMetody&&p.endsWith('/dictionaries/deliveryMethods'))return Response.json([{id:idMetody,name:'Dostawa Półcień',vendor:'ownTransport'}]);
  if(p.endsWith('/shipping/postingPoints'))return Response.json([
   {id:1,name:'Pracownia Półcień',companyName:'Pracownia Półcień',street:'Zmyślona',buildingNumber:'1',zip:'00-001',city:'Warszawa',isDefault:true,type:'address'},
   {id:7,name:'Magazyn Półcień',companyName:'Pracownia Półcień',street:'Cienista',buildingNumber:'7',zip:'00-002',city:'Warszawa',isDefault:false,type:'address'}]);
  if(bezMetodErli&&p.endsWith('/delivery/priceListsDetails'))return Response.json([{id:1,name:'Dostawy Półcień',prices:['dpd','paczkomat','dostawaPrzezSprzedajacego'].map(id=>({deliveryMethod:{id},basePrice:1000,nextItemPrice:0}))}]);
  return atrapa(u,i);
 };
 const m=createModulKanaly(definicje,false,{fetchImpl});
 const config=konfiguracjaKanalow(definicje,zPliku?{...env,POLCIEN_KLUCZ_API:klucz,POLCIEN_ADRES_API:produkcja,POLCIEN_OD:'2026-11-01'}:env);
 db=openOmsDb();a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?{...m,konfiguracja:()=>config}:x) as ModulOms[],env,teraz:()=>new Date('2026-11-11T12:00:00Z'),log:()=>{},nadpisania:klienciKanalow?{'kanaly.klienciKanalow':klienciKanalow}:undefined});
 zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
 const cookie='sesja_oms_proba='+podpisz('admin',wczytajSekret(db),Date.now());
 const panel=(method:'GET'|'POST',url:string,payload?:Record<string,unknown>)=>a.app.inject({method,url,payload,headers:{accept:'text/html',cookie,origin:'http://localhost'}});
 const req=(method:'GET'|'POST',path:string,payload?:Record<string,unknown>)=>panel(method,root+path,payload);
 const row=()=>db.prepare("SELECT * FROM kanaly_sprzedazy WHERE typ='erli' ORDER BY rowid").get()!;
 const post=(p:string,op:string,d:Record<string,unknown>={})=>req('POST',p+'/'+op,{wersja:row().wersja,...d});
 async function polaczony(){
  const r=await req('POST','/nowe/dane',{nazwa:'Pracownia Półcień',adresApi:produkcja,kluczApi:klucz,domyslnyCzasWysylki:'3',wersja:0});
  expect(r.statusCode).toBe(303);const p=String(r.headers.location).slice(root.length).split('?')[0];
  expect((await post(p,'sprawdz')).statusCode).toBe(200);
  return p;
 }
 const wiersz=(html:string,id:string)=>(html.match(/<tr id="erli-metoda-[^"]*"[\s\S]*?<\/tr>/g)??[]).find(w=>w.includes(`<small>${id}</small>`)||w.includes(`<th scope="row">${id}<`))??'';
 const zamowienie=(typeId:string)=>(db.prepare('SELECT * FROM zamowienia WHERE sklep=?').all(row().klucz) as any[]).find(z=>JSON.parse(z.surowe_json).delivery?.typeId===typeId);
 return {req,panel,post,row,polaczony,wiersz,zamowienie,zapytania,fetchImpl};
}

it('pominięcie metod prowadzi do daty startu, ma audyt i pozwala później zapisać metody',async()=>{
 const f=await setup(),p=await f.polaczony();
 const przed=await f.req('GET',p);
 expect(przed.body).toMatch(/<form[^>]*action="[^"]*\/pomin-metody"[\s\S]*?<button[^>]*class="btn">Pomiń — ustawię metody później<\/button>/);
 expect(przed.body).toContain('Bez tego kroku OMS nada Przesyłki Erli z domyślną paczką i punktem z ERLI');
 expect((await f.post(p,'pomin-metody',{wersja:Number(f.row().wersja)-1})).statusCode).toBe(409);
 const wersja=Number(f.row().wersja),generacja=f.row().generacja;
 expect((await f.post(p,'pomin-metody')).statusCode).toBe(303);
 expect(f.row().wersja).toBe(wersja+1);expect(f.row().generacja).toBe(generacja);
 expect(a.usluga<any>('kanaly','sklepyErli').pobierz(f.row().klucz).ustawienia.metodyPominiete).toBe(true);
 expect(db.prepare("SELECT operacja FROM kanaly_audit WHERE operacja='pomin-metody'").get()).toBeTruthy();
 let ekran=await f.req('GET',p);
 expect(ekran.body.match(/<li[^>]*aria-current="step"[\s\S]*?<\/li>/)?.[0]).toContain('Start');
 expect(ekran.body).not.toContain('Nadawanie Przesyłek Erli');expect(ekran.body).toContain('>Aktywuj</button>');
 expect((await f.post(p,'pobierz-metody')).statusCode).toBe(303);
 expect((await f.post(p,'metody')).statusCode).toBe(303);
 ekran=await f.req('GET',p);expect(ekran.body).toContain('id="erli-nadawanie"');
 expect(ekran.body.match(/<li[^>]*aria-current="step"[\s\S]*?<\/li>/)?.[0]).toContain('Nadawanie Przesyłek Erli');
});
it('nie pozwala pominąć metod przed sprawdzeniem połączenia',async()=>{
 const f=await setup(),p=await f.polaczony();await f.post(p,'odlacz',{potwierdz:'tak'});
 expect((await f.post(p,'pomin-metody')).statusCode).toBe(409);
});
it('krok 3: metody z cennika sklepu, metoda bez kuriera ostrzega, HTML bez klucza',async()=>{
 const f=await setup(),p=await f.polaczony();
 expect((await f.post(p,'pobierz-metody')).statusCode).toBe(303);
 const r=await f.req('GET',p);
 expect(r.statusCode).toBe(200);
 expect(f.wiersz(r.body,'erliPaczkomat')).toContain('Przesyłki Erli (umowa ERLI)');
 expect(f.wiersz(r.body,'erliPaczkomat')).not.toContain(OSTRZEZENIE);
 expect(f.wiersz(r.body,'dpd')).toContain('Twoja umowa');
 expect(f.wiersz(r.body,'dpd')).not.toContain(OSTRZEZENIE);
 expect(f.wiersz(r.body,'dostawaPrzezSprzedajacego')).toContain(OSTRZEZENIE);
 expect(r.body+JSON.stringify(r.headers)).not.toContain(klucz);
 expect(String(db.prepare("SELECT ustawienia_json FROM konfiguracja_integracji WHERE integracja LIKE 'erli:%'").get()!.ustawienia_json)).not.toContain(klucz);
});

it('zapis kroku 3 zmienia drogę nadania zamówienia z tą metodą od razu, bez restartu',async()=>{
 const f=await setup(),p=await f.polaczony();
 await f.post(p,'pobierz-metody');
 expect((await f.post(p,'aktywuj')).statusCode).toBe(303);
 await a.usluga<any>('kanaly','rejestrKanalow').przebiegZamowien();
 const z=f.zamowienie('dpd');expect(z).toBeTruthy();
 expect(drogaErliDlaZamowienia(db,z)).toMatchObject({droga:'umowa',kurier:'dpd'});
 expect((await f.post(p,'metody',{'kurier:dpd':'brak'})).statusCode).toBe(303);
 expect(drogaErliDlaZamowienia(db,z)).toMatchObject({droga:'blokada'});
 expect(f.wiersz((await f.req('GET',p)).body,'dpd')).toContain(OSTRZEZENIE);
 expect((await f.post(p,'metody',{'kurier:dpd':'inpost_paczkomat'})).statusCode).toBe(303);
 expect(drogaErliDlaZamowienia(db,z)).toMatchObject({droga:'umowa',kurier:'inpost_paczkomat'});
 expect((await f.post(p,'metody',{'kurier:dpd':''})).statusCode).toBe(303);
 expect(drogaErliDlaZamowienia(db,z)).toMatchObject({droga:'umowa',kurier:'dpd'});
 // Wartość spoza listy i kurier dla metody Przesyłek Erli są odrzucane bez zapisu.
 const wersja=f.row().wersja;
 expect((await f.post(p,'metody',{'kurier:dpd':'dhl'})).statusCode).toBe(400);
 expect((await f.post(p,'metody',{'kurier:erliPaczkomat':'dpd'})).statusCode).toBe(400);
 expect(f.row().wersja).toBe(wersja);
});

it('krok 4 jest pomijany, gdy sklep nie ma metody Przesyłek Erli',async()=>{
 const f=await setup({bezMetodErli:true}),p=await f.polaczony();
 await f.post(p,'pobierz-metody');
 const r=await f.req('GET',p);
 expect(r.body).toContain('id="erli-metody"');
 expect(r.body).not.toContain('id="erli-nadawanie"');
 expect(r.body).not.toContain('Nadawanie Przesyłek Erli');
 expect((await f.post(p,'nadawanie',{punktNadania:'1',waga:'1',dlugosc:'30',szerokosc:'20',wysokosc:'10'})).statusCode).toBe(409);
});

it('krok 4: domyślny punkt zaznaczony, zapisany punkt trafia do kuriera Przesyłek Erli, wymiary do formularza nadania',async()=>{
 const klienci:Record<string,unknown>={};
 const f=await setup({klienciKanalow:klienci}),p=await f.polaczony();
 klienci[String(f.row().klucz)]=(createErliClient as (o:Record<string,unknown>)=>unknown)({adresApi:produkcja,kluczApi:klucz,fetchImpl:f.fetchImpl});
 await f.post(p,'pobierz-metody');
 expect((await f.post(p,'metody')).statusCode).toBe(303);
 let r=await f.req('GET',p);
 expect(r.body).toContain('id="erli-nadawanie"');
 expect(r.body).toMatch(/<input[^>]*id="erli-punkt-1"[^>]*checked/);
 expect(r.body).not.toMatch(/<input[^>]*id="erli-punkt-7"[^>]*checked/);
 expect((await f.post(p,'nadawanie',{punktNadania:'99',waga:'1',dlugosc:'30',szerokosc:'20',wysokosc:'10'})).statusCode).toBe(400);
 expect((await f.post(p,'nadawanie',{punktNadania:'7',waga:'0',dlugosc:'30',szerokosc:'20',wysokosc:'10'})).statusCode).toBe(400);
 expect((await f.post(p,'nadawanie',{punktNadania:'7',waga:'1,5',dlugosc:'31',szerokosc:'21',wysokosc:'11'})).statusCode).toBe(303);
 r=await f.req('GET',p);expect(r.body).toMatch(/<input[^>]*id="erli-punkt-7"[^>]*checked/);
 expect((await f.post(p,'aktywuj',{decyzjaOdczytu:'1'})).statusCode).toBe(303);
 await a.usluga<any>('kanaly','rejestrKanalow').przebiegZamowien();
 const z=f.zamowienie('erliPaczkomat');expect(z).toBeTruthy();
 const ekran=await f.panel('GET',`/zamowienia/${z.id}/nadaj`);
 expect(ekran.statusCode).toBe(200);
 expect(ekran.body).toMatch(/name="waga" value="1.5"/);expect(ekran.body).toMatch(/name="dlugosc" value="31"/);
 const kurier=a.usluga<any>('wysylka','kurierzy').erli_przesylki;
 await kurier.nadaj({zamowienie:z,paczka:{waga:1.5,dlugosc:31,szerokosc:21,wysokosc:11}});
 const utworz=f.zapytania.find(x=>x.metoda==='POST'&&/\/shipping\/parcels\/?$/.test(x.url));
 expect(JSON.parse(utworz!.body)[0].shipping).toMatchObject({typeId:'erliPaczkomat',postingPointId:7});
});

it.each(['pobierz-metody','metody','nadawanie','pomin-metody'])('sklep z pliku konfiguracji: %s odrzucone 409 bez zapytań do ERLI',async op=>{
 const f=await setup({zPliku:true});
 expect((await f.req('GET','/z-pliku')).statusCode).toBe(200);
 const r=await f.req('POST','/z-pliku/'+op,{wersja:0,'kurier:dpd':'brak',punktNadania:'1'});
 expect(r.statusCode).toBe(409);expect(r.body).toContain('ustawiony w pliku konfiguracji');
 expect(f.zapytania).toEqual([]);
});

it('aktywny sklep sprzed kroku metod pozostaje w stanie, a metody są dostępne do uzupełnienia',async()=>{
 const f=await setup(),p=await f.polaczony();
 expect((await f.post(p,'aktywuj')).statusCode).toBe(303);
 const r=await f.req('GET',p);
 expect(r.statusCode).toBe(200);
 // PRZ-157.12u: aktywny sklep ma ekran zarządzania bez paska kroków; metody czekają w zwiniętej sekcji.
 expect(r.body).not.toContain('class="stepper"');
 expect(r.body).toMatch(/<details class="erli-krok" id="erli-krok-metody">\s*<summary>Metody dostawy — nieustawione[\s\S]*?id="erli-metody"[\s\S]*?>Pobierz metody dostawy<\/button>[\s\S]*?<\/details>/);
 // Połączenie jest sprawdzone, więc wskazówka „Najpierw sprawdź połączenie…” znika (punkt D planu).
 expect(r.body).not.toContain('Najpierw sprawdź połączenie');
});

it('aktywny sklep po odłączeniu wraca do kroku połączenia, a nie do stanu',async()=>{
 const f=await setup(),p=await f.polaczony();
 expect((await f.post(p,'aktywuj')).statusCode).toBe(303);
 expect((await f.post(p,'odlacz',{potwierdz:'tak'})).statusCode).toBe(303);
 const r=await f.req('GET',p);
 expect(r.body.match(/<li[^>]*aria-current="step"[\s\S]*?<\/li>/)?.[0]).toContain('Sprawdź połączenie');
});

it.each(['Dostawa.V2','dostawa z punktem','METODA'])('metoda %s jest widoczna i zapisywana, z bezpiecznymi id HTML',async id=>{
 const f=await setup({idMetody:id}),p=await f.polaczony();
 expect((await f.post(p,'pobierz-metody')).statusCode).toBe(303);
 let r=await f.req('GET',p);
 let w=f.wiersz(r.body,id);
 expect(w).toContain('Dostawa Półcień');
 expect(w).toContain('id="erli-metoda-0"');
 expect(w).toContain('<label for="erli-kurier-0">');
 expect(w).toContain(`id="erli-kurier-0" name="kurier:${id}" aria-describedby="erli-kurier-0-uwaga"`);
 expect(w).toContain('id="erli-kurier-0-uwaga"');
 // Rzeczywisty formularz urlencoded: spacja i kropka w nazwie pola przechodzą parser trasy.
 const response=await a.app.inject({method:'POST',url:root+p+'/metody',
  headers:{'content-type':'application/x-www-form-urlencoded',cookie:'sesja_oms_proba='+podpisz('admin',wczytajSekret(db),Date.now()),origin:'http://localhost'},
  payload:new URLSearchParams({wersja:String(f.row().wersja),['kurier:'+id]:'dpd'}).toString()});
 expect(response.statusCode).toBe(303);
 r=await f.req('GET',p);w=f.wiersz(r.body,id);
 expect(w).toContain('<option value="dpd" selected>');
 expect(w).not.toContain(OSTRZEZENIE);
 const zapis=db.prepare("SELECT ustawienia_json FROM konfiguracja_integracji WHERE integracja=?").get('erli:'+f.row().klucz)!;
 expect(JSON.parse(String(zapis.ustawienia_json)).mapaMetod).toEqual({[id]:'dpd'});
});
