import {afterEach,it,expect,vi} from 'vitest';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {migracjaKanalowSprzedazy} from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import {migracjaTypuKanaluISklepow} from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import {zbudujUslugiKanalow} from '../../../src/moduly/kanaly/services/kompozycja-kanalow.ts';
import {konfiguracjaKanalow} from '../../../src/moduly/kanaly/konfiguracja.ts';
import {UPRAWNIENIA_NOWEGO_POLACZENIA} from '../../../src/oms/allegro/oauth-code.ts';
import {wczytajKonfiguracjeIntegracji,zapiszKonfiguracjeIntegracji} from '../../../src/oms/db/konfiguracja-integracji.js';
import {readFileSync} from 'node:fs';
const para={clientId:'polcien-device-id',clientSecret:'SEKRET-POLCIEN'};
const aktor={id:1,login:'polcien_test'};
const bazy:ReturnType<typeof openOmsDb>[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const db of bazy.splice(0))db.close();});
function setup(status=200,env:Record<string,string>={},error=''){
 const db=openOmsDb();bazy.push(db);migracjaKanalowSprzedazy.wykonaj(db);migracjaTypuKanaluISklepow.wykonaj(db);
 const http=vi.fn(async()=>Response.json(status===200?{device_code:'KOD-DO-ODRZUCENIA',user_code:'KOD-UZYTKOWNIKA'}:{error,error_description:para.clientSecret},{status}));
 const log=vi.fn();const config=konfiguracjaKanalow([],env);
 const uslugi=zbudujUslugiKanalow({db,konfiguracja:config,teraz:()=>new Date(),log} as any,[],{fetchImpl:http});
 return {db,app:uslugi.aplikacjaAllegro,http,log,config};
}
it('bez env i bez wiersza nie ma aplikacji Device',async()=>{
 const {app,http}=setup();expect(app.stanAplikacji('produkcja')).toEqual({device:null,dcrGotowe:false});expect(app.aplikacjaDevice('produkcja')).toBeNull();
 for(const zle of [{...para,clientId:''},{...para,clientSecret:''},{...para,clientId:'id ze spacja'},{...para,clientSecret:'sekret\n'},{...para,clientId:'x'.repeat(201)},{...para,clientSecret:'x'.repeat(201)}])expect(await app.sprawdzIZapiszAplikacjeDevice('produkcja',zle,aktor)).toMatchObject({ok:false,kod:'walidacja'});
 expect(http).not.toHaveBeenCalled();
});
it('sprawdza dane raz, zapisuje panel i nie ujawnia sekretu ani kodów',async()=>{
 const consoleLog=vi.spyOn(console,'log').mockImplementation(()=>{}),consoleError=vi.spyOn(console,'error').mockImplementation(()=>{}),consoleWarn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 const {app,http,db,log}=setup();const wynik=await app.sprawdzIZapiszAplikacjeDevice('sandbox',para,aktor);
 expect(wynik).toEqual({ok:true,dane:{gotowa:true}});
 expect(http).toHaveBeenCalledTimes(1);
 const [url,init]=http.mock.calls[0] as unknown as [string,RequestInit];
 expect(url).toBe('https://allegro.pl.allegrosandbox.pl/auth/oauth/device');expect(init.method).toBe('POST');
 expect(new Headers(init.headers).get('Authorization')).toBe('Basic '+Buffer.from(para.clientId+':'+para.clientSecret).toString('base64'));
 expect(new URLSearchParams(String(init.body)).get('scope')).toBe(UPRAWNIENIA_NOWEGO_POLACZENIA.join(' '));
 expect(app.aplikacjaDevice('sandbox')).toEqual({...para,zrodlo:'panel'});
 const stan=app.stanAplikacji('sandbox');
 expect(JSON.stringify([wynik,stan,log.mock.calls,consoleLog.mock.calls,consoleError.mock.calls,consoleWarn.mock.calls,db.prepare('SELECT * FROM kanaly_audit').all()])).not.toContain(para.clientSecret);
 expect(stan).toEqual({device:{zrodlo:'panel',koncowkaId:'e-id'},dcrGotowe:false});
 expect(wczytajKonfiguracjeIntegracji(db,'allegro_aplikacja_device:sandbox')?.kontoLogin).toBe(aktor.login);
 expect(JSON.stringify(db.prepare('SELECT * FROM konfiguracja_integracji').all())).not.toMatch(/KOD-DO-ODRZUCENIA|KOD-UZYTKOWNIKA/);
 expect(app.aplikacjaDevice('produkcja')).toBeNull();
});
it('401 odrzuca dane aplikacji bez zapisu',async()=>{
 const {app,db,http}=setup(401,{},'invalid_client');const w=await app.sprawdzIZapiszAplikacjeDevice('produkcja',para,aktor);
 expect(w).toMatchObject({ok:false,kod:'dane_aplikacji'});expect(JSON.stringify(w)).not.toContain(para.clientSecret);expect(db.prepare('SELECT * FROM konfiguracja_integracji').all()).toEqual([]);
 http.mockResolvedValueOnce(Response.json({error:'invalid_client'},{status:400}));expect(await app.sprawdzIZapiszAplikacjeDevice('produkcja',para,aktor)).toMatchObject({ok:false,kod:'dane_aplikacji'});
 http.mockRejectedValueOnce(Error(para.clientSecret));const bladSieci=await app.sprawdzIZapiszAplikacjeDevice('produkcja',para,aktor);expect(bladSieci).toMatchObject({ok:false,kod:'tymczasowy'});expect(JSON.stringify(bladSieci)).not.toContain(para.clientSecret);
 http.mockResolvedValueOnce(Response.json({user_code:'sam-kod-uzytkownika'}));expect(await app.sprawdzIZapiszAplikacjeDevice('produkcja',para,aktor)).toMatchObject({ok:false,kod:'tymczasowy'});expect(db.prepare('SELECT * FROM konfiguracja_integracji').all()).toEqual([]);
});
it('400 unauthorized_client odrzuca typ aplikacji bez zapisu',async()=>{
 const {app,db}=setup(400,{},'unauthorized_client');expect(await app.sprawdzIZapiszAplikacjeDevice('produkcja',para,aktor)).toMatchObject({ok:false,kod:'typ_aplikacji'});expect(db.prepare('SELECT * FROM konfiguracja_integracji').all()).toEqual([]);
});
it('env wygrywa z panelem i odrzuca zapis bez HTTP',async()=>{
 const {app,db,http}=setup(200,{OMS_ALLEGRO_DEVICE_CLIENT_ID:para.clientId,OMS_ALLEGRO_DEVICE_CLIENT_SECRET:para.clientSecret,OMS_ALLEGRO_SANDBOX_DEVICE_CLIENT_ID:'sandbox-id',OMS_ALLEGRO_SANDBOX_DEVICE_CLIENT_SECRET:'sandbox-sekret'});
 zapiszKonfiguracjeIntegracji(db,'allegro_aplikacja_device:produkcja',{ustawienia:{},sekrety:{clientId:'stare-id',clientSecret:'stary-sekret'}});
 const przed=db.prepare('SELECT * FROM konfiguracja_integracji').all();
 expect(app.aplikacjaDevice('produkcja')).toEqual({...para,zrodlo:'env'});expect(app.aplikacjaDevice('sandbox')).toMatchObject({clientId:'sandbox-id',zrodlo:'env'});
 expect(await app.sprawdzIZapiszAplikacjeDevice('produkcja',para,aktor)).toMatchObject({ok:false,kod:'z_pliku'});expect(http).not.toHaveBeenCalled();expect(db.prepare('SELECT * FROM konfiguracja_integracji').all()).toEqual(przed);
});
it('połączone i oczekujące konto Device blokuje wymianę tylko w swoim środowisku',async()=>{
 const {app,db,http}=setup();
 db.prepare(`INSERT INTO kanaly_sprzedazy (klucz,nazwa,srodowisko,zrodlo,raport,autoryzacja,pobieranie,od_utc,wersja,generacja,generacja_importu,utworzono_at,zmieniono_at,aktor_id,aktor_login,aplikacja) VALUES ('allegro_polcien','Półcień','produkcja','panel','POLCIEN','polaczone','wylaczone','2026-11-01',0,0,0,'2026-11-01','2026-11-01',1,'polcien_test','device')`).run();
 for(const stan of ['polaczone','oczekuje_potwierdzenia']){db.prepare('UPDATE kanaly_sprzedazy SET autoryzacja=?').run(stan);expect(await app.sprawdzIZapiszAplikacjeDevice('produkcja',para,aktor)).toMatchObject({ok:false,kod:'w_uzyciu'});}
 expect(http).not.toHaveBeenCalled();expect((await app.sprawdzIZapiszAplikacjeDevice('sandbox',para,aktor)).ok).toBe(true);
 db.prepare("UPDATE kanaly_sprzedazy SET aplikacja='dcr'").run();expect((await app.sprawdzIZapiszAplikacjeDevice('produkcja',para,aktor)).ok).toBe(true);
});
it('domyślny User-Agent pochodzi z wersji produktu i spełnia wzorzec konfiguracji',async()=>{
 const {app,http,config}=setup();const version=JSON.parse(readFileSync(new URL('../../../package.json',import.meta.url),'utf8')).version;
 expect(config.userAgent).toBe(`TwojOMS/${version} (+https://twojoms.pl)`);
 expect(()=>konfiguracjaKanalow([{klucz:'allegro_polcien',typ:'allegro',prefiks:'POLCIEN'}],{POLCIEN_CLIENT_ID:'id',POLCIEN_CLIENT_SECRET:'sekret',POLCIEN_OD:'2026-11-01',POLCIEN_USER_AGENT:config.userAgent})).not.toThrow();
 await app.sprawdzIZapiszAplikacjeDevice('produkcja',para,aktor);expect(new Headers((http.mock.calls[0] as unknown as [string,RequestInit])[1].headers).get('User-Agent')).toBe(config.userAgent);
 expect(konfiguracjaKanalow([],{OMS_ALLEGRO_USER_AGENT:'Polcien/2 (+https://polcien.example)'}).userAgent).toBe('Polcien/2 (+https://polcien.example)');
 expect(()=>konfiguracjaKanalow([],{OMS_ALLEGRO_USER_AGENT:'zly'})).toThrow(/User-Agent/);
});
it('konto połączone w trakcie sprawdzania blokuje zapis (ponowne sprawdzenie po HTTP)',async()=>{
 const {app,db,http}=setup();
 http.mockImplementationOnce(async()=>{db.prepare(`INSERT INTO kanaly_sprzedazy (klucz,nazwa,srodowisko,zrodlo,raport,autoryzacja,pobieranie,od_utc,wersja,generacja,generacja_importu,utworzono_at,zmieniono_at,aktor_id,aktor_login,aplikacja) VALUES ('allegro_polcien','Półcień','produkcja','panel','POLCIEN','polaczone','wylaczone','2026-11-01',0,0,0,'2026-11-01','2026-11-01',1,'polcien_test','device')`).run();return Response.json({device_code:'KOD',user_code:'U'});});
 expect(await app.sprawdzIZapiszAplikacjeDevice('produkcja',para,aktor)).toMatchObject({ok:false,kod:'w_uzyciu'});
 expect(db.prepare('SELECT * FROM konfiguracja_integracji').all()).toEqual([]);
});
it('niepełna para Device w pliku konfiguracji nazywa brakującą zmienną',()=>{
 expect(()=>konfiguracjaKanalow([],{OMS_ALLEGRO_DEVICE_CLIENT_ID:'id'})).toThrow(/OMS_ALLEGRO_DEVICE_CLIENT_SECRET/);
 expect(()=>konfiguracjaKanalow([],{OMS_ALLEGRO_SANDBOX_DEVICE_CLIENT_SECRET:'s'})).toThrow(/OMS_ALLEGRO_SANDBOX_DEVICE_CLIENT_ID/);
});
