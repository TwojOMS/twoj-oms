import {afterEach, describe, expect, it} from 'vitest';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {migracjaKanalowSprzedazy} from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import {migracjaTypuKanaluISklepow} from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import {createRepozytoriumKanalow} from '../../../src/moduly/kanaly/repozytorium-kanalow.ts';
import type {PolaczenieAllegro, Wynik} from '../../../src/moduly/kanaly/kontrakty-allegro.ts';

// PRZ-132.02: sklep WooCommerce z panelu leży w tej samej tabeli co Allegro, ale lista() widzi tylko Allegro.
const aktor={id:1,login:'administrator'};
const odUtc='2026-10-31T23:00:00.000Z';
const bazy:ReturnType<typeof openOmsDb>[]=[];
afterEach(()=>{for(const db of bazy.splice(0))db.close();});
function setup(){
 const db=openOmsDb();bazy.push(db);migracjaKanalowSprzedazy.wykonaj(db);migracjaTypuKanaluISklepow.wykonaj(db);
 return {db,repo:createRepozytoriumKanalow({db,definicjeEnv:[],konfiguracjaEnv:{},teraz:()=>new Date('2026-11-01T12:00:00Z')})};
}
function dane<T extends PolaczenieAllegro>(w:Wynik<T>):T {expect(w.ok).toBe(true);if(!w.ok)throw Error(w.komunikat);return w.dane;}
const policz=(db:ReturnType<typeof openOmsDb>)=>({kanaly:Number((db.prepare('SELECT count(*) AS n FROM kanaly_sprzedazy').get() as any).n),sklepy:Number((db.prepare('SELECT count(*) AS n FROM kanaly_sklepy').get() as any).n)});
describe('repozytorium kanałów: sklepy WooCommerce z panelu',()=>{
 it('szkic sklepu ma typ woo, klucz woo_<uuid>, raport WOO_<8 hex>, bez dostępu i pobierania; lista() go nie zwraca',()=>{
  const {db,repo}=setup();
  const a=dane(repo.utworzSzkic({nazwa:'Półcień Allegro',odUtc,srodowisko:'produkcja'},aktor));
  const s=dane(repo.utworzSzkicSklepu({nazwa:'Sklep Półcień',adres:'https://sklep-polcien.test',odUtc,aktor}));
  expect(s).toMatchObject({typ:'woo',aplikacja:null,nazwa:'Sklep Półcień',srodowisko:'produkcja',zrodlo:'panel',kontoId:null,login:null,autoryzacja:'brak',pobieranie:'wylaczone',odUtc,wersja:1,generacja:0,generacjaImportu:0});
  expect(s.klucz).toMatch(/^woo_[a-f0-9]{32}$/);expect(s.raport).toMatch(/^WOO_[A-F0-9]{8}$/);
  expect(repo.lista()).toEqual([a]);expect(repo.pobierz(s.klucz)).toBeNull();
  expect(repo.listaTypu('woo')).toEqual([s]);expect(repo.listaTypu('allegro')).toEqual(repo.lista());
  expect(db.prepare('SELECT klucz,adres,ustawienia_json,sprawdzono_at FROM kanaly_sklepy').all()).toEqual([{klucz:s.klucz,adres:'https://sklep-polcien.test',ustawienia_json:'{}',sprawdzono_at:null}]);
  expect(db.prepare('SELECT operacja FROM kanaly_audit WHERE kanal=?').all(s.klucz)).toEqual([{operacja:'szkic_sklepu'}]);
 });
 it('adres już zajęty → błąd i brak wiersza w obu tabelach (jedna transakcja)',()=>{
  const {db,repo}=setup();dane(repo.utworzSzkicSklepu({nazwa:'Sklep Półcień',adres:'https://sklep-polcien.test',odUtc,aktor}));
  const przed=policz(db);
  expect(repo.utworzSzkicSklepu({nazwa:'Drugi Półcień',adres:'https://sklep-polcien.test',odUtc,aktor})).toMatchObject({ok:false,kod:'konflikt'});
  expect(policz(db)).toEqual(przed);expect(repo.listaTypu('woo')).toHaveLength(1);
  expect(db.prepare('SELECT count(*) AS n FROM kanaly_audit').get()).toEqual({n:1});
 });
 it.each([
  ['zła nazwa',{nazwa:'  ',adres:'https://sklep-polcien.test',odUtc}],
  ['pusty adres',{nazwa:'Sklep Półcień',adres:'',odUtc}],
  ['zła data',{nazwa:'Sklep Półcień',adres:'https://sklep-polcien.test',odUtc:'2026-10-31'}],
 ])('odrzuca szkic bez zapisu: %s',(_,d)=>{
  const {db,repo}=setup();expect(repo.utworzSzkicSklepu({...d,aktor})).toMatchObject({ok:false,kod:'walidacja'});expect(policz(db)).toEqual({kanaly:0,sklepy:0});
 });
 it('zapiszSklep zmienia adres i mapowanie, podnosi wersję i generację; stara wersja i cudzy klucz → konflikt',()=>{
  const {db,repo}=setup();const s=dane(repo.utworzSzkicSklepu({nazwa:'Sklep Półcień',adres:'https://sklep-polcien.test',odUtc,aktor}));
  const mapowanie={instancje:{'7':'dpd'},poPozycji:[]};
  const b=dane(repo.zapiszSklep(s.klucz,{adres:'https://nowy-polcien.test',mapowanie},s.wersja,aktor));
  expect(b).toMatchObject({...s,wersja:2,generacja:1});
  expect(db.prepare('SELECT adres,ustawienia_json,zmieniono_at FROM kanaly_sklepy').get()).toEqual({adres:'https://nowy-polcien.test',ustawienia_json:JSON.stringify({mapowanie}),zmieniono_at:'2026-11-01T12:00:00.000Z'});
  const c=dane(repo.zapiszSklep(s.klucz,{mapowanie:{instancje:{},poPozycji:[]}},b.wersja,aktor));
  expect(c).toMatchObject({wersja:3,generacja:2});expect(db.prepare('SELECT adres FROM kanaly_sklepy').get()).toEqual({adres:'https://nowy-polcien.test'});
  expect(repo.zapiszSklep(s.klucz,{adres:'https://trzeci-polcien.test'},b.wersja,aktor)).toMatchObject({ok:false,kod:'konflikt'});
  const a=dane(repo.utworzSzkic({nazwa:'Półcień Allegro',odUtc,srodowisko:'produkcja'},aktor));
  expect(repo.zapiszSklep(a.klucz,{adres:'https://trzeci-polcien.test'},a.wersja,aktor)).toMatchObject({ok:false,kod:'konflikt'});
  expect(db.prepare('SELECT adres FROM kanaly_sklepy').all()).toEqual([{adres:'https://nowy-polcien.test'}]);
 });
 it('zapiszSklep: adres innego sklepu → konflikt bez zmiany; puste zmiany i zły adres → walidacja',()=>{
  const {db,repo}=setup();const s=dane(repo.utworzSzkicSklepu({nazwa:'Sklep Półcień',adres:'https://sklep-polcien.test',odUtc,aktor}));
  dane(repo.utworzSzkicSklepu({nazwa:'Drugi Półcień',adres:'https://drugi-polcien.test',odUtc,aktor}));
  expect(repo.zapiszSklep(s.klucz,{adres:'https://drugi-polcien.test'},s.wersja,aktor)).toMatchObject({ok:false,kod:'konflikt'});
  expect(repo.zapiszSklep(s.klucz,{},s.wersja,aktor)).toMatchObject({ok:false,kod:'walidacja'});
  expect(repo.zapiszSklep(s.klucz,{adres:''},s.wersja,aktor)).toMatchObject({ok:false,kod:'walidacja'});
  expect(repo.listaTypu('woo').find(k=>k.klucz===s.klucz)).toMatchObject({wersja:1,generacja:0});
  expect(db.prepare('SELECT adres FROM kanaly_sklepy WHERE klucz=?').get(s.klucz)).toEqual({adres:'https://sklep-polcien.test'});
 });
});
