import {describe,it,expect} from 'vitest';
import {tmpdir} from 'node:os';
import {zbudujOms} from '../../src/oms/bootstrap.ts';
describe('Kompletna kompozycja zamówień, kanałów, wysyłki i faktur',()=>{
 it('rejestruje rzeczywiste ekrany i zgłasza brakującą usługę zamiast fallbacku',async()=>{
  const env={OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_USER:'operator',OMS_PASS:'atrapa',OMS_PROFORMY_KATALOG:tmpdir(),OMS_ETYKIETY_KATALOG:tmpdir()};
  const a=await zbudujOms({env,nadpisania:{'wysylka.nadanie':{nadaj:async()=>{throw new Error('Ten test nie nadaje przesyłek');}}}});
  try {
   const h={authorization:'Basic '+Buffer.from('operator:atrapa').toString('base64')};
   for(const url of ['/','/zamowienia/nowe','/przesylki','/faktury','/okresy'])expect((await a.app.inject({url,headers:h})).statusCode,url).toBe(200);
   const id=Number(a.db.prepare("INSERT INTO zamowienia(sklep,zrodlo_id,numer,utworzone_at,kwota_brutto,metoda_wysylki)VALUES('kanal-testowy',1,'1','2026-09-30','10.00','dpd')").run().lastInsertRowid);
   expect((await a.app.inject({url:`/zamowienia/${id}/nadaj`,headers:h})).statusCode).toBe(200);
   expect(a.usluga('faktury','infakt')).toBeNull();
   expect(a.usluga('zamowienia','wczytajListe')).toBeTypeOf('function');
   expect(()=>a.usluga('brak','usluga')).toThrow(/nie istnieje/);
  } finally {await a.app.close();a.db.close();}
 });
});
