import {afterEach,expect,it} from 'vitest';
import {fixtureAllegro,daneAllegro,aktorAllegro,callbackAllegro} from '../../pomoc/allegro-konfigurator.ts';
import {createRepozytoriumKanalow} from '../../../src/moduly/kanaly/repozytorium-kanalow.ts';
import {createRejestrKanalow} from '../../../src/moduly/kanaly/services/rejestr-kanalow.ts';
import {createZarzadzanieAllegro} from '../../../src/moduly/kanaly/services/zarzadzanie-allegro.ts';

const fixtures:ReturnType<typeof fixtureAllegro>[]=[];
afterEach(()=>{for(const f of fixtures.splice(0))f.db.close();});
function setup(env=false){
 const f=fixtureAllegro();fixtures.push(f);
 const repo=env?createRepozytoriumKanalow({db:f.db,definicjeEnv:[{klucz:'allegro_polcien',typ:'allegro',prefiks:'POLCIEN'}],konfiguracjaEnv:{allegro_polcien:{od:'2026-10-31T23:00:00.000Z'}},teraz:f.teraz}):f.repo;
 const rejestr=createRejestrKanalow({repozytorium:repo,fabryki:()=>({klient:{},poller:{stan:()=>null,przebieg:async()=>{}}})});
 return {...f,repo,z:createZarzadzanieAllegro({db:f.db,repozytorium:repo,autoryzacja:f.auth,rejestr,teraz:f.teraz})};
}
const od='2026-10-30T23:00:00.000Z';
it('zmienia datę przed aktywacją, waliduje ją i zapisuje audyt',async()=>{
 const f=setup(),k=f.szkic();
 for(const niepoprawna of ['2024-01-01T00:00:00.000Z','2026-11-02T23:00:00.000Z','2026-10-30T12:00:00.000Z']){
  expect(await f.z.ustawDateStartu(k.klucz,niepoprawna,k.wersja,aktorAllegro)).toMatchObject({ok:false,kod:'walidacja'});
  expect(f.repo.pobierz(k.klucz)).toEqual(k);
 }
 const w=daneAllegro(await f.z.ustawDateStartu(k.klucz,od,k.wersja,aktorAllegro));
 expect(w).toMatchObject({odUtc:od,wersja:k.wersja+1,generacjaImportu:0});expect(f.repo.pobierz(k.klucz)).toEqual(w);
 expect(f.db.prepare('SELECT operacja,wersja,aktor_id,aktor_login FROM kanaly_audit WHERE kanal=? ORDER BY wersja DESC LIMIT 1').get(k.klucz)).toEqual({operacja:'odUtc',wersja:w.wersja,aktor_id:aktorAllegro.id,aktor_login:aktorAllegro.login});
});
it('po aktywacji odmawia zmiany daty',async()=>{
 const f=setup(),k=f.szkic();
 const p=daneAllegro(await f.auth.rozpocznijAutoryzacje(k.klucz,aktorAllegro,'sesja'));
 const konto=daneAllegro(await f.auth.obsluzPowrot({state:new URL(p.adres).searchParams.get('state')!,code:'kod',redirectUri:callbackAllegro},'sesja'));
 const aktywny=daneAllegro(await f.z.aktywuj(k.klucz,p.probaId,konto.wersja,true,aktorAllegro,'sesja'));
 expect(aktywny.generacjaImportu).toBeGreaterThan(0);
 expect(await f.z.ustawDateStartu(k.klucz,od,aktywny.wersja,aktorAllegro)).toEqual({ok:false,kod:'walidacja',komunikat:'Data startu jest już ustalona — zamówień sprzed niej OMS nie pobierze.'});
 expect(f.repo.pobierz(k.klucz)).toEqual(aktywny);
});
it('po aktywacji z wyłączonym pobieraniem też odmawia zmiany daty (usługa i repozytorium)',async()=>{
 const f=setup(),k=f.szkic();
 const p=daneAllegro(await f.auth.rozpocznijAutoryzacje(k.klucz,aktorAllegro,'sesja'));
 const konto=daneAllegro(await f.auth.obsluzPowrot({state:new URL(p.adres).searchParams.get('state')!,code:'kod',redirectUri:callbackAllegro},'sesja'));
 const aktywny=daneAllegro(await f.z.aktywuj(k.klucz,p.probaId,konto.wersja,false,aktorAllegro,'sesja'));
 expect(aktywny).toMatchObject({autoryzacja:'polaczone',pobieranie:'wylaczone'});
 expect(await f.z.ustawDateStartu(k.klucz,od,aktywny.wersja,aktorAllegro)).toEqual({ok:false,kod:'walidacja',komunikat:'Data startu jest już ustalona — zamówień sprzed niej OMS nie pobierze.'});
 expect(f.repo.zapiszZmiane(k.klucz,aktywny.wersja,{odUtc:od},aktorAllegro)).toMatchObject({ok:false,kod:'walidacja'});
 expect(f.repo.pobierz(k.klucz)).toEqual(aktywny);
});
it('po zgodzie i potwierdzeniu konta, przed aktywacją, data jest jeszcze zmienna (kolejność kreatora)',async()=>{
 const f=setup(),k=f.szkic();
 const p=daneAllegro(await f.auth.rozpocznijAutoryzacje(k.klucz,aktorAllegro,'sesja'));
 const konto=daneAllegro(await f.auth.obsluzPowrot({state:new URL(p.adres).searchParams.get('state')!,code:'kod',redirectUri:callbackAllegro},'sesja'));
 expect(await f.z.ustawDateStartu(k.klucz,od,konto.wersja,aktorAllegro)).toMatchObject({ok:true,dane:{odUtc:od}});
});
it('nie zmienia kanału z konfiguracji środowiska',async()=>{
 const f=setup(true),k=f.repo.pobierz('allegro_polcien')!;
 expect(await f.z.ustawDateStartu(k.klucz,od,k.wersja,aktorAllegro)).toMatchObject({ok:false,kod:'walidacja'});
 expect(f.repo.zapiszZmiane(k.klucz,k.wersja,{odUtc:od},aktorAllegro)).toMatchObject({ok:false,kod:'walidacja'});
 expect(f.repo.pobierz(k.klucz)).toEqual(k);expect(f.db.prepare('SELECT * FROM kanaly_sprzedazy').all()).toEqual([]);expect(f.db.prepare('SELECT * FROM kanaly_audit').all()).toEqual([]);
});
it('odrzuca nieaktualną wersję bez zmiany stanu i audytu',async()=>{
 const f=setup(),k=f.szkic(),audit=f.db.prepare('SELECT * FROM kanaly_audit').all();
 expect(await f.z.ustawDateStartu(k.klucz,od,k.wersja+1,aktorAllegro)).toMatchObject({ok:false,kod:'konflikt'});
 expect(f.repo.pobierz(k.klucz)).toEqual(k);expect(f.db.prepare('SELECT * FROM kanaly_audit').all()).toEqual(audit);
});
