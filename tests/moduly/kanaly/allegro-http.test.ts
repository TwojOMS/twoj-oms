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
import {zapiszTokeny} from '../../../src/oms/db/tokeny.js';

const root='/ustawienia/integracje/allegro';
const callback='http://localhost'+root+'/oauth/powrot';
let a:Aplikacja,db:ReturnType<typeof openOmsDb>;
afterEach(async()=>{await a?.app.close();db?.close();});
async function setup(legacy=false,ssi=true,zTokenami=false,kontoTokenu?:string,od='2024-11-01T00:00:00Z'){
 let czas=new Date('2026-11-01T12:00:00Z'),meStatus=200;const calls:string[]=[];
 const http=async(u:string,i:RequestInit={})=>{
  calls.push(u);
  if(u.endsWith('/register'))return Response.json({client_id:'app-public',client_secret:'SECRET-BAIT',client_name:JSON.parse(String(i.body)).client_name,redirect_uris:[callback],software_statement_id:'ssi',grant_types:['authorization_code','refresh_token']},{status:201});
  if(u.endsWith('/device'))return Response.json({device_code:'DEVICE-BAIT',user_code:'TEST-123',verification_uri:'https://allegro.pl/skojarz',expires_in:600,interval:5});
  if(u.endsWith('/token'))return Response.json({access_token:kontoTokenu===undefined?'ACCESS-BAIT':'fixture.'+Buffer.from(JSON.stringify({user_name:kontoTokenu})).toString('base64url')+'.fixture',refresh_token:'REFRESH-BAIT',expires_in:3600,scope:scopesAllegro.filter(s=>!legacy||s!=='allegro:api:profile:read').join(' ')});
  if(u.endsWith('/me'))return Response.json({id:'123',login:'TestoweKonto',email:'PRIVATE-BAIT'},{status:meStatus});
  if(u.includes('/order/checkout-forms?'))return Response.json({checkoutForms:[],totalCount:0});
  throw Error('Nieoczekiwane API');
 };
 const env={OMS_USER:'serwis',OMS_PASS:'fixture',OMS_TRYB:'proba',OMS_KANALY:'[]',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:'/tmp/prz128-proformy',OMS_ETYKIETY_KATALOG:'/tmp/prz128-etykiety'};
 const def=legacy?['legacy',...(zTokenami?['allegro_polcien']:[])].map(klucz=>({klucz,typ:'allegro' as const,prefiks:klucz.toUpperCase(),raport:klucz.toUpperCase()})):[];
 const m=createModulKanaly(def,false,{fetchImpl:(u,i)=>http(String(u),i),autoryzacjaAtrapy:{http,softwareStatementId:ssi?'ssi':'',redirectUri:callback,userAgent:'Fixture/1 (+https://example.invalid)'}});
 // Klucze są wyłącznie fikcyjne; walidacja trybu próby blokuje klucze env w normalnym składaczu.
 const kanal={...m,konfiguracja:()=>({...m.konfiguracja(env),kanaly:Object.fromEntries(def.map(d=>[d.klucz,{clientId:'app-public',clientSecret:'SECRET-BAIT',userAgent:'Fixture/1 (+https://example.invalid)',api:'https://api.allegro.pl',auth:'https://allegro.pl/auth/oauth',od}]))})};
 db=openOmsDb();
 if(zTokenami)for(const d of def)zapiszTokeny(db,d.klucz,{accessToken:'fixture.'+Buffer.from(JSON.stringify({user_name:d.klucz==='legacy'?'123':'456',scope:scopesAllegro.filter(s=>s!=='allegro:api:profile:read')})).toString('base64url')+'.fixture',refreshToken:'REFRESH-OLD',wygasaAt:'2099-01-01T00:00:00Z',refreshWygasaAt:'2099-02-01T00:00:00Z'});
 a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?kanal:x) as ModulOms[],env,teraz:()=>czas,log:()=>{}});
 zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
 zalozKonto(db,{login:'operator',imie:'Operator',haslo:'fixture',rola:'sprzedaz',ekrany:['ustawienia']} as any);
 const cookie=(login:string,t=Date.now())=>'sesja_oms_proba='+podpisz(login,wczytajSekret(db),t);
 const admin=cookie('admin');let flow='';
 async function req(method:'GET'|'POST',path:string,payload?:Record<string,unknown>,auth=admin,origin:string|undefined='http://localhost',referer?:string){
  const r=await a.app.inject({method,url:path,headers:{accept:'text/html',cookie:[auth,flow].filter(Boolean).join('; '),...(method==='POST'&&origin?{origin}:{}),...(referer?{referer}:{})},payload});
  const cookies=[r.headers['set-cookie']??[]].flat();const c=cookies.find(c=>c.startsWith('oms_allegro_flow='));if(c)flow=c.split(';')[0];
  expect(r.body).not.toMatch(/SECRET-BAIT|DEVICE-BAIT|ACCESS-BAIT|REFRESH-BAIT|PRIVATE-BAIT/);
  return r;
 }
 const repo=a.usluga<any>('kanaly','repozytoriumKanalow');
 let formularzId='';
 async function draft(nazwa='Konto główne'){
  const page=await req('GET',root+'/nowe');formularzId=page.body.match(/name="formularzId" value="([^"]+)"/)?.[1]??'';
  const r=await req('POST',root+'/szkice',{formularzId,nazwa,od:'2026-11-01',srodowisko:'produkcja'});
  expect(r.statusCode).toBe(303);return r.headers.location!.split('/').pop()!;
 }
 async function candidate(k:string){
  const r=await req('POST',root+'/'+k+'/autoryzacja',{wersja:String(repo.pobierz(k).wersja)});
  expect(r.statusCode).toBe(303);const state=new URL(r.headers.location!).searchParams.get('state')!;
  const cb=await req('GET',root+'/oauth/powrot?state='+state+'&code=CODE-BAIT');
  expect(cb.statusCode).toBe(303);expect(cb.headers.location).toBe(root+'/'+k);expect(cb.headers['referrer-policy']).toBe('strict-origin');
  const page=await req('GET',cb.headers.location!);expect(page.body).toContain('TestoweKonto');
  const proba=page.body.match(/name="probaId" value="([^"]+)"/)?.[1];expect(proba).toBeTruthy();
  expect((await req('POST',root+'/'+k+'/potwierdz',{probaId:proba,wersja:String(repo.pobierz(k).wersja)})).statusCode).toBe(303);
  return {probaId:proba!,wersja:String(repo.pobierz(k).wersja),potwierdz:'tak',pobieraj:'nie'};
 }
 return {calls,repo,req,draft,candidate,cookie,formularz:()=>formularzId,setCzas:(t:string)=>{czas=new Date(t);},setMeStatus:(n:number)=>{meStatus=n;}};
}

it('data startu z formularza: walidacja dnia, wersji, uprawnień i CSRF przed zapisem',async()=>{
 const f=await setup(),k=await f.draft('Pracownia Półcień'),url=root+'/'+k+'/data-startu';
 const payload={wersja:String(f.repo.pobierz(k).wersja),od:'2026-10-30'};
 expect((await f.req('POST',url,payload,f.cookie('operator'))).statusCode).toBe(403);
 expect((await f.req('POST',url,payload,undefined,'')).statusCode).toBe(403);
 expect((await f.req('POST',url,{...payload,od:'nigdy'})).statusCode).toBe(400);
 expect((await f.req('POST',url,{...payload,wersja:'999'})).statusCode).toBe(409);
 expect((await f.req('POST',url,payload)).statusCode).toBe(303);
 expect(f.repo.pobierz(k).odUtc).toBe('2026-10-29T23:00:00.000Z');expect(f.calls).toEqual([]);
});
it('tylko administrator: także operator z dostępem do Ustawień ma 403; CSRF nie tworzy szkicu',async()=>{
 const f=await setup();
 expect((await f.req('GET',root+'/nowe',undefined,f.cookie('operator'))).statusCode).toBe(403);
 expect((await f.req('POST',root+'/szkice',{nazwa:'x'},f.cookie('operator'))).statusCode).toBe(403);
 expect((await f.req('POST',root+'/szkice',{nazwa:'x'},undefined,'https://obca.invalid')).statusCode).toBe(403);
 expect(f.repo.lista()).toEqual([]);expect(f.calls).toEqual([]);
});
it('strict-origin zachowuje źródło formularza; sam Referer działa, Origin null pozostaje zabroniony',async()=>{
 const f=await setup();const page=await f.req('GET',root+'/nowe');
 expect(page.headers['referrer-policy']).toBe('strict-origin');
 const formularzId=page.body.match(/name="formularzId" value="([^"]+)"/)![1];
 const payload={formularzId,nazwa:'Półcień',od:'2026-11-01',srodowisko:'produkcja'};
 expect((await f.req('POST',root+'/szkice',payload,undefined,'null')).statusCode).toBe(403);
 expect((await f.req('POST',root+'/szkice',payload,undefined,'null','http://localhost/')).statusCode).toBe(403);
 // Przeglądarka pomijająca Origin przesyła z strict-origin sam origin w Referer.
 expect((await f.req('POST',root+'/szkice',payload,undefined,'','http://localhost/')).statusCode).toBe(303);
});
it('dwa kanały env startują bez rejestru; Device Flow nie zatrzymuje dostępu, pollera ani health',async()=>{
 const f=await setup(true,true,true);
 db.prepare("UPDATE tokeny_kanalu SET refresh_wygasa_at=? WHERE kanal='legacy'").run(new Date(Date.now()+3*86400000).toISOString());
 expect(db.prepare('SELECT * FROM kanaly_sprzedazy').all()).toEqual([]);
 const klienci=a.usluga<any>('kanaly','klienciKanalow'),poller=a.usluga<any>('kanaly','poller');
 expect(Object.keys(klienci).sort()).toEqual(['allegro_polcien','legacy']);
 await poller.przebieg();
 expect(db.prepare('SELECT sklep FROM stan_pollera ORDER BY sklep').all()).toEqual([{sklep:'allegro_polcien'},{sklep:'legacy'}]);
 const health=await f.req('GET','/health');expect(health.statusCode).toBe(200);
 expect(health.body).toContain('legacy');expect(health.body).toContain('allegro_polcien');
 const before=f.repo.pobierz('legacy');
 const tokenyPrzed=db.prepare('SELECT * FROM tokeny_kanalu ORDER BY kanal').all();
 await f.req('GET',root+'/legacy');
 const start=await f.req('POST','/ustawienia/kanaly/legacy/wiazanie');
 expect(start.statusCode).toBe(200);expect(start.body).toContain('TEST-123');
 expect(f.repo.pobierz('legacy')).toEqual(before);
 expect(db.prepare('SELECT * FROM tokeny_kanalu ORDER BY kanal').all()).toEqual(tokenyPrzed);
 expect(Object.keys(klienci).sort()).toEqual(['allegro_polcien','legacy']);
 const calls=f.calls.length;await poller.przebieg();expect(f.calls.slice(calls).filter(u=>u.includes('/order/checkout-forms?'))).toHaveLength(2);
 expect((await f.req('GET','/health')).body).toContain('legacy');
});
it('ponowna aktywacja jednego z dwóch env działa także gdy drugie konto nie ma profile:read',async()=>{
 const f=await setup(true,true,true,'123');f.setMeStatus(403);
 db.prepare("UPDATE tokeny_kanalu SET refresh_wygasa_at=? WHERE kanal='legacy'").run(new Date(Date.now()+3*86400000).toISOString());
 await f.req('GET',root+'/legacy');
 const start=await f.req('POST','/ustawienia/kanaly/legacy/wiazanie');
 const probaId=start.body.match(/name="probaId" value="([^"]+)"/)![1];
 f.setCzas('2026-11-01T12:00:06Z');
 expect((await f.req('POST',root+'/legacy/zgoda',{probaId})).statusCode).toBe(200);
 expect((await f.req('POST',root+'/legacy/potwierdz',{probaId,wersja:String(f.repo.pobierz('legacy').wersja)})).statusCode).toBe(303);
 expect((await f.req('POST',root+'/legacy/aktywuj',{probaId,wersja:'0',potwierdz:'tak',pobieraj:'nie'})).statusCode).toBe(303);
 expect(f.repo.lista().map((k:any)=>[k.klucz,k.pobieranie])).toEqual([['legacy','wlaczone'],['allegro_polcien','wlaczone']]);
});
it('zdrowy kanał env odmawia Device Flow bez wywołania HTTP',async()=>{
 const f=await setup(true,true,true);const przed=f.calls.length;
 expect(a.usluga<any>('kanaly','stanyKanalow')().find((s:any)=>s.kanal==='legacy').wolnoWiazac).toBe(false);
 const r=await f.req('POST','/ustawienia/kanaly/legacy/wiazanie');
 expect(r.statusCode).toBe(403);expect(f.calls).toHaveLength(przed);
 expect(db.prepare('SELECT * FROM kanaly_sprzedazy').all()).toEqual([]);
});
it.each(['wlaczone','wylaczone'])('env: odłącz i przywróć zachowuje parę i pobieranie %s bez Device Flow',async pobieranie=>{
 const f=await setup(true,true,true);const k='legacy';
 if(pobieranie==='wylaczone')expect(f.repo.zapiszZmiane(k,0,{pobieranie},{id:1,login:'admin'}).ok).toBe(true);
 const przed=f.calls.length,tokeny=db.prepare('SELECT * FROM tokeny_kanalu ORDER BY kanal').all();
 expect((await f.req('POST',root+'/'+k+'/odlacz',{wersja:String(f.repo.pobierz(k).wersja),potwierdz:'tak'})).statusCode).toBe(303);
 const page=await f.req('GET',root+'/'+k);expect(page.body).toContain('Przywróć połączenie');
 expect(page.body).toContain('<dt>Pobieranie zamówień</dt><dd>Wyłączone</dd>');
 expect(Object.keys(a.usluga<any>('kanaly','klienciKanalow'))).not.toContain(k);
 const payload={wersja:String(f.repo.pobierz(k).wersja)};
 expect((await f.req('POST',root+'/'+k+'/przywroc',payload,f.cookie('operator'))).statusCode).toBe(403);
 expect((await f.req('POST',root+'/'+k+'/przywroc',payload,undefined,'https://obca.invalid')).statusCode).toBe(403);
 expect((await f.req('POST',root+'/'+k+'/przywroc',{wersja:'999'})).statusCode).toBe(409);
 expect((await f.req('POST',root+'/'+k+'/przywroc',payload)).statusCode).toBe(303);
 expect(f.repo.pobierz(k)).toMatchObject({autoryzacja:'polaczone',pobieranie});
 expect(db.prepare('SELECT * FROM tokeny_kanalu ORDER BY kanal').all()).toEqual(tokeny);
 expect(f.calls).toHaveLength(przed);
 expect(Object.keys(a.usluga<any>('kanaly','klienciKanalow'))).toContain(k);
 const calls=f.calls.length;await a.usluga<any>('kanaly','poller').przebieg();
 expect(f.calls.slice(calls).filter(u=>u.includes('/order/checkout-forms?'))).toHaveLength(pobieranie==='wlaczone'?2:1);
});
it('kanał panelu nie oferuje przywracania z konfiguracji i odrzuca trasę',async()=>{
 const f=await setup(),k=await f.draft();
 expect(f.repo.zapiszZmiane(k,f.repo.pobierz(k).wersja,{autoryzacja:'odlaczone'},{id:1,login:'admin'}).ok).toBe(true);
 expect((await f.req('GET',root+'/'+k)).body).not.toContain('Przywróć połączenie');
 expect((await f.req('POST',root+'/'+k+'/przywroc',{wersja:String(f.repo.pobierz(k).wersja)})).statusCode).toBe(403);
 expect(f.calls).toEqual([]);
});
it('env bez zachowanej pary: przywrócenie wraca do stanu przed zgodą i Device Flow znów działa',async()=>{
 const f=await setup(true);const k='legacy';
 expect((await f.req('POST',root+'/'+k+'/odlacz',{wersja:'0',potwierdz:'tak'})).statusCode).toBe(303);
 expect((await f.req('POST',root+'/'+k+'/przywroc',{wersja:String(f.repo.pobierz(k).wersja)})).statusCode).toBe(303);
 expect(f.repo.pobierz(k).autoryzacja).toBe('brak');expect(f.calls).toEqual([]);
 expect((await f.req('POST','/ustawienia/kanaly/legacy/wiazanie')).statusCode).toBe(200);
});
it.each([
 ['2024-11-01T00:00:00Z','wlaczone'],
 ['2026-11-01T00:00:00Z','wlaczone'],
 ['2026-11-01T00:00:00Z','wylaczone'],
] as const)('env aktywuje %s bez profile:read i zachowuje pobieranie %s przy znanym ID',async(od,pobieranie)=>{
 const f=await setup(true,true,false,undefined,od);
 expect(f.repo.zapiszZmiane('legacy',0,{kontoId:'123',pobieranie}, {id:1,login:'admin'}).ok).toBe(true);
 await f.req('GET',root+'/legacy');
 const start=await f.req('POST','/ustawienia/kanaly/legacy/wiazanie');
 expect(start.statusCode).toBe(200);
 const probaId=start.body.match(/name="probaId" value="([^"]+)"/)![1];
 f.setCzas('2026-11-01T12:00:06Z');
 const zgoda=await f.req('POST',root+'/legacy/zgoda',{probaId});expect(zgoda.statusCode).toBe(200);expect(zgoda.body).toContain('Potwierdź konto');
 expect((await f.req('POST',root+'/legacy/potwierdz',{probaId,wersja:String(f.repo.pobierz('legacy').wersja)})).statusCode).toBe(303);
 const r=await f.req('POST',root+'/legacy/aktywuj',{probaId,wersja:String(f.repo.pobierz('legacy').wersja),potwierdz:'tak',pobieraj:'nie'});
 expect(r.statusCode).toBe(303);
 expect(f.repo.pobierz('legacy')).toMatchObject({odUtc:od,kontoId:'123',autoryzacja:'polaczone',pobieranie});
 expect(db.prepare('SELECT kanal FROM tokeny_kanalu').all()).toEqual([{kanal:'legacy'}]);
});
it.each(['123','999',''])('env bez prawa /me: tożsamość nowej pary %s musi pasować do znanego ID',async konto=>{
 const f=await setup(true,true,false,konto);
 f.repo.zapiszZmiane('legacy',0,{kontoId:'123'}, {id:1,login:'admin'});
 f.setMeStatus(403);await f.req('GET',root+'/legacy');
 const start=await f.req('POST','/ustawienia/kanaly/legacy/wiazanie');
 const probaId=start.body.match(/name="probaId" value="([^"]+)"/)![1];
 f.setCzas('2026-11-01T12:00:06Z');
 const zgoda=await f.req('POST',root+'/legacy/zgoda',{probaId});
 if(konto!=='123'){
  expect(zgoda.statusCode).toBeGreaterThanOrEqual(400);
  expect(db.prepare('SELECT kanal FROM tokeny_kanalu').all()).toEqual([]);return;
 }
 expect(zgoda.statusCode).toBe(200);expect(zgoda.body).toContain('Potwierdź konto');
 expect((await f.req('POST',root+'/legacy/potwierdz',{probaId,wersja:String(f.repo.pobierz('legacy').wersja)})).statusCode).toBe(303);
 expect((await f.req('POST',root+'/legacy/aktywuj',{probaId,wersja:String(f.repo.pobierz('legacy').wersja),potwierdz:'tak',pobieraj:'nie'})).statusCode).toBe(303);
 const sprawdz=await f.req('POST',root+'/legacy/sprawdz',{wersja:String(f.repo.pobierz('legacy').wersja)});
 expect(sprawdz.statusCode).toBe(200);expect(sprawdz.body).toContain('Brak uprawnienia do odczytu profilu');
 expect(sprawdz.body).toContain('Odczyt zamówień działa');
});
it('szkic ma datę warszawską, jest odporny na podwójne wysłanie i nie wykonuje HTTP',async()=>{
 const f=await setup(),k=await f.draft();
 expect(f.repo.pobierz(k)).toMatchObject({odUtc:'2026-10-31T23:00:00.000Z',pobieranie:'wylaczone'});
 const r=await f.req('POST',root+'/szkice',{formularzId:f.formularz(),nazwa:'Konto główne',od:'2026-11-01',srodowisko:'produkcja'});
 expect(r.headers.location).toBe(root+'/'+k);expect(f.repo.lista()).toHaveLength(1);expect(f.calls).toEqual([]);
 expect((await f.req('POST',root+'/szkice',{nazwa:'',od:'nigdy',srodowisko:'produkcja'})).statusCode).toBe(400);
});
it('brak SSI daje odmowę bez rejestracji; statyczne adresy nie trafiają do kanału',async()=>{
 const f=await setup(false,false);await f.req('GET',root+'/nowe');
 const r=await f.req('POST',root+'/aplikacja',{kod:'CODE-BAIT',srodowisko:'produkcja'});
 expect(r.statusCode).toBe(403);expect(r.body).not.toContain('CODE-BAIT');expect(f.calls).toEqual([]);
 expect((await f.req('GET',root+'/nowe')).statusCode).toBe(200);
 expect((await f.req('GET',root+'/oauth/powrot?state=nieznany&code=CODE-BAIT')).statusCode).toBe(303);
});
it('OAuth kończy się potwierdzeniem konta, nie aktywną parą; osobny POST wymaga zgody',async()=>{
 const f=await setup(),k=await f.draft();
 await f.req('POST',root+'/aplikacja',{kod:'CODE-BAIT',srodowisko:'produkcja'});
 const p=await f.candidate(k);
 expect(db.prepare('SELECT count(*) AS n FROM tokeny_kanalu').get()).toEqual({n:0});
 expect((await f.req('POST',root+'/'+k+'/aktywuj',{...p,potwierdz:'nie'})).statusCode).toBe(400);
 expect((await f.req('POST',root+'/'+k+'/aktywuj',p)).statusCode).toBe(303);
 expect(f.repo.pobierz(k)).toMatchObject({kontoId:'123',login:'TestoweKonto',autoryzacja:'polaczone',pobieranie:'wylaczone'});
 expect(db.prepare('SELECT count(*) AS n FROM tokeny_kanalu').get()).toEqual({n:1});
});
it('stary formularz i obca sesja nie aktywują kandydata; callback nie ujawnia kodu w HTML',async()=>{
 const f=await setup(),k=await f.draft();await f.req('POST',root+'/aplikacja',{kod:'CODE-BAIT',srodowisko:'produkcja'});const p=await f.candidate(k);
 expect((await f.req('POST',root+'/'+k+'/aktywuj',p,f.cookie('admin',Date.now()-10000))).statusCode).toBe(409);
 expect((await f.req('POST',root+'/'+k+'/aktywuj',{...p,wersja:'0'})).statusCode).toBe(409);
 const r=await f.req('GET',root+'/oauth/powrot?state=zly&code=CODE-BAIT');expect(r.body).not.toContain('CODE-BAIT');
 expect(db.prepare('SELECT count(*) AS n FROM tokeny_kanalu').get()).toEqual({n:0});
});
it('nazwa jest escapowana, stara wersja daje 409, test połączenia nie importuje',async()=>{
 const f=await setup(),k=await f.draft('<script>alert(1)</script>');
 const page=await f.req('GET',root+'/'+k);expect(page.body).toContain('&lt;script&gt;');expect(page.body).not.toContain('<script>alert(1)</script>');
 const v=String(f.repo.pobierz(k).wersja);expect((await f.req('POST',root+'/'+k+'/nazwa',{wersja:v,nazwa:'Nowa nazwa'})).statusCode).toBe(303);
 expect((await f.req('POST',root+'/'+k+'/nazwa',{wersja:v,nazwa:'Stara karta'})).statusCode).toBe(409);
 await f.req('POST',root+'/aplikacja',{kod:'CODE-BAIT',srodowisko:'produkcja'});const p=await f.candidate(k);await f.req('POST',root+'/'+k+'/aktywuj',p);
 const before=f.calls.length;const r=await f.req('POST',root+'/'+k+'/sprawdz',{wersja:String(f.repo.pobierz(k).wersja)});
 expect(r.statusCode).toBe(200);expect(r.body).toContain('Odczyt konta i zamówień działa');expect(f.calls.slice(before).filter(u=>u.includes('/order/checkout-forms?'))).toHaveLength(1);
 expect(db.prepare('SELECT count(*) AS n FROM zamowienia').get()).toEqual({n:0});expect(db.prepare('SELECT * FROM stan_pollera').all()).toEqual([]);
});
it('stary endpoint Device Flow pokazuje kod i potwierdzenie; nie uruchamia dawnego automatycznego zapisu',async()=>{
 const f=await setup(true);await f.req('GET',root+'/legacy');
 const start=await f.req('POST','/ustawienia/kanaly/legacy/wiazanie');expect(start.statusCode).toBe(200);expect(start.body).toContain('TEST-123');
 const probaId=start.body.match(/name="probaId" value="([^"]+)"/)?.[1];expect(probaId).toBeTruthy();
 f.setCzas('2026-11-01T12:00:06Z');const r=await f.req('POST',root+'/legacy/zgoda',{probaId});
 expect(r.statusCode).toBe(200);expect(r.body).toContain('TestoweKonto');expect(r.body).toContain('Potwierdź konto');
 expect(db.prepare('SELECT count(*) AS n FROM tokeny_kanalu').get()).toEqual({n:0});
});
it('przygotowanie aplikacji z ekranu szkicu wraca do tego samego konta',async()=>{
 const f=await setup(),k=await f.draft();
 const przed=await f.req('GET',root+'/'+k);expect(przed.body).toContain('name="kod"');
 const r=await f.req('POST',root+'/aplikacja',{kanal:k,kod:'CODE-BAIT',srodowisko:'produkcja'});
 expect(r.headers.location).toBe(root+'/'+k);
 const po=await f.req('GET',root+'/'+k);expect(po.body).not.toContain('name="kod"');
 expect(f.repo.lista()).toHaveLength(1);expect(f.repo.pobierz(k).autoryzacja).toBe('brak');
});
it('pauza, wznowienie i odłączenie pozostawiają historię, a ponowne połączenie blokuje zaległe zapisy',async()=>{
 const f=await setup(),k=await f.draft();await f.req('POST',root+'/aplikacja',{kod:'CODE-BAIT',srodowisko:'produkcja'});
 const p=await f.candidate(k);await f.req('POST',root+'/'+k+'/aktywuj',p);
 const zmien=async(akcja:string,dane:Record<string,unknown>)=>f.req('POST',root+'/'+k+'/'+akcja,{wersja:String(f.repo.pobierz(k).wersja),...dane});
 expect((await zmien('pobieranie',{wlaczone:'tak'})).statusCode).toBe(303);expect(f.repo.pobierz(k).pobieranie).toBe('wlaczone');
 await zmien('pobieranie',{wlaczone:'nie'});expect(f.repo.pobierz(k).pobieranie).toBe('wylaczone');
 const przed=f.calls.length;await zmien('odlacz',{potwierdz:'tak'});expect(f.calls).toHaveLength(przed);
 expect(f.repo.pobierz(k).autoryzacja).toBe('odlaczone');expect(db.prepare('SELECT count(*) AS n FROM tokeny_kanalu').get()).toEqual({n:0});
 const q=await f.candidate(k);await f.req('POST',root+'/'+k+'/aktywuj',q);expect(f.repo.pobierz(k).pobieranie).toBe('wylaczone');
 expect(f.repo.zapisyZablokowane(k)).toBe(true);
 const r=await zmien('przeglad',{});expect(r.statusCode).toBe(200);
 const przegladId=r.body.match(/name="przegladId" value="([^"]+)"/)?.[1];expect(przegladId).toBeTruthy();
 const post=await f.req('POST',root+'/'+k+'/zapisy',{przegladId,potwierdz:'tak'});expect(post.statusCode).toBe(303);expect(f.repo.zapisyZablokowane(k)).toBe(false);
 expect(f.repo.pobierz(k).pobieranie).toBe('wylaczone');
});
it('Moje połączenia pokazują skonfigurowane i odłączone konto oraz zachowują ostatni udany test po błędzie',async()=>{
 const f=await setup(),k=await f.draft('Moje testowe Allegro');await f.req('POST',root+'/aplikacja',{kod:'CODE-BAIT',srodowisko:'produkcja'});
 const p=await f.candidate(k);await f.req('POST',root+'/'+k+'/aktywuj',p);
 await f.req('POST',root+'/'+k+'/sprawdz',{wersja:String(f.repo.pobierz(k).wersja)});
 f.setCzas('2026-11-01T12:05:00Z');f.setMeStatus(503);expect((await f.req('POST',root+'/'+k+'/sprawdz',{wersja:String(f.repo.pobierz(k).wersja)})).statusCode).toBe(503);
 const d=db.prepare('SELECT ostatnia_proba_at,ostatni_sukces_at,blad FROM kanaly_diagnostyka WHERE kanal=?').get(k);
 expect(d).toEqual({ostatnia_proba_at:'2026-11-01T12:05:00.000Z',ostatni_sukces_at:'2026-11-01T12:00:00.000Z',blad:1});
 const przed=await f.req('GET','/ustawienia/integracje');expect(przed.body).toContain(root+'/'+k);expect(przed.body).toContain('TestoweKonto');
 await f.req('POST',root+'/'+k+'/odlacz',{wersja:String(f.repo.pobierz(k).wersja),potwierdz:'tak'});
 const po=await f.req('GET','/ustawienia/integracje');expect(po.body).toContain('Moje testowe Allegro');expect(po.body).toContain(root+'/'+k);expect(po.body).toMatch(/<details class="pol-wstrzymane"[\s\S]*Moje testowe Allegro[\s\S]*Wyłączone/);
 const katalog=await f.req('GET','/ustawienia/integracje/katalog');expect(katalog.body).toContain(root+'/nowe');
});
const tresc=(html:string)=>html.slice(html.indexOf('<div class="allegro-konfiguracja">'));
it('B3, U21–U22: ekran dodawania nie mówi naraz „krok 0 zrobione” i „Najpierw załóż aplikację”; jeden „Dalej”',async()=>{
 const f=await setup();
 const przyciskiDalej=(html:string)=>html.match(/<button[^>]*>\s*Dalej/g)??[];
 const bez=await f.req('GET',root+'/nowe');
 expect(bez.body).toContain('Najpierw załóż aplikację');expect(bez.body).not.toContain('Aplikacja Allegro — zrobione');expect(przyciskiDalej(bez.body)).toHaveLength(1);
 expect((await f.req('POST',root+'/aplikacja-urzadzenia',{srodowisko:'produkcja',clientId:'app-device',clientSecret:'fixture-device'})).statusCode).toBe(200);
 const po=await f.req('GET',root+'/nowe');
 expect(po.body).toContain('Aplikacja Allegro — zrobione');expect(po.body).not.toContain('Najpierw załóż aplikację');expect(przyciskiDalej(po.body)).toHaveLength(1);
});
it('PRZ-146.05 (B1): bez aplikacji bieżący jest krok 0; z aplikacją w jednym środowisku start od 1 i ostrzeżenie przy drugim',async()=>{
 const f=await setup();
 const biezacy=(html:string)=>html.match(/class="step current" aria-current="step">\s*<span class="step-dot" aria-hidden="true">(\d)</)?.[1];
 const ostrzezenie=(html:string,s:string)=>html.match(new RegExp(`<p class="ust-uwaga" data-bez-aplikacji="${s}"( hidden)?[^>]*>([\\s\\S]*?)</p>`));
 const bez=await f.req('GET',root+'/nowe');
 expect(biezacy(bez.body)).toBe('0');expect(bez.body).toContain('<strong>0. Aplikacja Allegro</strong>');
 expect(bez.body).toContain('<h2>0. Aplikacja Allegro</h2>');expect(bez.body).toContain('Najpierw załóż aplikację Allegro (krok 0).');
 expect(bez.body).toMatch(/name="formularzId" value="[^"]+"/);
 expect((await f.req('POST',root+'/aplikacja-urzadzenia',{srodowisko:'produkcja',clientId:'app-device',clientSecret:'fixture-device'})).statusCode).toBe(200);
 const po=await f.req('GET',root+'/nowe');
 expect(biezacy(po.body)).toBe('1');expect(po.body).toContain('0. Aplikacja Allegro — zrobione');expect(po.body).not.toContain('<h2>0. Aplikacja Allegro</h2>');
 expect(ostrzezenie(po.body,'produkcja')).toBeNull();
 const ukryte=ostrzezenie(po.body,'sandbox')!;expect(ukryte).toBeTruthy();expect(ukryte[1]).toBe(' hidden');
 expect(ukryte[2]).toContain(`href="${root}/aplikacja?srodowisko=sandbox"`);
 const form=po.body.match(/name="formularzId" value="([^"]+)"/)![1];
 const r=await f.req('POST',root+'/szkice',{formularzId:form,nazwa:'Konto testowe',od:'2026-11-01',srodowisko:'sandbox'});expect(r.statusCode).toBe(303);
 const krok1=await f.req('GET',r.headers.location!+'/krok-1');
 expect(krok1.body).toMatch(/value="sandbox" selected/);
 const widoczne=ostrzezenie(krok1.body,'sandbox')!;expect(widoczne).toBeTruthy();expect(widoczne[1]).toBeUndefined();
 expect(widoczne[2]).toContain(`href="${root}/aplikacja?srodowisko=sandbox"`);
});
it('U24–U27: działające konto ma tytuł „Allegro: nazwa”, stan zamiast stepera, „Odłącz” jako przycisk niebezpieczny (B9); główny przycisk tylko przy problemie',async()=>{
 const f=await setup(),k=await f.draft('Półcień');await f.req('POST',root+'/aplikacja',{kod:'CODE-BAIT',srodowisko:'produkcja'});
 const p=await f.candidate(k);await f.req('POST',root+'/'+k+'/aktywuj',p);
 await f.req('POST',root+'/'+k+'/sprawdz',{wersja:String(f.repo.pobierz(k).wersja)});
 const ok=await f.req('GET',root+'/'+k);
 expect(ok.body).toContain('<h1>Allegro: Półcień</h1>');expect(ok.body).not.toContain('class="stepper"');
 expect(ok.body).toContain('Ostatni odczyt');expect(ok.body).toMatch(/class="ust-przycisk grozny"[^>]*>Odłącz konto/);expect(tresc(ok.body)).not.toContain('btn--glowny');
 f.setCzas('2026-11-01T12:05:00Z');f.setMeStatus(503);
 const bl=await f.req('POST',root+'/'+k+'/sprawdz',{wersja:String(f.repo.pobierz(k).wersja)});expect(bl.body).toContain('nie odpowiada');
 const problem=await f.req('GET',root+'/'+k);expect(problem.body).toMatch(/class="btn btn--glowny"[^>]*>Sprawdź połączenie/);
});
it('G16a: zapis przy zatrzymywanym pobieraniu wraca na ekran kanału, nie gołym tekstem 202',async()=>{
 const f=await setup(true);
 expect(f.repo.zapiszZmiane('legacy',0,{kontoId:'123',pobieranie:'zatrzymywanie'},{id:1,login:'admin'}).ok).toBe(true);
 const r=await f.req('POST',root+'/legacy/nazwa',{nazwa:'Pracownia Półcień',wersja:String(f.repo.pobierz('legacy').wersja)});
 expect(r.statusCode).toBe(303);expect(r.headers.location).toBe(root+'/legacy');
 const ekran=await f.req('GET',root+'/legacy');
 expect(ekran.statusCode).toBe(200);expect(ekran.body).toContain('Zatrzymywanie');
});
