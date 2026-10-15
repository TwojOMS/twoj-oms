import { definicjeKanalowHistoryczne } from './kanaly-historyczne-fixture.js';
import { CENNIKI_HISTORYCZNE } from './cenniki-historyczne-fixture.js';
import { tmpdir } from 'node:os';
import type { ModulOms } from '../../src/core/kontrakty.ts';
import { zbudujOms } from './zbuduj-oms.ts';
import { modulRdzen } from '../../src/moduly/rdzen/modul.ts';
import { modulWeb } from '../../src/core/web/modul.ts';
import { modulKanaly } from '../../src/moduly/kanaly/modul.ts';
import { createModulZamowienia } from '../../src/moduly/zamowienia/modul.ts';
import { modulWysylka } from '../../src/moduly/wysylka/modul.ts';
import { modulFaktury } from '../../src/moduly/faktury/modul.ts';
import { modulMagazyn } from '../../src/moduly/magazyn/modul.ts';
import { modulZwroty } from '../../src/moduly/zwroty/modul.ts';
import { modulKoszty } from '../../src/moduly/koszty/modul.ts';
import { modulUstawienia } from '../../src/moduly/ustawienia/modul.ts';
import { modulZdrowie } from '../../src/moduly/zdrowie/modul.ts';
import { modulMarketing } from '../../src/moduly/marketing/modul.ts';
import { modulRaporty } from '../../src/moduly/raporty/modul.ts';
import { configRaportowFixture } from './raporty-parytetu.js';
import { modulWiadomosci } from '../../src/moduly/wiadomosci/modul.ts';
import { modulApiPanelu } from '../../src/moduly/api-panelu/modul.ts';
export { ODSTEP_CZUWACZA_MS } from './bootstrap-parytetu.ts';

/** Adapter wyłącznie danych dawnych testów. HTTP i usługi wykonują prawdziwe moduły. */
export function buildOmsServer(o: Record<string, any>) {
  const config=o.config??{};
  if (!Object.hasOwn(config, 'definicje')) config.definicje=definicjeKanalowHistoryczne;
  if (!Object.hasOwn(config, 'cenniki')) config.cenniki=CENNIKI_HISTORYCZNE;
  // Dawne testy auth-only korzystały ze stałych kanałów kontrolera magazynu.
  // To jawne dane fixture; produkcyjny bootstrap nadal wymaga konfiguracji kanałów.
  const configKanalow={...config,
    sklepy:config.sklepy??{pro:{},szkicownia:{}},
    kanaly:config.kanaly??{allegro_szkicownia:{},allegro_amarka:{}}};
  const env={OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',
    OMS_USER:config.auth?.user??'operator',OMS_PASS:config.auth?.pass??'atrapa',
    OMS_ETYKIETY_KATALOG:tmpdir(),OMS_PROFORMY_KATALOG:tmpdir(),
    DPD_NADAWCA_NAZWA:config.nadawca?.nazwa,DPD_NADAWCA_ULICA:config.nadawca?.ulica,
    DPD_NADAWCA_KOD:config.nadawca?.kod,DPD_NADAWCA_MIASTO:config.nadawca?.miasto,DPD_NADAWCA_KRAJ:config.nadawca?.kraj,
    ...o.env};
  const nadpisania:Record<string,unknown>=o.nadpisania??{};
  Object.assign(nadpisania,{
    'web.config':config,'kanaly.config':configKanalow,'faktury.config':config,
    'zamowienia.opcjeTras':{...o,config},
    'raporty.config': {...configRaportowFixture, ...config.raporty},
    'marketing.config':config,
  });
  for(const key of ['poller','stanyKanalow','wiazanieKanalow'])if(Object.hasOwn(o,key))nadpisania[`kanaly.${key}`]=o[key];
  for(const key of ['czuwaczKampanii','czuwaczReklam','reklamy'])if(Object.hasOwn(o,key))nadpisania[`marketing.${key}`]=o[key];
  if(Object.hasOwn(o,'lacznosc'))nadpisania['ustawienia.lacznosc']=o.lacznosc;
  for(const key of ['wiadomosci','klienciWiadomosci','pollerWiadomosci','czuwaczFormulki','odswiezanieSpraw'])if(Object.hasOwn(o,key))nadpisania[`wiadomosci.${key}`]=o[key];
  if(Object.hasOwn(o,'klienciWiadomosci'))nadpisania['kanaly.klienciKanalow']=o.klienciWiadomosci;
  if(Object.hasOwn(o,'gus'))nadpisania['zamowienia.gus']=o.gus;
  if(Object.hasOwn(o,'syncSklep'))nadpisania['zamowienia.syncSklep']=o.syncSklep;
  if(Object.hasOwn(o,'magazyn'))nadpisania['magazyn.magazyn']=o.magazyn;
  if(Object.hasOwn(o,'sklepy'))nadpisania['kanaly.klienciSklepow']=o.sklepy;
  if(Object.hasOwn(o,'korekta'))nadpisania['zwroty.korekta']=o.korekta;
  for(const key of ['czuwaczKosztow','wizualizacjaKosztu','paczkaDlaBiura'])if(Object.hasOwn(o,key))nadpisania[`koszty.${key}`]=o[key];
  for(const key of ['nadanie','podjazdy','kurierzy','przesylkiAllegro'])if(Object.hasOwn(o,key))nadpisania[`wysylka.${key}`]=o[key];
  for(const key of ['faktura','proforma','fakturaAllegro','fakturaHurtem','doczytanieKsef','infakt','fakturyWidok','wysylkaKsef','czuwaczArchiwumSprzedazy','paczkaBiuro','paczkaDlaBiura','vies'])if(Object.hasOwn(o,key))nadpisania[`faktury.${key}`]=o[key];
  // Frozen buildOmsServer przyjmował proforma=null, bez fabryki w konstruktorze HTTP.
  // Odtwarzamy wyłącznie jego wejście testowe; bootstrap produktu buduje rzeczywistą usługę.
  if(!o.bootstrap&&!Object.hasOwn(o,'proforma')&&!Object.hasOwn(nadpisania,'faktury.proforma'))nadpisania['faktury.proforma']=null;
  let przechwycony:any;
  // Dawny serwer przyjmował osobne config.nadawca nawet bez klienta DPD.
  // To wyłącznie wejście fixture: produkcyjny manifest nadal waliduje config.dpd.
  const wysylkaHistoryczna={...modulWysylka,konfiguracja:(srodowisko:Parameters<typeof modulWysylka.konfiguracja>[0])=>{
    const rzeczywista=modulWysylka.konfiguracja(srodowisko);
    if(!Object.hasOwn(config,'nadawca') || !config.nadawca)return rzeczywista;
    const n=config.nadawca;
    return {...rzeczywista,adresPodjazdu:{name:n.nazwa??'',street:n.ulica??'',postalCode:n.kod??'',city:n.miasto??'',
      countryCode:n.kraj??'PL',email:n.email??'',phone:n.phone??''}};
  }};
  const obserwator:ModulOms={nazwa:'parytet-obserwator',wersja:'1.0.0',wymaga:['wysylka'],migracje:[],menu:[],uprawnienia:[],konfiguracja:()=>null,zbuduj:()=>({trasy:app=>{przechwycony=app;}})};
  const moduly=[...(o.moduly??[modulRdzen,modulWeb,modulKanaly,modulFaktury,modulWiadomosci,createModulZamowienia({zWiadomosciami:true}),wysylkaHistoryczna,modulMagazyn,modulZwroty,modulKoszty,modulUstawienia,modulRaporty,modulMarketing,modulApiPanelu,modulZdrowie]),
    obserwator] as readonly ModulOms[];
  const gotowe=zbudujOms({moduly,db:o.db,env,nadpisania});
  // Dawna konstrukcja jest synchroniczna; wszystkie operacje asynchroniczne czekają na skład.
  return new Proxy({}, {get:(_target,property)=>{
    if(property==='then')return undefined;
    if(property==='initialConfig')return przechwycony?.initialConfig;
    if(property==='ready')return async()=>{await gotowe;};
    if(property==='close')return async()=>{await (await gotowe).app.close();};
    return async(...args:unknown[])=>{const app=(await gotowe).app as any;const fn=app[property];if(typeof fn!=='function')throw new Error(`Adapter HTTP nie udostępnia ${String(property)}`);return fn.apply(app,args);};
  }}) as any;
}
