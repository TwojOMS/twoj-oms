import {afterEach,it,expect,vi} from 'vitest';
import {fixtureAllegro,daneAllegro,aktorAllegro,scopesAllegro,callbackAllegro} from '../../pomoc/allegro-konfigurator.ts';
import {createAutoryzacjaAllegro} from '../../../src/moduly/kanaly/services/autoryzacja-allegro.ts';
import {migracjaTypuKanaluISklepow} from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import {zbudujUslugiKanalow} from '../../../src/moduly/kanaly/services/kompozycja-kanalow.ts';
import {konfiguracjaKanalow} from '../../../src/moduly/kanaly/konfiguracja.ts';
const bazy:ReturnType<typeof fixtureAllegro>[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const f of bazy.splice(0))f.db.close();});
function setup(){
 const f=fixtureAllegro();bazy.push(f);migracjaTypuKanaluISklepow.wykonaj(f.db);
 let pending=true;const calls:{url:string;init:RequestInit}[]=[];const log=vi.fn();
 const http=async(url:string,init:RequestInit={})=>{
  calls.push({url,init});
  if(url.endsWith('/device'))return Response.json({device_code:'DEVICE-POLCIEN',user_code:'ABC-123',verification_uri:'https://allegro.pl/skojarz',expires_in:600,interval:5});
  if(url.endsWith('/token')&&pending)return Response.json({error:'authorization_pending'},{status:400});
  if(url.endsWith('/me'))return Response.json({id:'1000001',login:'polcien_test'});
  return f.http(url,init);
 };
 const u=zbudujUslugiKanalow({db:f.db,konfiguracja:konfiguracjaKanalow([],{OMS_ALLEGRO_DEVICE_CLIENT_ID:'polcien-device-id',OMS_ALLEGRO_DEVICE_CLIENT_SECRET:'SEKRET-POLCIEN'}),teraz:f.teraz,log,usluga:()=>()=>{}} as any,[],{fetchImpl:(url,i)=>http(String(url),i)});
 const k=daneAllegro(u.repozytoriumKanalow.utworzSzkic({nazwa:'Półcień',odUtc:'2026-10-31T23:00:00Z',srodowisko:'produkcja'},aktorAllegro));
 return {...f,...u,k,calls,log,setPending:()=>{pending=false;}};
}
it('panel bez DCR: Device → pending → kandydat → aktywacja na aplikacji Device; sekret nie wycieka',async()=>{
 const logs=[vi.spyOn(console,'log').mockImplementation(()=>{}),vi.spyOn(console,'warn').mockImplementation(()=>{}),vi.spyOn(console,'error').mockImplementation(()=>{})];
 const f=setup(),auth=f.autoryzacjaAllegro;
 const start=daneAllegro(await auth.rozpocznijDevice(f.k.klucz,aktorAllegro,'A'));
 expect(daneAllegro(await auth.rozpocznijDevice(f.k.klucz,aktorAllegro,'A'))).toEqual(start);
 expect((await auth.rozpocznijDevice(f.k.klucz,aktorAllegro,'B')).ok).toBe(false);
 f.setCzas('2026-11-01T12:00:06Z');expect(daneAllegro(await auth.sprawdzDevice(start.probaId,aktorAllegro,'A'))).toMatchObject({gotowe:false});
 f.setPending();f.setCzas('2026-11-01T12:00:12Z');
 const para=daneAllegro(await auth.sprawdzDevice(start.probaId,aktorAllegro,'A'));
 expect(para).toMatchObject({gotowe:true,kontoId:'1000001',login:'polcien_test'});
 expect(f.repozytoriumKanalow.pobierz(f.k.klucz)).toMatchObject({autoryzacja:'oczekuje_potwierdzenia',aplikacja:'device'});
 expect(f.db.prepare('SELECT * FROM tokeny_kanalu').all()).toEqual([]);
 const aktywacja=await f.zarzadzanieAllegro.aktywuj(f.k.klucz,start.probaId,para.gotowe?para.wersja:0,false,aktorAllegro,'A');
 expect(aktywacja).toMatchObject({ok:true,dane:{aplikacja:'device',autoryzacja:'polaczone',login:'polcien_test'}});
 const startHttp=f.calls.find(c=>c.url.endsWith('/device'))!;
 expect(new Headers(startHttp.init.headers).get('Authorization')).toBe('Basic '+Buffer.from('polcien-device-id:SEKRET-POLCIEN').toString('base64'));
 expect(new URLSearchParams(String(startHttp.init.body)).get('scope')?.split(' ')).toEqual(scopesAllegro);
 expect(JSON.stringify([start,para,aktywacja,f.log.mock.calls,logs.map(l=>l.mock.calls),f.db.prepare('SELECT * FROM kanaly_audit').all()])).not.toMatch(/SEKRET-POLCIEN|DEVICE-POLCIEN|ACCESS-WABIK|REFRESH-WABIK/);
});
it('autoryzacja bez opcji userAgent wysyła domyślny TwojOMS na każdym żądaniu',async()=>{
 const f=setup();
 const start=daneAllegro(await f.autoryzacjaAllegro.rozpocznijDevice(f.k.klucz,aktorAllegro,'A'));
 f.setPending();f.setCzas('2026-11-01T12:00:06Z');
 expect((await f.autoryzacjaAllegro.sprawdzDevice(start.probaId,aktorAllegro,'A')).ok).toBe(true);
 expect(f.calls.length).toBeGreaterThanOrEqual(4);
 for(const c of f.calls)expect(new Headers(c.init.headers).get('User-Agent')).toMatch(/^TwojOMS\//);
});
it('zapiszZmiane odmawia zmiany aplikacji połączonego konta i pozostawia cały wiersz',()=>{
 const f=setup(),r=f.repozytoriumKanalow;
 const k=daneAllegro(r.zapiszZmiane(f.k.klucz,f.k.wersja,{aplikacja:'device',autoryzacja:'polaczone',kontoId:'1000001'},aktorAllegro));
 const przed=f.db.prepare('SELECT * FROM kanaly_sprzedazy WHERE klucz=?').get(k.klucz);
 for(const aplikacja of ['dcr',null] as const){
  expect(r.zapiszZmiane(k.klucz,k.wersja,{aplikacja,autoryzacja:'odlaczone'},aktorAllegro)).toMatchObject({ok:false});
  expect(f.db.prepare('SELECT * FROM kanaly_sprzedazy WHERE klucz=?').get(k.klucz)).toEqual(przed);
 }
});
it('nieudany start Device nie zmienia kanału i nie blokuje zmiany aplikacji',async()=>{
 const f=setup();const przed=f.db.prepare('SELECT * FROM kanaly_sprzedazy WHERE klucz=?').get(f.k.klucz);
 const auth=createAutoryzacjaAllegro({repozytorium:f.repozytoriumKanalow,aplikacjaDevice:()=>({clientId:'polcien-device-id',clientSecret:'SEKRET-POLCIEN',srodowisko:'produkcja'}),http:async()=>Response.json({error:'invalid_client'},{status:401}),userAgent:'TwojOMS/test',teraz:f.teraz} as any);
 expect(await auth.rozpocznijDevice(f.k.klucz,aktorAllegro,'A')).toMatchObject({ok:false});
 expect(f.db.prepare('SELECT * FROM kanaly_sprzedazy WHERE klucz=?').get(f.k.klucz)).toEqual(przed);
});
it('start Device na połączonym kanale z panelu daje konflikt i zostawia wiersz',async()=>{
 const f=setup(),r=f.repozytoriumKanalow;
 const k=daneAllegro(r.zapiszZmiane(f.k.klucz,f.k.wersja,{aplikacja:'device',autoryzacja:'polaczone',kontoId:'1000001'},aktorAllegro));
 const przed=f.db.prepare('SELECT * FROM kanaly_sprzedazy WHERE klucz=?').get(k.klucz);
 expect(await f.autoryzacjaAllegro.rozpocznijDevice(k.klucz,aktorAllegro,'A')).toMatchObject({ok:false,kod:'konflikt'});
 expect(f.db.prepare('SELECT * FROM kanaly_sprzedazy WHERE klucz=?').get(k.klucz)).toEqual(przed);
});
it('DCR po porzuconym starcie Device zapisuje aplikację dcr',async()=>{
 const f=fixtureAllegro();bazy.push(f);
 const http=async(url:string,init:RequestInit={})=>url.endsWith('/auth/oauth/device')?Response.json({device_code:'DEVICE-POLCIEN',user_code:'ABC-123',verification_uri:'https://allegro.pl/skojarz',expires_in:600,interval:5}):f.http(url,init);
 const auth=createAutoryzacjaAllegro({repozytorium:f.repo,aplikacjaDlaInstalacji:()=>f.app,aplikacjaDevice:()=>({clientId:'polcien-device-id',clientSecret:'SEKRET-POLCIEN',srodowisko:'produkcja'}),http,userAgent:'TwojOMS/test',teraz:f.teraz} as any);
 const k=f.szkic();
 expect((await auth.rozpocznijDevice(k.klucz,aktorAllegro,'A')).ok).toBe(true);
 expect(f.repo.pobierz(k.klucz)).toMatchObject({aplikacja:'device'});
 const p=daneAllegro(await auth.rozpocznijAutoryzacje(k.klucz,aktorAllegro,'A'));
 expect((await auth.obsluzPowrot({state:new URL(p.adres).searchParams.get('state')!,code:'kod',redirectUri:callbackAllegro},'A')).ok).toBe(true);
 expect(f.repo.pobierz(k.klucz)).toMatchObject({aplikacja:'dcr'});
});
it('zmiana aplikacji Device w trakcie /device unieważnia start i nie zmienia kanału',async()=>{
 const f=setup();const przed=f.db.prepare('SELECT * FROM kanaly_sprzedazy WHERE klucz=?').get(f.k.klucz);
 let app={clientId:'stara-app',clientSecret:'SEKRET-STARY',srodowisko:'produkcja'};let pusc:()=>void=()=>{};
 const http=async()=>{await new Promise<void>(r=>{pusc=r;});return Response.json({device_code:'DEVICE-POLCIEN',user_code:'ABC-123',verification_uri:'https://allegro.pl/skojarz',expires_in:600,interval:5});};
 const auth=createAutoryzacjaAllegro({repozytorium:f.repozytoriumKanalow,aplikacjaDevice:()=>app,http,userAgent:'TwojOMS/test',teraz:f.teraz} as any);
 const start=auth.rozpocznijDevice(f.k.klucz,aktorAllegro,'A');await new Promise(r=>setTimeout(r,0));
 app={...app,clientId:'nowa-app'};pusc();
 expect(await start).toMatchObject({ok:false,kod:'konflikt'});
 expect(f.db.prepare('SELECT * FROM kanaly_sprzedazy WHERE klucz=?').get(f.k.klucz)).toEqual(przed);
});
