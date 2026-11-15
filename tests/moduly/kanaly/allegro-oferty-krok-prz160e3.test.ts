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
import {gotowoscOfertAllegro} from '../../../src/moduly/kanaly/services/oferty-allegro-ustawienia.ts';

// PRZ-160 E3.13 (D15, D24, D35, D42): krok 6 „Oferty” konfiguratora Allegro — dane konta, których karta nie zna,
// listy „Pobierz z Allegro” i producent każdej marki na koncie. Wyłącznie atrapa HTTP i fixture; dane zmyślone.

const root='/ustawienia/integracje/allegro';
const slowniki=JSON.parse(readFileSync(new URL('../../fixtures/allegro/e3-dok-slowniki.json',import.meta.url),'utf8'));
const SCIEZKI:Record<string,string>={
 '/sale/shipping-rates':'cenniki','/after-sales-service-conditions/return-policies':'zwroty',
 '/after-sales-service-conditions/implied-warranties':'reklamacje','/after-sales-service-conditions/warranties':'gwarancje',
 '/sale/responsible-producers':'producenci','/sale/responsible-persons':'osoby',
};
const jwt=(scope:string[],konto='456')=>'fixture.'+Buffer.from(JSON.stringify({user_name:konto,scope})).toString('base64url')+'.fixture';
let a:Aplikacja|undefined,db:ReturnType<typeof openOmsDb>|undefined;
afterEach(async()=>{await a?.app.close();db?.close();a=undefined;db=undefined;vi.restoreAllMocks();});

async function setup(o:{zOfertami?:boolean}={}){
 let odmowa=false;
 const calls:string[]=[];
 const http=async(u:string)=>{
  calls.push(u);
  const sciezka=Object.keys(SCIEZKI).find(s=>new URL(u).pathname===s);
  if(sciezka){
   if(odmowa)return Response.json({errors:[{code:'AccessDenied',message:'SUROWY-BLAD-ALLEGRO'}]},{status:403});
   return Response.json(slowniki[SCIEZKI[sciezka]]);
  }
  if(u.includes('/order/checkout-forms?'))return Response.json({checkoutForms:[],totalCount:0});
  throw Error('Nieoczekiwane API: '+u);
 };
 const env={OMS_USER:'serwis',OMS_PASS:'fixture',OMS_TRYB:'proba',OMS_KANALY:'[]',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:'/tmp/prz160-proformy',OMS_ETYKIETY_KATALOG:'/tmp/prz160-etykiety'};
 const def=['legacy','allegro_polcien'].map(klucz=>({klucz,typ:'allegro' as const,prefiks:klucz.toUpperCase(),raport:klucz.toUpperCase()}));
 const m=createModulKanaly(def,false,{fetchImpl:(u,_i)=>http(String(u)),autoryzacjaAtrapy:{http,softwareStatementId:'',redirectUri:'http://localhost'+root+'/oauth/powrot',userAgent:'Fixture/1 (+https://example.invalid)'}});
 const kanal={...m,konfiguracja:()=>({...m.konfiguracja(env),kanaly:Object.fromEntries(def.map(d=>[d.klucz,{clientId:'app-public',clientSecret:'SECRET-BAIT',userAgent:'Fixture/1 (+https://example.invalid)',api:'https://api.allegro.pl',auth:'https://allegro.pl/auth/oauth',od:'2024-11-01T00:00:00Z'}]))})};
 db=openOmsDb();
 const bazowe=scopesAllegro.filter(s=>s!=='allegro:api:profile:read');
 for(const d of def)zapiszTokeny(db,d.klucz,{accessToken:jwt(o.zOfertami===false?bazowe:[...bazowe,...UPRAWNIENIA_OFERT],d.klucz==='legacy'?'123':'456'),refreshToken:'REFRESH-OLD',wygasaAt:'2099-01-01T00:00:00Z',refreshWygasaAt:'2099-02-01T00:00:00Z'});
 a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?kanal:x) as ModulOms[],env,teraz:()=>new Date('2026-11-14T12:00:00Z'),log:()=>{}});
 zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
 zalozKonto(db,{login:'operator',imie:'Operator',haslo:'fixture',rola:'sprzedaz',ekrany:['ustawienia']} as any);
 for(const marka of ['Lumena','Półcień Studio','Bez Wyboru'])db.prepare('INSERT INTO marki (nazwa, utworzona_at) VALUES (?, ?)').run(marka,'2026-11-01T00:00:00Z');
 const cookie=(login:string)=>'sesja_oms_proba='+podpisz(login,wczytajSekret(db),Date.now());
 const admin=cookie('admin');
 async function req(method:'GET'|'POST',path:string,payload?:Record<string,unknown>,auth=admin,origin='http://localhost'){
  const r=await a!.app.inject({method,url:path,headers:{accept:'text/html',cookie:auth,...(method==='POST'&&origin?{origin}:{}),...(payload?{'content-type':'application/x-www-form-urlencoded'}:{})},payload:payload?new URLSearchParams(Object.entries(payload).flatMap(([k,v])=>Array.isArray(v)?v.map(x=>[k,String(x)]):[[k,String(v)]])).toString():undefined});
  expect(r.body).not.toMatch(/SECRET-BAIT|REFRESH-OLD|SUROWY-BLAD-ALLEGRO|fixture\./);
  return r;
 }
 const slownikowe=()=>calls.filter(u=>Object.keys(SCIEZKI).includes(new URL(u).pathname));
 const gpsr=(konto:string)=>db!.prepare('SELECT marka,zrodlo,producent_id FROM allegro_marki_gpsr WHERE konto=? ORDER BY marka').all(konto).map((w:any)=>({...w}));
 return {req,cookie,calls,slownikowe,gpsr,ustawienia:(k:string)=>ustawieniaOfertKonta(db!,k),setOdmowa:(v:boolean)=>{odmowa=v;}};
}
const poprawne={czynne:'wstrzymane',narzutProcent:'12,5',progPotwierdzeniaProcent:'20',stalaIlosc:'3',czasWysylkiDni:'2',stawkaVat:'23',aktywujPoSprawdzeniu:'nie',bezpieczenstwoDomyslne:''};

it('krok 6 „Oferty”: steper, domyślnie wstrzymane i „Aktywuj po sprawdzeniu” = nie, stała ilość bez domyślnej, bez pola lokalizacji, bez wywołań Allegro',async()=>{
 const f=await setup();
 const r=await f.req('GET',root+'/legacy/oferty');
 expect(r.statusCode).toBe(200);
 expect(r.body).toMatch(/aria-current="step"[\s\S]*?6\. Oferty/);
 expect(r.body).toContain('href="'+root+'/legacy"');
 expect(r.body).toMatch(/<input[^>]*value="wstrzymane"[^>]*checked/);
 expect(r.body).not.toMatch(/<input[^>]*value="czynne"[^>]*checked/);
 expect(r.body).toMatch(/<input[^>]*name="aktywujPoSprawdzeniu"[^>]*value="nie"[^>]*checked/);
 expect(r.body).toMatch(/<input[^>]*name="stalaIlosc"[^>]*value=""[^>]*required/);
 expect(r.body).toMatch(/<textarea[^>]*name="bezpieczenstwoDomyslne"[^>]*maxlength="5000"/);
 expect(r.body).not.toMatch(/name="lokalizacja/);
 expect(r.body).toContain('Pobierz z Allegro');
 expect(f.calls).toEqual([]);
});

it('brak stałej ilości: gotowość odsyła do kroku „Oferty” konta; zapis bez ilości → 400 i nic nie zapisane',async()=>{
 const f=await setup();
 const g=gotowoscOfertAllegro(db!,'legacy');
 expect(g.gotowe).toBe(false);
 expect(g.braki).toContain('stała liczba sztuk');
 expect(g.krok).toBe(root+'/legacy/oferty');
 const r=await f.req('POST',root+'/legacy/oferty',{...poprawne,stalaIlosc:''});
 expect(r.statusCode).toBe(400);
 expect(r.body).toContain('Podaj stałą liczbę sztuk');
 expect(r.body).toMatch(/<input[^>]*name="stalaIlosc"[^>]*aria-invalid="true"/);
 expect(r.body).toMatch(/<input[^>]*name="czasWysylkiDni"[^>]*value="2"/);
 expect(f.ustawienia('legacy').zapisane).toBe(false);
 expect(gotowoscOfertAllegro(db!,'legacy').braki).toContain('stała liczba sztuk');
 const e=await f.req('GET',root+'/legacy/oferty');
 expect(e.body).toContain('stała liczba sztuk');
});

it('„Pobierz z Allegro” zapisuje sześć list konta (identyfikator i nazwa) i pokazuje je w wyborach',async()=>{
 const f=await setup();
 const p=await f.req('POST',root+'/legacy/oferty/pobierz');
 expect(p.statusCode).toBe(303);
 expect(p.headers.location).toBe(root+'/legacy/oferty?wynik=pobrano');
 expect(f.slownikowe().map(u=>new URL(u).pathname).sort()).toEqual(Object.keys(SCIEZKI).sort());
 const s=f.ustawienia('legacy').slowniki as any;
 expect(s.cenniki).toEqual([{id:'cennik-przyklad-1',nazwa:'Lampy — kurier'}]);
 expect(s.producenci).toEqual([{id:'producent-przyklad-1',nazwa:'Pracownia Półcień'}]);
 expect(f.ustawienia('allegro_polcien').slowniki).toBeNull();
 const r=await f.req('GET',root+'/legacy/oferty?wynik=pobrano');
 expect(r.body).toContain('Lampy — kurier');
 expect(r.body).toMatch(/<option value="producent-przyklad-1">Pracownia Półcień<\/option>/);
 expect(r.body).toContain('Listy konta pobrane z Allegro.');
});

it('odmowa Allegro przy pobieraniu → komunikat po polsku, zapisane wartości i listy nietknięte',async()=>{
 const f=await setup();
 await f.req('POST',root+'/legacy/oferty/pobierz');
 // E3d.02-02: cennik dostaw w tabeli reguł (pole „dla większych”), nie w polu cennikDostaw.
 expect((await f.req('POST',root+'/legacy/oferty',{...poprawne,cennikWiekszych:'cennik-przyklad-1'})).statusCode).toBe(303);
 const przed=f.ustawienia('legacy');
 f.setOdmowa(true);
 const r=await f.req('POST',root+'/legacy/oferty/pobierz');
 expect(r.statusCode).toBe(502);
 expect(r.body).toContain('Allegro odmówiło pobrania list konta. Zapisane ustawienia zostały bez zmian.');
 expect(f.ustawienia('legacy')).toEqual(przed);
});

it('identyfikator spoza pobranej listy → odmowa 400, nic nie zapisane; z listy → zapis z aktorem',async()=>{
 const f=await setup();
 const bezList=await f.req('POST',root+'/legacy/oferty',{...poprawne,cennikWiekszych:'cennik-obcy'});
 expect(bezList.statusCode).toBe(400);
 expect(f.ustawienia('legacy').zapisane).toBe(false);
 await f.req('POST',root+'/legacy/oferty/pobierz');
 const poPobraniu=f.ustawienia('legacy');
 for(const [pole,obcy] of [['cennikWiekszych','cennik-obcy'],['zwrotyId','zwrot-obcy'],['reklamacjeId','x'],['gwarancjaId','x'],['producentId','x'],['osobaOdpowiedzialnaId','x']]){
  const r=await f.req('POST',root+'/legacy/oferty',{...poprawne,[pole]:obcy});
  expect(r.statusCode,pole).toBe(400);
  expect(r.body,pole).toContain('Wybierz z listy pobranej z Allegro');
  expect(r.body,pole).toMatch(new RegExp(`<select[^>]*name="${pole}"[^>]*aria-invalid="true"`));
 }
 expect(f.ustawienia('legacy')).toEqual(poPobraniu);
 const ok=await f.req('POST',root+'/legacy/oferty',{...poprawne,czynne:'czynne',aktywujPoSprawdzeniu:'tak',bezpieczenstwoDomyslne:'Nie zostawiać włączonej lampy bez nadzoru.',
  cennikWiekszych:'cennik-przyklad-1',zwrotyId:'zwrot-przyklad-1',reklamacjeId:'reklamacja-przyklad-1',gwarancjaId:'',producentId:'producent-przyklad-1',osobaOdpowiedzialnaId:''});
 expect(ok.statusCode).toBe(303);
 expect(f.ustawienia('legacy')).toMatchObject({zapisane:true,czynne:true,narzutProcent:12.5,progPotwierdzeniaProcent:20,stalaIlosc:3,czasWysylkiDni:2,stawkaVat:'23',
  aktywujPoSprawdzeniu:true,bezpieczenstwoDomyslne:'Nie zostawiać włączonej lampy bez nadzoru.',cenniki:[{cennik:'cennik-przyklad-1'}],zwrotyId:'zwrot-przyklad-1',
  reklamacjeId:'reklamacja-przyklad-1',gwarancjaId:null,producentId:'producent-przyklad-1',osobaOdpowiedzialnaId:null,aktorLogin:'admin',zmienionoAt:'2026-11-14T12:00:00.000Z'});
 expect(ok.headers.location).toBe(root+'/legacy/oferty?wynik=zapisano');
 expect(gotowoscOfertAllegro(db!,'legacy')).toMatchObject({gotowe:true,braki:[]});
 const r=await f.req('GET',root+'/legacy/oferty?wynik=zapisano');
 expect(r.body).toContain('Ustawienia ofert zapisane.');
 expect(r.body).toMatch(/<option value="cennik-przyklad-1" selected>Lampy — kurier<\/option>/);
});

it('informacja o bezpieczeństwie ponad 5000 znaków → 400, nic nie zapisane',async()=>{
 const f=await setup();
 const r=await f.req('POST',root+'/legacy/oferty',{...poprawne,bezpieczenstwoDomyslne:'x'.repeat(5001)});
 expect(r.statusCode).toBe(400);
 expect(r.body).toMatch(/<textarea[^>]*name="bezpieczenstwoDomyslne"[^>]*aria-invalid="true"/);
 expect(f.ustawienia('legacy').zapisane).toBe(false);
});

it('drugie konto z env obsłużone tak samo, po własnym kluczu — pierwsze konto bez zmian',async()=>{
 const f=await setup();
 expect((await f.req('POST',root+'/allegro_polcien/oferty/pobierz')).statusCode).toBe(303);
 expect((await f.req('POST',root+'/allegro_polcien/oferty',{...poprawne,stalaIlosc:'7',producentId:'producent-przyklad-1',producentMarki:['konto','',''],marka:['Lumena','Półcień Studio','Bez Wyboru']})).statusCode).toBe(303);
 expect(f.ustawienia('allegro_polcien')).toMatchObject({stalaIlosc:7,aktorLogin:'admin'});
 expect(f.ustawienia('legacy').zapisane).toBe(false);
 expect(f.gpsr('allegro_polcien')).toEqual([{marka:'Lumena',zrodlo:'konto',producent_id:null}]);
 expect(f.gpsr('legacy')).toEqual([]);
});

it('tabela „Producent marki”: wybór konta albo producenta z listy; marka bez wyboru zostaje nieprzypisana',async()=>{
 const f=await setup();
 await f.req('POST',root+'/legacy/oferty/pobierz');
 const r0=await f.req('GET',root+'/legacy/oferty');
 for(const marka of ['Lumena','Półcień Studio','Bez Wyboru'])expect(r0.body).toContain(marka);
 expect(r0.body).toContain('Producent konta (marka własna)');
 const marka=['Bez Wyboru','Lumena','Półcień Studio'];
 expect((await f.req('POST',root+'/legacy/oferty',{...poprawne,marka,producentMarki:['','konto','producent-przyklad-1']})).statusCode).toBe(303);
 expect(f.gpsr('legacy')).toEqual([
  {marka:'Lumena',zrodlo:'konto',producent_id:null},
  {marka:'Półcień Studio',zrodlo:'wybrany',producent_id:'producent-przyklad-1'},
 ]);
 const r1=await f.req('GET',root+'/legacy/oferty');
 expect(r1.body).toMatch(/<option value="konto" selected>Producent konta \(marka własna\)<\/option>/);
 // Cofnięcie wyboru usuwa przypisanie — marka nie dostaje producenta konta.
 expect((await f.req('POST',root+'/legacy/oferty',{...poprawne,marka,producentMarki:['','','producent-przyklad-1']})).statusCode).toBe(303);
 expect(f.gpsr('legacy')).toEqual([{marka:'Półcień Studio',zrodlo:'wybrany',producent_id:'producent-przyklad-1'}]);
 // Producent spoza listy konta albo marka spoza słownika → odmowa, przypisania bez zmian.
 expect((await f.req('POST',root+'/legacy/oferty',{...poprawne,marka:['Lumena'],producentMarki:['producent-obcy']})).statusCode).toBe(400);
 expect((await f.req('POST',root+'/legacy/oferty',{...poprawne,marka:['Nieznana'],producentMarki:['konto']})).statusCode).toBe(400);
 expect(f.gpsr('legacy')).toEqual([{marka:'Półcień Studio',zrodlo:'wybrany',producent_id:'producent-przyklad-1'}]);
});

it('konto bez zgody na oferty: krok mówi D21, „Pobierz z Allegro” odmawia bez wywołań',async()=>{
 const f=await setup({zOfertami:false});
 const r=await f.req('GET',root+'/legacy/oferty');
 expect(r.statusCode).toBe(200);
 expect(r.body).toContain('To konto nie ma zgody na zapis ofert — połącz je ponownie');
 expect(r.body).not.toContain('Pobierz z Allegro');
 const p=await f.req('POST',root+'/legacy/oferty/pobierz');
 expect(p.statusCode).toBe(409);
 expect(p.body).toContain('To konto nie ma zgody na zapis ofert — połącz je ponownie');
 expect(f.slownikowe()).toEqual([]);
 expect(f.ustawienia('legacy').slowniki).toBeNull();
});

it('CSRF i rola: bez Origin, z obcym Origin i bez roli administratora → 403, bez wywołań i zapisów',async()=>{
 const f=await setup();
 for(const sciezka of ['oferty','oferty/pobierz']){
  const dane=sciezka==='oferty'?poprawne:{};
  expect((await f.req('POST',root+'/legacy/'+sciezka,dane,undefined,'')).statusCode).toBe(403);
  expect((await f.req('POST',root+'/legacy/'+sciezka,dane,undefined,'https://obcy.example')).statusCode).toBe(403);
  expect((await f.req('POST',root+'/legacy/'+sciezka,dane,f.cookie('operator'))).statusCode).toBe(403);
 }
 expect((await f.req('GET',root+'/legacy/oferty',undefined,f.cookie('operator'))).statusCode).toBe(403);
 expect(f.calls).toEqual([]);
 expect(f.ustawienia('legacy').zapisane).toBe(false);
 expect(f.gpsr('legacy')).toEqual([]);
});

it('nieznane konto → 404',async()=>{
 const f=await setup();
 expect((await f.req('GET',root+'/nie_ma/oferty')).statusCode).toBe(404);
});
