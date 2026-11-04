import {afterEach,expect,it,vi} from 'vitest';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {createSklepyWoo} from '../../../src/moduly/kanaly/services/sklepy-woo.ts';
import {klientSklepuPrzykladowego} from '../../../src/moduly/kanaly/services/atrapa-sklepu-przykladowego.ts';

const PRZYKLADOWY='https://sklep-przykladowy.example.invalid';
const bazy:ReturnType<typeof openOmsDb>[]=[];
afterEach(()=>{for(const db of bazy.splice(0))db.close();});
const aktor={id:1,login:'polcien_test'};
function ok(w:any){expect(w.ok).toBe(true);return w.dane;}
async function setup(proba:boolean,adres=PRZYKLADOWY){
 const db=openOmsDb();bazy.push(db);
 const fetchImpl=vi.fn(async()=>{throw new TypeError('Transport testowy nie łączy się z siecią.');});
 const modul=createModulKanaly([],false,{fetchImpl});
 const konfiguracja=modul.konfiguracja({OMS_TRYB:proba?'proba':'produkcja'});
 // Znacznik przykładowego sklepu jak w konfiguracji piaskownicy; nie jest połączeniem z panelu.
 konfiguracja.sklepy.przykladowy={baseUrl:PRZYKLADOWY,atrapa:true} as any;
 for(const m of modul.migracje??[])m.wykonaj(db);
 let uslugi:any;
 const z=modul.zbuduj({db,konfiguracja,teraz:()=>new Date('2026-11-04T12:00:00Z'),log:()=>{},
  usluga:(_modul:string,nazwa:string)=>{if(nazwa==='config')return uslugi.config;return ()=>{};}} as any);
 uslugi=z.uslugi!;
 // Przygotowanie połączenia niezależne od kreatora i transportu badanego pollera.
 const s=createSklepyWoo({db,repozytorium:uslugi.repozytoriumKanalow,envSklepy:[],tryb:'produkcja',
  klient:()=>klientSklepuPrzykladowego({ck:'ck_fixture',cs:'cs_fixture'})});
 const k=ok(s.utworzSzkic({nazwa:'Pracownia Półcień',adres,ck:'ck_fixture',cs:'cs_fixture',od:'2026-11-01'},aktor)).klucz;
 const wersja=()=>uslugi.repozytoriumKanalow.listaTypu('woo').find((s:any)=>s.klucz===k).wersja;
 ok(s.zapiszMapowanie(k,{instancje:{},bramkiPobrania:[]},wersja(),aktor));
 ok(await s.sprawdz(k));ok(s.aktywuj(k,wersja(),aktor));
 return {db,uslugi,fetchImpl,k,s,wersja};
}
it('proba: poller połączonego sklepu przykładowego kończy przebieg bez błędu i bez fetch',async()=>{
 const {db,uslugi,fetchImpl,k}=await setup(true);
 await expect(uslugi.rejestrKanalow.przebiegZamowien()).resolves.toBeUndefined();
 expect(fetchImpl).not.toHaveBeenCalled();
 expect(db.prepare('SELECT ostatni_blad,ostatni_przebieg_at FROM stan_pollera WHERE sklep=?').get(k))
  .toEqual({ostatni_blad:null,ostatni_przebieg_at:expect.any(String)});
 expect(db.prepare('SELECT count(*) AS n FROM zamowienia').get()).toEqual({n:0});
});
it.each([[false,PRZYKLADOWY],[true,'https://sklep.example.test']])('zwykły transport poza próbą lub dla obcego adresu (%s, %s)',async(proba,adres)=>{
 const {uslugi,fetchImpl}=await setup(proba,adres);
 await expect(uslugi.rejestrKanalow.przebiegZamowien()).rejects.toThrow('Nie udało się');
 expect(fetchImpl).toHaveBeenCalled();
 expect(fetchImpl.mock.calls.length).toBeGreaterThan(0);
});
it.each(['pobierzZamowieniaZakresu','pobierzWszystkieProdukty','pobierzWarianty','pobierzMiniatury',
 'ustawienieSklepu','pobierzProdukt','zapiszProdukt','dodajNotatke','ustawStatus'])('proba: %s zwraca czytelną odmowę bez sieci',async metoda=>{
 const {uslugi,fetchImpl,k}=await setup(true);
 await expect(uslugi.rejestrKanalow.klient(k)[metoda]()).rejects.toThrow('Sklep przykładowy nie obsługuje tej operacji. Nic nie zostało wysłane.');
 expect(fetchImpl).not.toHaveBeenCalled();
});
it('odłączenie unieważnia także klienta przykładowego pobranego z rejestru',async()=>{
 const {uslugi,fetchImpl,k,s,wersja}=await setup(true);
 const klient=uslugi.rejestrKanalow.klient(k);
 ok(s.odlacz(k,wersja(),aktor));
 await expect(klient.pobierzZamowienia()).rejects.toMatchObject({name:'KanalZatrzymany'});
 expect(fetchImpl).not.toHaveBeenCalled();
});
