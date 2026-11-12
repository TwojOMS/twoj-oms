// PRZ-157.00 (D9): kompozycja kanałów podpina rejestr typów połączeń do wyboru modułu zamówienia.
// Typ z OMS_KANALY (env) albo z kanaly_sprzedazy.typ (panel), nigdy z prefiksu klucza.
import {it,expect,afterEach} from 'vitest';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {zbudujAplikacje} from '../../../src/core/aplikacja.ts';
import {modulRdzen} from '../../../src/moduly/rdzen/modul.ts';
import type {ModulOms} from '../../../src/core/kontrakty.ts';
import {modulZamowienia,umiejetnosciZamowienia,ustawRejestrKanalow,nieznaneKanalyZamowien} from '../../../src/domena/moduly-kanalow.ts';

afterEach(()=>ustawRejestrKanalow(null));
const mapa=JSON.stringify({instancje:{1:{metoda:'dpd'}},poPozycji:[]});
const env={OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',
 SKLEP_POLNOC_URL:'https://polnoc.invalid',SKLEP_POLNOC_CK:'fikcyjny',SKLEP_POLNOC_CS:'fikcyjny',SKLEP_POLNOC_MAPOWANIE:mapa,SKLEP_POLNOC_OD:'2026-01-01',
 RYNEK_CLIENT_ID:'fikcyjny',RYNEK_CLIENT_SECRET:'fikcyjny',RYNEK_USER_AGENT:'Fixture/1.0 (+https://fixture.invalid)',RYNEK_OD:'2026-01-01'};
const definicje=[{klucz:'polnoc',typ:'woo',prefiks:'SKLEP_POLNOC'},{klucz:'rynek',typ:'allegro',prefiks:'RYNEK'}] as const;
const wiersz=(db:ReturnType<typeof openOmsDb>,klucz:string,typ:string)=>db.prepare(`INSERT INTO kanaly_sprzedazy(klucz,nazwa,srodowisko,zrodlo,raport,autoryzacja,pobieranie,od_utc,wersja,generacja,generacja_importu,utworzono_at,zmieniono_at,aktor_id,aktor_login,typ)
 VALUES (?,'Pracownia Półcień','produkcja','panel',?,'brak','wylaczone','2026-01-01T00:00:00Z',1,0,0,'2026-01-01','2026-01-01',1,'admin',?)`).run(klucz,klucz.toUpperCase(),typ);

it('Allegro i Woo z env i z panelu, ręczne → te same moduły co przed zmianą, także gdy typ z bazy mówi inaczej niż predykat',async()=>{
 const db=openOmsDb();let a:Awaited<ReturnType<typeof zbudujAplikacje>>|undefined;
 try{
  a=await zbudujAplikacje({db,moduly:[modulRdzen,createModulKanaly(definicje)] as ModulOms[],env});
  wiersz(db,'allegro_a1b2c3','allegro');
  wiersz(db,'woo_d4e5f6','woo');
  // Klucz bez prefiksu z wierszem typu allegro — zostaje Woo jak w SQL KSeF (recenzja PRZ-157.00).
  wiersz(db,'konto_polcien','allegro');
  const typy=Object.fromEntries(['rynek','polnoc','allegro_a1b2c3','woo_d4e5f6','konto_polcien','reczne','indywidualne',''].map(k=>[k,modulZamowienia({sklep:k}).typ]));
  expect(typy).toEqual({rynek:'allegro',polnoc:'woo',allegro_a1b2c3:'allegro',woo_d4e5f6:'woo',konto_polcien:'woo',reczne:'woo',indywidualne:'woo','':'woo'});
  expect(umiejetnosciZamowienia({sklep:'woo_d4e5f6'}).statusZwrotny).toBe('wyslane');
  expect(nieznaneKanalyZamowien()).toEqual([]);
  expect(a.zdrowie().uwagi).toEqual([]);
 }finally{await a?.app.close();db.close();}
});

it('nieznany klucz i typ bez modułu → moduł jak dotąd, ostrzeżenie w zdrowiu kanałów (tylko klucz, bez danych)',async()=>{
 const db=openOmsDb();let a:Awaited<ReturnType<typeof zbudujAplikacje>>|undefined;
 try{
  a=await zbudujAplikacje({db,moduly:[modulRdzen,createModulKanaly(definicje)] as ModulOms[],env});
  wiersz(db,'polcien_g7h8','polcien');
  expect(modulZamowienia({sklep:'polcien_g7h8'}).typ).toBe('woo');
  expect(modulZamowienia({sklep:'zniknal_polcien'}).typ).toBe('woo');
  expect(modulZamowienia({sklep:'allegro_usuniety'}).typ).toBe('allegro');
  const uwagi=a.zdrowie().uwagi;
  expect(uwagi).toHaveLength(1);
  expect(uwagi[0]).toContain('polcien_g7h8, zniknal_polcien, allegro_usuniety');
 }finally{await a?.app.close();db.close();}
});

it('zamknięta baza poprzedniej kompozycji nie wywraca domeny — wynik jak dotąd',async()=>{
 const db=openOmsDb();let a:Awaited<ReturnType<typeof zbudujAplikacje>>|undefined;
 try{a=await zbudujAplikacje({db,moduly:[modulRdzen,createModulKanaly(definicje)] as ModulOms[],env});}
 finally{await a?.app.close();db.close();}
 expect(modulZamowienia({sklep:'woo_d4e5f6'}).typ).toBe('woo');
 expect(modulZamowienia({sklep:'allegro_a1b2c3'}).typ).toBe('allegro');
});
