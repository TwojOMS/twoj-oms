import {afterEach,expect,it,vi} from 'vitest';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {migracjaKanalowSprzedazy} from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import {migracjaTypuKanaluISklepow} from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import {createAplikacjaAllegro} from '../../../src/moduly/kanaly/services/aplikacja-allegro.ts';
import {UPRAWNIENIA_NOWEGO_POLACZENIA} from '../../../src/oms/allegro/oauth-code.ts';
import {OPISY_UPRAWNIEN} from '../../../src/moduly/kanaly/instrukcja-aplikacji-allegro.ts';

const para={clientId:'fikcyjne-id',clientSecret:'TAJNY-FIKCYJNY-SEKRET'};
const aktor={id:1,login:'test'};
const kodDevice='NIEZAPISANY-KOD-DEVICE';
const bazy:ReturnType<typeof openOmsDb>[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const db of bazy.splice(0))db.close();});
const odpowiedz=(error:string)=>Response.json({error,error_description:para.clientSecret,device_code:kodDevice},{status:400});
function setup(error:string,braki:readonly string[]=[],awaria=false,inna?:(scope:string)=>Response|undefined){
 const db=openOmsDb();bazy.push(db);migracjaKanalowSprzedazy.wykonaj(db);migracjaTypuKanaluISklepow.wykonaj(db);
 const log=vi.spyOn(console,'warn').mockImplementation(()=>{});
 const http=vi.fn(async(_url:string,init?:RequestInit)=>{
  const scope=new URLSearchParams(String(init?.body)).get('scope')!;
  if(scope.includes(' '))return odpowiedz(error);
  const r=inna?.(scope);if(r)return r;
  if(awaria&&scope===UPRAWNIENIA_NOWEGO_POLACZENIA[2])throw Error(para.clientSecret);
  return braki.includes(scope)?odpowiedz('invalid_scope'):Response.json({device_code:kodDevice});
 });
 const app=createAplikacjaAllegro({db,http,softwareStatementId:'',redirectUri:''});
 return {db,http,log,app};
}
const typ='Ta aplikacja nie obsługuje łączenia kodem — załóż nową aplikację i w polu typu zaznacz „bez dostępu do przeglądarki albo klawiatury”.';
const uprawnienia='Aplikacja nie ma wszystkich uprawnień. W Zarządzanie aplikacjami zaznacz wszystkie z listy w kroku 0 i zapisz.';
it.each(['unauthorized_client','unsupported_grant_type'])('%s oznacza zły typ aplikacji',async error=>{
 const {app,http,log}=setup(error);
 expect(await app.sprawdzIZapiszAplikacjeDevice('sandbox',para,aktor)).toMatchObject({ok:false,kod:'typ_aplikacji',komunikat:typ});
 expect(http).toHaveBeenCalledTimes(1);expect(log).toHaveBeenCalledWith(error);
});
it.each([['sandbox','Sandbox'],['produkcja','sprzedażowe']] as const)('invalid_client wskazuje środowisko %s',async(s,nazwa)=>{
 const {app,log}=setup('invalid_client');
 expect(await app.sprawdzIZapiszAplikacjeDevice(s,para,aktor)).toMatchObject({ok:false,kod:'dane_aplikacji',komunikat:`Client ID albo sekret nie pasują do środowiska ${nazwa} — sprawdź, czy aplikacja jest założona w tym środowisku.`});
 expect(log).toHaveBeenCalledWith('invalid_client');
});
it('inne 400 pokazuje tylko kod błędu',async()=>{
 const {app,log}=setup('invalid_request');const w=await app.sprawdzIZapiszAplikacjeDevice('sandbox',para,aktor);
 expect(w).toMatchObject({ok:false,kod:'tymczasowy'});expect('komunikat' in w&&w.komunikat).toContain('(invalid_request)');
 expect(JSON.stringify([w,log.mock.calls])).not.toMatch(/TAJNY-FIKCYJNY-SEKRET|NIEZAPISANY-KOD-DEVICE|error_description/);
});
it.each(['',para.clientSecret,'invalid_request\n'+para.clientSecret,'<script>','x'.repeat(100)])('nie wypisuje niepoprawnego pola error: %s',async error=>{
 const {app,log}=setup(error);const w=await app.sprawdzIZapiszAplikacjeDevice('sandbox',para,aktor);
 expect(w).toMatchObject({ok:false,kod:'tymczasowy'});expect(log).toHaveBeenCalledWith('unknown_error');
 expect(JSON.stringify([w,log.mock.calls])).not.toMatch(/TAJNY-FIKCYJNY-SEKRET|NIEZAPISANY-KOD-DEVICE|<script>/);
});
const sekcje=['Zamówienia i obsługa posprzedażowa','Zamówienia i obsługa posprzedażowa','Zarządzanie ofertami','Zarządzanie przesyłkami','Zarządzanie przesyłkami','Zarządzanie wiadomościami','Zamówienia i obsługa posprzedażowa','Dane osobowe'];
it.each([{indeksy:[7]},{indeksy:[0,2,3,4,5,6,7]},{indeksy:[]}])('invalid_scope ustala braki $indeksy kolejno, bez zapisu kodów',async({indeksy})=>{
 const braki=indeksy.map(i=>UPRAWNIENIA_NOWEGO_POLACZENIA[i]);const {app,http,db,log}=setup('invalid_scope',braki);
 const w=await app.sprawdzIZapiszAplikacjeDevice('sandbox',para,aktor);
 expect(w).toMatchObject({ok:false,komunikat:uprawnienia});
 expect(!w.ok&&w.brakujace||[]).toEqual(indeksy.map(i=>({nazwa:UPRAWNIENIA_NOWEGO_POLACZENIA[i],opis:OPISY_UPRAWNIEN[UPRAWNIENIA_NOWEGO_POLACZENIA[i]],sekcja:sekcje[i]})));
 expect(http).toHaveBeenCalledTimes(9);
 expect(http.mock.calls.slice(1).map(([,init])=>new URLSearchParams(String(init?.body)).get('scope'))).toEqual([...UPRAWNIENIA_NOWEGO_POLACZENIA]);
 for(const [url,init] of http.mock.calls){expect(url).toBe('https://allegro.pl.allegrosandbox.pl/auth/oauth/device');expect(init?.signal).toBeInstanceOf(AbortSignal);}
 expect(db.prepare('SELECT * FROM konfiguracja_integracji').all()).toEqual([]);
 expect(JSON.stringify([w,log.mock.calls])).not.toMatch(/TAJNY-FIKCYJNY-SEKRET|NIEZAPISANY-KOD-DEVICE/);
});
it('błąd sieci w trakcie diagnostyki daje komunikat o uprawnieniach bez częściowej listy',async()=>{
 const {app,log}=setup('invalid_scope',[UPRAWNIENIA_NOWEGO_POLACZENIA[0]],true);
 const w=await app.sprawdzIZapiszAplikacjeDevice('sandbox',para,aktor);
 expect(w).toMatchObject({ok:false,komunikat:uprawnienia});expect(!w.ok&&w.brakujace||[]).toEqual([]);
 expect(JSON.stringify([w,log.mock.calls])).not.toMatch(/TAJNY-FIKCYJNY-SEKRET|NIEZAPISANY-KOD-DEVICE/);
});
it.each([[429,'too_many_requests'],[400,'invalid_request'],[500,'server_error']])('PRZ-146.04: odpowiedź %i (%s) w trakcie sprawdzania nie daje listy braków',async(status,error)=>{
 const braki=[UPRAWNIENIA_NOWEGO_POLACZENIA[7]];
 const {app,db}=setup('invalid_scope',braki,false,scope=>scope===UPRAWNIENIA_NOWEGO_POLACZENIA[1]?Response.json({error},{status}):undefined);
 const w=await app.sprawdzIZapiszAplikacjeDevice('sandbox',para,aktor);
 expect(w).toMatchObject({ok:false,kod:'tymczasowy',komunikat:uprawnienia});
 expect(!w.ok&&w.brakujace||[]).toEqual([]);
 expect(db.prepare('SELECT * FROM konfiguracja_integracji').all()).toEqual([]);
});
// PRZ-148.06 (1): sprawdzenie aplikacji ma jeden łączny limit czasu, nie 9 × 30 s.
it('PRZ-148.06: wolne Allegro — po łącznym limicie przerywa sprawdzanie bez listy braków',async()=>{
 const db=openOmsDb();bazy.push(db);migracjaKanalowSprzedazy.wykonaj(db);migracjaTypuKanaluISklepow.wykonaj(db);
 vi.spyOn(console,'warn').mockImplementation(()=>{});
 const http=vi.fn((_url:string,init?:RequestInit)=>new Promise<Response>((ok,zle)=>{
  const t=setTimeout(()=>ok(odpowiedz('invalid_scope')),60);
  init?.signal?.addEventListener('abort',()=>{clearTimeout(t);zle(init.signal!.reason);},{once:true});
 }));
 const app=createAplikacjaAllegro({db,http,softwareStatementId:'',redirectUri:'',limitSprawdzaniaMs:150});
 const start=Date.now(),w=await app.sprawdzIZapiszAplikacjeDevice('sandbox',para,aktor);
 expect(w).toMatchObject({ok:false,kod:'tymczasowy',komunikat:uprawnienia});expect(!w.ok&&w.brakujace||[]).toEqual([]);
 expect(http.mock.calls.length).toBeLessThan(9);expect(Date.now()-start).toBeLessThan(400);
 for(const [,init] of http.mock.calls)expect(init?.signal).toBeInstanceOf(AbortSignal);
 expect(db.prepare('SELECT * FROM konfiguracja_integracji').all()).toEqual([]);
});
it('PRZ-148.06: pierwsze zapytanie wisi — łączny limit kończy je komunikatem tymczasowym',async()=>{
 const db=openOmsDb();bazy.push(db);migracjaKanalowSprzedazy.wykonaj(db);migracjaTypuKanaluISklepow.wykonaj(db);
 const http=vi.fn((_url:string,init?:RequestInit)=>new Promise<Response>((_ok,zle)=>{init?.signal?.addEventListener('abort',()=>zle(init.signal!.reason),{once:true});}));
 const app=createAplikacjaAllegro({db,http,softwareStatementId:'',redirectUri:'',limitSprawdzaniaMs:100});
 const start=Date.now(),w=await app.sprawdzIZapiszAplikacjeDevice('sandbox',para,aktor);
 expect(w).toMatchObject({ok:false,kod:'tymczasowy'});expect(http).toHaveBeenCalledTimes(1);expect(Date.now()-start).toBeLessThan(400);
});
