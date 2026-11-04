import {afterEach,expect,it} from 'vitest';
import {zbudujAplikacje,type Aplikacja} from '../../../src/core/aplikacja.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {modulyPiaskownicy} from '../../../deploy/proba/atrapy/index.mjs';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {zalozKonto} from '../../../src/core/bezpieczenstwo/konta.js';
import {podpisz} from '../../../src/core/bezpieczenstwo/sesja.js';
import {wczytajSekret} from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import type {ModulOms} from '../../../src/core/kontrakty.ts';

const root='/ustawienia/integracje/allegro/aplikacja';
const akcja='/ustawienia/integracje/allegro/aplikacja-urzadzenia';
const SEKRET='SEKRET-POLCIEN';
let a:Aplikacja,db:ReturnType<typeof openOmsDb>;
afterEach(async()=>{await a?.app.close();db?.close();});
async function setup(status=200,envExtra:Record<string,string>={}){
 const calls:string[]=[]; const headers:string[]=[];
 const http=async(u:string,i?:RequestInit)=>{ headers.push(new Headers(i?.headers).get('User-Agent')??'');
  calls.push(u);
  if(u.endsWith('/device'))return status===200?Response.json({device_code:'KOD-ODRZUCONY',user_code:'KOD-UZYTKOWNIKA',verification_uri:u.includes('allegrosandbox.pl')?'https://allegro.pl.allegrosandbox.pl/skojarz':'https://allegro.pl/skojarz',expires_in:600,interval:5}):Response.json({error:'invalid_client',error_description:SEKRET},{status});
  if(u.endsWith('/me'))return Response.json({id:'100001',login:'polcien'}); throw Error('Nieoczekiwane API');
 };
 const env={OMS_USER:'serwis',OMS_PASS:'fixture',OMS_TRYB:'proba',OMS_KANALY:'[]',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:'/tmp/prz132-proformy',OMS_ETYKIETY_KATALOG:'/tmp/prz132-etykiety',...envExtra};
 const m=createModulKanaly([],false,{fetchImpl:(u,i)=>http(String(u),i),autoryzacjaAtrapy:{http,softwareStatementId:'',redirectUri:'http://localhost/ustawienia/integracje/allegro/oauth/powrot',userAgent:'Fixture/1 (+https://example.invalid)'}});
 const kanal={...m,konfiguracja:()=>m.konfiguracja(env)};
 db=openOmsDb();
 a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?kanal:x) as ModulOms[],env,teraz:()=>new Date('2026-11-01T12:00:00Z'),log:()=>{}});
 zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
 zalozKonto(db,{login:'operator',imie:'Operator',haslo:'fixture',rola:'sprzedaz',ekrany:['ustawienia']} as any);
 const cookie=(login:string)=>'sesja_oms_proba='+podpisz(login,wczytajSekret(db),Date.now());
 async function req(method:'GET'|'POST',url:string,payload?:Record<string,unknown>,auth=cookie('admin'),origin:string|undefined='http://localhost'){
  const r=await a.app.inject({method,url,headers:{accept:'text/html',cookie:auth,...(method==='POST'&&origin?{origin}:{})},payload});
  expect(r.body).not.toContain(SEKRET);expect(r.body).not.toContain('KOD-ODRZUCONY');
  return r;
 }
 return {req,cookie,calls,headers};
}

import {userAgentAllegro} from '../../../src/moduly/kanaly/konfiguracja.ts';
import {wczytajKonfiguracjeIntegracji} from '../../../src/oms/db/konfiguracja-integracji.js';
import {zapiszTokeny} from '../../../src/oms/db/tokeny.js';
const post='/ustawienia/integracje/allegro/user-agent';
const pola={srodowisko:'produkcja',nazwa:'Polcien',wersja:'2.1',adres:'https://polcien.invalid/info'};
const naglowek='Polcien/2.1 (+https://polcien.invalid/info)';
it('GET pokazuje sekcję i domyślny nagłówek; POST zapisuje pola i aktora; puste przywracają domyślny',async()=>{
 const f=await setup();const get=()=>f.req('GET',root+'?srodowisko=produkcja');
 expect((await get()).body).toContain('Zaawansowane: jak OMS przedstawia się Allegro');
 expect((await get()).body).toContain(userAgentAllegro({}));
 expect((await f.req('POST',post,pola)).statusCode).toBe(200);
 expect((await get()).body).toContain(naglowek);
 expect(wczytajKonfiguracjeIntegracji(db,'allegro-user-agent')).toMatchObject({ustawienia:{nazwa:pola.nazwa,wersja:pola.wersja,adres:pola.adres},sekrety:{},kontoLogin:'admin'});
 expect((await f.req('POST',post,{srodowisko:'produkcja',nazwa:'',wersja:'',adres:''})).statusCode).toBe(200);
 expect((await get()).body).toContain(userAgentAllegro({}));
});
it('nazwa bez adresu daje 400 i zachowuje pola',async()=>{
 const f=await setup();const r=await f.req('POST',post,{...pola,adres:''});
 expect(r.statusCode).toBe(400);expect(r.body).toContain('Podaj adres strony z informacją o aplikacji — Allegro kontaktuje się przez niego z autorem integracji.');expect(r.body).toContain('value="Polcien"');
 expect(wczytajKonfiguracjeIntegracji(db,'allegro-user-agent')).toBeNull();
});
it.each(['ftp://polcien.invalid','https://','https://polcien.invalid/ zle'])('zły adres %s daje 400',async adres=>{
 const f=await setup();expect((await f.req('POST',post,{...pola,adres})).statusCode).toBe(400);
});
it('adres bez nazwy i pusta wersja używają wartości produktu; błędna nazwa lub wersja daje 400',async()=>{
 const f=await setup();const r=await f.req('POST',post,{...pola,nazwa:'',wersja:''});
 expect(r.statusCode).toBe(200);expect(r.body).toContain(userAgentAllegro({}).replace('https://twojoms.pl',pola.adres));
 for(const zmiana of [{nazwa:'Pracownia Półcień'},{wersja:'abc'}])expect((await f.req('POST',post,{...pola,...zmiana})).statusCode).toBe(400);
});
it('env wygrywa: brak pól, POST 409 bez zapisu',async()=>{
 const f=await setup(200,{OMS_ALLEGRO_USER_AGENT:'Env/3 (+https://env.invalid)'});
 const g=await f.req('GET',root+'?srodowisko=produkcja');expect(g.body).toContain('Env/3 (+https://env.invalid)');expect(g.body).not.toContain('name="nazwa"');
 const odmowa=await f.req('POST',post,pola);expect(odmowa.statusCode).toBe(409);expect(wczytajKonfiguracjeIntegracji(db,'allegro-user-agent')).toBeNull();
 expect(odmowa.body).toContain('Ustawione przez administratora serwera');
 await f.req('POST',akcja,{srodowisko:'produkcja',clientId:'polcien-id',clientSecret:SEKRET});expect(f.headers.at(-1)).toBe('Env/3 (+https://env.invalid)');
});
it('uprawnienia i Origin chronią zapis',async()=>{
 const f=await setup();expect((await f.req('POST',post,pola,f.cookie('operator'))).statusCode).toBe(403);
 expect((await f.req('POST',post,pola,undefined,'')).statusCode).toBe(403);expect((await f.req('POST',post,pola,undefined,'https://obca.invalid')).statusCode).toBe(403);
});
it('istniejący klient i autoryzacja wysyłają nowy nagłówek po zapisie bez restartu',async()=>{
 const f=await setup();await f.req('POST',akcja,{srodowisko:'produkcja',clientId:'polcien-id',clientSecret:SEKRET});
 expect((await f.req('GET',root+'?srodowisko=produkcja')).body).toContain('Zaawansowane: jak OMS przedstawia się Allegro');
 const repo=a.usluga<any>('kanaly','repozytoriumKanalow');const w=repo.utworzSzkic({nazwa:'Pracownia Półcień',odUtc:'2026-10-31T23:00:00Z',srodowisko:'produkcja'},{id:1,login:'admin'});expect(w.ok).toBe(true);
 const k=w.dane;expect(repo.zapiszZmiane(k.klucz,k.wersja,{aplikacja:'device',autoryzacja:'polaczone'},{id:1,login:'admin'}).ok).toBe(true);
 zapiszTokeny(db,k.klucz,{accessToken:'fixture',refreshToken:'fixture',wygasaAt:'2099-01-01',refreshWygasaAt:'2099-02-01'});
 const klient=a.usluga<any>('kanaly','klienciKanalow')[k.klucz];await klient.pobierzMojeKonto();
 expect((await f.req('POST',post,pola)).statusCode).toBe(200);await klient.pobierzMojeKonto();expect(f.headers.at(-1)).toBe(naglowek);
 await f.req('POST',akcja,{srodowisko:'sandbox',clientId:'polcien-id',clientSecret:SEKRET});expect(f.headers.at(-1)).toBe(naglowek);
 const nowy=repo.utworzSzkic({nazwa:'Drugie',odUtc:'2026-10-31T23:00:00Z',srodowisko:'sandbox'},{id:1,login:'admin'}).dane;
 expect((await a.usluga<any>('kanaly','autoryzacjaAllegro').rozpocznijDevice(nowy.klucz,{id:1,login:'admin'},'fixture')).ok).toBe(true);expect(f.headers.at(-1)).toBe(naglowek);
});
it('polskie znaki odrzucone z 400 bez zapisu — nagłówek HTTP przyjmuje tylko ASCII',async()=>{
 const f=await setup();
 for(const zmiana of [{nazwa:'Półcień'},{adres:'https://półcień.invalid'},{wersja:'2.ł'}]){
  const r=await f.req('POST',post,{...pola,...zmiana});expect(r.statusCode).toBe(400);expect(r.body).toContain('bez polskich znaków');expect(r.body).toContain('<details id="user-agent" open>');
 }
 expect(wczytajKonfiguracjeIntegracji(db,'allegro-user-agent')).toBeNull();
});
it('po zapisie sekcja otwarta z potwierdzeniem; GET na adres formularza wraca na krok 0',async()=>{
 const f=await setup();const r=await f.req('POST',post+'?srodowisko=sandbox',pola);
 expect(r.body).toContain('<details id="user-agent" open>');expect(r.body).toContain('Zapisano.');
 const g=await f.req('GET',post+'?srodowisko=sandbox');expect(g.statusCode).toBe(303);expect(g.headers.location).toBe(root+'?srodowisko=sandbox');
 expect((await f.req('GET',root+'?srodowisko=produkcja')).body).not.toContain('Zapisano.');
});
it('env wygrywa także nad zapisem z panelu',async()=>{
 const f=await setup(200,{OMS_ALLEGRO_USER_AGENT:'Env/3 (+https://env.invalid)'});
 const {zapiszKonfiguracjeIntegracji}=await import('../../../src/oms/db/konfiguracja-integracji.js');
 zapiszKonfiguracjeIntegracji(db,'allegro-user-agent',{ustawienia:{nazwa:'Polcien',wersja:'2.1',adres:'https://polcien.invalid/info'},sekrety:{}},{konto:{id:1,login:'admin'} as any,teraz:new Date('2026-11-01T12:00:00Z')} as any);
 expect((await f.req('GET',root+'?srodowisko=produkcja')).body).not.toContain(naglowek);
 await f.req('POST',akcja,{srodowisko:'produkcja',clientId:'polcien-id',clientSecret:SEKRET});expect(f.headers.at(-1)).toBe('Env/3 (+https://env.invalid)');
});
it('uszkodzony zapis w bazie nie blokuje kroku 0 ani Allegro — wraca nagłówek produktu',async()=>{
 const f=await setup();
 const {zapiszKonfiguracjeIntegracji}=await import('../../../src/oms/db/konfiguracja-integracji.js');
 zapiszKonfiguracjeIntegracji(db,'allegro-user-agent',{ustawienia:{nazwa:'Półcień',wersja:'',adres:'https://polcien.invalid'},sekrety:{}},{konto:{id:1,login:'admin'} as any,teraz:new Date('2026-11-01T12:00:00Z')} as any);
 const g=await f.req('GET',root+'?srodowisko=produkcja');expect(g.statusCode).toBe(200);expect(g.body).toContain(userAgentAllegro({}));
 await f.req('POST',akcja,{srodowisko:'produkcja',clientId:'polcien-id',clientSecret:SEKRET});expect(f.headers.at(-1)).toBe('Fixture/1 (+https://example.invalid)');
});
it('sekcja pozostaje widoczna przy aplikacji Device ustawionej w env',async()=>{
 const f=await setup(200,{OMS_ALLEGRO_DEVICE_CLIENT_ID:'fixture-id',OMS_ALLEGRO_DEVICE_CLIENT_SECRET:'fixture-secret'});
 const g=await f.req('GET',root+'?srodowisko=produkcja');expect(g.statusCode).toBe(200);expect(g.body).toContain('name="nazwa"');expect(g.body).toContain('Zaawansowane: jak OMS przedstawia się Allegro');
});
