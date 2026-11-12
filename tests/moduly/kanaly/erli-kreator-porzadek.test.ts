// PRZ-157.12u: kreator ERLI krok po kroku — jeden rozwinięty krok naraz, ostatni krok „Start”, ekran aktywnego sklepu.
// Na atrapie ERLI, bez sieci; dane zmyślone (Pracownia Półcień).
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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Katalog roboczy w os.tmpdir(), nie na jednej maszynie (CI kopii publicznej 12.11.2026).
const KATALOG_TESTU=fs.mkdtempSync(path.join(os.tmpdir(),'erli-kreator-porzadek-'));
const root='/ustawienia/integracje/erli',sandbox='https://sandbox.erli.dev/svc/shop-api',klucz='atrapa-polcien';
const KOLEJNOSC=['dane','polaczenie','metody','nadawanie','start'];
let a:Aplikacja,db:ReturnType<typeof openOmsDb>;
afterEach(async()=>{await a?.app.close();db?.close();});
type Opcje={bezMetodErli?:boolean;bezNazw?:boolean;odmowa?:boolean;zPliku?:boolean};
async function setup({bezMetodErli=false,bezNazw=false,odmowa=false,zPliku=false}:Opcje={}){
 const env={OMS_TRYB:'proba',OMS_KANALY:'[]',OMS_USER:'serwis',OMS_PASS:'fixture',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:path.join(KATALOG_TESTU,'proformy'),OMS_ETYKIETY_KATALOG:path.join(KATALOG_TESTU,'etykiety')};
 const definicje=zPliku?[{klucz:'z-pliku',typ:'erli' as const,prefiks:'POLCIEN',etykieta:'Pracownia Półcień'}]:[];
 const stan={odmowa};
 const atrapa=(u:any,i?:RequestInit)=>transportErliPiaskownicy({baza:()=>db,env,log:()=>{}})(u,i);
 const fetchImpl=async(u:any,i?:RequestInit)=>{
  const p=new URL(String(u)).pathname;
  if(stan.odmowa)return Response.json({message:'odmowa'},{status:401});
  if(bezMetodErli&&p.endsWith('/delivery/priceListsDetails'))return Response.json([{id:1,name:'Dostawy Półcień',prices:['dpd','paczkomat','dostawaPrzezSprzedajacego'].map(id=>({deliveryMethod:{id},basePrice:1000,nextItemPrice:0}))}]);
  if(bezNazw&&p.endsWith('/dictionaries/deliveryMethods')){const r=await atrapa(u,i);return Response.json((await r.json() as any[]).map(({name:_,...m})=>m));}
  return atrapa(u,i);
 };
 const m=createModulKanaly(definicje,false,{fetchImpl});
 const config=konfiguracjaKanalow(definicje,zPliku?{...env,POLCIEN_KLUCZ_API:klucz,POLCIEN_ADRES_API:sandbox,POLCIEN_OD:'2026-11-01'}:env);
 db=openOmsDb();a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?{...m,konfiguracja:()=>config}:x) as ModulOms[],env,teraz:()=>new Date('2026-11-11T12:00:00Z'),log:()=>{}});
 zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
 const cookie='sesja_oms_proba='+podpisz('admin',wczytajSekret(db),Date.now());
 const req=(method:'GET'|'POST',path:string,payload?:Record<string,unknown>)=>a.app.inject({method,url:root+path,payload,headers:{accept:'text/html',cookie,origin:'http://localhost'}});
 const row=(n=0)=>(db.prepare("SELECT * FROM kanaly_sprzedazy WHERE typ='erli' ORDER BY rowid").all() as any[])[n];
 const post=(p:string,op:string,d:Record<string,unknown>={})=>req('POST',p+'/'+op,{wersja:db.prepare('SELECT wersja FROM kanaly_sprzedazy WHERE klucz=?').get(p.slice(1))!.wersja,...d});
 async function szkic(nazwa='Pracownia Półcień'){
  const r=await req('POST','/nowe/dane',{nazwa,adresApi:sandbox,kluczApi:klucz,domyslnyCzasWysylki:'3',wersja:0});
  expect(r.statusCode).toBe(303);return {p:String(r.headers.location).slice(root.length).split('?')[0],location:String(r.headers.location)};
 }
 const get=async(p:string)=>{const r=await req('GET',p);expect(r.statusCode).toBe(200);return r.body;};
 return {req,post,row,szkic,get,stan};
}
const bezDetails=(html:string)=>html.replace(/<details\b[\s\S]*?<\/details>/g,'');
/** Rozwinięte sekcje kroków: `section.ust-sekcja` poza `<details>`, z id nagłówka h2. */
const rozwiniete=(html:string)=>[...bezDetails(html).matchAll(/<section class="ust-sekcja"[^>]*>\s*<h2 id="erli-([^"]+)"/g)].map(m=>m[1]);
const wszystkieKroki=(html:string)=>[...html.matchAll(/<h2 id="erli-([^"]+)"/g)].map(m=>m[1]).filter(id=>KOLEJNOSC.includes(id));
const pasek=(html:string)=>html.match(/<ol class="stepper"[\s\S]*?<\/ol>/)?.[0]??'';
const biezacyWPasku=(html:string)=>pasek(html).match(/<li[^>]*aria-current="step"[\s\S]*?<\/li>/)?.[0]??'';
function jedenKrok(html:string,biezacy:string){
 expect(rozwiniete(html)).toEqual([biezacy]);
 for(const id of wszystkieKroki(html))expect(KOLEJNOSC.indexOf(id)).toBeLessThanOrEqual(KOLEJNOSC.indexOf(biezacy));
}

it('nowy sklep: tylko krok 1, pasek 5 kroków ze „Start” na końcu',async()=>{
 const f=await setup(),html=await f.get('/nowe');
 jedenKrok(html,'dane');
 expect([...pasek(html).matchAll(/class="step-dot"[^>]*>(\d)</g)].map(m=>m[1])).toEqual(['1','2','3','4','5']);
 expect(pasek(html)).toContain('5. Start');expect(pasek(html)).not.toContain('Data startu');
 expect(html).not.toContain('<details class="erli-krok"');
});
it('po zapisie kroku 1: krok 1 zwinięty z podsumowaniem, bieżące metody, bez napisu o sprawdzaniu połączenia',async()=>{
 const f=await setup(),{location}=await f.szkic();
 expect(location).toMatch(/\?polaczenie=ok$/);
 const html=await f.get(location.slice(root.length));
 jedenKrok(html,'metody');
 expect(html).toContain('Połączenie z ERLI działa — sklep pracownia-polcien');
 expect(html).toMatch(/<details class="erli-krok" id="erli-krok-dane">\s*<summary>1\. Nazwa, środowisko, klucz — Pracownia Półcień, sandbox, klucz zapisany<\/summary>/);
 expect(html).not.toContain('Najpierw sprawdź połączenie');
 expect(pasek(html)).toContain('<a href="#erli-krok-dane">1. Nazwa, środowisko, klucz</a>');
 expect(biezacyWPasku(html)).toContain('3. Metody dostawy');
 expect(html).toMatch(/<h2 id="erli-metody" tabindex="-1" autofocus>/);
 // Plan A: „Sprawdź ponownie” zostaje w rozwinięciu zwiniętego kroku 1.
 expect(html).toMatch(/id="erli-krok-dane">[\s\S]*?\/sprawdz"[\s\S]*?Sprawdź ponownie<\/button>[\s\S]*?<\/details>/);
});
it('błąd połączenia: rozwinięty tylko krok 2, krok 1 zwinięty z odnośnikiem do poprawy klucza',async()=>{
 const f=await setup({odmowa:true}),{location}=await f.szkic();
 expect(location).toMatch(/\?polaczenie=blad$/);
 const html=await f.get(location.slice(root.length));
 jedenKrok(html,'polaczenie');
 expect(html).toContain('Klucz zapisany, ale połączenie z ERLI nie działa.');
 expect(bezDetails(html)).not.toContain('id="erli-klucz"');
 expect(html).toContain('href="#erli-krok-dane"');
});
it('metody pobrane, niezapisane: „Pobierz ponownie” nad tabelą, „Pomiń” pod formularzem, nazwy metod zamiast identyfikatorów',async()=>{
 const f=await setup(),{p}=await f.szkic();
 const r=await f.post(p,'pobierz-metody');expect(r.headers.location).toBe(root+p+'?zapisano=pobierz-metody');
 const html=await f.get(p+'?zapisano=pobierz-metody');
 jedenKrok(html,'metody');
 expect(html).toContain('role="status"');expect(html).toContain('Pobrano metody dostawy z ERLI.');
 const iPonownie=html.indexOf('Pobierz metody ponownie'),iTabela=html.indexOf('action="'+root+p+'/metody"'),iPomin=html.indexOf('/pomin-metody"');
 expect(iPonownie).toBeGreaterThan(0);expect(iTabela).toBeGreaterThan(iPonownie);expect(iPomin).toBeGreaterThan(iTabela);
 expect(html).toMatch(/<th scope="row">Kurier DPD<br><small>dpd<\/small><\/th>/);
 expect(html).toMatch(/<th scope="row">Dostawa przez sprzedającego<br><small>dostawaPrzezSprzedajacego<\/small><\/th>/);
 expect(html).not.toContain('Najpierw sprawdź połączenie');
});
it('metoda bez nazwy z ERLI dostaje czytelną etykietę, identyfikator małym drukiem',async()=>{
 const f=await setup({bezNazw:true}),{p}=await f.szkic();await f.post(p,'pobierz-metody');
 const html=await f.get(p);
 expect(html).toMatch(/<th scope="row">Odbior osobisty<br><small>odbiorOsobisty<\/small><\/th>/);
 expect(html).not.toMatch(/<th scope="row">odbiorOsobisty</);
});
it('po zapisie metod: metody zwinięte z podsumowaniem, bieżące nadawanie, komunikat „zapisane”, bez „Pomiń”',async()=>{
 const f=await setup(),{p}=await f.szkic();await f.post(p,'pobierz-metody');
 const r=await f.post(p,'metody');expect(r.headers.location).toBe(root+p+'?zapisano=metody');
 const html=await f.get(p+'?zapisano=metody');
 jedenKrok(html,'nadawanie');
 expect(html).toContain('Metody dostawy zapisane.');expect(html).not.toContain('Połączenie z ERLI działa');
 expect(html).toContain('<summary>3. Metody dostawy — 6 metod: 2 Przesyłki Erli, 3 Twoja umowa, 1 bez kuriera ⚠</summary>');
 expect(html).not.toContain('/pomin-metody"');
 expect(html).toMatch(/<h2 id="erli-nadawanie" tabindex="-1" autofocus>/);
});
it('metody pominięte: od razu „Start”, bez kroku nadawania, podsumowanie „pominięte”',async()=>{
 const f=await setup(),{p}=await f.szkic();
 expect((await f.post(p,'pomin-metody')).headers.location).toBe(root+p+'?zapisano=pomin-metody');
 const html=await f.get(p+'?zapisano=pomin-metody');
 jedenKrok(html,'start');
 expect(html).toContain('<summary>3. Metody dostawy — pominięte, ustawisz później</summary>');
 expect(html).not.toContain('Nadawanie Przesyłek Erli');
 expect(biezacyWPasku(html)).toContain('4. Start');
});
it('sklep bez Przesyłek Erli: 4 kroki, po metodach od razu „Start”',async()=>{
 const f=await setup({bezMetodErli:true}),{p}=await f.szkic();await f.post(p,'pobierz-metody');await f.post(p,'metody');
 const html=await f.get(p);
 jedenKrok(html,'start');
 expect([...pasek(html).matchAll(/class="step-dot"/g)]).toHaveLength(4);
 expect(html).not.toContain('Nadawanie Przesyłek Erli');
 expect(html).toContain('<summary>3. Metody dostawy — 3 metody: 2 Twoja umowa, 1 bez kuriera ⚠</summary>');
});
it('po kroku 4: jeden krok „Start” — data, tylko odczyt i jeden przycisk „Aktywuj”, bez wstrzymania i odłączenia',async()=>{
 const f=await setup(),{p}=await f.szkic();await f.post(p,'pobierz-metody');await f.post(p,'metody');
 expect((await f.post(p,'nadawanie',{punktNadania:'1',waga:'2',dlugosc:'40',szerokosc:'30',wysokosc:'20'})).headers.location).toBe(root+p+'?zapisano=nadawanie');
 const html=await f.get(p+'?zapisano=nadawanie');
 jedenKrok(html,'start');
 expect(html).toContain('<summary>4. Nadawanie Przesyłek Erli — punkt Pracownia Półcień, paczka 2 kg 40×30×20 cm</summary>');
 expect(html.match(/<button[^>]*>Aktywuj<\/button>/g)).toHaveLength(1);
 const form=html.match(/<form[^>]*action="[^"]*\/aktywuj"[\s\S]*?<\/form>/)?.[0]??'';
 expect(form).toMatch(/<input id="erli-od" type="date" name="od"[^>]*value="2026-11-11"/);expect(form).toContain('name="tylkoOdczyt"');
 for(const zakaz of ['/data-startu"','/odlacz"','/pobieranie"','Pobieranie wstrzymane','Wstrzymaj','Odłącz'])expect(html).not.toContain(zakaz);
 expect(html).toMatch(/<details class="erli-usun">\s*<summary>Usuń sklep<\/summary>/);
});
it('„Aktywuj” z datą w tym samym formularzu zapisuje datę, wersję i audyt jak dotąd',async()=>{
 const f=await setup(),{p}=await f.szkic();await f.post(p,'pomin-metody');
 const wersja=Number(f.row().wersja),audyt=db.prepare("SELECT COUNT(*) AS n FROM kanaly_audit WHERE operacja='aktywuj'").get()!.n;
 const r=await f.post(p,'aktywuj',{od:'2026-11-01',decyzjaOdczytu:'1'});
 expect(r.statusCode).toBe(303);expect(r.headers.location).toBe(root+p+'?zapisano=aktywuj');
 expect(new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'}).format(new Date(String(f.row().od_utc)))).toBe('2026-11-01');
 expect(f.row().autoryzacja).toBe('polaczone');expect(Number(f.row().wersja)).toBe(wersja+1);
 expect(db.prepare("SELECT COUNT(*) AS n FROM kanaly_audit WHERE operacja='aktywuj'").get()!.n).toBe(Number(audyt)+1);
 expect((await f.post(p,'aktywuj',{od:'2026-11-02'})).statusCode).toBe(409);
});
it.each(['2026-11-12','2025-11-10','2026-02-30','zła'])('„Aktywuj” ze złą datą %s: 400 bez aktywacji i bez żadnego zapisu',async od=>{
 const f=await setup(),{p}=await f.szkic();await f.post(p,'pomin-metody');
 const zrzut=()=>({k:db.prepare('SELECT * FROM kanaly_sprzedazy').all(),a:db.prepare('SELECT * FROM kanaly_audit').all(),i:db.prepare('SELECT * FROM konfiguracja_integracji').all(),b:db.prepare('SELECT * FROM kanaly_blokady_zapisu').all()});
 const przed=zrzut();
 const r=await f.post(p,'aktywuj',{od,decyzjaOdczytu:'1'});
 expect(r.statusCode).toBe(400);expect(r.body).toContain('Podaj poprawną datę startu');
 expect(zrzut()).toEqual(przed);expect(f.row().autoryzacja).not.toBe('polaczone');
});
it('aktywny sklep: ekran zarządzania bez paska kroków, stan u góry, sekcje zwinięte, „Odłącz” na dole',async()=>{
 const f=await setup(),{p}=await f.szkic();await f.post(p,'pobierz-metody');await f.post(p,'metody');
 await f.post(p,'nadawanie',{punktNadania:'1',waga:'2',dlugosc:'40',szerokosc:'30',wysokosc:'20'});
 await f.post(p,'aktywuj',{od:'2026-11-01',decyzjaOdczytu:'1'});
 const html=await f.get(p+'?zapisano=aktywuj');
 expect(html).not.toContain('class="stepper"');
 expect(rozwiniete(html)).toEqual(['stan']);
 expect(bezDetails(html)).not.toContain('id="erli-klucz"');expect(bezDetails(html)).not.toContain('action="'+root+p+'/dane"');
 expect(html).toContain('Sklep aktywny — pobieranie włączone, zamówienia od 01.11.2026');
 expect(html).toMatch(/<button[^>]*>Wstrzymaj<\/button>/);
 for(const s of ['Nazwa, środowisko, klucz — Pracownia Półcień, sandbox, klucz zapisany','Metody dostawy — 6 metod','Nadawanie Przesyłek Erli — punkt Pracownia Półcień'])expect(html).toContain('<summary>'+s);
 const iOdlacz=html.indexOf('/odlacz"');expect(iOdlacz).toBeGreaterThan(html.lastIndexOf('<details class="erli-krok"'));
 expect(html).toMatch(/<details class="erli-odlacz">\s*<summary>Odłącz sklep<\/summary>/);
 expect(html).not.toContain('<input id="erli-od"');
 expect(html.match(/role="status"/g)).toHaveLength(1);expect(html).toContain('Sklep aktywowany.');
});
it('sklep z pliku konfiguracji: ekran zarządzania, formularze wyłączone',async()=>{
 const f=await setup({zPliku:true}),html=await f.get('/z-pliku');
 expect(html).not.toContain('class="stepper"');expect(rozwiniete(html)).toEqual(['stan']);
 expect(bezDetails(html)).not.toContain('id="erli-klucz"');
});
it('kolizja: drugi sklep stoi na kroku 2 z komunikatem kolizji, tylko ten krok rozwinięty',async()=>{
 const f=await setup(),{p}=await f.szkic();await f.post(p,'pomin-metody');await f.post(p,'aktywuj');
 const {location}=await f.szkic('Pracownia Półcień — druga');
 expect(location).toMatch(/\?polaczenie=blad$/);
 const html=await f.get(location.slice(root.length));
 jedenKrok(html,'polaczenie');
 expect(html).toContain('Ten sklep ERLI jest już zapisany w innym kanale');
 const pierwszy=await f.get(p);
 expect(pierwszy).toContain('Ten sklep ERLI jest już zapisany w innym kanale');expect(pierwszy).not.toContain('class="stepper"');
});
it('odłączony sklep wraca do kreatora: krok 2, potem „Start” z datą jako tekstem',async()=>{
 const f=await setup(),{p}=await f.szkic();await f.post(p,'pomin-metody');await f.post(p,'aktywuj',{od:'2026-11-01'});
 await f.post(p,'odlacz',{potwierdz:'tak'});
 let html=await f.get(p);jedenKrok(html,'polaczenie');
 // Odłączenie kasuje klucz: zapis kroku 1 z kluczem sam sprawdza połączenie.
 expect((await f.post(p,'dane',{nazwa:'Pracownia Półcień',adresApi:sandbox,kluczApi:klucz})).headers.location).toBe(root+p+'?polaczenie=ok');
 html=await f.get(p);jedenKrok(html,'start');
 expect(html).not.toContain('<input id="erli-od"');expect(html).toContain('Zamówienia od 01.11.2026');
});
