import {afterEach, expect, it, vi} from 'vitest';
import Fastify from 'fastify';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {migracjaKanalowSprzedazy} from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import {migracjaTypuKanaluISklepow} from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import {zbudujUslugiKanalow} from '../../../src/moduly/kanaly/services/kompozycja-kanalow.ts';
import {createSklepyWoo} from '../../../src/moduly/kanaly/services/sklepy-woo.ts';
import {konfiguracjaKanalow} from '../../../src/moduly/kanaly/konfiguracja.ts';
import {modulMagazyn} from '../../../src/moduly/magazyn/modul.ts';
import {modulZdrowie} from '../../../src/moduly/zdrowie/modul.ts';
import {celeLacznosci} from '../../../src/domena/lacznosc.js';
import {polaczeniaIntegracji} from '../../../src/moduly/ustawienia/services/polaczenia-integracji.ts';

const sprzatanie: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const f of sprzatanie.splice(0))await f();});
function ok(w:any){expect(w.ok).toBe(true);return w.dane;}
function setup(){
  const db=openOmsDb();
  migracjaKanalowSprzedazy.wykonaj(db);migracjaTypuKanaluISklepow.wykonaj(db);
  const teraz=()=>new Date('2026-11-02T12:00:00Z');
  const fetchImpl=vi.fn(async()=>Response.json([],{headers:{'X-WP-TotalPages':'1'}}));
  const u=zbudujUslugiKanalow({db,konfiguracja:konfiguracjaKanalow([],{}),log:vi.fn(),teraz,usluga:()=>undefined} as any,[],{fetchImpl});
  const ctx={db,log:vi.fn(),teraz,konfiguracja:{proba:false,kopieKatalog:'',kopiaZewnetrzna:''},
    usluga:(modul:string,nazwa:string)=>modul==='kanaly'?(u as any)[nazwa]:nazwa==='puls'?{startAt:teraz().toISOString(),stan:()=>({})}:nazwa==='kurierzy'?{}:null};
  const magazyn=modulMagazyn.zbuduj(ctx as any).uslugi!.magazyn as any;
  const zdrowie=modulZdrowie.zbuduj(ctx as any);
  const app=Fastify();zdrowie.trasy!(app as any);
  sprzatanie.push(async()=>{await app.close();db.close();});
  const aktor={id:1,login:'polcien_test'};
  const s=createSklepyWoo({db,repozytorium:u.repozytoriumKanalow,envSklepy:[],teraz,tryb:'produkcja',
    klient:()=>({sprawdzPolaczenie:async()=>({ok:true}),pobierzMetodyWysylki:async()=>[],pobierzBramkiPlatnosci:async()=>[]})});
  const aktywuj=async()=>{
    const k=ok(s.utworzSzkic({nazwa:'Pracownia Półcień',adres:'https://sklep.polcien.example',ck:'ck_polcien',cs:'cs_polcien',od:'2026-11-01'},aktor)).klucz;
    ok(s.zapiszMapowanie(k,{instancje:{},bramkiPobrania:[]},u.repozytoriumKanalow.listaTypu('woo').find(p=>p.klucz===k)!.wersja,aktor));
    ok(await s.sprawdz(k));ok(s.aktywuj(k,u.repozytoriumKanalow.listaTypu('woo').find(p=>p.klucz===k)!.wersja,aktor));return k;
  };
  return {db,u,app,magazyn,aktywuj,fetchImpl,teraz};
}
it('magazyn zbudowany przed aktywacją odczytuje klienta i listę sklepów przy przebiegu',async()=>{
  const {magazyn,aktywuj,fetchImpl}=setup();
  expect(magazyn.gotowy()).toBe(false);
  const k=await aktywuj();expect(magazyn.gotowy()).toBe(true);
  expect(magazyn.start()).toEqual({wystartowal:true});
  await vi.waitFor(()=>expect(magazyn.stan().trwa).toBe(false));
  expect(magazyn.stan()).toMatchObject({blad:null,kanaly:[{kanal:k,blad:null,zapisane:0}]});
  expect(fetchImpl).toHaveBeenCalled();
});
it('/health widzi stan nowego sklepu i nie alarmuje o nieznanej konfiguracji ani nie ujawnia kluczy',async()=>{
  const {db,app,aktywuj,teraz,fetchImpl}=setup();
  expect((await app.inject('/health')).json().poller.zrodla).toEqual([]);
  const k=await aktywuj();
  db.prepare('INSERT INTO stan_pollera(sklep,ostatni_przebieg_at) VALUES(?,?)').run(k,teraz().toISOString());
  db.prepare("INSERT INTO zamowienia(sklep,zrodlo_id,numer,kwota_brutto,utworzone_at) VALUES(?,1,'TEST','0',?)").run(k,teraz().toISOString());
  const r=await app.inject('/health');expect(r.statusCode).toBe(200);
  expect(r.json().poller.zrodla).toEqual([expect.objectContaining({zrodlo:k,zdrowy:true})]);
  expect(r.json().alarmy).toEqual([]);
  expect(r.body).not.toMatch(/ck_polcien|cs_polcien/);expect(fetchImpl).not.toHaveBeenCalled();
});
it('łączność odczytuje sklep aktywowany po utworzeniu konsumentów',async()=>{
  const {u,aktywuj,fetchImpl}=setup();expect(celeLacznosci(u.config as any)).toEqual([]);
  const k=await aktywuj();
  expect(celeLacznosci(u.config as any)).toEqual([{klucz:`sklep:${k}`,nazwa:`Sklep ${k}`,url:'https://sklep.polcien.example',host:'sklep.polcien.example'}]);
  expect(fetchImpl).not.toHaveBeenCalled();
});
it('Integracje pokazują nazwę, źródło i stan pollera nowego sklepu bez sekretów',async()=>{
  const {db,u,aktywuj,fetchImpl}=setup();
  const odczyt=()=>polaczeniaIntegracji({db,kanaly:u.config,sklepyWoo:u.repozytoriumKanalow.listaTypu('woo')});expect(odczyt()).toEqual([]);
  const k=await aktywuj();
  db.prepare('INSERT INTO stan_pollera(sklep,ostatni_przebieg_at) VALUES(?,?)').run(k,'2026-11-02T12:00:00Z');
  expect(odczyt()).toEqual([expect.objectContaining({id:`woocommerce:${k}`,nazwa:'Pracownia Półcień',zrodlo:'panel',stan:'dziala',ostatniSukcesAt:'2026-11-02T12:00:00Z'})]);
  db.prepare('UPDATE stan_pollera SET ostatni_blad=? WHERE sklep=?').run('ck_polcien cs_polcien',k);
  expect(odczyt()[0].stan).toBe('uwaga');
  expect(JSON.stringify(odczyt())).not.toMatch(/ck_polcien|cs_polcien/);expect(fetchImpl).not.toHaveBeenCalled();
});
