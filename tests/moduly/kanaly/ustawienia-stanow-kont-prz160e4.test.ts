import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {zbudujAplikacje,type Aplikacja} from '../../../src/core/aplikacja.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {modulyPiaskownicy} from '../../../deploy/proba/atrapy/index.mjs';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {zalozKonto} from '../../../src/core/bezpieczenstwo/konta.js';
import {podpisz} from '../../../src/core/bezpieczenstwo/sesja.js';
import {wczytajSekret} from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import {scopesAllegro} from '../../pomoc/allegro-konfigurator.ts';
import type {ModulOms} from '../../../src/core/kontrakty.ts';
import {zapiszTokeny} from '../../../src/oms/db/tokeny.js';
import {UPRAWNIENIA_OFERT} from '../../../src/domena/uprawnienia-kanalu.js';
import {ustawieniaOfertKonta} from '../../../src/oms/db/oferty-kanalow.ts';
import {przelaczStany} from '../../../src/oms/db/stany-magazynowe.js';
import {MODUL_WOO} from '../../../src/domena/modul-woo.ts';

// PRZ-160 E4.10 (D47, D48, D61): bufor i próg skoku na koncie ERLI/Allegro, krok 6 „Stany” sklepu Woo, etykieta stałej.
// Pola widać dopiero, gdy stany magazynowe choć raz były włączone; do tej chwili formularze są bajt w bajt jak w bazie
// (wzorce wygenerowane z ddd06abd, po scaleniu E3d na nowo z main ef198eb1). Wyłącznie atrapy HTTP; dane zmyślone.

let a:Aplikacja|undefined,db:ReturnType<typeof openOmsDb>|undefined;
afterEach(async()=>{await a?.app.close();db?.close();a=undefined;db=undefined;});
const env={OMS_USER:'serwis',OMS_PASS:'fixture',OMS_TRYB:'proba',OMS_KANALY:'[]',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:'/tmp/prz160e410-proformy',OMS_ETYKIETY_KATALOG:'/tmp/prz160e410-etykiety'};
const wzorzec=(n:string)=>readFileSync(new URL('../../fixtures/e4-blizniak-konfigurator-'+n+'.html',import.meta.url),'utf8');
const wytnij=(html:string,akcja:string)=>{const i=html.indexOf('<form method="post" action="'+akcja+'"');expect(i).toBeGreaterThan(0);return html.slice(i,html.indexOf('</form>',i)+7)+'\n';};
const ETYKIETA_STALEJ='Stała liczba sztuk (gdy stany magazynowe są wyłączone)';
const BUFOR_BLAD='Bufor (szt.) musi być liczbą całkowitą od 0 do 1000000';
const WYLACZONE='Stany magazynowe są wyłączone — ten krok nic nie robi';
const ODCZYT='Klucz tylko do odczytu — stanów nie zapiszemy.';
const wlaczIWylacz=()=>{przelaczStany(db!,{wlacz:true,at:'2026-11-10T08:00:00Z'});przelaczStany(db!,{wlacz:false,at:'2026-11-11T08:00:00Z'});};

function konta(){
 zalozKonto(db!,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
 zalozKonto(db!,{login:'operator',imie:'Operator',haslo:'fixture',rola:'sprzedaz',ekrany:['ustawienia']} as any);
 const cookie=(login:string)=>'sesja_oms_proba='+podpisz(login,wczytajSekret(db!),Date.now());
 return {admin:cookie('admin'),operator:cookie('operator')};
}
const formularz=(payload:Record<string,unknown>)=>new URLSearchParams(Object.entries(payload).map(([k,v])=>[k,String(v)])).toString();
function zapytania(c:{admin:string}){
 return (method:'GET'|'POST',url:string,payload?:Record<string,unknown>,o:{cookie?:string;origin?:string|null}={})=>a!.app.inject({method,url,
  payload:payload?formularz(payload):undefined,
  headers:{accept:'text/html',cookie:o.cookie??c.admin,...(payload?{'content-type':'application/x-www-form-urlencoded'}:{}),...(method==='POST'&&o.origin!==null?{origin:o.origin??'http://localhost'}:{})}});
}

async function erli(){
 db=openOmsDb();
 const transport=vi.fn(async()=>{throw new Error('Ten krok nie może wywołać ERLI');});
 const kanaly=createModulKanaly([],false,{fetchImpl:transport});
 a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(m=>m.nazwa==='kanaly'?kanaly:m) as ModulOms[],env,log:()=>{}});
 const c=konta(),req=zapytania(c);
 const s=a.usluga<any>('kanaly','sklepyErli');
 const {klucz}=await s.operacja('nowe','dane',{nazwa:'Pracownia Półcień',adresApi:'https://sandbox.erli.dev/svc/shop-api',kluczApi:'atrapa-polcien',wersja:0},{id:0,login:'admin'});
 db.prepare("UPDATE kanaly_sprzedazy SET autoryzacja='polaczone' WHERE klucz=?").run(klucz);
 const adres='/ustawienia/integracje/erli/'+klucz;
 const zapisz=(p:Record<string,unknown>,o?:{cookie?:string;origin?:string|null})=>req('POST',adres+'/oferty',{wersja:s.pobierz(klucz).wersja,...p},o);
 return {klucz,adres,req,zapisz,c,transport};
}
const poprawneErli={narzutProcent:'12,5',progPotwierdzeniaProcent:'20',stalaIlosc:'7',czasWysylkiDni:'2',cennikDostaw:'demo-cennik',stawkaVat:'23',czynne:'wstrzymane'};

async function allegro(){
 const jwt=(scope:string[],konto:string)=>'fixture.'+Buffer.from(JSON.stringify({user_name:konto,scope})).toString('base64url')+'.fixture';
 const root='/ustawienia/integracje/allegro';
 const calls:string[]=[];
 const http=async(u:string)=>{calls.push(u);if(u.includes('/order/checkout-forms?'))return Response.json({checkoutForms:[],totalCount:0});throw Error('Nieoczekiwane API: '+u);};
 const def=[{klucz:'legacy',typ:'allegro' as const,prefiks:'LEGACY',raport:'LEGACY'}];
 const m=createModulKanaly(def,false,{fetchImpl:(u,_i)=>http(String(u)),autoryzacjaAtrapy:{http,softwareStatementId:'',redirectUri:'http://localhost'+root+'/oauth/powrot',userAgent:'Fixture/1 (+https://example.invalid)'}});
 const kanal={...m,konfiguracja:()=>({...m.konfiguracja(env),kanaly:{legacy:{clientId:'app-public',clientSecret:'x',userAgent:'Fixture/1 (+https://example.invalid)',api:'https://api.allegro.pl',auth:'https://allegro.pl/auth/oauth',od:'2024-11-01T00:00:00Z'}}})};
 db=openOmsDb();
 zapiszTokeny(db,'legacy',{accessToken:jwt([...scopesAllegro.filter(s=>s!=='allegro:api:profile:read'),...UPRAWNIENIA_OFERT],'123'),refreshToken:'R',wygasaAt:'2099-01-01T00:00:00Z',refreshWygasaAt:'2099-02-01T00:00:00Z'});
 a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?kanal:x) as ModulOms[],env,teraz:()=>new Date('2026-11-14T12:00:00Z'),log:()=>{}});
 const c=konta(),req=zapytania(c);
 const adres=root+'/legacy/oferty';
 return {adres,req,c,calls,zapisz:(p:Record<string,unknown>,o?:{cookie?:string;origin?:string|null})=>req('POST',adres,p,o)};
}
const poprawneAllegro={czynne:'wstrzymane',narzutProcent:'12,5',progPotwierdzeniaProcent:'20',stalaIlosc:'3',czasWysylkiDni:'2',stawkaVat:'23',aktywujPoSprawdzeniu:'nie',bezpieczenstwoDomyslne:''};

async function woo(){
 const root=MODUL_WOO.konfigurator.sciezka;
 const m=createModulKanaly([],false,{fetchImpl:async(u)=>{const url=String(u);if(url.includes('/shipping/zones/'))return Response.json([{instance_id:1,title:'Kurier Półcień',method_id:'flat_rate',enabled:true}]);if(url.includes('/shipping/zones'))return Response.json([{id:1,name:'Polska'}]);if(url.includes('/payment_gateways'))return Response.json([{id:'cod',title:'Za pobraniem',enabled:true}]);return Response.json([]);}});
 const config=createModulKanaly([]).konfiguracja(env);
 db=openOmsDb();
 a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?{...m,konfiguracja:()=>config}:x) as ModulOms[],env,teraz:()=>new Date('2026-11-14T12:00:00Z'),log:()=>{}});
 const c=konta(),req=zapytania(c);
 async function sklep(uprawnienia?:'odczyt'|'zapis',aktywny=true){
  const p=await req('POST',root+'/szkice',{nazwa:'Pracownia Półcień',adres:'https://sklep.polcien.example'});
  const formularzId=p.body.match(/name="formularzId" value="([^"]+)"/)?.[1];
  const w=await req('POST',root+'/nowy/klucze',{formularzId,wersja:0,ck:'ck_test_polcien',cs:'cs_test_polcien',...(uprawnienia?{uprawnienia}:{})});
  expect(w.statusCode).toBe(303);
  const klucz=decodeURIComponent(String(w.headers.location).slice(root.length+1));
  if(aktywny)db!.prepare("UPDATE kanaly_sprzedazy SET autoryzacja='polaczone' WHERE klucz=?").run(klucz);
  return klucz;
 }
 const adres=(k:string)=>root+'/'+encodeURIComponent(k);
 const wersja=(k:string)=>(db!.prepare('SELECT wersja FROM kanaly_sprzedazy WHERE klucz=?').get(k) as any).wersja;
 const zapisz=(k:string,p:Record<string,unknown>,o?:{cookie?:string;origin?:string|null})=>req('POST',adres(k)+'/stany',{wersja:wersja(k),...p},o);
 return {req,sklep,adres,zapisz,c,wersja};
}

// ---------- ERLI ----------

it('ERLI: stany nigdy niewłączone → formularz ofert bajt w bajt jak w bazie, bufor z formularza pominięty',async()=>{
 const f=await erli();
 const r=await f.req('GET',f.adres);
 expect(r.statusCode).toBe(200);
 expect(wytnij(r.body,f.adres+'/oferty').replaceAll(f.klucz,'KLUCZ')).toBe(wzorzec('erli'));
 expect((await f.zapisz({...poprawneErli,buforSzt:'4',progSkokuSzt:'9'})).statusCode).toBe(303);
 expect(ustawieniaOfertKonta(db!,f.klucz)).toMatchObject({stalaIlosc:7,buforSzt:0,progSkokuSzt:5});
 expect(f.transport).not.toHaveBeenCalled();
});

it('ERLI: po włączeniu (także później wyłączonym) — bufor, próg i nowa etykieta stałej',async()=>{
 const f=await erli();wlaczIWylacz();
 const r=await f.req('GET',f.adres);
 expect(r.body).toContain(`<label for="erli-oferty-stalaIlosc">${ETYKIETA_STALEJ}</label>`);
 expect(r.body).not.toContain('Stała liczba sztuk (wymagana)');
 expect(r.body).toMatch(/<input id="erli-oferty-buforSzt" type="number" name="buforSzt" inputmode="numeric" value="0"[^>]* min="0" max="1000000" step="1"/);
 expect(r.body).toMatch(/<input id="erli-oferty-progSkokuSzt" type="number" name="progSkokuSzt" inputmode="numeric" value="5"[^>]* min="1" max="1000000" step="1"/);
});

it('ERLI: bufor −1 → odmowa po polsku przy polu, nic nie zapisane',async()=>{
 const f=await erli();wlaczIWylacz();
 const r=await f.zapisz({...poprawneErli,buforSzt:'-1',progSkokuSzt:'5'});
 expect(r.statusCode).toBe(400);
 expect(r.body).toContain(BUFOR_BLAD);
 expect(r.body).toMatch(/name="buforSzt"[^>]*aria-invalid="true"/);
 expect(ustawieniaOfertKonta(db!,f.klucz).zapisane).toBe(false);
});

it('ERLI: zapis bufora i progu nie zmienia innych pól',async()=>{
 const f=await erli();wlaczIWylacz();
 expect((await f.zapisz({...poprawneErli,czynne:'czynne',buforSzt:'0',progSkokuSzt:'5'})).statusCode).toBe(303);
 const {zmienionoAt:_a,buforSzt:_b,progSkokuSzt:_c,...przed}=ustawieniaOfertKonta(db!,f.klucz) as any;
 expect((await f.zapisz({...poprawneErli,czynne:'czynne',buforSzt:'2',progSkokuSzt:'3'})).statusCode).toBe(303);
 const {zmienionoAt:_d,buforSzt,progSkokuSzt,...po}=ustawieniaOfertKonta(db!,f.klucz) as any;
 expect({buforSzt,progSkokuSzt}).toEqual({buforSzt:2,progSkokuSzt:3});
 expect(po).toEqual(przed);
});

it('ERLI: zapis bez Origin → 403, operator bez roli administratora → 403; nic nie zapisane',async()=>{
 const f=await erli();wlaczIWylacz();
 expect((await f.zapisz({...poprawneErli,buforSzt:'2',progSkokuSzt:'3'},{origin:null})).statusCode).toBe(403);
 expect((await f.zapisz({...poprawneErli,buforSzt:'2',progSkokuSzt:'3'},{cookie:f.c.operator})).statusCode).toBe(403);
 expect(ustawieniaOfertKonta(db!,f.klucz).zapisane).toBe(false);
});

// ---------- Allegro ----------

it('Allegro: stany nigdy niewłączone → formularz kroku „Oferty” bajt w bajt jak w bazie, bufor pominięty',async()=>{
 const f=await allegro();
 const r=await f.req('GET',f.adres);
 expect(r.statusCode).toBe(200);
 expect(wytnij(r.body,f.adres)).toBe(wzorzec('allegro'));
 expect((await f.zapisz({...poprawneAllegro,buforSzt:'4',progSkokuSzt:'9'})).statusCode).toBe(303);
 expect(ustawieniaOfertKonta(db!,'legacy')).toMatchObject({stalaIlosc:3,buforSzt:0,progSkokuSzt:5});
});

it('Allegro: po włączeniu stanów — bufor, próg, etykieta stałej; bufor −1 → odmowa, nic nie zapisane',async()=>{
 const f=await allegro();wlaczIWylacz();
 const r=await f.req('GET',f.adres);
 expect(r.body).toContain(`<label for="allegro-oferty-stalaIlosc">${ETYKIETA_STALEJ}</label>`);
 expect(r.body).toMatch(/<input id="allegro-oferty-buforSzt" type="number" name="buforSzt" inputmode="numeric" value="0"[^>]* min="0" max="1000000" step="1"/);
 expect(r.body).toMatch(/<input id="allegro-oferty-progSkokuSzt" type="number" name="progSkokuSzt" inputmode="numeric" value="5"[^>]* min="1" max="1000000" step="1"/);
 const z=await f.zapisz({...poprawneAllegro,buforSzt:'-1',progSkokuSzt:'5'});
 expect(z.statusCode).toBe(400);
 expect(z.body).toContain(BUFOR_BLAD);
 expect(z.body).toMatch(/name="buforSzt"[^>]*value="-1"[^>]*aria-invalid="true"/);
 expect(ustawieniaOfertKonta(db!,'legacy').zapisane).toBe(false);
});

it('Allegro: zapis bufora i progu nie zmienia innych pól; CSRF i rola → 403',async()=>{
 const f=await allegro();wlaczIWylacz();
 expect((await f.zapisz({...poprawneAllegro,buforSzt:'0',progSkokuSzt:'5'})).statusCode).toBe(303);
 const {zmienionoAt:_a,buforSzt:_b,progSkokuSzt:_c,...przed}=ustawieniaOfertKonta(db!,'legacy') as any;
 expect((await f.zapisz({...poprawneAllegro,buforSzt:'1',progSkokuSzt:'2'},{origin:null})).statusCode).toBe(403);
 expect((await f.zapisz({...poprawneAllegro,buforSzt:'1',progSkokuSzt:'2'},{cookie:f.c.operator})).statusCode).toBe(403);
 expect(ustawieniaOfertKonta(db!,'legacy')).toMatchObject({buforSzt:0,progSkokuSzt:5});
 expect((await f.zapisz({...poprawneAllegro,buforSzt:'1',progSkokuSzt:'2'})).statusCode).toBe(303);
 const {zmienionoAt:_d,buforSzt,progSkokuSzt,...po}=ustawieniaOfertKonta(db!,'legacy') as any;
 expect({buforSzt,progSkokuSzt}).toEqual({buforSzt:1,progSkokuSzt:2});
 expect(po).toEqual(przed);
 expect(f.calls.filter(u=>!u.includes('/order/checkout-forms?'))).toEqual([]);
});

// ---------- Woo ----------

it('Woo: krok 6 „Stany” na pasku kroków szkicu; bez stanów sekcja mówi, że krok nic nie robi, i nie ma formularza',async()=>{
 const f=await woo();
 const szkic=await f.sklep('zapis',false);
 const s=await f.req('GET',f.adres(szkic));
 expect(s.body).toMatch(/<span class="step-dot" aria-hidden="true">6<\/span>\s*<span class="step-label">6\. Stany<\/span>/);
 const k=szkic;
 db!.prepare("UPDATE kanaly_sprzedazy SET autoryzacja='polaczone' WHERE klucz=?").run(k);
 const r=await f.req('GET',f.adres(k));
 expect(r.body).toContain('<h2>6. Stany</h2>');
 expect(r.body).toContain(WYLACZONE);
 expect(r.body).not.toContain('action="'+f.adres(k)+'/stany"');
 const z=await f.zapisz(k,{czynne:'czynne',buforSzt:'1',progSkokuSzt:'5'});
 expect(z.statusCode).toBe(400);
 expect(z.body).toContain(WYLACZONE);
 expect(ustawieniaOfertKonta(db!,k).zapisane).toBe(false);
});

it('Woo: po włączeniu stanów krok 6 domyślnie „wstrzymane”; zapis czynne, bufora i progu bez zmiany wersji sklepu',async()=>{
 const f=await woo();wlaczIWylacz();
 const k=await f.sklep('zapis');
 const r=await f.req('GET',f.adres(k));
 expect(r.body).toContain('<legend>Stany do sklepu: wstrzymane / czynne</legend>');
 expect(r.body).toMatch(/<input id="woo-stany-wstrzymane" type="radio" name="czynne" value="wstrzymane" checked/);
 expect(r.body).not.toMatch(/<input id="woo-stany-czynne"[^>]* checked/);
 expect(r.body).toMatch(/<input id="woo-stany-buforSzt" type="number" name="buforSzt" inputmode="numeric" value="0"[^>]* min="0" max="1000000" step="1"/);
 expect(r.body).not.toContain(WYLACZONE);
 const v=f.wersja(k);
 const z=await f.zapisz(k,{czynne:'czynne',buforSzt:'1',progSkokuSzt:'4'});
 expect(z.statusCode).toBe(303);
 expect(ustawieniaOfertKonta(db!,k)).toMatchObject({czynne:true,buforSzt:1,progSkokuSzt:4,aktorLogin:'admin'});
 expect(f.wersja(k)).toBe(v);
 expect((await f.req('GET',f.adres(k))).body).toMatch(/<input id="woo-stany-czynne" type="radio" name="czynne" value="czynne" checked/);
 const b=await f.zapisz(k,{czynne:'wstrzymane',buforSzt:'-1',progSkokuSzt:'4'});
 expect(b.statusCode).toBe(400);
 expect(b.body).toContain(BUFOR_BLAD);
 expect(ustawieniaOfertKonta(db!,k)).toMatchObject({czynne:true,buforSzt:1,progSkokuSzt:4});
});

it('Woo: klucz „Odczyt” → „klucz tylko do odczytu — stanów nie zapiszemy”; czynne odrzucone',async()=>{
 const f=await woo();wlaczIWylacz();
 const k=await f.sklep('odczyt');
 const r=await f.req('GET',f.adres(k));
 expect(r.body).toContain(ODCZYT);
 expect(r.body).toMatch(/<input id="woo-stany-czynne" type="radio" name="czynne" value="czynne" disabled/);
 const z=await f.zapisz(k,{czynne:'czynne',buforSzt:'1',progSkokuSzt:'5'});
 expect(z.statusCode).toBe(400);
 expect(z.body).toContain(ODCZYT);
 expect(ustawieniaOfertKonta(db!,k).czynne).toBe(false);
 expect(ustawieniaOfertKonta(db!,k).zapisane).toBe(false);
});

it('Woo: zapis kroku 6 bez Origin → 403, operator → 403; nic nie zapisane',async()=>{
 const f=await woo();wlaczIWylacz();
 const k=await f.sklep('zapis');
 expect((await f.zapisz(k,{czynne:'czynne',buforSzt:'1',progSkokuSzt:'5'},{origin:null})).statusCode).toBe(403);
 expect((await f.zapisz(k,{czynne:'czynne',buforSzt:'1',progSkokuSzt:'5'},{cookie:f.c.operator})).statusCode).toBe(403);
 expect(ustawieniaOfertKonta(db!,k).zapisane).toBe(false);
});
