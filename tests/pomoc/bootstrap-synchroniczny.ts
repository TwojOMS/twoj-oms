import type { ModulOms, Srodowisko } from '../../src/core/kontrakty.ts';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { modulRdzen } from '../../src/moduly/rdzen/modul.ts';
import { modulWeb } from '../../src/core/web/modul.ts';
import { createModulKanaly } from '../../src/moduly/kanaly/modul.ts';
import { definicjeKanalow } from '../../src/moduly/kanaly/konfiguracja.ts';
import { createModulZamowienia } from '../../src/moduly/zamowienia/modul.ts';
import { createModulFaktury, wczytajFaktury } from '../../src/moduly/faktury/modul.ts';
import { createModulKoszty, wczytajKoszty } from '../../src/moduly/koszty/modul.ts';
import { modulZdrowie } from '../../src/moduly/zdrowie/modul.ts';
import { konfiguracjaKanalow } from '../../src/moduly/kanaly/konfiguracja.ts';
import { stanyKanalowZKolizjami } from '../../src/domena/kanal-stan.js';
import { createModulWysylka } from '../../src/moduly/wysylka/modul.ts';
import { modulMagazyn } from '../../src/moduly/magazyn/modul.ts';
import { modulZwroty } from '../../src/moduly/zwroty/modul.ts';
import { createModulWiadomosci } from '../../src/moduly/wiadomosci/modul.ts';
import { modulRaporty } from '../../src/moduly/raporty/modul.ts';
import {createModulMarketing} from '../../src/moduly/marketing/modul.ts';
import {konfiguracjaMarketingu} from '../../src/moduly/marketing/konfiguracja.ts';
import {utworzUslugiMarketingu} from '../../src/moduly/marketing/uslugi.ts';
import { modulUstawienia } from '../../src/moduly/ustawienia/modul.ts';
import { loadOmsConfig } from './konfiguracja-parytetu.ts';
import { buildOmsServer } from './serwer-parytetu.ts';

/** Jawne tłumaczenie historycznych nazw env i wstrzykniętych fabryk. Logika usług pozostaje produkcyjna. */
export function zbudujOms(o:any) {
  const old:Srodowisko=o.env;
  const e:Record<string,string|undefined>={...old,
    OMS_USER:old.OMS_USER??old.OMS_AUTH_USER,OMS_PASS:old.OMS_PASS??old.OMS_AUTH_PASS,
    OMS_ETYKIETY_KATALOG:old.OMS_ETYKIETY_KATALOG??old.OMS_ETYKIETY_DIR,
  };
  const defs:any[]=[];
  const aliasyUserAgent=new Map<string,string>();
  for(const [k,v] of Object.entries(old)) {
    const shop=/^(SHOP_[A-Z0-9_]+)_URL$/.exec(k);
    if(shop&&v){const p=shop[1]!;defs.push({klucz:p.slice(5).toLowerCase(),typ:'woo',prefiks:p});e[`${p}_MAPOWANIE`]=old[`${p}_MAPOWANIE`]??'{"instancje":{},"poPozycji":[]}';}
    const allegro=/^(ALLEGRO_[A-Z0-9_]+)_CLIENT_ID$/.exec(k);
    if(allegro&&v){const p=allegro[1]!;defs.push({klucz:p.toLowerCase(),typ:'allegro',prefiks:p});if(old[`${p}_USER_AGENT`]===undefined){e[`${p}_USER_AGENT`]=old.ALLEGRO_USER_AGENT;aliasyUserAgent.set(`${p}_USER_AGENT`,'ALLEGRO_USER_AGENT');}}
  }
  e.OMS_KANALY=JSON.stringify(defs);
  const config:any=loadOmsConfig(e);
  e.OMS_PROFORMY_KATALOG = e.OMS_PROFORMY_KATALOG ?? config.proforma.katalog;
  e.OMS_SPRZEDAWCA_NIP = e.OMS_SPRZEDAWCA_NIP ?? config.proforma.nip;
  e.OMS_RACHUNEK = e.OMS_RACHUNEK ?? config.proforma.rachunek;
  if(e.KSEF_TOKEN)e.KSEF_API = e.KSEF_API ?? 'https://api.ksef.mf.gov.pl/v2';
  // Zachowane synchroniczne odmowy frozen, przed utworzeniem asynchronicznego HTTP.
  try{Object.assign(config,konfiguracjaKanalow(definicjeKanalow(e),e));}
  catch(err){let komunikat=err instanceof Error?err.message:String(err);for(const [nowa,stara] of aliasyUserAgent)komunikat=komunikat.replaceAll(nowa,stara);throw Error(komunikat);}
  wczytajFaktury(e); wczytajKoszty(e);
  Object.assign(config,konfiguracjaMarketingu(e));
  const db=openOmsDb(old.OMS_DB_PATH??':memory:');
  const marketing=utworzUslugiMarketingu({db,config:konfiguracjaMarketingu(e),fabryki:{createMeta:o.createMeta,createGa4:o.createGa4}});
  const nadpisania:Record<string,any>={};const wynik:Record<string,any>={...marketing,db,config};
  const obserwator:ModulOms={nazwa:'parytet-bootstrap',wersja:'1.0.0',wymaga:['wysylka','wiadomosci','faktury','koszty','zdrowie','zamowienia'],konfiguracja:()=>null,migracje:[],uprawnienia:[],menu:[],zbuduj:ctx=>{
    const kurierzy=ctx.usluga<Record<string,any>>('wysylka','kurierzy');
    Object.assign(config,ctx.usluga('wysylka','config'));
    Object.assign(wynik,{dpd:kurierzy.dpd??null,inpost:kurierzy.inpost??null,kurierzy,
      nadanie:ctx.usluga('wysylka','nadanie'),poller:ctx.usluga('kanaly','poller')});
    for(const nazwa of ['infakt','faktura','proforma','fakturaAllegro','fakturaHurtem','doczytanieKsef','fakturyWidok','wysylkaKsef','czuwaczKsef','czuwaczArchiwumSprzedazy','puls'])wynik[nazwa]=ctx.usluga('faktury',nazwa);
    for(const nazwa of ['czuwaczKosztow','wizualizacjaKosztu','paczkaDlaBiura'])wynik[nazwa]=ctx.usluga('koszty',nazwa);
    for(const nazwa of ['zdrowie','czuwaczOstrzezen'])wynik[nazwa]=ctx.usluga('zdrowie',nazwa);
    for(const nazwa of ['czuwaczPrzesylek','czuwaczPodjazdow','podjazdy','przesylkiAllegro'])wynik[nazwa]=ctx.usluga('wysylka',nazwa);
    for(const nazwa of ['stanyKanalow','wiazanieKanalow','klienciKanalow','tokenyKanalow'])wynik[nazwa]=ctx.usluga('kanaly',nazwa);
    wynik.syncSklep=ctx.usluga('zamowienia','syncSklep');
    wynik.korekta=ctx.usluga('zwroty','korekta');
    for (const nazwa of ['config','klienciWiadomosci','mailer','potwierdzenie','wiadomosci','pollerWiadomosci','czuwaczFormulki','odswiezanieSpraw']) {
      if(nazwa==='config') {
        // Ten fragment jest własnością wiadomości; nie nadpisuje nadawcy wysyłki.
        const { poczta, oprawaPoczty } = ctx.usluga<Record<string, unknown>>('wiadomosci','config');
        Object.assign(config, { poczta, oprawaPoczty });
      }
      else wynik[nazwa]=ctx.usluga('wiadomosci',nazwa);
    }
    return {};
  }};
  const fabryki=Object.fromEntries(['createDpd','createInpost','createAllegroWza','createAllegroSledzenie'].filter(k=>o[k]).map(k=>[k,o[k]]));
  const fabrykiWiadomosci=Object.fromEntries(['createMailer','createPotwierdzenie','createWiadomosci','createPollerWiadomosci','createCzuwaczFormulki','createOdswiezanieSpraw'].filter(k=>o[k]).map(k=>[k,o[k]]));
  const fabrykiFaktur=Object.fromEntries(['createCzuwacz','createCzuwaczArchiwumSprzedazy'].filter(k=>o[k]).map(k=>[k,o[k]]));
  const fabrykiKosztow=Object.fromEntries(['createCzuwaczKosztow','createWizualizacjaKosztuFn','createPaczkaDlaBiuraFn'].filter(k=>o[k]).map(k=>[k,o[k]]));
  const kanaly=createModulKanaly(definicjeKanalow(e),false,{fetchImpl:globalThis.fetch});
  wynik.app=buildOmsServer({db,config,env:e,nadpisania,bootstrap:true,
    stanyKanalow:()=>stanyKanalowZKolizjami(Object.values(wynik.tokenyKanalow??{}).map((t:any)=>t.stanDlaEkranu())),
    moduly:[modulRdzen,modulWeb,kanaly,createModulFaktury({fabryki:fabrykiFaktur}),createModulWiadomosci({fabryki:fabrykiWiadomosci}),createModulZamowienia({zWiadomosciami:true}),createModulWysylka({fabryki}),modulMagazyn,modulZwroty,modulRaporty,createModulMarketing({uslugi:marketing}),modulUstawienia,createModulKoszty({createKlient:o.createKsefKlient,fabryki:fabrykiKosztow}),modulZdrowie,obserwator]});
  return wynik;
}
