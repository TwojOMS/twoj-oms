import {afterEach,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {migracjaKanalowSprzedazy} from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import {migracjaTypuKanaluISklepow} from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import {createSklepyErli} from '../../../src/moduly/kanaly/services/sklepy-erli.ts';
import {registerTrasyErli} from '../../../src/moduly/kanaly/trasy-erli.ts';
import {stanErliWBazie} from '../../../src/oms/erli/adapter.js';

const root='/ustawienia/integracje/erli',aktor={id:1,login:'admin'};
const bazy:ReturnType<typeof openOmsDb>[]=[],aplikacje:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{for(const app of aplikacje.splice(0))await app.close();for(const db of bazy.splice(0))db.close();});
async function setup(zPliku=false){
 const db=openOmsDb();bazy.push(db);
 migracjaKanalowSprzedazy.wykonaj(db);migracjaTypuKanaluISklepow.wykonaj(db);
 const teraz=()=>new Date('2026-11-11T12:00:00Z');
 // Zamknięta atrapa transportu: żadne żądanie nie wychodzi do ERLI.
 const fetchImpl=vi.fn(async()=>Response.json({id:123,name:'Pracownia Półcień'}));
 const sklepy=createSklepyErli({db,teraz,fetchImpl,
  definicje:zPliku?[{klucz:'z-pliku'}]:[],
  ustawieniaEnv:zPliku?{'z-pliku':{adresApi:'https://sandbox.erli.dev/svc/shop-api',kluczApi:'fikcyjny-klucz'}}:{}});
 const app=Fastify();aplikacje.push(app);
 app.decorateRequest('konto',null);
 app.addHook('onRequest',async r=>{Object.assign(r,{konto:{...aktor,admin:true}});});
 // Zbieramy dane widoku, bez zmiany EJS równolegle edytowanego w 12o.
 app.decorateReply('view',function(_szablon:string,dane:Record<string,unknown>){return this.send(dane);});
 registerTrasyErli(app,sklepy,teraz);
 const req=(method:'GET'|'POST',k:string,op='',payload?:Record<string,unknown>)=>app.inject({method,url:root+'/'+k+(op?'/'+op:''),payload});
 const row=(k:string)=>db.prepare('SELECT * FROM kanaly_sprzedazy WHERE klucz=?').get(k)!;
 const post=(k:string,op:string,payload:Record<string,unknown>={})=>req('POST',k,op,{wersja:row(k)?.wersja??0,...payload});
 async function szkic(){
  const r=await req('POST','nowe','dane',{wersja:0,nazwa:'Pracownia Półcień',adresApi:'https://sandbox.erli.dev/svc/shop-api',kluczApi:'fikcyjny-klucz'});
  expect(r.statusCode).toBe(303);return String(r.headers.location).split('?')[0].split('/').at(-1)!;
 }
 function dodatki(k:string){
  stanErliWBazie(db,k).zapisz({tor:'inbox'});
  db.prepare("INSERT INTO stan_pollera(sklep,zsynchronizowane_do) VALUES (?,'2026-11-01')").run(k);
  db.prepare("INSERT INTO kanaly_blokady_zapisu(kanal,zablokowane,aktor_id,aktor_login,zmieniono_at) VALUES (?,1,1,'admin','2026-11-01')").run(k);
  db.prepare("INSERT INTO kanaly_operacje_niejednoznaczne(id,kanal,metoda,sciezka,zmieniono_at) VALUES (?,?,'PUT','/fixture','2026-11-01')").run(k,k);
  db.prepare("INSERT INTO granice_historii(kanal,do_dnia,zrodlo,uwaga) VALUES (?,'2026-11-01','oms-bez-historii','test')").run(row(k).raport);
 }
 const stan=()=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(t=>({tabela:t.name,wiersze:db.prepare('SELECT * FROM "'+String(t.name).replaceAll('"','""')+'"').all()}));
 return {db,sklepy,req,post,row,szkic,dodatki,stan,fetchImpl};
}

it.each([false,true])('usuwa szkic lub sklep sprawdzony (%s), konfigurację z kluczem i stan pollera, zapisuje audyt',async sprawdzony=>{
 const f=await setup();
 // Zapis klucza sam sprawdza połączenie (12t); sklep niesprawdzony = ERLI odrzuciło klucz przy zapisie.
 f.fetchImpl.mockResolvedValueOnce(sprawdzony?Response.json({id:123,name:'Pracownia Półcień'}):new Response('{}',{status:401}))
  .mockResolvedValueOnce(Response.json({id:456,name:'Pracownia Druga'}));
 const k=await f.szkic();
 expect(Boolean(f.sklepy.pobierz(k)?.ustawienia?.sprawdzono)).toBe(sprawdzony);
 const inny=await f.szkic();
 f.dodatki(k);f.dodatki(inny);
 const wersja=Number(f.row(k).wersja),raport=f.row(k).raport;
 expect((await f.req('GET',k)).json().moznaUsunac).toBe(true);
 const r=await f.post(k,'usun',{potwierdz:'tak'});
 expect(r.statusCode).toBe(303);
 expect(r.headers.location).toBe('/ustawienia/integracje?zapisano=usunieto_sklep');
 expect(f.row(k)).toBeUndefined();
 expect(f.db.prepare('SELECT * FROM konfiguracja_integracji WHERE integracja=?').get('erli:'+k)).toBeUndefined();
 expect(f.db.prepare('SELECT * FROM konfiguracja_integracji WHERE integracja=?').get('erli_stan:'+k)).toBeUndefined();
 for(const [t,pole,wartosc] of [['stan_pollera','sklep',k],['kanaly_blokady_zapisu','kanal',k],['kanaly_operacje_niejednoznaczne','kanal',k],['granice_historii','kanal',raport]]){
  expect(f.db.prepare(`SELECT * FROM ${t} WHERE ${pole}=?`).get(wartosc)).toBeUndefined();
  expect(f.db.prepare(`SELECT * FROM ${t}`).all()).toHaveLength(1);
 }
 expect(f.row(inny)).toBeTruthy();
 expect(f.db.prepare('SELECT * FROM konfiguracja_integracji WHERE integracja=?').get('erli:'+inny)).toBeTruthy();
 expect(f.db.prepare('SELECT * FROM konfiguracja_integracji WHERE integracja=?').get('erli_stan:'+inny)).toBeTruthy();
 expect(f.db.prepare("SELECT * FROM kanaly_audit WHERE kanal=? AND operacja='usuniecie_sklepu'").all(k)).toEqual([expect.objectContaining({wersja:wersja+1,aktor_id:1,aktor_login:'admin'})]);
 expect(f.fetchImpl).toHaveBeenCalledTimes(2);
});

it.each([['bez potwierdzenia',{},400],['ze złą wersją',{potwierdz:'tak',wersja:999},409]] as const)('odmawia usunięcia %s bez zmiany danych',async(_opis,payload,status)=>{
 const f=await setup(),k=await f.szkic();f.dodatki(k);const przed=f.stan();
 expect((await f.post(k,'usun',payload)).statusCode).toBe(status);
 expect(f.stan()).toEqual(przed);
});

it.each(['zamowienie','import','produkt'] as const)('blokuje sklep z danymi: %s, nic nie usuwa i przekazuje moznaUsunac=false',async dane=>{
 const f=await setup(),k=await f.szkic();f.dodatki(k);
 if(dane==='zamowienie')f.db.prepare("INSERT INTO zamowienia(sklep,zrodlo_id,numer,kwota_brutto,utworzone_at) VALUES (?,1,'TEST-1','10.00','2026-11-01')").run(k);
 if(dane==='import')f.db.prepare('INSERT INTO stan_importu_sklepu(sklep) VALUES (?)').run(k);
 if(dane==='produkt')f.db.prepare("INSERT INTO produkty_sklepowe(kanal,produkt_id,nazwa,odczytane_at) VALUES (?,'1','Produkt testowy','2026-11-01')").run(k);
 const przed=f.stan(),r=await f.post(k,'usun',{potwierdz:'tak'});
 expect(r.statusCode).toBe(409);expect(r.json().blad).toMatch(/odłącz/);
 expect(f.stan()).toEqual(przed);
 expect((await f.req('GET',k)).json().moznaUsunac).toBe(false);
});

it('odmawia usunięcia sklepu z pliku i ukrywa możliwość usunięcia także dla nowego sklepu',async()=>{
 const f=await setup(true),przed=f.stan();
 const r=await f.post('z-pliku','usun',{potwierdz:'tak'});
 expect(r.statusCode).toBe(409);expect(r.json().blad).toMatch(/pliku/);
 expect(f.stan()).toEqual(przed);expect(f.sklepy.pobierz('z-pliku')).toBeTruthy();
 expect((await f.req('GET','z-pliku')).json().moznaUsunac).toBe(false);
 expect((await f.req('GET','nowe')).json().moznaUsunac).toBe(false);
});

it('wycofuje całą transakcję po błędzie zapisu audytu',async()=>{
 const f=await setup(),k=await f.szkic();f.dodatki(k);
 f.db.exec("CREATE TRIGGER odmowa_audytu BEFORE INSERT ON kanaly_audit WHEN NEW.operacja='usuniecie_sklepu' BEGIN SELECT RAISE(ABORT,'test'); END");
 const przed=f.stan();expect((await f.post(k,'usun',{potwierdz:'tak'})).statusCode).toBe(503);
 expect(f.stan()).toEqual(przed);
});
it('odmawia usunięcia aktywnego sklepu bez danych — najpierw odłączenie (jak Woo)',async()=>{
 const f=await setup(),k=await f.szkic();
 f.db.prepare("UPDATE kanaly_sprzedazy SET autoryzacja='polaczone',pobieranie='wlaczone' WHERE klucz=?").run(k);
 const przed=f.stan(),r=await f.post(k,'usun',{potwierdz:'tak'});
 expect(r.statusCode).toBe(409);expect(r.json().blad).toMatch(/odłącz/);
 expect(f.stan()).toEqual(przed);
 expect((await f.req('GET',k)).json().moznaUsunac).toBe(false);
});
