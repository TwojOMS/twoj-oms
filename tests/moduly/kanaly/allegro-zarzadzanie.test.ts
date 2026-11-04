import {afterEach,describe,it,expect} from 'vitest';
import {fixtureAllegro,daneAllegro,aktorAllegro,callbackAllegro} from '../../pomoc/allegro-konfigurator.ts';
import {createRejestrKanalow} from '../../../src/moduly/kanaly/services/rejestr-kanalow.ts';
import {createZarzadzanieAllegro} from '../../../src/moduly/kanaly/services/zarzadzanie-allegro.ts';
import {migracjaDiagnostykiAllegro} from '../../../src/moduly/kanaly/migracje/0002-diagnostyka-allegro.ts';
const fixtures:ReturnType<typeof fixtureAllegro>[]=[];afterEach(()=>{for(const f of fixtures.splice(0))f.db.close();});
function setup(){const f=fixtureAllegro();fixtures.push(f);let imports=0;const rejestr=createRejestrKanalow({repozytorium:f.repo,fabryki:()=>({klient:{},poller:{stan:()=>null,przebieg:async()=>{imports++;}}})});const z=createZarzadzanieAllegro({db:f.db,repozytorium:f.repo,autoryzacja:f.auth,rejestr,teraz:f.teraz});return {...f,rejestr,z,imports:()=>imports};}
async function polacz(f:ReturnType<typeof setup>,k=f.szkic()){
 const p=daneAllegro(await f.auth.rozpocznijAutoryzacje(k.klucz,aktorAllegro,'A'));const identity=daneAllegro(await f.auth.obsluzPowrot({state:new URL(p.adres).searchParams.get('state')!,code:'kod',redirectUri:callbackAllegro},'A'));
 return daneAllegro(await f.z.aktywuj(k.klucz,p.probaId,identity.wersja,true,aktorAllegro,'A'));
}
describe('zarządzanie połączeniem',()=>{
 it('zmiana nazwy zachowuje parę tokenów, kursor, tożsamość i raport',async()=>{
  const f=setup(),k=await polacz(f);f.db.prepare('INSERT INTO stan_pollera(sklep,zsynchronizowane_do) VALUES (?,?)').run(k.klucz,'2026-11-01T10:00:00Z');
  const before=f.db.prepare('SELECT * FROM tokeny_kanalu').all();const n=daneAllegro(await f.z.zmienNazwe(k.klucz,'Nowa etykieta',k.wersja,aktorAllegro));expect(n).toMatchObject({...k,nazwa:'Nowa etykieta',wersja:k.wersja+1});expect(f.db.prepare('SELECT * FROM tokeny_kanalu').all()).toEqual(before);expect(f.db.prepare('SELECT zsynchronizowane_do FROM stan_pollera').get()).toMatchObject({zsynchronizowane_do:'2026-11-01T10:00:00Z'});
 });
 it('pauza zachowuje tokeny i kursor; drugi kanał pracuje; wznowienie nie zeruje kursora',async()=>{
  const f=setup(),k=await polacz(f);f.setKonto('456');await polacz(f);const before=f.db.prepare('SELECT * FROM tokeny_kanalu').all();
  f.db.prepare('INSERT INTO stan_pollera(sklep,zsynchronizowane_do) VALUES (?,?)').run(k.klucz,'2026-11-01T10:00:00Z');
  const p=daneAllegro(await f.z.ustawPobieranie(k.klucz,false,k.wersja,aktorAllegro));await f.rejestr.przebiegZamowien();expect(f.imports()).toBe(1);expect(p).toMatchObject({pobieranie:'wylaczone',generacja:k.generacja});expect(f.db.prepare('SELECT * FROM tokeny_kanalu').all()).toEqual(before);
  const n=daneAllegro(await f.z.ustawPobieranie(k.klucz,true,p.wersja,aktorAllegro));expect(n.pobieranie).toBe('wlaczone');expect(f.db.prepare('SELECT zsynchronizowane_do FROM stan_pollera WHERE sklep=?').get(k.klucz)).toMatchObject({zsynchronizowane_do:'2026-11-01T10:00:00Z'});
 });
 it('odłączenie usuwa parę, zachowuje historię konta i blokuje stare formularze; reconnect tylko tego samego ID, bez importu',async()=>{
  const f=setup(),k=await polacz(f);f.db.prepare('INSERT INTO stan_pollera(sklep,zsynchronizowane_do) VALUES (?,?)').run(k.klucz,'2026-11-01T10:00:00Z');
  const d=daneAllegro(await f.z.odlacz(k.klucz,k.wersja,aktorAllegro));expect(d).toMatchObject({autoryzacja:'odlaczone',pobieranie:'wylaczone',kontoId:'123',klucz:k.klucz,raport:k.raport});expect(f.db.prepare('SELECT * FROM tokeny_kanalu').all()).toEqual([]);
  expect((await f.z.ustawPobieranie(k.klucz,true,k.wersja,aktorAllegro)).ok).toBe(false);
  f.setKonto('999');const p=daneAllegro(await f.auth.rozpocznijAutoryzacje(k.klucz,aktorAllegro,'A'));expect((await f.auth.obsluzPowrot({state:new URL(p.adres).searchParams.get('state')!,code:'kod',redirectUri:callbackAllegro},'A')).ok).toBe(false);
  f.setKonto('123');const again=await polacz(f,d);expect(again).toMatchObject({kontoId:'123',pobieranie:'wylaczone'});expect(f.db.prepare('SELECT zsynchronizowane_do FROM stan_pollera WHERE sklep=?').get(k.klucz)).toMatchObject({zsynchronizowane_do:'2026-11-01T10:00:00Z'});
 });
 it('B5: odmowa Allegro (401/403) ma inny komunikat niż brak odpowiedzi (sieć, 5xx); tokeny bez zmian',async()=>{
  const f=fixtureAllegro();fixtures.push(f);migracjaDiagnostykiAllegro.wykonaj(f.db);let blad:unknown=null;
  const rejestr=createRejestrKanalow({repozytorium:f.repo,fabryki:()=>({klient:{pobierzMojeKonto:async()=>{throw blad;},sprawdzZakresZamowien:async()=>0},poller:{stan:()=>null,przebieg:async()=>{}}})});
  const z=createZarzadzanieAllegro({db:f.db,repozytorium:f.repo,autoryzacja:f.auth,rejestr,teraz:f.teraz});
  const k=await polacz({...f,rejestr,z,imports:()=>0});const tokeny=f.db.prepare('SELECT * FROM tokeny_kanalu').all();
  const sprawdz=async(e:unknown)=>{blad=e;const w=await z.sprawdzPolaczenie(k.klucz,k.wersja);expect(w.ok).toBe(false);return w.ok?'':w.komunikat;};
  for(const status of [401,403])expect(await sprawdz(Object.assign(new Error('Allegro: HTTP '+status),{status}))).toContain('odmówiło');
  for(const e of [Object.assign(new Error('fetch failed'),{cause:Object.assign(new Error('socket hang up'),{code:'ECONNRESET'})}),Object.assign(new Error('read ECONNRESET'),{code:'ECONNRESET'}),Object.assign(new Error('Allegro: HTTP 503'),{status:503})]){
   const t=await sprawdz(e);expect(t).toContain('nie odpowiada');expect(t).not.toContain('odmówiło');
  }
  expect(f.db.prepare('SELECT * FROM tokeny_kanalu').all()).toEqual(tokeny);
  expect(f.db.prepare('SELECT blad FROM kanaly_diagnostyka WHERE kanal=?').get(k.klucz)).toMatchObject({blad:1});
 });
 it('stary przycisk odłączenia nie usuwa nowej pary po ponownym połączeniu',async()=>{const f=setup(),k=await polacz(f);const d=daneAllegro(await f.z.odlacz(k.klucz,k.wersja,aktorAllegro));await polacz(f,d);expect(await f.z.odlacz(k.klucz,k.wersja,aktorAllegro)).toMatchObject({ok:false,kod:'konflikt'});expect(f.db.prepare('SELECT * FROM tokeny_kanalu').all()).toHaveLength(1);});
});
