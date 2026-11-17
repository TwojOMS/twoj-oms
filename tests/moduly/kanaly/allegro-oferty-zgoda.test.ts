import {afterEach,expect,it,vi} from 'vitest';
import {zbudujAplikacje,type Aplikacja} from '../../../src/core/aplikacja.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {modulyPiaskownicy} from '../../../deploy/proba/atrapy/index.mjs';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {zalozKonto} from '../../../src/core/bezpieczenstwo/konta.js';
import {podpisz} from '../../../src/core/bezpieczenstwo/sesja.js';
import {wczytajSekret} from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import {scopesAllegro,fixtureAllegro,daneAllegro,aktorAllegro} from '../../pomoc/allegro-konfigurator.ts';
import type {ModulOms} from '../../../src/core/kontrakty.ts';
import {zapiszTokeny} from '../../../src/oms/db/tokeny.js';
import {UPRAWNIENIA_OFERT,WYMAGANE_UPRAWNIENIA} from '../../../src/domena/uprawnienia-kanalu.js';
import {UPRAWNIENIA_NOWEGO_POLACZENIA} from '../../../src/oms/allegro/oauth-code.ts';
import {OPISY_UPRAWNIEN,uprawnieniaDoZaznaczenia} from '../../../src/moduly/kanaly/instrukcja-aplikacji-allegro.ts';
import {migracjaTypuKanaluISklepow} from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import {zbudujUslugiKanalow} from '../../../src/moduly/kanaly/services/kompozycja-kanalow.ts';
import {konfiguracjaKanalow} from '../../../src/moduly/kanaly/konfiguracja.ts';
import {createAutoryzacjaAllegro} from '../../../src/moduly/kanaly/services/autoryzacja-allegro.ts';
import {konfiguracjeJawne} from '../../pomoc/sejf-testowy.ts';

// Zgoda na wystawianie ofert. Zakresy ofert są opcjonalne; konto bez nich
// działa jak dziś. Ponowna zgoda tylko na żądanie: „Sprawdź uprawnienia aplikacji” (zapisuje sam
// znacznik aplikacji), „Chcę wystawiać oferty” (otwiera wiązanie konta env), potem wiązanie.

const root='/ustawienia/integracje/allegro';
const zakresOfert=UPRAWNIENIA_OFERT.join(' ');
const jwt=(scope:string[],konto='456')=>'fixture.'+Buffer.from(JSON.stringify({user_name:konto,scope})).toString('base64url')+'.fixture';
let a:Aplikacja|undefined,db:ReturnType<typeof openOmsDb>|undefined;
const bazy:ReturnType<typeof fixtureAllegro>[]=[];
afterEach(async()=>{await a?.app.close();db?.close();a=undefined;db=undefined;vi.restoreAllMocks();for(const f of bazy.splice(0))f.db.close();});

async function setupEnv(o:{appOferty?:boolean;zOfertami?:boolean}={}){
 let appOferty=o.appOferty??true;
 const calls:{url:string;body:URLSearchParams}[]=[];
 const http=async(u:string,i:RequestInit={})=>{
  calls.push({url:u,body:new URLSearchParams(String(i.body??''))});
  if(u.endsWith('/device')){
   const scope=new URLSearchParams(String(i.body)).get('scope')??'';
   if(scope.includes('allegro:api:sale:offers:write')&&!appOferty)return Response.json({error:'invalid_scope',error_description:'OPIS-BAIT'},{status:400});
   return Response.json({device_code:'DEVICE-BAIT',user_code:'TEST-123',verification_uri:'https://allegro.pl/skojarz',expires_in:600,interval:5});
  }
  if(u.includes('/order/checkout-forms?'))return Response.json({checkoutForms:[],totalCount:0});
  throw Error('Nieoczekiwane API: '+u);
 };
 const env={OMS_USER:'serwis',OMS_PASS:'fixture',OMS_TRYB:'proba',OMS_KANALY:'[]',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:'/tmp/prz160-proformy',OMS_ETYKIETY_KATALOG:'/tmp/prz160-etykiety'};
 const def=['legacy','allegro_polcien'].map(klucz=>({klucz,typ:'allegro' as const,prefiks:klucz.toUpperCase(),raport:klucz.toUpperCase()}));
 const m=createModulKanaly(def,false,{fetchImpl:(u,i)=>http(String(u),i),autoryzacjaAtrapy:{http,softwareStatementId:'',redirectUri:'http://localhost'+root+'/oauth/powrot',userAgent:'Fixture/1 (+https://example.invalid)'}});
 const kanal={...m,konfiguracja:()=>({...m.konfiguracja(env),kanaly:Object.fromEntries(def.map(d=>[d.klucz,{clientId:'app-public',clientSecret:'SECRET-BAIT',userAgent:'Fixture/1 (+https://example.invalid)',api:'https://api.allegro.pl',auth:'https://allegro.pl/auth/oauth',od:'2024-11-01T00:00:00Z'}]))})};
 db=openOmsDb();
 const bazowe=scopesAllegro.filter(s=>s!=='allegro:api:profile:read');
 for(const d of def)zapiszTokeny(db,d.klucz,{accessToken:jwt(o.zOfertami?[...bazowe,...UPRAWNIENIA_OFERT]:bazowe,d.klucz==='legacy'?'123':'456'),refreshToken:'REFRESH-OLD',wygasaAt:'2099-01-01T00:00:00Z',refreshWygasaAt:'2099-02-01T00:00:00Z'});
 a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?kanal:x) as ModulOms[],env,teraz:()=>new Date('2026-11-14T12:00:00Z'),log:()=>{}});
 zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
 zalozKonto(db,{login:'operator',imie:'Operator',haslo:'fixture',rola:'sprzedaz',ekrany:['ustawienia']} as any);
 const cookie=(login:string)=>'sesja_oms_proba='+podpisz(login,wczytajSekret(db),Date.now());
 const admin=cookie('admin');
 async function req(method:'GET'|'POST',path:string,payload?:Record<string,unknown>,auth=admin,origin='http://localhost'){
  const r=await a!.app.inject({method,url:path,headers:{accept:'text/html',cookie:auth,...(method==='POST'&&origin?{origin}:{})},payload});
  expect(r.body).not.toMatch(/SECRET-BAIT|DEVICE-BAIT|REFRESH-OLD|OPIS-BAIT|fixture\./);
  return r;
 }
 const stan=(k:string)=>a!.usluga<any>('kanaly','stanyKanalow')().find((s:any)=>s.kanal===k);
 const flagi=()=>db!.prepare("SELECT integracja FROM konfiguracja_integracji WHERE integracja LIKE 'allegro_oferty%' ORDER BY integracja").all().map((r:any)=>r.integracja);
 return {calls,req,stan,flagi,cookie,repo:a.usluga<any>('kanaly','repozytoriumKanalow'),setAppOferty:(v:boolean)=>{appOferty=v;}};
}

it('konto env bez zgody: ekran Stan pokazuje „Brak zgody” i przycisk sprawdzenia aplikacji',async()=>{
 const f=await setupEnv();
 const r=await f.req('GET',root+'/legacy');
 expect(r.statusCode).toBe(200);
 expect(r.body).toMatch(/<dt>Oferty<\/dt>\s*<dd>Brak zgody/);
 expect(r.body).toContain('Sprawdź uprawnienia aplikacji');
 expect(r.body).toContain('action="'+root+'/legacy/oferty-aplikacja"');
 expect(r.body).not.toContain('Chcę wystawiać oferty');
 expect(f.stan('legacy')).toMatchObject({wolnoWiazac:false,zgodaOfertOtwarta:false});
 expect(f.calls.filter(c=>c.url.endsWith('/device'))).toEqual([]);
});

it('konto env ze zgodą: „Zgoda jest”, bez przycisków ofert',async()=>{
 const f=await setupEnv({zOfertami:true});
 const r=await f.req('GET',root+'/legacy');
 expect(r.body).toMatch(/<dt>Oferty<\/dt>\s*<dd>Zgoda jest/);
 expect(r.body).not.toContain('Sprawdź uprawnienia aplikacji');
 expect(r.body).not.toContain('Chcę wystawiać oferty');
});

it('„Sprawdź” zapisuje tylko znacznik aplikacji; „Chcę” otwiera wiązanie wyłącznie tego konta',async()=>{
 const f=await setupEnv();
 const przed=f.repo.pobierz('legacy'),tokenyPrzed=db!.prepare('SELECT * FROM tokeny_kanalu ORDER BY kanal').all();
 const s=await f.req('POST',root+'/legacy/oferty-aplikacja');
 expect(s.statusCode).toBe(200);expect(s.body).toContain('Aplikacja ma uprawnienia do wystawiania ofert.');
 const proba=f.calls.filter(c=>c.url.endsWith('/device'));
 expect(proba).toHaveLength(1);
 expect(proba[0].url).toBe('https://allegro.pl/auth/oauth/device');
 expect(proba[0].body.get('scope')).toBe(zakresOfert);expect(proba[0].body.get('client_id')).toBe('app-public');
 expect(f.repo.pobierz('legacy')).toEqual(przed);
 expect(db!.prepare('SELECT * FROM tokeny_kanalu ORDER BY kanal').all()).toEqual(tokenyPrzed);
 expect(f.flagi()).toEqual(['allegro_oferty_aplikacja:produkcja']);
 // Sam znacznik aplikacji nie otwiera bariery — zdrowe konto bez kliknięcia zostaje zamknięte.
 expect(f.stan('legacy').wolnoWiazac).toBe(false);
 expect((await f.req('POST','/ustawienia/kanaly/legacy/wiazanie')).statusCode).toBe(403);
 expect(f.calls.filter(c=>c.url.endsWith('/device'))).toHaveLength(1);
 const ekran=await f.req('GET',root+'/legacy');
 expect(ekran.body).toContain('Chcę wystawiać oferty');expect(ekran.body).toContain('action="'+root+'/legacy/oferty-chce"');
 const c=await f.req('POST',root+'/legacy/oferty-chce');
 expect(c.statusCode).toBe(303);expect(c.headers.location).toBe(root+'/legacy#oferty-polacz');
 expect(f.stan('legacy').wolnoWiazac).toBe(true);
 expect(f.stan('allegro_polcien').wolnoWiazac).toBe(false);
 const poKliku=await f.req('GET',root+'/legacy');
 expect(poKliku.body).toContain('action="/ustawienia/kanaly/legacy/wiazanie"');
 const w=await f.req('POST','/ustawienia/kanaly/legacy/wiazanie');
 expect(w.statusCode).toBe(200);expect(w.body).toContain('TEST-123');
 // Legacy /device bez scope: Allegro daje wszystkie zakresy aplikacji, także oferty.
 const ostatnie=f.calls.filter(c=>c.url.endsWith('/device')).at(-1)!;
 expect(ostatnie.body.has('scope')).toBe(false);
 expect(f.repo.pobierz('legacy')).toEqual(przed);
});

it('aplikacja bez zakresów ofert: komunikat, znacznik „nie”, „Chcę” odmawia 400',async()=>{
 const f=await setupEnv({appOferty:false});
 const s=await f.req('POST',root+'/legacy/oferty-aplikacja');
 expect(s.statusCode).toBe(200);expect(s.body).toContain('Aplikacja nie ma uprawnień do ofert');
 const zapis:any=JSON.parse(String((db!.prepare("SELECT ustawienia_json FROM konfiguracja_integracji WHERE integracja='allegro_oferty_aplikacja:produkcja'").get() as any).ustawienia_json));
 expect(Object.values(zapis.aplikacje)).toEqual([expect.objectContaining({oferty:false})]);
 expect(JSON.stringify(zapis)).not.toContain('app-public');
 const c=await f.req('POST',root+'/legacy/oferty-chce');
 expect(c.statusCode).toBe(400);expect(c.body).toContain('Najpierw sprawdź uprawnienia aplikacji');
 expect(f.stan('legacy').wolnoWiazac).toBe(false);
 expect(f.flagi()).toEqual(['allegro_oferty_aplikacja:produkcja']);
 // Zaznaczono zakresy w Allegro → ponowne sprawdzenie nadpisuje znacznik.
 f.setAppOferty(true);
 expect((await f.req('POST',root+'/legacy/oferty-aplikacja')).body).toContain('Aplikacja ma uprawnienia do wystawiania ofert.');
 expect((await f.req('POST',root+'/legacy/oferty-chce')).statusCode).toBe(303);
});

it('oba przyciski: bez CSRF → 403 i bez roli administratora → 403, bez wywołań i zapisów',async()=>{
 const f=await setupEnv();
 for(const sciezka of ['oferty-aplikacja','oferty-chce']){
  expect((await f.req('POST',root+'/legacy/'+sciezka,{},undefined,'')).statusCode).toBe(403);
  expect((await f.req('POST',root+'/legacy/'+sciezka,{},undefined,'https://obcy.example')).statusCode).toBe(403);
  expect((await f.req('POST',root+'/legacy/'+sciezka,{},f.cookie('operator'))).statusCode).toBe(403);
 }
 expect(f.calls).toEqual([]);expect(f.flagi()).toEqual([]);
});

it('instrukcja aplikacji: każdy zakres ofert ma opis i jest oznaczony jako opcjonalny; lista połączenia bez zmian',()=>{
 expect(UPRAWNIENIA_NOWEGO_POLACZENIA).toHaveLength(8);
 const lista=uprawnieniaDoZaznaczenia();
 for(const u of UPRAWNIENIA_OFERT){
  expect(OPISY_UPRAWNIEN[u],'opis dla '+u).toBeTruthy();
  expect(lista.find(x=>x.nazwa===u)?.opis).toMatch(/opcjonalne/);
 }
 for(const u of UPRAWNIENIA_NOWEGO_POLACZENIA)expect(lista.find(x=>x.nazwa===u)?.opis).not.toMatch(/opcjonalne/);
});

it('instrukcja na ekranie pokazuje zakresy ofert z opisem',async()=>{
 const f=await setupEnv();
 const p=await f.req('GET',root+'/aplikacja?srodowisko=sandbox');
 expect(p.statusCode).toBe(200);
 for(const u of UPRAWNIENIA_OFERT){expect(p.body).toContain(u);expect(p.body).toContain(OPISY_UPRAWNIEN[u]);}
 expect(p.body).toContain('opcjonalne');
});

// ── Ścieżka panelu (aplikacja Device z instalacji) i DCR — na usługach, bez HTTP panelu.
function setupPanel(clientId='polcien-device-id',appOferty=true,f=fixtureAllegro()){
 if(!bazy.includes(f)){bazy.push(f);migracjaTypuKanaluISklepow.wykonaj(f.db);}
 const calls:{url:string;body:URLSearchParams}[]=[];
 const http=async(url:string,init:RequestInit={})=>{
  calls.push({url,body:new URLSearchParams(String(init.body??''))});
  if(url.endsWith('/device')){
   const scope=new URLSearchParams(String(init.body)).get('scope')??'';
   if(scope.includes('allegro:api:sale:offers:write')&&!appOferty)return Response.json({error:'invalid_scope'},{status:400});
   return Response.json({device_code:'DEVICE-POLCIEN',user_code:'ABC-123',verification_uri:'https://allegro.pl/skojarz',expires_in:600,interval:5});
  }
  return f.http(url,init);
 };
 const env=clientId?{OMS_ALLEGRO_DEVICE_CLIENT_ID:clientId,OMS_ALLEGRO_DEVICE_CLIENT_SECRET:'SEKRET-POLCIEN'}:{};
 const u=zbudujUslugiKanalow({db:f.db,konfiguracja:konfiguracjaKanalow([],env),teraz:f.teraz,log:vi.fn(),usluga:()=>()=>{}} as any,[],{fetchImpl:(url,i)=>http(String(url),i)});
 return {...f,...u,calls,f};
}
const scopeStartu=(calls:{url:string;body:URLSearchParams}[])=>calls.filter(c=>c.url.endsWith('/device')).at(-1)!.body.get('scope')!.split(' ');

it('panel: aplikacja bez znacznika ofert → zapytanie bez zakresów ofert; ze znacznikiem → z nimi',async()=>{
 const p=setupPanel();
 const k=daneAllegro(p.repozytoriumKanalow.utworzSzkic({nazwa:'Półcień',odUtc:'2026-10-31T23:00:00Z',srodowisko:'produkcja'},aktorAllegro));
 daneAllegro(await p.autoryzacjaAllegro.rozpocznijDevice(k.klucz,aktorAllegro,'A'));
 expect(scopeStartu(p.calls)).toEqual(UPRAWNIENIA_NOWEGO_POLACZENIA);
 const przed=p.repozytoriumKanalow.pobierz(k.klucz);
 expect(daneAllegro(await p.ofertyAllegro.sprawdzAplikacje(k.klucz,aktorAllegro))).toEqual({oferty:true});
 expect(p.repozytoriumKanalow.pobierz(k.klucz)).toEqual(przed);
 expect(p.ofertyAllegro.stan(k.klucz)).toMatchObject({sciezka:'panel',aplikacja:true});
 const k2=daneAllegro(p.repozytoriumKanalow.utworzSzkic({nazwa:'Półcień 2',odUtc:'2026-10-31T23:00:00Z',srodowisko:'produkcja'},aktorAllegro));
 daneAllegro(await p.autoryzacjaAllegro.rozpocznijDevice(k2.klucz,aktorAllegro,'A'));
 expect(scopeStartu(p.calls)).toEqual([...UPRAWNIENIA_NOWEGO_POLACZENIA,...UPRAWNIENIA_OFERT]);
 expect(JSON.stringify(konfiguracjeJawne(p.db))).not.toContain('polcien-device-id');
});

it('panel: zmiana Client ID kasuje znacznik ofert (nowa aplikacja nie dziedziczy zgody)',async()=>{
 const p=setupPanel();
 const k=daneAllegro(p.repozytoriumKanalow.utworzSzkic({nazwa:'Półcień',odUtc:'2026-10-31T23:00:00Z',srodowisko:'produkcja'},aktorAllegro));
 daneAllegro(await p.ofertyAllegro.sprawdzAplikacje(k.klucz,aktorAllegro));
 expect(p.aplikacjaAllegro.aplikacjaMaOferty('produkcja','polcien-device-id')).toBe(true);
 const q=setupPanel('polcien-device-inna',true,p.f);
 expect(q.aplikacjaAllegro.aplikacjaMaOferty('produkcja','polcien-device-inna')).toBeNull();
 expect(q.ofertyAllegro.stan(k.klucz)).toMatchObject({sciezka:'panel',aplikacja:null});
 daneAllegro(await q.autoryzacjaAllegro.rozpocznijDevice(k.klucz,aktorAllegro,'A'));
 expect(scopeStartu(q.calls)).toEqual(UPRAWNIENIA_NOWEGO_POLACZENIA);
});

it('panel: aplikacja bez ofert → znacznik „nie”, zapytanie Device bez zakresów ofert',async()=>{
 const p=setupPanel('polcien-device-id',false);
 const k=daneAllegro(p.repozytoriumKanalow.utworzSzkic({nazwa:'Półcień',odUtc:'2026-10-31T23:00:00Z',srodowisko:'produkcja'},aktorAllegro));
 expect(daneAllegro(await p.ofertyAllegro.sprawdzAplikacje(k.klucz,aktorAllegro))).toEqual({oferty:false});
 expect(p.ofertyAllegro.chce(k.klucz,aktorAllegro)).toMatchObject({ok:false,kod:'walidacja'});
 daneAllegro(await p.autoryzacjaAllegro.rozpocznijDevice(k.klucz,aktorAllegro,'A'));
 expect(scopeStartu(p.calls)).toEqual(UPRAWNIENIA_NOWEGO_POLACZENIA);
});

it('DCR: oferty niedostępne w tej instalacji, bez wywołań; zapytanie /authorize bez zmian',async()=>{
 const p=setupPanel('');
 const k=daneAllegro(p.repozytoriumKanalow.utworzSzkic({nazwa:'Półcień',odUtc:'2026-10-31T23:00:00Z',srodowisko:'produkcja'},aktorAllegro));
 expect(p.ofertyAllegro.stan(k.klucz)).toMatchObject({sciezka:'dcr'});
 const w=await p.ofertyAllegro.sprawdzAplikacje(k.klucz,aktorAllegro);
 expect(w).toMatchObject({ok:false,kod:'konflikt'});expect(!w.ok&&w.komunikat).toMatch(/niedostępne w tej instalacji/);
 expect(p.ofertyAllegro.chce(k.klucz,aktorAllegro)).toMatchObject({ok:false,kod:'konflikt'});
 expect(p.calls).toEqual([]);
 // Start DCR nie dokłada zakresów ofert, nawet gdy znacznik twierdzi, że aplikacja je ma.
 const auth=createAutoryzacjaAllegro({repozytorium:p.repo,aplikacjaDlaInstalacji:()=>p.app,http:p.http,userAgent:'OMS/1 (+https://example.invalid)',teraz:p.teraz,zakresyOfert:()=>true});
 const sz=p.szkic();
 const start=daneAllegro(await auth.rozpocznijAutoryzacje(sz.klucz,aktorAllegro,'A'));
 expect(new URL(start.adres).searchParams.get('scope')!.split(' ')).toEqual(UPRAWNIENIA_NOWEGO_POLACZENIA);
});

it('stan ofert szkicu bez tokenów: zgoda nieznana, nic nie otwiera, bez wywołań',async()=>{
 const p=setupPanel();
 expect(WYMAGANE_UPRAWNIENIA.some(u=>UPRAWNIENIA_OFERT.includes(u))).toBe(false);
 const k=daneAllegro(p.repozytoriumKanalow.utworzSzkic({nazwa:'Półcień',odUtc:'2026-10-31T23:00:00Z',srodowisko:'produkcja'},aktorAllegro));
 // Szkic bez tokenów: zgody nie da się odczytać — „nie wiem”, nie „brak”.
 expect(p.ofertyAllegro.stan(k.klucz)).toMatchObject({zgoda:null,chce:false,wolnoWiazac:false});
 expect(p.calls).toEqual([]);
});
