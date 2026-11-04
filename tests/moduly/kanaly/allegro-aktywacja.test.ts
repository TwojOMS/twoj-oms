import {afterEach,describe,it,expect} from 'vitest';
import {fixtureAllegro,daneAllegro,aktorAllegro,callbackAllegro} from '../../pomoc/allegro-konfigurator.ts';
import {createRejestrKanalow} from '../../../src/moduly/kanaly/services/rejestr-kanalow.ts';
import {createZarzadzanieAllegro} from '../../../src/moduly/kanaly/services/zarzadzanie-allegro.ts';
import {poczatekDniaWarszawa,poprawnaDataStartu} from '../../../src/moduly/kanaly/zakres-importu-allegro.ts';
const bazy:ReturnType<typeof fixtureAllegro>[]=[];afterEach(()=>{for(const f of bazy.splice(0))f.db.close();});
function setup(){const f=fixtureAllegro();bazy.push(f);const rejestr=createRejestrKanalow({repozytorium:f.repo,fabryki:()=>({klient:{},poller:{stan:()=>null,przebieg:async()=>{}}})});const zarzadzanie=createZarzadzanieAllegro({db:f.db,repozytorium:f.repo,autoryzacja:f.auth,rejestr,teraz:f.teraz});return {...f,rejestr,zarzadzanie};}
async function kandydat(f:ReturnType<typeof setup>,k=f.szkic()){
 const p=daneAllegro(await f.auth.rozpocznijAutoryzacje(k.klucz,aktorAllegro,'sesja-A'));const state=new URL(p.adres).searchParams.get('state')!;
 const konto=daneAllegro(await f.auth.obsluzPowrot({state,code:'kod',redirectUri:callbackAllegro},'sesja-A'));return {k,p,konto};
}
describe('aktywacja zatwierdzonego konta',()=>{
 it('inne konto przy reconnect jest odrzucone przed utworzeniem kandydata, nie tylko przy zapisie',async()=>{
  const f=setup(),k=f.szkic();
  daneAllegro(f.repo.zapiszZmiane(k.klucz,k.wersja,{kontoId:'999',login:'Poprzednie',autoryzacja:'odlaczone'},aktorAllegro));
  const p=daneAllegro(await f.auth.rozpocznijAutoryzacje(k.klucz,aktorAllegro,'sesja-A'));
  const w=await f.auth.obsluzPowrot({state:new URL(p.adres).searchParams.get('state')!,code:'kod',redirectUri:callbackAllegro},'sesja-A');
  expect(w).toMatchObject({ok:false,kod:'konflikt'});expect(f.auth.pobierzKandydata(p.probaId,'sesja-A')).toBeNull();
  expect(f.db.prepare('SELECT * FROM tokeny_kanalu').all()).toEqual([]);
 });
 it('dopiero aktywacja zapisuje parę tokenów i udostępnia kanał; podwójny POST nie dubluje',async()=>{
  const f=setup(),{k,p,konto}=await kandydat(f);expect(f.db.prepare('SELECT * FROM tokeny_kanalu').all()).toEqual([]);
  const w=daneAllegro(await f.zarzadzanie.aktywuj(k.klucz,p.probaId,konto.wersja,true,aktorAllegro,'sesja-A'));expect(w).toMatchObject({kontoId:'123',login:'konto-123',autoryzacja:'polaczone',pobieranie:'wlaczone'});
  expect(f.db.prepare('SELECT kanal,access_token,refresh_token FROM tokeny_kanalu').all()).toEqual([{kanal:k.klucz,access_token:'ACCESS-WABIK',refresh_token:'REFRESH-WABIK'}]);expect(f.rejestr.definicje()).toHaveLength(1);
  expect(await f.zarzadzanie.aktywuj(k.klucz,p.probaId,konto.wersja,true,aktorAllegro,'sesja-A')).toEqual({ok:true,dane:w});
 });
 it.each(['sesja','aktor','wersja'])('blokuje niezgodność: %s',async mode=>{const f=setup(),{k,p,konto}=await kandydat(f);const w=await f.zarzadzanie.aktywuj(k.klucz,p.probaId,konto.wersja+(mode==='wersja'?1:0),true,mode==='aktor'?{id:2,login:'inny'}:aktorAllegro,mode==='sesja'?'B':'sesja-A');expect(w.ok).toBe(false);expect(f.db.prepare('SELECT * FROM tokeny_kanalu').all()).toEqual([]);});
 it('dwie karty tego samego konta dają jeden sukces, drugi kanał nie dostaje tokenów',async()=>{
  const f=setup(),a=await kandydat(f),b=await kandydat(f);const w=await Promise.all([f.zarzadzanie.aktywuj(a.k.klucz,a.p.probaId,a.konto.wersja,true,aktorAllegro,'sesja-A'),f.zarzadzanie.aktywuj(b.k.klucz,b.p.probaId,b.konto.wersja,true,aktorAllegro,'sesja-A')]);expect(w.map(r=>r.ok).sort()).toEqual([false,true]);expect(f.db.prepare('SELECT * FROM tokeny_kanalu').all()).toHaveLength(1);
 });
 it.each([10000,10001])('granica %s zamówień jest sprawdzana ponownie przy zapisie',async n=>{const f=setup(),{k,p,konto}=await kandydat(f);f.setCount(n);expect((await f.zarzadzanie.aktywuj(k.klucz,p.probaId,konto.wersja,true,aktorAllegro,'sesja-A')).ok).toBe(n===10000);});
 it('awaria zapisu tokenów wycofuje także aktywację kanału',async()=>{const f=setup(),{k,p,konto}=await kandydat(f);f.db.exec("CREATE TRIGGER awaria_pary BEFORE INSERT ON tokeny_kanalu BEGIN SELECT RAISE(ABORT,'kontrolowana awaria'); END");expect((await f.zarzadzanie.aktywuj(k.klucz,p.probaId,konto.wersja,true,aktorAllegro,'sesja-A')).ok).toBe(false);expect(f.repo.pobierz(k.klucz)).toMatchObject({kontoId:null,autoryzacja:'oczekuje_potwierdzenia'});});
});
describe('daty importu w Warszawie',()=>{
 it.each([['2026-03-29','2026-03-28T23:00:00.000Z'],['2026-03-30','2026-03-29T22:00:00.000Z'],['2026-10-25','2026-10-24T22:00:00.000Z'],['2026-10-26','2026-10-25T23:00:00.000Z']])('%s to %s', (d,utc)=>expect(poczatekDniaWarszawa(d)).toBe(utc));
 it.each(['2026-02-30','2026-13-01','2026-1-01','tekst'])('nieistniejący dzień %s',d=>expect(poczatekDniaWarszawa(d)).toBeNull());
 it.each([['2025-10-31T23:00:00.000Z',true],['2025-10-30T23:00:00.000Z',false],['2026-11-01T23:00:00.000Z',false],['2026-10-31T23:00:00.000Z',true]])('12 miesięcy kalendarzowych: %s → %s',(d,w)=>expect(poprawnaDataStartu(d,new Date('2026-11-01T12:00:00Z'))).toBe(w));
});
