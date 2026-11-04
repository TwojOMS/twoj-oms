import {afterEach, describe, expect, it} from 'vitest';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {migracjaKanalowSprzedazy} from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import {migracjaTypuKanaluISklepow} from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import {createRepozytoriumKanalow} from '../../../src/moduly/kanaly/repozytorium-kanalow.ts';
import type {PolaczenieAllegro, Wynik} from '../../../src/moduly/kanaly/kontrakty-allegro.ts';
import {zapiszTokeny} from '../../../src/oms/db/tokeny.js';
const aktor={id:1,login:'administrator'};
const odUtc='2026-10-31T23:00:00.000Z';
const bazy:ReturnType<typeof openOmsDb>[]=[];
afterEach(()=>{for(const db of bazy.splice(0))db.close();});
function setup(env=false) {
 const db=openOmsDb(); bazy.push(db); migracjaKanalowSprzedazy.wykonaj(db);
 const definicjeEnv=env?[{klucz:'rynek',typ:'allegro' as const,prefiks:'RYNEK',raport:'RYNEK_RAPORT',etykieta:'Stara nazwa'}]:[];
 const konfiguracjaEnv=env?{rynek:{od:'2026-01-01T00:00:00',api:'https://api.allegro.pl',clientSecret:'sekret-env-wabik'}}:{};
 return {db,repo:createRepozytoriumKanalow({db,definicjeEnv,konfiguracjaEnv,teraz:()=>new Date('2026-11-01T12:00:00Z')})};
}
function dane(w:Wynik<PolaczenieAllegro>):PolaczenieAllegro {expect(w.ok).toBe(true);if(!w.ok)throw Error(w.komunikat);return w.dane;}
const szkic=(repo:ReturnType<typeof createRepozytoriumKanalow>,nazwa='Sklep główny')=>dane(repo.utworzSzkic({nazwa,odUtc,srodowisko:'produkcja'},aktor));
describe('trwałe kanały Allegro',()=>{
 it('tworzy szkic bez dostępu i importu, zachowuje stabilny klucz i raport po zmianie nazwy',()=>{
  const {repo}=setup();const a=szkic(repo);expect(a).toMatchObject({nazwa:'Sklep główny',kontoId:null,autoryzacja:'brak',pobieranie:'wylaczone',odUtc,wersja:1,generacja:0,generacjaImportu:0});
  expect(a.klucz).toMatch(/^allegro_[a-f0-9]{32}$/);expect(a.raport).toMatch(/^ALLEGRO_[A-F0-9]{32}$/);
  const b=dane(repo.zapiszZmiane(a.klucz,a.wersja,{nazwa:'Nowa nazwa'},aktor));expect(b).toMatchObject({...a,nazwa:'Nowa nazwa',wersja:2});expect(repo.lista()).toEqual([b]);
 });
 it.each(['','   ','x'.repeat(81)])('odrzuca złą nazwę bez zapisu: %j',nazwa=>{const {repo}=setup();expect(repo.utworzSzkic({nazwa,odUtc,srodowisko:'produkcja'},aktor)).toMatchObject({ok:false,kod:'walidacja'});expect(repo.lista()).toEqual([]);});
 it('akceptuje 80 znaków i nie wymaga unikalnej etykiety',()=>{const {repo}=setup();szkic(repo,'x'.repeat(80));szkic(repo,'x'.repeat(80));expect(repo.lista()).toHaveLength(2);});
 it('stary formularz nie nadpisuje nowszego zapisu',()=>{const {repo}=setup();const a=szkic(repo);dane(repo.zapiszZmiane(a.klucz,1,{nazwa:'Pierwszy'},aktor));expect(repo.zapiszZmiane(a.klucz,1,{nazwa:'Drugi'},aktor)).toMatchObject({ok:false,kod:'konflikt'});expect(repo.lista()[0].nazwa).toBe('Pierwszy');});
 it('konto jest unikalne także po odłączeniu; środowiska są oddzielne',()=>{
  const {repo}=setup();const a=szkic(repo),b=szkic(repo);
  const linked=dane(repo.zapiszZmiane(a.klucz,1,{kontoId:'123',login:'konto-a',autoryzacja:'polaczone'},aktor));
  expect(repo.zapiszZmiane(b.klucz,1,{kontoId:'123',login:'konto-a',autoryzacja:'polaczone'},aktor)).toMatchObject({ok:false,kod:'konflikt'});
  dane(repo.zapiszZmiane(a.klucz,linked.wersja,{autoryzacja:'odlaczone'},aktor));
  expect(repo.zapiszZmiane(b.klucz,1,{kontoId:'123'},aktor)).toMatchObject({ok:false,kod:'konflikt'});
  const c=dane(repo.utworzSzkic({nazwa:'Sandbox',odUtc,srodowisko:'sandbox'},aktor));expect(repo.zapiszZmiane(c.klucz,1,{kontoId:'123'},aktor).ok).toBe(true);
 });
 it('raz zapisanej tożsamości nie można podmienić ani wyzerować',()=>{const {repo}=setup();const a=szkic(repo);const b=dane(repo.zapiszZmiane(a.klucz,1,{kontoId:'123'},aktor));for(const kontoId of ['456',null])expect(repo.zapiszZmiane(a.klucz,b.wersja,{kontoId},aktor)).toMatchObject({ok:false,kod:'konflikt'});});
 it('migracja nie rusza tokenów ani kursora i overlay env nie kopiuje sekretów',()=>{
  const {db,repo}=setup(true);zapiszTokeny(db,'rynek',{accessToken:'access-wabik',refreshToken:'refresh-wabik',wygasaAt:'2026-11-02',refreshWygasaAt:'2027-02-01'});
  db.prepare('INSERT INTO stan_pollera(sklep,zsynchronizowane_do) VALUES (?,?)').run('rynek','2026-11-01T10:00:00Z');
  const before=db.prepare('SELECT * FROM tokeny_kanalu').all();migracjaKanalowSprzedazy.wykonaj(db);
  expect(db.prepare('SELECT * FROM kanaly_sprzedazy').all()).toEqual([]);
  const a=repo.lista()[0];expect(a).toMatchObject({klucz:'rynek',raport:'RYNEK_RAPORT',nazwa:'Stara nazwa',zrodlo:'env'});
  dane(repo.zapiszZmiane('rynek',a.wersja,{nazwa:'Nowa etykieta',pobieranie:'wylaczone'},aktor));
  expect(db.prepare('SELECT * FROM tokeny_kanalu').all()).toEqual(before);expect(db.prepare('SELECT zsynchronizowane_do FROM stan_pollera').get()).toMatchObject({zsynchronizowane_do:'2026-11-01T10:00:00Z'});
  const rows=JSON.stringify(db.prepare('SELECT * FROM kanaly_sprzedazy').all());for(const secret of ['sekret-env-wabik','access-wabik','refresh-wabik'])expect(rows).not.toContain(secret);
  const again=createRepozytoriumKanalow({db,definicjeEnv:[{klucz:'rynek',typ:'allegro',prefiks:'RYNEK'}],konfiguracjaEnv:{rynek:{od:'2026-01-01T00:00:00'}}});expect(again.lista()[0]).toMatchObject({klucz:'rynek',nazwa:'Nowa etykieta',pobieranie:'wylaczone',raport:'RYNEK_RAPORT'});
 });
});
// PRZ-132.02: po migracji 0003 kanał Allegro ma typ i aplikację; data startu zmienialna tylko przed pierwszym importem.
describe('kanały Allegro po migracji 0003',()=>{
 function setup3(env=false){const s=setup(env);migracjaTypuKanaluISklepow.wykonaj(s.db);return s;}
 it('lista() i szkic mają typ allegro i aplikację NULL; zapiszZmiane zapisuje aplikację device/dcr i odrzuca inną',()=>{
  const {db,repo}=setup3();const a=szkic(repo);expect(a).toMatchObject({typ:'allegro',aplikacja:null});
  const b=dane(repo.zapiszZmiane(a.klucz,a.wersja,{aplikacja:'device'},aktor));expect(b).toMatchObject({aplikacja:'device',wersja:2});
  expect(repo.lista()).toEqual([b]);expect(db.prepare('SELECT typ,aplikacja FROM kanaly_sprzedazy').get()).toEqual({typ:'allegro',aplikacja:'device'});
  for(const aplikacja of ['env','DEVICE',''] as any[])expect(repo.zapiszZmiane(a.klucz,b.wersja,{aplikacja},aktor)).toMatchObject({ok:false,kod:'walidacja'});
  expect(repo.zapiszZmiane(a.klucz,b.wersja,{aplikacja:'dcr'},aktor)).toMatchObject({ok:true,dane:{aplikacja:'dcr'}});
 });
 it('zapiszZmiane({odUtc}) przed pierwszą aktywacją zmienia datę, po aktywacji odmawia bez zapisu',()=>{
  const {db,repo}=setup3();const a=szkic(repo);const nowa='2026-09-30T22:00:00.000Z';
  const b=dane(repo.zapiszZmiane(a.klucz,a.wersja,{odUtc:nowa},aktor));expect(b).toMatchObject({odUtc:nowa,wersja:2,generacjaImportu:0});
  expect(db.prepare('SELECT od_utc FROM kanaly_sprzedazy').get()).toEqual({od_utc:nowa});
  expect(repo.zapiszZmiane(a.klucz,b.wersja,{odUtc:'2026-13-01'},aktor)).toMatchObject({ok:false,kod:'walidacja'});
  const c=dane(repo.zapiszZmiane(a.klucz,b.wersja,{kontoId:'1000001',login:'polcien_test',autoryzacja:'polaczone'},aktor));
  const d=dane(repo.zapiszZmiane(a.klucz,c.wersja,{pobieranie:'wlaczone'},aktor));expect(d.generacjaImportu).toBe(1);
  expect(repo.zapiszZmiane(a.klucz,d.wersja,{odUtc:'2026-08-31T22:00:00.000Z'},aktor)).toMatchObject({ok:false,kod:'walidacja'});
  const e=dane(repo.zapiszZmiane(a.klucz,d.wersja,{pobieranie:'wylaczone'},aktor));
  expect(repo.zapiszZmiane(a.klucz,e.wersja,{odUtc:'2026-08-31T22:00:00.000Z'},aktor)).toMatchObject({ok:false,kod:'walidacja'});
  expect(repo.pobierz(a.klucz)).toMatchObject({odUtc:nowa,wersja:e.wersja});expect(db.prepare('SELECT od_utc FROM kanaly_sprzedazy').get()).toEqual({od_utc:nowa});
 });
 it('kanał z pliku konfiguracji nie zmienia daty startu z panelu',()=>{
  const {db,repo}=setup3(true);const a=repo.lista()[0];
  expect(repo.zapiszZmiane('rynek',a.wersja,{odUtc:'2026-09-30T22:00:00.000Z'},aktor)).toMatchObject({ok:false,kod:'walidacja'});
  expect(db.prepare('SELECT * FROM kanaly_sprzedazy').all()).toEqual([]);
 });
});
