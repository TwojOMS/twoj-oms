import {createSklepyWooRuntime} from './sklepy-woo-runtime.ts';
import type {KontekstModulu} from '../../../core/kontrakty.ts';
import type {DefinicjaKanalu} from '../konfiguracja.ts';
import type {PolaczenieKanalu} from '../kontrakty-allegro.ts';
import {konfiguracjaKanalow,userAgentZZapisu} from '../konfiguracja.ts';
import {wczytajKonfiguracjeIntegracji,zapiszKonfiguracjeIntegracji} from '../../../oms/db/konfiguracja-integracji.js';
import {bladAllegro,type Aktor,type Wynik} from '../kontrakty-allegro.ts';
import {createRepozytoriumKanalow} from '../repozytorium-kanalow.ts';
import {createRejestrKanalow} from './rejestr-kanalow.ts';
import {createAplikacjaAllegro} from './aplikacja-allegro.ts';
import {createAutoryzacjaAllegro} from './autoryzacja-allegro.ts';
import {createZarzadzanieAllegro} from './zarzadzanie-allegro.ts';
import {createPrzegladZapisowAllegro} from './przeglad-zapisow-allegro.ts';
import {HOSTY_ALLEGRO} from '../../../oms/allegro/dcr.ts';
import {createAllegroClient} from '../../../oms/allegro/client.js';
import {createTokeny} from '../../../oms/allegro/tokeny.js';
import {wczytajTokeny} from '../../../oms/db/tokeny.js';
import {maZgodeNaOferty,brakZgodyNaOferty} from '../../../domena/uprawnienia-kanalu.js';
import {createWooClient} from '../../../oms/woo/client.js';
import {createWooAdapter,createAllegroAdapter} from '../../../integracje/fabryki.ts';
import {createPoller} from './poller.js';
import {createFabrykaErli} from './kanal-erli.ts';
import {createZdjeciaAllegro,zPobieraniemZdjec} from './zdjecia-allegro.js';
import {createImportSklepu} from './import-sklep.js';
import {listaNaZadanie,mapaNaZadanie} from '../kolekcje-na-zadanie.ts';
import * as zapytania from '../../../oms/db/zamowienia.js';
import {stanyKanalowZKolizjami} from '../../../domena/kanal-stan.js';
import {bladPolleraNaEkran} from '../../../domena/zdrowie.js';
import {ustawKanalyAllegro} from '../../../domena/wysylka.js';
import {ustawRejestrKanalow} from '../../../domena/moduly-kanalow.ts';
import {MODUL_ALLEGRO} from '../../../domena/modul-allegro.ts';
import {utworzHttp} from '../../../core/http.ts';
import {strzezAllegroProby,type ProfilAllegroProby} from '../straz-allegro-proby.ts';
export type OpcjeKompozycji={klientWooZastepczy?:(u:{baseUrl:string;ck:string;cs:string})=>Record<string,any>|null;fetchImpl?:typeof fetch;limitCzasuMs?:number;userAgent?:string;strazAllegro?:ProfilAllegroProby;autoryzacjaAtrapy?:{http:(u:string,i?:RequestInit)=>Promise<Response>;softwareStatementId:string;redirectUri:string;userAgent:string}};
export function zbudujUslugiKanalow(ctx:KontekstModulu<ReturnType<typeof konfiguracjaKanalow>>,definicje:readonly DefinicjaKanalu[],o:OpcjeKompozycji){
 const {db,konfiguracja:config}=ctx;const envKanaly=config.kanaly,envSklepy=config.sklepy;
 const repozytoriumKanalow=createRepozytoriumKanalow({db,definicjeEnv:definicje,konfiguracjaEnv:{...envKanaly,...config.erli},teraz:ctx.teraz});
 // Atrapa autoryzacji jest wstrzykiwana wyłącznie w OMS_TRYB=proba.
 const opcje=o.autoryzacjaAtrapy;
 // Tryb próby (moduł ustawia strazAllegro) — wszystkie drogi do Allegro idą przez odmowę hosta.
 const fetchAllegro=o.strazAllegro?strzezAllegroProby({profil:o.strazAllegro,fetchImpl:o.fetchImpl}):o.fetchImpl;
 const httpAutoryzacji=opcje?.http??utworzHttp({fetchImpl:fetchAllegro,ponowien:0});
 const userAgent=()=>{
  if(config.userAgentZEnv)return config.userAgentZEnv;
  const zapis=wczytajKonfiguracjeIntegracji(db,'allegro-user-agent');
  return userAgentZZapisu(zapis?.ustawienia)??opcje?.userAgent??o.userAgent??config.userAgent;
 };
 const aplikacjaAllegro=createAplikacjaAllegro({db,softwareStatementId:opcje?.softwareStatementId??'',redirectUri:opcje?.redirectUri??'',http:httpAutoryzacji,deviceEnv:config.deviceEnv,userAgent,teraz:ctx.teraz});
 function ustawienia(klucz:string){
  const k=repozytoriumKanalow.pobierz(klucz)!;
  if(k.zrodlo==='env')return envKanaly[klucz];
  const a=k.aplikacja==='device'?aplikacjaAllegro.aplikacjaDevice(k.srodowisko):aplikacjaAllegro.aplikacjaDlaInstalacji(k.srodowisko);if(!a)throw new Error('Aplikacja Allegro tego konta nie jest skonfigurowana.');
  // Rejestr buforuje klientów: getter odświeża nagłówek również w istniejącym kliencie.
  return {...HOSTY_ALLEGRO[k.srodowisko],clientId:a.clientId,clientSecret:a.clientSecret,get userAgent(){return userAgent();},od:k.odUtc};
 }
 const skonfigurowany=(k:PolaczenieKanalu)=>k.zrodlo!=='env'||Boolean(envKanaly[k.klucz]||config.erli?.[k.klucz]);
 const wooRuntime=createSklepyWooRuntime({db,repozytorium:repozytoriumKanalow,klientWooZastepczy:o.klientWooZastepczy});
 const limitCzasuMs=o.limitCzasuMs??30000;
 const rejestrKanalow=createRejestrKanalow({repozytorium:repozytoriumKanalow,skonfigurowany,db,teraz:ctx.teraz,limitCzasuMs,fetchImpl:o.fetchImpl||!opcje?fetchAllegro:(u,i)=>opcje.http(String(u),i),fabryki:{woo:wooRuntime.fabryka,allegro:({polaczenie,http,httpAutoryzacji,sprawdzZapis})=>{
  const u=ustawienia(polaczenie.klucz);
  const tokeny=createTokeny({db,kanal:polaczenie.klucz,ustawienia:u,fetchImpl:undefined,http:httpAutoryzacji});
  const klient=createAllegroClient({ustawienia:u,tokeny,fetchImpl:undefined,http});
  return {tokeny,klient,poller:createPoller({db,sklep:polaczenie.klucz,od:u.od,kontrola:sprawdzZapis,kanal:createAllegroAdapter({klient})})};
 },
 erli:createFabrykaErli({db,teraz:ctx.teraz,ustawieniaEnv:config.erli})}});
 const definicjeBiezace=():DefinicjaKanalu[]=>[
  ...definicje.filter(d=>!rejestrKanalow.definicje().some(r=>r.klucz===d.klucz)),
  ...rejestrKanalow.definicje().map(d=>{const env=definicje.find(e=>e.klucz===d.klucz);return env?{...env,etykieta:d.etykieta}:d;}),
 ];
 config.definicje=listaNaZadanie(definicjeBiezace);
 // pobierz() obsługuje tylko Allegro; raporty potrzebują daty także dla ERLI i Woo.
 Object.defineProperty(config,'odKanalu',{enumerable:true,value:(klucz:string)=>{
  const typ=repozytoriumKanalow.typKanalu(klucz);
  return typ?repozytoriumKanalow.listaTypu(typ as PolaczenieKanalu['typ']).find(k=>k.klucz===klucz)?.odUtc??null:null;
 }});
 Object.defineProperty(config,'wstrzymaneKanaly',{enumerable:true,value:()=>repozytoriumKanalow.lista().filter(k=>['odlaczone','oczekuje_potwierdzenia'].includes(k.autoryzacja)).map(k=>k.klucz)});
 // Nowe kanały mają gwarantowany prefiks allegro_; rozpoznaje go też SQL domeny.
 // Dodatkowy zbiór służy wyłącznie niezmiennym kluczom legacy z env.
 ustawKanalyAllegro(definicje.filter(d=>d.typ==='allegro').map(d=>d.klucz));
 // Moduł zamówienia z typu połączenia (env albo kanaly_sprzedazy.typ), czytanego na żywo — panel nie musi odświeżać.
 ustawRejestrKanalow(repozytoriumKanalow.typKanalu);
 const kluczeDostepu=()=>repozytoriumKanalow.lista().filter(k=>skonfigurowany(k)&&(k.autoryzacja==='polaczone'||(k.zrodlo==='env'&&k.autoryzacja==='brak'))&&!repozytoriumKanalow.konfliktKlucza(k.klucz)).map(k=>k.klucz);
 config.kanaly=mapaNaZadanie(kluczeDostepu,ustawienia);
 const kluczeKlientow=()=>[...kluczeDostepu(),...repozytoriumKanalow.listaTypu('erli').filter(k=>skonfigurowany(k)&&k.autoryzacja==='polaczone'&&!repozytoriumKanalow.konfliktKlucza(k.klucz)).map(k=>k.klucz)];
 const klienciKanalow=mapaNaZadanie(kluczeKlientow,k=>rejestrKanalow.klient(k));
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
 const zdjecia=createZdjeciaAllegro({db,klienci:mapaNaZadanie(kluczeDostepu,k=>klienciKanalow[k])});
 const poller=zPobieraniemZdjec(zbiorczy,zdjecia);
 // Trzy ścieżki zgody na oferty.
 // env = konto z pliku (Device Flow ponownie, bez rozłączania); panel = aplikacja Device z instalacji
 // (też Device Flow ponownie, bez rozłączania; nowa para tylko dla tego samego konta Allegro);
 // dcr = oferty niedostępne.
 const sciezkaOfert=(k:PolaczenieKanalu):'env'|'panel'|'dcr'=>k.zrodlo==='env'?'env'
  :k.aplikacja==='device'||(k.aplikacja==null&&k.autoryzacja!=='polaczone'&&aplikacjaAllegro.aplikacjaDevice(k.srodowisko))?'panel':'dcr';
 const aplikacjaOfert=(k:PolaczenieKanalu):{clientId:string;clientSecret:string;userAgent?:string}|null=>{
  const s=sciezkaOfert(k);
  if(s==='env'){const u=envKanaly[k.klucz];return u?{clientId:u.clientId,clientSecret:u.clientSecret,userAgent:u.userAgent}:null;}
  return s==='panel'?aplikacjaAllegro.aplikacjaDevice(k.srodowisko):null;
 };
 const chceKey=(klucz:string)=>'allegro_oferty_chce:'+klucz;
 const chceOfert=(klucz:string)=>wczytajKonfiguracjeIntegracji(db,chceKey(klucz))?.ustawienia?.chce===true;
 // ⚠️ Flagi tylko dla kont env: tam `wolnoWiazac` otwiera ponowny Device Flow na zdrowym koncie.
 // Konto z panelu wiąże się ponownie wyłącznie dla zgody na oferty — `ponownaZgodaPanelu` niżej.
 const flagiOfert=(klucz:string)=>{
  const k=repozytoriumKanalow.pobierz(klucz);if(!k||k.zrodlo!=='env')return {};
  const a=aplikacjaOfert(k);
  return {aplikacjaMaOferty:Boolean(a&&aplikacjaAllegro.aplikacjaMaOferty(k.srodowisko,a.clientId)===true),chceOfert:chceOfert(klucz)};
 };
 const stanyKanalow=()=>stanyKanalowZKolizjami(Object.entries(tokenyKanalow).filter(([k])=>repozytoriumKanalow.pobierz(k)?.autoryzacja!=='odlaczone').map(([k,t])=>({...t.stanDlaEkranu(),...flagiOfert(k)})));
 const importySklepow=Object.fromEntries(Object.entries(klienciSklepow).filter(([k])=>config.sklepy[k].historia).map(([k,klient])=>[k,createImportSklepu({db,sklep:k,klient,konfiguracja:config.sklepy[k].historia,log:ctx.log})]));
 const autoryzacjaAllegro=createAutoryzacjaAllegro({repozytorium:repozytoriumKanalow,aplikacjaDlaInstalacji:aplikacjaAllegro.aplikacjaDlaInstalacji,aplikacjaDevice:aplikacjaAllegro.aplikacjaDevice,http:httpAutoryzacji,userAgent,teraz:ctx.teraz,zakresyOfert:(s,clientId)=>aplikacjaAllegro.aplikacjaMaOferty(s,clientId)===true,ponownieDlaPanelu:klucz=>ponownaZgodaPanelu(klucz),legacyDlaKanalu:klucz=>{
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
 // Zgoda na oferty na żądanie. Ani sprawdzenie aplikacji, ani „chcę” nie
 // ruszają konta (wersja, generacja, tokeny) — zapisują wyłącznie swój znacznik.
 const NIEDOSTEPNE='Oferty niedostępne w tej instalacji. Konto połączone przez logowanie w przeglądarce nie może poprosić o zgodę na oferty.';
 // Połączone konto z panelu wiąże się ponownie tylko po „Chcę wystawiać oferty”,
 // gdy token nie ma zakresów ofert, a aplikacja Device je ma. Inne powody (wygasła zgoda) dalej
 // prowadzą przez rozłączenie i nowe połączenie.
 function ponownaZgodaPanelu(klucz:string){
  const k=repozytoriumKanalow.pobierz(klucz);
  if(!k||k.typ!==MODUL_ALLEGRO.typ||k.zrodlo!=='panel'||k.autoryzacja!=='polaczone'||k.aplikacja!=='device'||!k.kontoId||sciezkaOfert(k)!=='panel')return false;
  const a=aplikacjaOfert(k);
  return Boolean(a&&chceOfert(klucz)&&brakZgodyNaOferty(wczytajTokeny(db,klucz)?.access_token)&&aplikacjaAllegro.aplikacjaMaOferty(k.srodowisko,a.clientId)===true);
 }
 const ofertyAllegro={
  stan(klucz:string){
   const k=repozytoriumKanalow.pobierz(klucz);if(!k)return null;
   const sciezka=sciezkaOfert(k),a=aplikacjaOfert(k);
   // Ekran i Magazyn czytają ten sam token, także gdy klient konta jest atrapą.
   const token=wczytajTokeny(db,klucz)?.access_token;
   const zgoda=maZgodeNaOferty(token)?true:brakZgodyNaOferty(token)?false:null;
   const wolnoWiazac=sciezka==='env'?stanyKanalow().find((s:any)=>s.kanal===klucz)?.wolnoWiazac===true:ponownaZgodaPanelu(klucz);
   return {sciezka,zgoda,aplikacja:config.kanaly[klucz]?.atrapa===true?true:a&&sciezka!=='dcr'?aplikacjaAllegro.aplikacjaMaOferty(k.srodowisko,a.clientId):null,chce:chceOfert(klucz),wolnoWiazac,koncowka:a?a.clientId.slice(-4):null};
  },
  async sprawdzAplikacje(klucz:string,aktor:Aktor):Promise<Wynik<{oferty:boolean}>>{
   const k=repozytoriumKanalow.pobierz(klucz);if(!k||k.typ!==MODUL_ALLEGRO.typ)return bladAllegro('walidacja','Nie ma takiego konta Allegro.');
   if(sciezkaOfert(k)==='dcr')return bladAllegro('konflikt',NIEDOSTEPNE);
   const a=aplikacjaOfert(k);if(!a)return bladAllegro('brak_dostepu','Aplikacja Allegro tego konta nie jest skonfigurowana.');
   return aplikacjaAllegro.sprawdzOferty(k.srodowisko,a,aktor);
  },
  chce(klucz:string,aktor:Aktor):Wynik<{chce:true}>{
   const k=repozytoriumKanalow.pobierz(klucz);if(!k||k.typ!==MODUL_ALLEGRO.typ)return bladAllegro('walidacja','Nie ma takiego konta Allegro.');
   if(sciezkaOfert(k)==='dcr')return bladAllegro('konflikt',NIEDOSTEPNE);
   if(ofertyAllegro.stan(klucz)?.zgoda===true)return bladAllegro('konflikt','Konto ma już zgodę na oferty.');
   const a=aplikacjaOfert(k);
   if(!a||aplikacjaAllegro.aplikacjaMaOferty(k.srodowisko,a.clientId)!==true)return bladAllegro('walidacja','Najpierw sprawdź uprawnienia aplikacji (przycisk wyżej).');
   zapiszKonfiguracjeIntegracji(db,chceKey(klucz),{ustawienia:{chce:true},sekrety:{}},{konto:aktor as any,teraz:ctx.teraz()});
   return {ok:true,dane:{chce:true}};
  },
 };
 return {config,db,zapytania,klienciSklepow,klienciKanalow,tokenyKanalow,poller,stanyKanalow,importySklepow,repozytoriumKanalow,rejestrKanalow,aplikacjaAllegro,autoryzacjaAllegro,zarzadzanieAllegro,przegladZapisowAllegro,ofertyAllegro,poAktywacji,limitCzasuMs,callbackAllegro:opcje?.redirectUri??''};
}
