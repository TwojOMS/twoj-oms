import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wykonaj } from '../../scripts/inicjalizuj-granice-bez-historii.mjs';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
import { wczytajRaporty } from '../../src/moduly/raporty/konfiguracja.ts';
import { kanalOms, kanalHistoryczny } from '../../src/domena/kanaly-raportowe.js';
import { sprzedazWOkresie, zwrotyWOkresie, inicjalizujGraniceBezHistorii } from '../../src/domena/sprzedaz-okresu.js';
const okres={od:'2026-08-01',do:'2026-08-31'};
const env=(klucz='obcy',raport='OBCE')=>({OMS_KANALY:JSON.stringify([{klucz,typ:'woo',prefiks:'X',raport}])});
const reguly=(e: Record<string,string>=env())=>wczytajRaporty(e).regulySprzedazy;
function baza(path=':memory:'){
 const db=new DatabaseSync(path);
 db.exec(`CREATE TABLE granice_historii(kanal TEXT PRIMARY KEY,do_dnia TEXT,zrodlo TEXT,uwaga TEXT);
 CREATE TABLE sprzedaz_historyczna(apilo_id TEXT,platform_account_id INTEGER,numer TEXT,dzien TEXT,brutto TEXT,status INTEGER,tagi_json TEXT,klient_email TEXT,klient_nazwa TEXT,payment_status INTEGER,faktura INTEGER,zrodlo TEXT);
 CREATE TABLE sprzedaz_historyczna_pozycje(apilo_id TEXT);
 CREATE TABLE zamowienia(id INTEGER PRIMARY KEY,sklep TEXT,numer TEXT,kwota_brutto TEXT,utworzone_at TEXT,okres_rozliczeniowy_id INTEGER,indywidualne INTEGER DEFAULT 0,b2b INTEGER DEFAULT 0,anulowane INTEGER,anulowane_recznie INTEGER,chce_fakture INTEGER,chce_fakture_reczne INTEGER,klient_json TEXT,klient_reczny_json TEXT,oplacone_at TEXT,oplacone_recznie INTEGER,koszt_dostawy_brutto TEXT,pozycje_reczne_json TEXT);
 CREATE TABLE pozycje(id INTEGER,zrodlo_id TEXT,nazwa TEXT,ilosc INTEGER,cena_brutto TEXT,brutto_linii TEXT,zrodlo TEXT,zamowienie_id INTEGER);
 CREATE TABLE zwroty(id INTEGER,zamowienie_id INTEGER,data TEXT,kwota TEXT,kwota_dostawy TEXT);`);
 return db;
}
function zam(db: any,id: number,sklep='obcy',b2b=0,drop: number|null=null){
 db.prepare('INSERT INTO zamowienia(id,sklep,numer,kwota_brutto,utworzone_at,b2b,okres_rozliczeniowy_id) VALUES(?,?,?,?,?,?,?)').run(id,sklep,'O'+id,'123.00','2026-08-10T10:00:00Z',b2b,drop);
}
it('dwie konfiguracje A/B/A klasyfikują obce sklepy bez przecieku',()=>{
 const a=reguly(),b=reguly(env('drugi','DRUGIE'));
 expect(kanalOms({sklep:'obcy'},a.klasyfikacja)).toBe('OBCE');
 expect(kanalOms({sklep:'drugi'},b.klasyfikacja)).toBe('DRUGIE');
 expect(()=>kanalOms({sklep:'obcy'},b.klasyfikacja)).toThrow(/sklep/);
 expect(kanalOms({sklep:'obcy'},a.klasyfikacja)).toBe('OBCE');
});
it('brak raportu i pominięta klasyfikacja są odmową, nawet pusta baza',()=>{
 const r=reguly({OMS_KANALY:'[{"klucz":"obcy","typ":"woo","prefiks":"X"}]'});
 expect(()=>kanalOms({sklep:'obcy'},r.klasyfikacja)).toThrow(/sklep/);
 expect(()=>(kanalOms as any)({sklep:'reczne'})).toThrow(/klasyfikac/);
 expect(()=>(kanalHistoryczny as any)({platform_account_id:91})).toThrow(/klasyfikac/);
 const db=baza();expect(()=>sprzedazWOkresie(db,okres)).toThrow(/klasyfikac/);db.close();
});
it('historia jest jawna, zachowuje priorytet tagów, konta i prefiksu',()=>{
 const r=reguly({...env(),OMS_HISTORIA_KLASYFIKACJA:JSON.stringify({konta:[{konto:91,raport:'ARCHIWUM'},{konto:12,raport:'B2B'}],tagDrop:6,tagGdd:9,tagB2b:3,kontaB2b:[12],prefiksyIndywidualne:['28040|']})});
 const k=r.klasyfikacja;
 expect(kanalHistoryczny({platform_account_id:91},k)).toBe('ARCHIWUM');
 expect(kanalHistoryczny({platform_account_id:12,tagi:[6,9,3]},k)).toBe('DROPSHIPPING');
 expect(kanalHistoryczny({platform_account_id:12,tagi:[9,3]},k)).toBe('GDD');
 expect(kanalHistoryczny({platform_account_id:91,pozycje:[{original_code:'28040|x'}]},k)).toBe('INDYWIDUALNE');
 expect(()=>kanalHistoryczny({platform_account_id:9},reguly().klasyfikacja)).toThrow(/konto/);
});
it.each([{konta:[{konto:91,raport:'A'},{konto:91,raport:'B'}]},{konta:[{konto:1.5,raport:'A'}]},{konta:[],tagDrop:6,tagB2b:6},{konta:[],prefiksyIndywidualne:['']},{konta:[],prefiksyIndywidualne:['2804']},{konta:[],tagGdd:-1}])('odrzuca uszkodzoną historię %j',h=>{
 expect(()=>reguly({...env(),OMS_HISTORIA_KLASYFIKACJA:JSON.stringify(h)})).toThrow();
});
it('odrzuca rozjazd raportów historii/OMS, nieznane konto sufitu i nazwę',()=>{
 expect(()=>reguly({...env(),X_HISTORIA_KONTO_APILO:'91',OMS_HISTORIA_KLASYFIKACJA:'{"konta":[{"konto":91,"raport":"INNE"}]}'})).toThrow(/histori/i);
 expect(()=>reguly({...env(),OMS_RAPORTY_KONTO_HISTORII:'91'})).toThrow(/konto/i);
 expect(()=>reguly({...env(),OMS_RAPORTY_NAZWY_KANALOW:'{"NIEZNANY":"x"}'})).toThrow(/kana/i);
});
it('granica jest jawna, jednorazowa; historia i OMS nie dublują kwoty',()=>{
 const db=baza(),r=reguly({...env(),X_HISTORIA_KONTO_APILO:'91',OMS_HISTORIA_KLASYFIKACJA:'{"konta":[{"konto":91,"raport":"OBCE"}]}'});
 db.exec("INSERT INTO granice_historii VALUES('OBCE','2026-08-10','test',NULL); INSERT INTO sprzedaz_historyczna VALUES('H',91,'H','2026-08-10','123.00',15,'[]',NULL,NULL,2,0,'apilo')");
 zam(db,1);zam(db,2);db.exec("UPDATE zamowienia SET utworzone_at='2026-08-11T10:00:00Z' WHERE id=2");
 expect(sprzedazWOkresie(db,okres,r).map(w=>[w.zrodlo,w.bruttoGrosze,w.kanal])).toEqual([['historia',12300,'OBCE'],['oms',12300,'OBCE']]);db.close();
 const fresh=baza();zam(fresh,1);
 expect(()=>sprzedazWOkresie(fresh,okres,reguly())).toThrow(/granica/);
 inicjalizujGraniceBezHistorii(fresh,'OBCE','2026-08-09',reguly().klasyfikacja);
 expect(sprzedazWOkresie(fresh,okres,reguly())[0].bruttoGrosze).toBe(12300);
 expect(()=>inicjalizujGraniceBezHistorii(fresh,'OBCE','2026-08-08',reguly().klasyfikacja)).toThrow(/granica|istnie/i);
 fresh.close();
});
it('rzeczywiste zwroty klasyfikują B2B i drop identycznie sprzedaż',()=>{
 const db=baza(),r=reguly();zam(db,1,'reczne',1);zam(db,2,'reczne',1,7);
 db.exec("INSERT INTO granice_historii VALUES('B2B','2026-07-31','test',NULL),('DROPSHIPPING','2026-07-31','test',NULL); INSERT INTO zwroty VALUES(1,1,'2026-08-12','12.30',NULL),(2,2,'2026-08-12','24.60',NULL)");
 expect(sprzedazWOkresie(db,okres,r).map(w=>w.kanal)).toEqual(['B2B','DROPSHIPPING']);
 expect(zwrotyWOkresie(db,okres,r).map(w=>[w.kanal,w.bruttoGrosze])).toEqual([['B2B',1230],['DROPSHIPPING',2460]]);db.close();
});

it('CLI zapisuje granicę syntetycznej istniejącej bazy i odmawia ponowienia',()=>{
 const dir=mkdtempSync(join(tmpdir(),'prz053-granice-')),path=join(dir,'syntetyczna.sqlite');
 try {
  const db=baza(path);zam(db,1);db.close();
  wykonaj([path,'OBCE','2026-08-09'],env());
  const wynik=new DatabaseSync(path);
  expect(wynik.prepare('SELECT kanal,do_dnia,zrodlo FROM granice_historii').get()).toEqual({kanal:'OBCE',do_dnia:'2026-08-09',zrodlo:'oms-bez-historii'});
  wynik.close();
  expect(()=>wykonaj([path,'OBCE','2026-08-08'],env())).toThrow(/istnie/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it('inicjalizacja odmawia granicy obejmującej pierwszą sprzedaż, kanału historycznego i uszkodzonej daty',()=>{
 const db=baza();zam(db,1);
 expect(()=>inicjalizujGraniceBezHistorii(db,'OBCE','2026-08-10',reguly().klasyfikacja)).toThrow(/pierwszy dzień/);
 const h=reguly({...env(),OMS_HISTORIA_KLASYFIKACJA:'{"konta":[{"konto":91,"raport":"OBCE"}]}'});
 expect(()=>inicjalizujGraniceBezHistorii(db,'OBCE','2026-08-09',h.klasyfikacja)).toThrow(/histori/);
 expect(()=>inicjalizujGraniceBezHistorii(db,'OBCE','2026-02-30',reguly().klasyfikacja)).toThrow(/dzień/);db.close();
});

it('jawna granica bez historii odmawia historii dodanej później, również poza okresem raportu',()=>{
 const db=baza();zam(db,1);
 inicjalizujGraniceBezHistorii(db,'OBCE','2026-01-01',reguly().klasyfikacja);
 db.exec("INSERT INTO sprzedaz_historyczna VALUES('POTEM',91,'H','2026-06-10','123.00',15,'[]',NULL,NULL,2,0,'apilo')");
 const r=reguly({...env(),OMS_HISTORIA_KLASYFIKACJA:'{"konta":[{"konto":91,"raport":"OBCE"}]}'});
 expect(()=>sprzedazWOkresie(db,{od:'2026-06-01',do:'2026-06-30'},r)).toThrow(/oms-bez-historii/);
 expect(()=>sprzedazWOkresie(db,okres,r)).toThrow(/oms-bez-historii/);db.close();
});
it('historyczne konto/tag B2B wygrywa z pozycją indywidualną, konto działa bez tagu',()=>{
 const r=reguly({...env(),OMS_HISTORIA_KLASYFIKACJA:JSON.stringify({konta:[{konto:12,raport:'B2B'},{konto:91,raport:'ARCHIWUM'}],tagB2b:3,kontaB2b:[12],prefiksyIndywidualne:['28040|']})});
 const pozycje=[{original_code:'28040|x'}];
 expect(kanalHistoryczny({platform_account_id:12,tagi:[],pozycje},r.klasyfikacja)).toBe('B2B');
 expect(kanalHistoryczny({platform_account_id:91,tagi:[3],pozycje},r.klasyfikacja)).toBe('B2B');
});
it.each(['SKLEP','SKLEP_INDYWIDUALNE','ALLEGRO'])('historia odrzuca identyfikator endpointu %s',raport=>{
 expect(()=>reguly({...env(),OMS_HISTORIA_KLASYFIKACJA:JSON.stringify({konta:[{konto:91,raport}]})})).toThrow(/raport/);
});
it.each(['kontaB2b','prefiksyIndywidualne','tagDrop','tagGdd','tagB2b'])('niepełna ręczna klasyfikacja odmawia czytelnie: %s',pole=>{
 const c: any={...reguly().klasyfikacja};delete c[pole];
 expect(()=>kanalOms({sklep:'obcy'},c)).toThrow(/jawnej klasyfikacji/);
});
