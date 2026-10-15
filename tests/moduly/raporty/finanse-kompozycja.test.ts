import {it,expect,vi} from 'vitest';
import {tmpdir} from 'node:os';
import {zbudujOms} from '../../../src/oms/bootstrap.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {zalozKonto,ustawUprawnienia,uprawnieniaKonta} from '../../../src/core/bezpieczenstwo/konta.js';
import {wczytajRaporty} from '../../../src/moduly/raporty/konfiguracja.ts';
import {MODULY} from '../../../src/moduly/lista.ts';
import {nawigacjaDla} from '../../../src/domena/menu-stron.js';
import {ustawGranice,zapiszHistorie} from '../../../src/oms/db/historia-sprzedazy.js';
import {KANALY} from '../../pomoc/raporty-historyczne-fixture.js';
import {zapiszDaneMiesiaca} from '../../../src/oms/db/dane-miesieczne.js';
const env={OMS_USER:'operator',OMS_PASS:'fixture',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:tmpdir(),OMS_ETYKIETY_KATALOG:tmpdir()};
const headers={authorization:`Basic ${Buffer.from('operator:fixture').toString('base64')}`};
it('PRZ027F syntetyczna instalacja liczy rachunek i filtruje zamówienia według jej konfiguracji',async()=>{
 const db=openOmsDb();
 for(const k of KANALY)ustawGranice(db,k,'2031-07-02','fixture',null);
 for(const [id,email,brutto] of [['sprzedaz','kupiec@example.test','246.00'],['test','test@example.test','1230.00']])zapiszHistorie(db,{
  apiloId:id,platformAccountId:21,dzien:'2031-06-10',utworzoneAt:'2031-06-10T10:00:00Z',brutto,tagi:[],status:15,paymentStatus:2,klientEmail:email,pozycje:[],
 });
 zapiszDaneMiesiaca(db,'2031-06',{zusRazem:'10.00',pit5:'0.00'});
 const a=await zbudujOms({db,env:{...env,OMS_RAPORTY_PODLOGA_KOSZTOW:'2031-01',OMS_HISTORIA_MAILE_TESTOWE:'test@example.test',OMS_HISTORIA_KLASYFIKACJA:'{"konta":[{"konto":21,"raport":"RECZNE"}]}'}});
 try{
  const odp=await a.app.inject({method:'GET',url:'/finanse?od=2031-06-01&do=2031-06-30',headers});
  expect(odp.statusCode).toBe(200);expect(odp.body).toContain('200,00');expect(odp.body).toContain('190,00');
  expect(odp.body).not.toContain('1 200,00');
  // Mutacja ujawniła brak ochrony domyślnego zamkniętego miesiąca w historycznej suite.
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2031-07-15T10:00:00Z'));
  try{
   const start=await a.app.inject({method:'GET',url:'/finanse',headers});
   expect(start.statusCode).toBe(200);expect(start.body).toContain('value="2031-06-01"');
   expect(start.body).toContain('value="2031-06-30"');
  }finally{vi.useRealTimers();}
  for(const [url,location] of [['/raporty/zarzadczy?skrot=q2','/finanse?skrot=q2'],['/raporty/dane?miesiac=2031-06','/finanse/dane?miesiac=2031-06'],['/raporty/dane/2031-06','/finanse/dane/2031-06']]){
   const r=await a.app.inject({method:'GET',url,headers});expect(r.statusCode).toBe(302);expect(r.headers.location).toBe(location);
  }
 }finally{await a.app.close();db.close();}
});
it('PRZ027F brak podłogi odmawia rachunku, dane działają i produkt nie zasiewa firmy',async()=>{
 const siec=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
 const a=await zbudujOms({env});
 try{
  const finanse=await a.app.inject({method:'GET',url:'/finanse?od=2031-06-01&do=2031-06-30',headers});
  expect(finanse.statusCode).toBe(400);expect(finanse.body).toContain('podłogi danych kosztów');
  const dane=await a.app.inject({method:'GET',url:'/finanse/dane/2031-06',headers});
  expect(dane.statusCode).toBe(200);expect(dane.body).toContain('action="/finanse/dane"');
  expect(a.db.prepare('SELECT COUNT(*) AS c FROM dane_miesieczne').get()?.c).toBe(0);
  expect(siec).not.toHaveBeenCalled();
 }finally{await a.app.close();a.db.close();siec.mockRestore();}
});
it('PRZ027F podłoga jest miesiącem z konfiguracji, bez wartości firmy i bez ujawnienia wadliwego wejścia',()=>{
 expect((wczytajRaporty({}) as any).podlogaKosztow).toBeNull();
 expect((wczytajRaporty({OMS_RAPORTY_PODLOGA_KOSZTOW:' 2031-02 '}) as any).podlogaKosztow).toBe('2031-02');
 for(const v of ['2031-00','2031-13','canary-private-value']){
  expect(()=>wczytajRaporty({OMS_RAPORTY_PODLOGA_KOSZTOW:v})).toThrow('OMS_RAPORTY_PODLOGA_KOSZTOW');
  try{wczytajRaporty({OMS_RAPORTY_PODLOGA_KOSZTOW:v});}catch(e){expect(String(e)).not.toContain(v);}
 }
});
it('PRZ027F istniejące odebrane prawo nie wraca, przyznane zostaje, nowe Sprzedaż nie dostaje Finansów',async()=>{
 const db=openOmsDb();
 const zabrane=zalozKonto(db,{login:'zabrane',imie:'Z',haslo:'fixture',rola:'administrator'});
 const przyznane=zalozKonto(db,{login:'przyznane',imie:'P',haslo:'fixture',rola:'sprzedaz'});
 ustawUprawnienia(db,zabrane,[]);ustawUprawnienia(db,przyznane,['finanse']);
 const a=await zbudujOms({env,db});
 try{
  expect(uprawnieniaKonta(db,zabrane).has('finanse')).toBe(false);
  expect(uprawnieniaKonta(db,przyznane).has('finanse')).toBe(true);
  for(const [login,status] of [['zabrane',403],['przyznane',200]] as const){
   const logowanie=await a.app.inject({method:'POST',url:'/login',headers:{origin:'http://localhost'},payload:{uzytkownik:login,haslo:'fixture'}});
   expect(logowanie.statusCode).toBe(302);
   const cookie=String(logowanie.headers['set-cookie']).split(';')[0];
   const odp=await a.app.inject({method:'GET',url:'/finanse/dane/2031-06',headers:{cookie}});
   expect(odp.statusCode).toBe(status);
  }
  const nowy=zalozKonto(db,{login:'nowy',imie:'N',haslo:'fixture',rola:'sprzedaz'});
  expect(uprawnieniaKonta(db,nowy).has('finanse')).toBe(false);
  const konto={czynne:true,admin:false,uprawnienia:new Set(['finanse'])};
  const menu=MODULY.flatMap(m=>m.menu);
  const n=nawigacjaDla({sciezka:'/finanse/dane/2031-06',konto,menu});
  expect(n.kontekst?.grupy.flatMap((g:any)=>g.pozycje)).toEqual([{klucz:'finanse',etykieta:'Finanse',href:'/finanse',aktywna:true}]);
 }finally{await a.app.close();db.close();}
});
