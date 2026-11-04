import {afterEach,describe,it,expect} from 'vitest';
import {fixtureAllegro,daneAllegro,aktorAllegro,scopesAllegro} from '../../pomoc/allegro-konfigurator.ts';
import {createAutoryzacjaAllegro} from '../../../src/moduly/kanaly/services/autoryzacja-allegro.ts';
import {createRepozytoriumKanalow} from '../../../src/moduly/kanaly/repozytorium-kanalow.ts';
import {migracjaTypuKanaluISklepow} from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
const fixtures:ReturnType<typeof fixtureAllegro>[]=[];
afterEach(()=>{for(const f of fixtures.splice(0))f.db.close();});
function setup(){
 const f=fixtureAllegro();fixtures.push(f);let wolno=true,pending=false;
 const repo=createRepozytoriumKanalow({db:f.db,definicjeEnv:[{klucz:'legacy',typ:'allegro',prefiks:'LEGACY',etykieta:'Stare konto',raport:'ALLEGRO_STARE'}],konfiguracjaEnv:{legacy:{api:'https://api.allegro.pl',od:'2026-10-31T23:00:00Z'}},teraz:f.teraz});
 const calls:string[]=[];
 const http=async(u:string,i:RequestInit={})=>{
  calls.push(u);
  if(u.endsWith('/device'))return Response.json({device_code:'TAJNY-DEVICE',user_code:'ABC-123',verification_uri:'https://allegro.pl/skojarz',expires_in:600,interval:5});
  if(u.endsWith('/token')&&pending)return Response.json({error:'authorization_pending'},{status:400});
  return f.http(u,i);
 };
 const auth=createAutoryzacjaAllegro({repozytorium:repo,aplikacjaDlaInstalacji:()=>null,http,userAgent:'fixture',teraz:f.teraz,
  legacyDlaKanalu:(k:string)=>k==='legacy'?{app:f.app,wolnoWiazac:wolno}:null});
 return {...f,repo,auth,calls,setWolno:(v:boolean)=>{wolno=v;},setPending:(v:boolean)=>{pending=v;}};
}
describe('legacy Device Flow jako kandydat',()=>{
 it('panel wymaga profile:read i nie korzysta z legacy fallback po 403',async()=>{
  for(const brakProfilu of [true,false]){
   const f=setup();migracjaTypuKanaluISklepow.wykonaj(f.db);
   const k=f.szkic();if(brakProfilu)f.setScopes(scopesAllegro.filter(s=>s!=='allegro:api:profile:read'));else f.setMeStatus(403);
   const auth=createAutoryzacjaAllegro({repozytorium:f.repo,aplikacjaDlaInstalacji:()=>null,aplikacjaDevice:()=>f.app,http:async(u,i)=>u.endsWith('/device')?Response.json({device_code:'kod',user_code:'ABC',verification_uri:'https://allegro.pl/skojarz',interval:5,expires_in:600}):f.http(u,i),userAgent:'TwojOMS/test',teraz:f.teraz});
   const p=daneAllegro(await auth.rozpocznijDevice(k.klucz,aktorAllegro,'A'));
   f.setCzas('2026-11-01T12:00:06Z');expect((await auth.sprawdzDevice(p.probaId,aktorAllegro,'A')).ok).toBe(false);
   expect(auth.pobierzKandydata(p.probaId,'A')).toBeNull();expect(f.db.prepare('SELECT * FROM tokeny_kanalu').all()).toEqual([]);
  }
 });
 it('nie zapisuje aktywnej pary po zgodzie; zwraca wyłącznie tożsamość z API',async()=>{
  const f=setup();const p=daneAllegro(await f.auth.rozpocznijLegacy('legacy',aktorAllegro,'A'));
  expect(p).toMatchObject({userCode:'ABC-123',adres:'https://allegro.pl/skojarz'});expect(JSON.stringify(p)).not.toContain('TAJNY');
  f.setCzas('2026-11-01T12:00:06Z');const wynik=daneAllegro(await f.auth.sprawdzLegacy(p.probaId,aktorAllegro,'A'));
  expect(wynik).toMatchObject({gotowe:true,kontoId:'123',login:'konto-123'});
  expect(JSON.stringify(wynik)).not.toMatch(/ACCESS-WABIK|REFRESH-WABIK|TAJNY/);
  expect(f.db.prepare('SELECT * FROM tokeny_kanalu').all()).toEqual([]);
  expect(f.auth.pobierzKandydata(p.probaId,'A')).toMatchObject({kontoId:'123',klucz:'legacy'});
 });
 it('zdrowy kanał i kanał panelowy nie uruchamiają legacy; podwójny start nie prosi o drugi kod',async()=>{
  const f=setup();f.setWolno(false);expect((await f.auth.rozpocznijLegacy('legacy',aktorAllegro,'A')).ok).toBe(false);expect(f.calls).toEqual([]);
  f.setWolno(true);const a=daneAllegro(await f.auth.rozpocznijLegacy('legacy',aktorAllegro,'A'));
  expect(daneAllegro(await f.auth.rozpocznijLegacy('legacy',aktorAllegro,'A'))).toEqual(a);
  expect((await f.auth.rozpocznijLegacy('legacy',aktorAllegro,'B')).ok).toBe(false);
  expect(f.calls.filter(u=>u.endsWith('/device'))).toHaveLength(1);
  expect((await f.auth.rozpocznijLegacy(f.szkic().klucz,aktorAllegro,'A')).ok).toBe(false);
 });
 it('sesja, aktor, TTL, interwał i zmiana wersji chronią także Device Flow',async()=>{
  const f=setup(),p=daneAllegro(await f.auth.rozpocznijLegacy('legacy',aktorAllegro,'A'));
  expect((await f.auth.sprawdzLegacy(p.probaId,aktorAllegro,'B')).ok).toBe(false);
  expect((await f.auth.sprawdzLegacy(p.probaId,{id:2,login:'inny'},'A')).ok).toBe(false);
  expect(daneAllegro(await f.auth.sprawdzLegacy(p.probaId,aktorAllegro,'A'))).toMatchObject({gotowe:false});
  expect(f.calls.filter(u=>u.endsWith('/token'))).toHaveLength(0);
  f.setPending(true);f.setCzas('2026-11-01T12:00:06Z');expect(daneAllegro(await f.auth.sprawdzLegacy(p.probaId,aktorAllegro,'A'))).toMatchObject({gotowe:false});
  const k=f.repo.pobierz('legacy')!;daneAllegro(f.repo.zapiszZmiane('legacy',k.wersja,{autoryzacja:'odlaczone'},aktorAllegro));
  f.setCzas('2026-11-01T12:00:12Z');expect((await f.auth.sprawdzLegacy(p.probaId,aktorAllegro,'A')).ok).toBe(false);
  expect(f.db.prepare('SELECT * FROM tokeny_kanalu').all()).toEqual([]);
 });
 it('nie przyjmuje zgody bez kompletu uprawnień ani po wygaśnięciu',async()=>{
  const f=setup(),p=daneAllegro(await f.auth.rozpocznijLegacy('legacy',aktorAllegro,'A'));
  f.setScopes(scopesAllegro.slice(1));f.setCzas('2026-11-01T12:00:06Z');expect((await f.auth.sprawdzLegacy(p.probaId,aktorAllegro,'A')).ok).toBe(false);
  expect(f.auth.pobierzKandydata(p.probaId,'A')).toBeNull();
  f.setCzas('2026-11-01T12:11:00Z');expect((await f.auth.sprawdzLegacy(p.probaId,aktorAllegro,'A')).ok).toBe(false);
 });
});
