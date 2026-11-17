import {afterEach,expect,it,vi} from 'vitest';
import {zbudujAplikacje,type Aplikacja} from '../../../src/core/aplikacja.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {modulyPiaskownicy} from '../../../deploy/proba/atrapy/index.mjs';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {zalozKonto} from '../../../src/core/bezpieczenstwo/konta.js';
import {podpisz} from '../../../src/core/bezpieczenstwo/sesja.js';
import {wczytajSekret} from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import {fixtureAllegro,daneAllegro,aktorAllegro,scopesAllegro} from '../../pomoc/allegro-konfigurator.ts';
import type {ModulOms} from '../../../src/core/kontrakty.ts';
import {zapiszTokeny,wczytajTokeny} from '../../../src/oms/db/tokeny.js';
import {UPRAWNIENIA_OFERT} from '../../../src/domena/uprawnienia-kanalu.js';
import {UPRAWNIENIA_NOWEGO_POLACZENIA} from '../../../src/oms/allegro/oauth-code.ts';
import {migracjaTypuKanaluISklepow} from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import {zbudujUslugiKanalow} from '../../../src/moduly/kanaly/services/kompozycja-kanalow.ts';
import {konfiguracjaKanalow} from '../../../src/moduly/kanaly/konfiguracja.ts';

// PRZ-160 E3d.01: „Połącz ponownie z Allegro” dla konta połączonego w panelu. Dotychczasowe
// połączenie działa do końca; nowe tokeny zapisują się dopiero po zgodzie i tylko dla tego samego
// konta Allegro (to samo user.id) — bez przeglądu operacji. Inne konto, odmowa albo wygaśnięcie
// kodu niczego nie zmieniają.

const jwt=(scope:string[],konto='1000001')=>'fixture.'+Buffer.from(JSON.stringify({user_name:konto,scope})).toString('base64url')+'.fixture';
const bazowe=scopesAllegro.filter(s=>s!=='allegro:api:profile:read');
const bazy:ReturnType<typeof fixtureAllegro>[]=[];
let a:Aplikacja|undefined,db:ReturnType<typeof openOmsDb>|undefined;
afterEach(async()=>{await a?.app.close();db?.close();a=undefined;db=undefined;vi.restoreAllMocks();for(const f of bazy.splice(0))f.db.close();});

function setup(){
 const f=fixtureAllegro();bazy.push(f);migracjaTypuKanaluISklepow.wykonaj(f.db);
 let odmowa=false;
 const calls:{url:string;body:URLSearchParams}[]=[];
 const http=async(url:string,init:RequestInit={})=>{
  calls.push({url,body:new URLSearchParams(String(init.body??''))});
  if(url.endsWith('/device'))return Response.json({device_code:'DEVICE-POLCIEN',user_code:'ABC-123',verification_uri:'https://allegro.pl/skojarz',expires_in:600,interval:5});
  if(url.endsWith('/token')&&odmowa)return Response.json({error:'access_denied'},{status:400});
  return f.http(url,init);
 };
 const u=zbudujUslugiKanalow({db:f.db,konfiguracja:konfiguracjaKanalow([],{OMS_ALLEGRO_DEVICE_CLIENT_ID:'polcien-device-id',OMS_ALLEGRO_DEVICE_CLIENT_SECRET:'SEKRET-POLCIEN'}),teraz:f.teraz,log:vi.fn(),usluga:()=>()=>{}} as any,[],{fetchImpl:(url,i)=>http(String(url),i)});
 const r=u.repozytoriumKanalow;
 const sz=daneAllegro(r.utworzSzkic({nazwa:'Półcień',odUtc:'2026-10-31T23:00:00Z',srodowisko:'produkcja'},aktorAllegro));
 const k=daneAllegro(r.zapiszZmiane(sz.klucz,sz.wersja,{aplikacja:'device',autoryzacja:'polaczone',kontoId:'1000001',login:'polcien_test',pobieranie:'wlaczone'},aktorAllegro));
 zapiszTokeny(f.db,k.klucz,{accessToken:jwt(bazowe),refreshToken:'REFRESH-STARY',wygasaAt:'2099-01-01T00:00:00Z',refreshWygasaAt:'2099-02-01T00:00:00Z'},k.generacja);
 const wiersz=()=>f.db.prepare('SELECT * FROM kanaly_sprzedazy WHERE klucz=?').get(k.klucz);
 const tokeny=()=>{const t=wczytajTokeny(f.db,k.klucz);return t&&{access_token:t.access_token,refresh_token:t.refresh_token};};
 return {...f,...u,k,calls,wiersz,tokeny,setOdmowa:(v:boolean)=>{odmowa=v;}};
}
// „Sprawdź uprawnienia aplikacji” + „Chcę wystawiać oferty” — jedyna droga do ponownej zgody.
async function zgodaNaZadanie(p:ReturnType<typeof setup>){
 expect(daneAllegro(await p.ofertyAllegro.sprawdzAplikacje(p.k.klucz,aktorAllegro))).toEqual({oferty:true});
 daneAllegro(p.ofertyAllegro.chce(p.k.klucz,aktorAllegro));
}
const scopeStartu=(calls:{url:string;body:URLSearchParams}[])=>calls.filter(c=>c.url.endsWith('/device')).at(-1)!.body.get('scope')!.split(' ');

it('bez „Chcę wystawiać oferty” połączone konto z panelu nie wiąże się ponownie',async()=>{
 const p=setup();const przed=p.wiersz();
 // Aplikacja ma oferty, ale bez kliknięcia „Chcę wystawiać oferty” — nadal bez ponownej zgody.
 expect(daneAllegro(await p.ofertyAllegro.sprawdzAplikacje(p.k.klucz,aktorAllegro))).toEqual({oferty:true});
 expect(p.ofertyAllegro.stan(p.k.klucz)).toMatchObject({sciezka:'panel',zgoda:false,wolnoWiazac:false});
 expect(await p.autoryzacjaAllegro.rozpocznijDevice(p.k.klucz,aktorAllegro,'A')).toMatchObject({ok:false,kod:'konflikt'});
 expect(p.wiersz()).toEqual(przed);
});

it('to samo konto Allegro: stare tokeny działają do zgody, potem nowe — bez przeglądu operacji i bez zmian ustawień',async()=>{
 const p=setup();await zgodaNaZadanie(p);
 expect(p.ofertyAllegro.stan(p.k.klucz)).toMatchObject({sciezka:'panel',zgoda:false,chce:true,wolnoWiazac:true});
 // Data startu sprzed 12 miesięcy i duża historia nie blokują nowej zgody — import nie startuje od nowa.
 p.setCzas('2027-12-01T12:00:00Z');p.setCount(20000);
 const przed=p.wiersz(),tokenyPrzed=p.tokeny(),kanalPrzed=p.repozytoriumKanalow.pobierz(p.k.klucz)!;
 const start=daneAllegro(await p.autoryzacjaAllegro.rozpocznijDevice(p.k.klucz,aktorAllegro,'A'));
 expect(scopeStartu(p.calls)).toEqual([...UPRAWNIENIA_NOWEGO_POLACZENIA,...UPRAWNIENIA_OFERT]);
 expect(p.wiersz()).toEqual(przed);expect(p.tokeny()).toEqual(tokenyPrzed);
 p.setKonto('1000001');p.setScopes([...scopesAllegro,...UPRAWNIENIA_OFERT]);p.setCzas('2027-12-01T12:00:06Z');
 const para=daneAllegro(await p.autoryzacjaAllegro.sprawdzDevice(start.probaId,aktorAllegro,'A'));
 expect(para).toMatchObject({gotowe:true,kontoId:'1000001'});
 // Kandydat czeka w pamięci; połączenie i tokeny wciąż stare.
 expect(p.wiersz()).toEqual(przed);expect(p.tokeny()).toEqual(tokenyPrzed);
 const w=await p.zarzadzanieAllegro.aktywuj(p.k.klucz,start.probaId,para.gotowe?para.wersja:0,false,aktorAllegro,'A');
 expect(w).toMatchObject({ok:true,dane:{klucz:p.k.klucz,autoryzacja:'polaczone',aplikacja:'device',kontoId:'1000001',pobieranie:'wlaczone',generacja:kanalPrzed.generacja,generacjaImportu:kanalPrzed.generacjaImportu,odUtc:p.k.odUtc}});
 expect(p.tokeny()).toEqual({access_token:'ACCESS-WABIK',refresh_token:'REFRESH-WABIK'});
 expect(p.repozytoriumKanalow.zapisyZablokowane(p.k.klucz)).toBe(false);
});

it('inne konto Allegro: zgoda odrzucona, stare połączenie i tokeny bez zmian',async()=>{
 const p=setup();await zgodaNaZadanie(p);
 const przed=p.wiersz(),tokenyPrzed=p.tokeny();
 const start=daneAllegro(await p.autoryzacjaAllegro.rozpocznijDevice(p.k.klucz,aktorAllegro,'A'));
 p.setKonto('2000002');p.setCzas('2026-11-01T12:00:06Z');
 const w=await p.autoryzacjaAllegro.sprawdzDevice(start.probaId,aktorAllegro,'A');
 expect(w).toEqual({ok:false,kod:'konflikt',komunikat:'To inne konto Allegro niż podłączone — zgoda odrzucona'});
 expect(await p.zarzadzanieAllegro.aktywuj(p.k.klucz,start.probaId,p.k.wersja,false,aktorAllegro,'A')).toMatchObject({ok:false});
 expect(p.wiersz()).toEqual(przed);expect(p.tokeny()).toEqual(tokenyPrzed);
 expect(p.repozytoriumKanalow.zapisyZablokowane(p.k.klucz)).toBe(false);
});

it('aktywacja sama odrzuca kandydata innego konta, nawet z pominięciem sprawdzenia pary',async()=>{
 const p=setup();await zgodaNaZadanie(p);
 const przed=p.wiersz(),tokenyPrzed=p.tokeny();
 const start=daneAllegro(await p.autoryzacjaAllegro.rozpocznijDevice(p.k.klucz,aktorAllegro,'A'));
 p.setKonto('1000001');p.setScopes([...scopesAllegro,...UPRAWNIENIA_OFERT]);p.setCzas('2026-11-01T12:00:06Z');
 const para=daneAllegro(await p.autoryzacjaAllegro.sprawdzDevice(start.probaId,aktorAllegro,'A'));
 expect(para).toMatchObject({gotowe:true,kontoId:'1000001'});
 // Kandydat podstawiony wprost: ponowna zgoda, ale inne user.id niż podłączone.
 const pobierz=p.autoryzacjaAllegro.pobierzKandydata.bind(p.autoryzacjaAllegro);
 vi.spyOn(p.autoryzacjaAllegro,'pobierzKandydata').mockImplementation((id,sesja)=>{const c=pobierz(id,sesja);return c?{...c,kontoId:'2000002',login:'inne_konto'}:c;});
 const w=await p.zarzadzanieAllegro.aktywuj(p.k.klucz,start.probaId,para.gotowe?para.wersja:0,false,aktorAllegro,'A');
 expect(w).toEqual({ok:false,kod:'konflikt',komunikat:'Połączenie zostało zmienione.'});
 expect(p.wiersz()).toEqual(przed);expect(p.tokeny()).toEqual(tokenyPrzed);
 expect(p.repozytoriumKanalow.zapisyZablokowane(p.k.klucz)).toBe(false);
});

it('odmowa w Allegro albo wygaśnięcie kodu: nic się nie zmienia, można zacząć od nowa',async()=>{
 const p=setup();await zgodaNaZadanie(p);
 const przed=p.wiersz(),tokenyPrzed=p.tokeny();
 const s1=daneAllegro(await p.autoryzacjaAllegro.rozpocznijDevice(p.k.klucz,aktorAllegro,'A'));
 p.setOdmowa(true);p.setCzas('2026-11-01T12:00:06Z');
 expect(await p.autoryzacjaAllegro.sprawdzDevice(s1.probaId,aktorAllegro,'A')).toMatchObject({ok:false,kod:'ponow_autoryzacje'});
 expect(p.wiersz()).toEqual(przed);expect(p.tokeny()).toEqual(tokenyPrzed);
 p.setOdmowa(false);
 const s2=daneAllegro(await p.autoryzacjaAllegro.rozpocznijDevice(p.k.klucz,aktorAllegro,'A'));
 expect(s2.probaId).not.toBe(s1.probaId);
 p.setCzas('2026-11-01T12:11:00Z');
 expect(await p.autoryzacjaAllegro.sprawdzDevice(s2.probaId,aktorAllegro,'A')).toMatchObject({ok:false,kod:'ponow_autoryzacje'});
 expect(p.wiersz()).toEqual(przed);expect(p.tokeny()).toEqual(tokenyPrzed);
 expect(p.repozytoriumKanalow.zapisyZablokowane(p.k.klucz)).toBe(false);
});

it('ekran: „Chcę wystawiać oferty” → komunikat i kotwica, potem „Połącz ponownie z Allegro” bez zrywania połączenia',async()=>{
 const root='/ustawienia/integracje/allegro';
 let czas=new Date('2026-11-14T12:00:00Z');
 const calls:string[]=[];
 const http=async(u:string,i:RequestInit={})=>{
  calls.push(u);
  if(u.endsWith('/device'))return Response.json({device_code:'DEVICE-BAIT',user_code:'TEST-123',verification_uri:'https://allegro.pl/skojarz',expires_in:600,interval:5});
  if(u.endsWith('/auth/oauth/token'))return Response.json({access_token:jwt([...bazowe,...UPRAWNIENIA_OFERT]),refresh_token:'REFRESH-NOWY',expires_in:3600,scope:[...scopesAllegro,...UPRAWNIENIA_OFERT].join(' ')});
  if(u.endsWith('/me'))return Response.json({id:'1000001',login:'polcien_test'});
  if(u.includes('/order/checkout-forms?'))return Response.json({checkoutForms:[],totalCount:20000});
  throw Error('Nieoczekiwane API: '+u+String(i.method));
 };
 const env={OMS_USER:'serwis',OMS_PASS:'fixture',OMS_TRYB:'proba',OMS_KANALY:'[]',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:'/tmp/prz160-proformy',OMS_ETYKIETY_KATALOG:'/tmp/prz160-etykiety',OMS_ALLEGRO_DEVICE_CLIENT_ID:'polcien-device-id',OMS_ALLEGRO_DEVICE_CLIENT_SECRET:'SEKRET-BAIT'};
 const m=createModulKanaly([],false,{fetchImpl:(u,i)=>http(String(u),i),autoryzacjaAtrapy:{http,softwareStatementId:'',redirectUri:'http://localhost'+root+'/oauth/powrot',userAgent:'Fixture/1 (+https://example.invalid)'}});
 db=openOmsDb();
 a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?m:x) as ModulOms[],env,teraz:()=>czas,log:()=>{}});
 zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
 let cookie='sesja_oms_proba='+podpisz('admin',wczytajSekret(db),Date.now());
 const req=async(method:'GET'|'POST',path:string,payload?:Record<string,string>)=>{
  const r=await a!.app.inject({method,url:path,headers:{accept:'text/html',cookie,...(method==='POST'?{origin:'http://localhost'}:{})},payload});
  // Ciasteczko sesji konfiguratora (komunikat po przekierowaniu) jak w przeglądarce.
  for(const c of [r.headers['set-cookie']??[]].flat())if(!cookie.includes(c.split(';')[0]))cookie+='; '+c.split(';')[0];
  expect(r.body).not.toMatch(/SEKRET-BAIT|DEVICE-BAIT|REFRESH-STARY|fixture\./);
  return r;
 };
 const repo=a.usluga<any>('kanaly','repozytoriumKanalow');
 const sz=daneAllegro<any>(repo.utworzSzkic({nazwa:'Półcień',odUtc:'2026-10-31T23:00:00Z',srodowisko:'produkcja'},aktorAllegro));
 const k=daneAllegro<any>(repo.zapiszZmiane(sz.klucz,sz.wersja,{aplikacja:'device',autoryzacja:'polaczone',kontoId:'1000001',login:'polcien_test',pobieranie:'wlaczone'},aktorAllegro));
 zapiszTokeny(db,k.klucz,{accessToken:jwt(bazowe),refreshToken:'REFRESH-STARY',wygasaAt:'2099-01-01T00:00:00Z',refreshWygasaAt:'2099-02-01T00:00:00Z'},k.generacja);
 const adres=root+'/'+k.klucz;
 expect((await req('POST',adres+'/oferty-aplikacja')).statusCode).toBe(200);
 const c=await req('POST',adres+'/oferty-chce');
 expect(c.statusCode).toBe(303);expect(c.headers.location).toBe(adres+'#oferty-polacz');
 const ekran=await req('GET',adres);
 // Potwierdzenie stoi przy kotwicy (w kroku, do którego strona się przewija), nie na górze poza ekranem.
 const krok=ekran.body.match(/<li id="oferty-polacz">([\s\S]*?)<\/li>/)![1];
 expect(krok).toMatch(/^<p class="pas-potwierdzenie" role="status">Zapisano: chcesz wystawiać oferty z tego konta\./);
 expect(ekran.body.split('Zapisano: chcesz wystawiać oferty').length).toBe(2);
 expect(ekran.body).toContain('action="/ustawienia/kanaly/'+k.klucz+'/wiazanie"');
 expect(ekran.body).toContain('Połącz ponownie z Allegro');
 expect(ekran.body).not.toContain('Odłącz konto i połącz je ponownie');
 expect(ekran.body).not.toContain('dotychczasowe połączenie przestaje działać');
 // Komunikat znika po pierwszym wyświetleniu.
 expect((await req('GET',adres)).body).not.toContain('Zapisano: chcesz wystawiać oferty');
 const przed=repo.pobierz(k.klucz);
 const w=await req('POST','/ustawienia/kanaly/'+k.klucz+'/wiazanie');
 expect(w.statusCode).toBe(200);expect(w.body).toContain('TEST-123');
 expect(repo.pobierz(k.klucz)).toEqual(przed);
 expect(wczytajTokeny(db,k.klucz)?.refresh_token).toBe('REFRESH-STARY');
 // Zgoda w Allegro → „To moje konto — dalej” → krok 4 bez wyboru pobierania → „Zapisz nową zgodę”.
 const probaId=w.body.match(/name="probaId" value="([^"]+)"/)![1];
 czas=new Date(czas.getTime()+6000);
 expect((await req('POST',adres+'/zgoda',{probaId,wersja:String(przed.wersja)})).statusCode).toBe(200);
 expect(repo.pobierz(k.klucz)).toEqual(przed);
 expect((await req('POST',adres+'/potwierdz',{probaId,wersja:String(przed.wersja)})).statusCode).toBe(303);
 const krok4=await req('GET',adres);
 expect(krok4.body).toContain('Zapisz nową zgodę');
 expect(krok4.body).not.toContain('Pobieranie po zapisaniu');
 const wersja=krok4.body.match(/action="[^"]*\/aktywuj">\s*<input type="hidden" name="probaId" value="[^"]+"><input type="hidden" name="wersja" value="(\d+)"/)![1];
 expect((await req('POST',adres+'/aktywuj',{probaId,wersja,potwierdz:'tak',pobieraj:'nie'})).statusCode).toBe(303);
 const po=repo.pobierz(k.klucz);
 expect(po).toMatchObject({autoryzacja:'polaczone',pobieranie:'wlaczone',kontoId:'1000001',generacja:przed.generacja,generacjaImportu:przed.generacjaImportu,odUtc:przed.odUtc});
 expect(wczytajTokeny(db,k.klucz)?.refresh_token).toBe('REFRESH-NOWY');
 const stan=await req('GET',adres);
 expect(stan.body).not.toContain('OMS wstrzymuje zapisy do Allegro');expect(stan.body).toContain('Sprawdź operacje z niejednoznacznym wynikiem');
});
