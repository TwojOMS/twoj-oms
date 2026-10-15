import {it,expect,vi,afterEach} from 'vitest';
import {buildOmsServer} from '../pomoc/serwer-parytetu.ts';
import {openOmsDb} from '../../src/oms/db/db.ts';
import {modulWysylka} from '../../src/moduly/wysylka/modul.ts';

afterEach(()=>vi.unstubAllGlobals());
const headers={authorization:`Basic ${Buffer.from('operator:fixture').toString('base64')}`};
it('historyczne jawne config.nadawca zasila rzeczywistą trasę podjazdu bez tworzenia klienta DPD',async()=>{
 const fetch=vi.fn(async()=>{throw Error('Brak zgody testu na API');});vi.stubGlobal('fetch',fetch);
 const db=openOmsDb();const nadawca={nazwa:'Neutralna firma',ulica:'Polna 1',kod:'00-001',miasto:'Miasto testowe',kraj:'DE',email:'firma@przyklad.invalid',phone:'500100200'};
 const app=buildOmsServer({db,config:{auth:{user:'operator',pass:'fixture'},nadawca}});
 try{
  db.exec("INSERT INTO zamowienia(id,sklep,zrodlo_id,numer,kwota_brutto,utworzone_at) VALUES(1,'rynek',1,'TEST','10.00','2026-09-30'); INSERT INTO przesylki(id,zamowienie_id,kurier,status,numer_listu,utworzona_at) VALUES(1,1,'allegro_wza','nadana','TEST-LIST','2026-09-30')");
  const r=await app.inject({url:'/przesylki/podjazdy?ids=1',headers});expect(r.statusCode).toBe(200);
  for(const [pole,wartosc] of Object.entries({name:'Neutralna firma',street:'Polna 1',postalCode:'00-001',city:'Miasto testowe',countryCode:'DE',email:'firma@przyklad.invalid',phone:'500100200'}))
   expect(r.body).toContain(`name="${pole}" value="${wartosc}"`);
  expect(fetch).not.toHaveBeenCalled();
  // Fabryczny moduł bez zwalidowanego DPD nie bierze adresu z surowych zmiennych.
  expect(modulWysylka.konfiguracja({DPD_NADAWCA_ULICA:'Polna 1',OMS_PODJAZD_ULICA:'Polna 1'}).adresPodjazdu.street).toBe('');
 }finally{await app.close();db.close();}
});
