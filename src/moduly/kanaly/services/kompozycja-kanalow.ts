import {createSklepyWooRuntime} from './sklepy-woo-runtime.ts';
import type {KontekstModulu} from '../../../core/kontrakty.ts';
import type {DefinicjaKanalu} from '../konfiguracja.ts';
import type {PolaczenieKanalu} from '../kontrakty-allegro.ts';
import {konfiguracjaKanalow,userAgentZZapisu} from '../konfiguracja.ts';
import {wczytajKonfiguracjeIntegracji} from '../../../oms/db/konfiguracja-integracji.js';
import {createRepozytoriumKanalow} from '../repozytorium-kanalow.ts';
import {createRejestrKanalow} from './rejestr-kanalow.ts';
import {createAplikacjaAllegro} from './aplikacja-allegro.ts';
import {createAutoryzacjaAllegro} from './autoryzacja-allegro.ts';
import {createZarzadzanieAllegro} from './zarzadzanie-allegro.ts';
import {createPrzegladZapisowAllegro} from './przeglad-zapisow-allegro.ts';
import {HOSTY_ALLEGRO} from '../../../oms/allegro/dcr.ts';
import {createAllegroClient} from '../../../oms/allegro/client.js';
import {createTokeny} from '../../../oms/allegro/tokeny.js';
import {createWooClient} from '../../../oms/woo/client.js';
import {createWooAdapter,createAllegroAdapter} from '../../../integracje/fabryki.ts';
import {createPoller} from './poller.js';
import {createZdjeciaAllegro,zPobieraniemZdjec} from './zdjecia-allegro.js';
import {createImportSklepu} from './import-sklep.js';
import {listaNaZadanie,mapaNaZadanie} from '../kolekcje-na-zadanie.ts';
import * as zapytania from '../../../oms/db/zamowienia.js';
import {stanyKanalowZKolizjami} from '../../../domena/kanal-stan.js';
import {bladPolleraNaEkran} from '../../../domena/zdrowie.js';
import {ustawKanalyAllegro} from '../../../domena/wysylka.js';
import {utworzHttp} from '../../../core/http.ts';
import {strzezAllegroProby,type ProfilAllegroProby} from '../straz-allegro-proby.ts';
export type OpcjeKompozycji={fetchImpl?:typeof fetch;limitCzasuMs?:number;userAgent?:string;strazAllegro?:ProfilAllegroProby;autoryzacjaAtrapy?:{http:(u:string,i?:RequestInit)=>Promise<Response>;softwareStatementId:string;redirectUri:string;userAgent:string}};
export function zbudujUslugiKanalow(ctx:KontekstModulu<ReturnType<typeof konfiguracjaKanalow>>,definicje:readonly DefinicjaKanalu[],o:OpcjeKompozycji){
 const {db,konfiguracja:config}=ctx;const envKanaly=config.kanaly,envSklepy=config.sklepy;
 const repozytoriumKanalow=createRepozytoriumKanalow({db,definicjeEnv:definicje,konfiguracjaEnv:envKanaly,teraz:ctx.teraz});
 // Atrapa autoryzacji jest wstrzykiwana wyłącznie w OMS_TRYB=proba.
 const opcje=o.autoryzacjaAtrapy;
 // PRZ-148.07: tryb próby (moduł ustawia strazAllegro) — wszystkie drogi do Allegro idą przez odmowę hosta.
 const fetchAllegro=o.strazAllegro?strzezAllegroProby({profil:o.strazAllegro,fetchImpl:o.fetchImpl}):o.fetchImpl;
 const httpAutoryzacji=opcje?.http??utworzHttp({fetchImpl:fetchAllegro,ponowien:0});
 const userAgent=()=>{
  if(config.userAgentZEnv)return config.userAgentZEnv;
  const zapis=wczytajKonfiguracjeIntegracji(db,'allegro-user-agent');
  return userAgentZZapisu(zapis?.ustawienia)??opcje?.userAgent??o.userAgent??config.userAgent;
 };
 const aplikacjaAllegro=createAplikacjaAllegro({db,softwareStatementId:opcje?.softwareStatementId??'',redirectUri:opcje?.redirectUri??'',http:httpAutoryzacji,deviceEnv:config.deviceEnv,userAgent});
 function ustawienia(klucz:string){
  const k=repozytoriumKanalow.pobierz(klucz)!;
  if(k.zrodlo==='env')return envKanaly[klucz];
  const a=k.aplikacja==='device'?aplikacjaAllegro.aplikacjaDevice(k.srodowisko):aplikacjaAllegro.aplikacjaDlaInstalacji(k.srodowisko);if(!a)throw new Error('Aplikacja Allegro tego konta nie jest skonfigurowana.');
  // Rejestr buforuje klientów: getter odświeża nagłówek również w istniejącym kliencie.
  return {...HOSTY_ALLEGRO[k.srodowisko],clientId:a.clientId,clientSecret:a.clientSecret,get userAgent(){return userAgent();},od:k.odUtc};
 }
 const skonfigurowany=(k:PolaczenieKanalu)=>k.zrodlo!=='env'||Boolean(envKanaly[k.klucz]);
 const wooRuntime=createSklepyWooRuntime({db,repozytorium:repozytoriumKanalow});
 const limitCzasuMs=o.limitCzasuMs??30000;
 const rejestrKanalow=createRejestrKanalow({repozytorium:repozytoriumKanalow,skonfigurowany,db,teraz:ctx.teraz,limitCzasuMs,fetchImpl:o.fetchImpl||!opcje?fetchAllegro:(u,i)=>opcje.http(String(u),i),fabryki:{woo:wooRuntime.fabryka,allegro:({polaczenie,http,httpAutoryzacji,sprawdzZapis})=>{
  const u=ustawienia(polaczenie.klucz);
  const tokeny=createTokeny({db,kanal:polaczenie.klucz,ustawienia:u,fetchImpl:undefined,http:httpAutoryzacji});
  const klient=createAllegroClient({ustawienia:u,tokeny,fetchImpl:undefined,http});
  return {tokeny,klient,poller:createPoller({db,sklep:polaczenie.klucz,od:u.od,kontrola:sprawdzZapis,kanal:createAllegroAdapter({klient})})};
 }}});
 const definicjeBiezace=():DefinicjaKanalu[]=>[
  ...definicje.filter(d=>d.typ!=='allegro'),
  ...rejestrKanalow.definicje().map(d=>{const env=definicje.find(e=>e.klucz===d.klucz);return env?{...env,etykieta:d.etykieta}:d;}),
 ];
 config.definicje=listaNaZadanie(definicjeBiezace);
 Object.defineProperty(config,'odKanalu',{enumerable:true,value:(klucz:string)=>repozytoriumKanalow.pobierz(klucz)?.odUtc??null});
 Object.defineProperty(config,'wstrzymaneKanaly',{enumerable:true,value:()=>repozytoriumKanalow.lista().filter(k=>['odlaczone','oczekuje_potwierdzenia'].includes(k.autoryzacja)).map(k=>k.klucz)});
 // Nowe kanały mają gwarantowany prefiks allegro_; rozpoznaje go też SQL domeny.
 // Dodatkowy zbiór służy wyłącznie niezmiennym kluczom legacy z env.
 ustawKanalyAllegro(definicje.filter(d=>d.typ==='allegro').map(d=>d.klucz));
 const kluczeDostepu=()=>repozytoriumKanalow.lista().filter(k=>skonfigurowany(k)&&(k.autoryzacja==='polaczone'||(k.zrodlo==='env'&&k.autoryzacja==='brak'))&&!repozytoriumKanalow.konfliktKlucza(k.klucz)).map(k=>k.klucz);
 config.kanaly=mapaNaZadanie(kluczeDostepu,ustawienia);
 const klienciKanalow=mapaNaZadanie(kluczeDostepu,k=>rejestrKanalow.klient(k));
 const envTokeny=Object.fromEntries(Object.entries(envKanaly).map(([k,u])=>[k,createTokeny({db,kanal:k,ustawienia:u,fetchImpl:fetchAllegro})]));
 const tokenyKanalow=mapaNaZadanie(()=>repozytoriumKanalow.lista().filter(k=>skonfigurowany(k)&&(k.zrodlo==='env'||k.autoryzacja==='polaczone')).map(k=>k.klucz),k=>envTokeny[k]??rejestrKanalow.tokeny(k));
 const daty=zapytania.znormalizujDatyWoo(db,Object.keys(envSklepy));
 if(daty.naprawione||daty.pominiete)ctx.log(`daty zamowien: znormalizowano ${daty.naprawione} wierszy do UTC-Z`+(daty.pominiete?`, ${daty.pominiete} POMINIETYCH bez GMT w surowym JSON-ie (obejrzec recznie)`:'')+'.');
 const envKlienci=Object.fromEntries(Object.entries(envSklepy).map(([k,u])=>[k,createWooClient({...u,fetchImpl:o.fetchImpl})]));
 const kluczeSklepow=()=>[...Object.keys(envSklepy),...repozytoriumKanalow.listaTypu('woo').filter(k=>k.autoryzacja==='polaczone'&&!Object.hasOwn(envSklepy,k.klucz)).map(k=>k.klucz)];
 config.sklepy=mapaNaZadanie(kluczeSklepow,k=>envSklepy[k]??wooRuntime.ustawienia(k));
 const klienciSklepow=mapaNaZadanie(kluczeSklepow,k=>envKlienci[k]??rejestrKanalow.klient(k));
 const polleryWoo=Object.entries(envSklepy).map(([k,u])=>createPoller({db,sklep:k,od:u.od,kanal:createWooAdapter({woo:klienciSklepow[k] as any,mapowanie:u.mapowanie})}));
 const zbiorczy={przebieg:async()=>{const bledy:string[]=[];for(const p of [...polleryWoo,{przebieg:rejestrKanalow.przebiegZamowien}])try{await p.przebieg();}catch(e){bledy.push((e as Error).message);}if(bledy.length)throw new Error(bledy.join(' | '));},
  stany:()=>[...polleryWoo.map(p=>p.stan()),...rejestrKanalow.stany()],
  stan:():any=>{const stany=zbiorczy.stany();return stany.find(s=>bladPolleraNaEkran(s))??stany.find(s=>s?.ostatni_blad)??stany[0]??null;}};
 const zdjecia=createZdjeciaAllegro({db,klienci:klienciKanalow});
 const poller=zPobieraniemZdjec(zbiorczy,zdjecia);
 const stanyKanalow=()=>stanyKanalowZKolizjami(Object.entries(tokenyKanalow).filter(([k])=>repozytoriumKanalow.pobierz(k)?.autoryzacja!=='odlaczone').map(([,t])=>t.stanDlaEkranu()));
 // Starszy renderer może odczytać stan, ale nie uruchamia już pętli zapisującej
 // parę bez potwierdzenia. Wszystkie wejścia HTTP obsługuje nowy konfigurator.
 const wiazanieKanalow={stan:(_klucz:string)=>null,stanyWszystkich:()=>[]};
 const importySklepow=Object.fromEntries(Object.entries(klienciSklepow).filter(([k])=>config.sklepy[k].historia).map(([k,klient])=>[k,createImportSklepu({db,sklep:k,klient,konfiguracja:config.sklepy[k].historia,log:ctx.log})]));
 const autoryzacjaAllegro=createAutoryzacjaAllegro({repozytorium:repozytoriumKanalow,aplikacjaDlaInstalacji:aplikacjaAllegro.aplikacjaDlaInstalacji,aplikacjaDevice:aplikacjaAllegro.aplikacjaDevice,http:httpAutoryzacji,userAgent,teraz:ctx.teraz,legacyDlaKanalu:klucz=>{
  const k=repozytoriumKanalow.pobierz(klucz),u=envKanaly[klucz];if(!k||k.zrodlo!=='env'||!u)return null;
  return {app:{clientId:u.clientId,clientSecret:u.clientSecret,clientName:'legacy',softwareStatementId:'',redirectUri:'',srodowisko:k.srodowisko},userAgent:u.userAgent,wolnoWiazac:stanyKanalow().find((s:any)=>s.kanal===klucz)?.wolnoWiazac===true};
 }});
 const poAktywacji=(k:PolaczenieKanalu)=>{
  let odbiorca:((kanal:PolaczenieKanalu)=>void)|undefined;
  try{odbiorca=ctx.usluga('raporty','poAktywacjiKanalu');}catch(e){if(!(e instanceof Error)||!e.message.includes('raporty.poAktywacjiKanalu')||!e.message.includes('nie istnieje'))throw e;}
  odbiorca?.(k);
 };
 const zarzadzanieAllegro=createZarzadzanieAllegro({db,repozytorium:repozytoriumKanalow,autoryzacja:autoryzacjaAllegro,rejestr:rejestrKanalow,teraz:ctx.teraz,poAktywacji:k=>poAktywacji(repozytoriumKanalow.pobierz(k.klucz)!)});
 const przegladZapisowAllegro=createPrzegladZapisowAllegro({db,repozytorium:repozytoriumKanalow,rejestr:rejestrKanalow,teraz:ctx.teraz});
 return {config,db,zapytania,klienciSklepow,klienciKanalow,tokenyKanalow,poller,stanyKanalow,wiazanieKanalow,importySklepow,repozytoriumKanalow,rejestrKanalow,aplikacjaAllegro,autoryzacjaAllegro,zarzadzanieAllegro,przegladZapisowAllegro,poAktywacji,limitCzasuMs,callbackAllegro:opcje?.redirectUri??''};
}
