import {afterEach,expect,it,vi} from 'vitest';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {migracjaKanalowSprzedazy} from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import {migracjaTypuKanaluISklepow} from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import {zbudujUslugiKanalow} from '../../../src/moduly/kanaly/services/kompozycja-kanalow.ts';
import {createSklepyWoo} from '../../../src/moduly/kanaly/services/sklepy-woo.ts';
import {konfiguracjaKanalow} from '../../../src/moduly/kanaly/konfiguracja.ts';

// PRZ-134.04: dowód od zamówienia do karty. Sklep dodany z panelu, bramka płatności `cod` na liście
// `bramkiPobrania` -> w tabeli `zamowienia` pobranie. Sieć zabroniona, klient Woo to atrapa w pamięci.
//
// Wynik `SELECT numer, metoda_wysylki, pobranie, kwota_pobrania FROM zamowienia ORDER BY numer` (sklep z panelu):
//   1001 | dpd      | 1 | '149.99'  (bramka cod, instancja 3 bez flagi)
//   1002 | dpd      | 0 | NULL     (bramka bacs, instancja 3)
//   1003 | nieznana | 0 | NULL     (instancja 4 z flagą pobrania + bramka bacs = sprzeczność)
// Sklep z pliku (mapa jak dawna, instancja 9 z flagą, bez bramkiPobrania), zamówienie bacs:
//   2001 | dpd      | 1 | 80.00    (zachowanie sprzed zmiany: flaga instancji wystarcza)
const bazy:ReturnType<typeof openOmsDb>[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const db of bazy.splice(0))db.close();});
const a={id:1,login:'polcien_test'};
function ok(w:any){expect(w.ok).toBe(true);return w.dane;}
const zam=(id:number,instancja:number,bramka:string,total:string)=>({id,number:String(id),status:'processing',total,payment_method:bramka,date_created_gmt:'2026-11-01T10:00:00',date_modified_gmt:'2026-11-01T11:00:00',billing:{},shipping:{},shipping_lines:[{method_id:'flat_rate',instance_id:instancja}],line_items:[],meta_data:[]});
function setup(zamowienia:any[],env=false){
 vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Sieć zabroniona'));
 const db=openOmsDb();bazy.push(db);migracjaKanalowSprzedazy.wykonaj(db);migracjaTypuKanaluISklepow.wykonaj(db);
 const fetchImpl=vi.fn(async()=>Response.json(zamowienia,{headers:{'X-WP-TotalPages':'1'}}));
 const definicje=env?[{klucz:'woo_polcien',typ:'woo' as const,prefiks:'POLCIEN'}]:[];
 const mapaPliku='{"instancje":{"3":{"metoda":"dpd"},"9":{"metoda":"dpd","pobranie":true}},"poPozycji":[]}';
 const config=konfiguracjaKanalow(definicje,env?{POLCIEN_URL:'https://sklep.polcien.example',POLCIEN_CK:'ck_polcien',POLCIEN_CS:'cs_polcien',POLCIEN_MAPOWANIE:mapaPliku}:{});
 const teraz=()=>new Date('2026-11-02T12:00:00Z');
 const u=zbudujUslugiKanalow({db,konfiguracja:config,log:vi.fn(),teraz,usluga:()=>vi.fn()} as any,definicje,{fetchImpl});
 const s=createSklepyWoo({db,repozytorium:u.repozytoriumKanalow,envSklepy:[],teraz,tryb:'produkcja',poAktywacji:u.poAktywacji,klient:()=>({sprawdzPolaczenie:async()=>({ok:true}),pobierzMetodyWysylki:async()=>[],pobierzBramkiPlatnosci:async()=>[]})});
 const wersja=(k:string)=>u.repozytoriumKanalow.listaTypu('woo').find(x=>x.klucz===k)!.wersja;
 const aktywuj=async()=>{const k=ok(s.utworzSzkic({nazwa:'Pracownia Półcień',adres:'https://sklep.polcien.example',ck:'ck_polcien',cs:'cs_polcien',od:'2026-11-01'},a)).klucz;
  ok(s.zapiszMapowanie(k,{instancje:{'3':{metoda:'dpd'},'4':{metoda:'dpd',pobranie:true}},bramkiPobrania:['cod']},wersja(k),a));ok(await s.sprawdz(k));ok(s.aktywuj(k,wersja(k),a));return k;};
 return {db,u,aktywuj};
}
const zapytanie='SELECT numer, metoda_wysylki, pobranie, kwota_pobrania FROM zamowienia ORDER BY numer';
it('sklep z panelu: bramka cod daje pobranie, bacs nie, flaga + bacs daje nieznaną metodę',async()=>{
 const {db,u,aktywuj}=setup([zam(1001,3,'cod','149.99'),zam(1002,3,'bacs','60.00'),zam(1003,4,'bacs','70.00')]);
 await aktywuj();await u.poller.przebieg();
 expect(db.prepare(zapytanie).all()).toEqual([
  {numer:'1001',metoda_wysylki:'dpd',pobranie:1,kwota_pobrania:'149.99'},
  {numer:'1002',metoda_wysylki:'dpd',pobranie:0,kwota_pobrania:null},
  {numer:'1003',metoda_wysylki:'nieznana',pobranie:0,kwota_pobrania:null},
 ]);
});
it('sklep z pliku: instancja 9 z flagą nadal daje pobranie przy bacs (zachowanie sprzed zmiany)',async()=>{
 const {db,u}=setup([zam(2001,9,'bacs','80.00')],true);
 await u.poller.przebieg();
 expect(db.prepare(zapytanie).all()).toEqual([{numer:'2001',metoda_wysylki:'dpd',pobranie:1,kwota_pobrania:'80.00'}]);
});
