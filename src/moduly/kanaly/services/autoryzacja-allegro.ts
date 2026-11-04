import type {Aktor,SrodowiskoAllegro,Wynik} from '../kontrakty-allegro.ts';
import type {RepozytoriumKanalow} from '../repozytorium-kanalow.ts';
import type {AplikacjaWewnetrzna,HttpAllegro} from '../../../oms/allegro/dcr.ts';
import {HOSTY_ALLEGRO} from '../../../oms/allegro/dcr.ts';
import {wymienKod,odczytajPare,UPRAWNIENIA_NOWEGO_POLACZENIA,type ParaTokenow} from '../../../oms/allegro/oauth-code.ts';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {bladAllegro} from '../kontrakty-allegro.ts';
import {createAllegroClient} from '../../../oms/allegro/client.js';
import {kontoZTokenu} from '../../../domena/tozsamosc-kanalu.js';
type Tozsamosc={probaId:string;kontoId:string;login:string;wersja:number};
type WynikDevice=Wynik<({gotowe:true}&Tozsamosc)|{gotowe:false;odstepMs:number}>;
type KodDevice={deviceCode:string;userCode:string;adres:string;odstepMs:number;nastepna:number;polling?:Promise<WynikDevice>};
type Proba={id:string;klucz:string;sesjaId:string;aktor:Aktor;wersja:number;generacja:number;wygasa:number;state:string;verifier:string;app:AplikacjaWewnetrzna;adres:string;userAgent?:string;legacy?:boolean;device?:KodDevice};
export type KandydatAllegro={probaId:string;klucz:string;sesjaId:string;aktor:Aktor;wersja:number;generacja:number;kontoId:string;login:string;tokeny:ParaTokenow;wygasa:number;sprawdzZakres:(odUtc:string)=>Promise<number>};
export function createAutoryzacjaAllegro(o:{repozytorium:RepozytoriumKanalow;aplikacjaDlaInstalacji:(s:SrodowiskoAllegro)=>AplikacjaWewnetrzna|null;aplikacjaDevice?:(s:SrodowiskoAllegro)=>{clientId:string;clientSecret:string}|null;http:HttpAllegro;userAgent:string|(()=>string);teraz?:()=>Date;legacyDlaKanalu?:(klucz:string)=>{app:AplikacjaWewnetrzna;wolnoWiazac:boolean;userAgent?:string}|null}){
 const userAgent=()=>typeof o.userAgent==='function'?o.userAgent():o.userAgent;
 const teraz=o.teraz??(()=>new Date());const proby=new Map<string,Proba>();const kandydaci=new Map<string,KandydatAllegro>();
 function sprzataj(){for(const [s,p]of proby)if(p.wygasa<=teraz().getTime())proby.delete(s);for(const [id,k]of kandydaci)if(k.wygasa<=teraz().getTime())kandydaci.delete(id);}
 function aktualna(p:{klucz:string;wersja:number;generacja:number}){const k=o.repozytorium.pobierz(p.klucz);return Boolean(k&&k.wersja===p.wersja&&k.generacja===p.generacja&&(k.zrodlo==='env'||k.autoryzacja==='oczekuje_potwierdzenia')&&!o.repozytorium.konfliktKlucza(p.klucz));}
 const niewazna=()=>bladAllegro('ponow_autoryzacje','Zgoda wygasła lub połączenie zostało zmienione. Rozpocznij autoryzację ponownie.');
 const http:HttpAllegro=(u,i={})=>{const headers=new Headers(i.headers);if(!headers.has('User-Agent'))headers.set('User-Agent',userAgent());return o.http(u,{...i,headers,redirect:'error'});};
 async function rozpocznijAutoryzacje(klucz:string,aktor:Aktor,sesjaId:string):Promise<Wynik<{probaId:string;adres:string}>>{
  sprzataj();const k=o.repozytorium.pobierz(klucz);if(!k||!sesjaId||o.repozytorium.konfliktKlucza(klucz))return niewazna();
  if(k.autoryzacja==='polaczone')return bladAllegro('konflikt','Konto jest połączone. Ponowna zgoda wymaga utraty dostępu.');
  if(k.zrodlo==='env')return bladAllegro('walidacja','Istniejący kanał korzysta z Device Flow i własnej aplikacji.');
  const app=o.aplikacjaDlaInstalacji(k.srodowisko);if(!app)return bladAllegro('brak_dostepu','Konfiguracja Allegro nie jest jeszcze gotowa.');
  const obecna=[...proby.values()].find(p=>p.verifier&&p.klucz===klucz&&p.sesjaId===sesjaId&&p.aktor.id===aktor.id&&aktualna(p));
  if(obecna)return {ok:true,dane:{probaId:obecna.id,adres:obecna.adres}};
  if(proby.size+kandydaci.size>=1000)return bladAllegro('tymczasowy','Zbyt wiele rozpoczętych autoryzacji. Spróbuj później.');
  const zmiana=o.repozytorium.zapiszZmiane(klucz,k.wersja,{autoryzacja:'oczekuje_potwierdzenia',pobieranie:'wylaczone'},aktor);if(!zmiana.ok)return zmiana;
  for(const [s,p]of proby)if(p.klucz===klucz)proby.delete(s);for(const [id,p]of kandydaci)if(p.klucz===klucz)kandydaci.delete(id);
  const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');
  const url=new URL(HOSTY_ALLEGRO[k.srodowisko].auth+'/authorize');
  url.search=new URLSearchParams({response_type:'code',client_id:app.clientId,redirect_uri:app.redirectUri,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',scope:UPRAWNIENIA_NOWEGO_POLACZENIA.join(' '),prompt:'login'}).toString();
  const p:Proba={id:randomUUID(),klucz,sesjaId,aktor:{...aktor},wersja:zmiana.dane.wersja,generacja:zmiana.dane.generacja,wygasa:teraz().getTime()+600000,state,verifier,app,adres:url.href};proby.set(state,p);
  return {ok:true,dane:{probaId:p.id,adres:p.adres}};
 }
 async function obsluzPowrot(d:{state:string;code?:string;error?:string;redirectUri:string},sesjaId:string):Promise<Wynik<{probaId:string;kontoId:string;login:string;wersja:number}>>{
  sprzataj();const p=proby.get(d.state);if(!p||p.legacy||p.device||!p.verifier||p.sesjaId!==sesjaId||p.app.redirectUri!==d.redirectUri||!aktualna(p))return niewazna();
  proby.delete(d.state); // Przed pierwszym await: drugi callback nie może użyć kodu.
  if(d.error||!d.code)return bladAllegro('ponow_autoryzacje','Nie udzielono zgody w Allegro.');
  const tokeny=await wymienKod(p.app,{kod:d.code,verifier:p.verifier,redirectUri:d.redirectUri},http,teraz);if(!tokeny.ok)return tokeny;
  const zapis=o.repozytorium.zapiszZmiane(p.klucz,p.wersja,{aplikacja:'dcr'},p.aktor);if(!zapis.ok)return zapis;p.wersja=zapis.dane.wersja;
  return sprawdzPare(p,tokeny.dane);
 }
 async function sprawdzPare(p:Proba,para:ParaTokenow):Promise<Wynik<Tozsamosc>>{
  if(!aktualna(p)||p.wygasa<=teraz().getTime())return niewazna();
  try{
   // Klient kandydata nie widzi aktywnej tabeli tokenów ani pollera.
   const klient=createAllegroClient({ustawienia:{...HOSTY_ALLEGRO[p.app.srodowisko],get userAgent(){return p.userAgent??userAgent();}},tokeny:{waznyToken:async()=>para.accessToken},fetchImpl:undefined,http});
   let konto:{id:string;login:string};
   try{konto=await klient.pobierzMojeKonto();}catch(e){
    // Tylko legacy: para pochodzi właśnie z uwierzytelnionego endpointu tokenów,
    // więc ID można odczytać z niej także bez historycznie niewymaganego profile:read.
    const id=p.legacy?kontoZTokenu(para.accessToken):null;
    if(!p.legacy||(e as {status?:number}).status!==403||para.uprawnienia.includes('allegro:api:profile:read')||!id||!/^\d{1,32}$/.test(id))throw e;
    konto={id,login:'Konto '+id};
   }
   if(!aktualna(p))return niewazna();
   const zapis=o.repozytorium.pobierz(p.klucz)!;if(zapis.kontoId&&zapis.kontoId!==konto.id)return bladAllegro('konflikt','To inne konto Allegro. Połącz konto wcześniej przypisane do tego kanału.');
   const ile=await klient.sprawdzZakresZamowien({odUtc:zapis.odUtc});if(!aktualna(p)||p.wygasa<=teraz().getTime())return niewazna();
   if(ile>10000)return bladAllegro('walidacja','Zakres zawiera ponad 10 000 zamówień. Wybierz późniejszą datę.');
   kandydaci.set(p.id,{probaId:p.id,klucz:p.klucz,sesjaId:p.sesjaId,aktor:p.aktor,wersja:p.wersja,generacja:p.generacja,kontoId:konto.id,login:konto.login,tokeny:para,wygasa:p.wygasa,sprawdzZakres:(odUtc:string)=>klient.sprawdzZakresZamowien({odUtc})});
   return {ok:true,dane:{probaId:p.id,kontoId:konto.id,login:konto.login,wersja:p.wersja}};
  }catch{return bladAllegro('tymczasowy','Nie udało się sprawdzić konta i odczytu zamówień Allegro. Spróbuj autoryzacji ponownie.');}
 }
 type StartDevice=Wynik<{probaId:string;userCode:string;adres:string;wersja:number;wygasaAt:string}>;
 const startyLegacy=new Map<string,Promise<StartDevice>>();
 const publicznyDevice=(p:Proba)=>({probaId:p.id,userCode:p.device!.userCode,adres:p.device!.adres,wersja:p.wersja,wygasaAt:new Date(p.wygasa).toISOString()});
 function rozpocznijDevice(klucz:string,aktor:Aktor,sesjaId:string):Promise<StartDevice>{
  const key=JSON.stringify([klucz,sesjaId,aktor.id]);const trwa=startyLegacy.get(key);if(trwa)return trwa;
  const zadanie=startLegacy(klucz,aktor,sesjaId).finally(()=>{startyLegacy.delete(key);});startyLegacy.set(key,zadanie);return zadanie;
 }
 async function startLegacy(klucz:string,aktor:Aktor,sesjaId:string):Promise<StartDevice>{
  sprzataj();const k=o.repozytorium.pobierz(klucz);
  if(!k||!sesjaId||o.repozytorium.konfliktKlucza(klucz))return niewazna();
  if(k.zrodlo==='panel'&&k.autoryzacja==='polaczone')return bladAllegro('konflikt','Konto jest połączone. Ponowna zgoda wymaga utraty dostępu.');
  const istniejaca=[...proby.values()].find(p=>p.klucz===klucz&&aktualna(p));
  if(istniejaca){
   if(istniejaca.device&&istniejaca.sesjaId===sesjaId&&istniejaca.aktor.id===aktor.id)return {ok:true,dane:publicznyDevice(istniejaca)};
   return bladAllegro('konflikt','Autoryzacja tego kanału już trwa w innej karcie.');
  }
  if([...kandydaci.values()].some(p=>p.klucz===klucz&&aktualna(p)))return bladAllegro('konflikt','Konto czeka na potwierdzenie.');
  const legacy=k.zrodlo==='env'?o.legacyDlaKanalu?.(klucz):null;
  const device=k.zrodlo==='panel'?o.aplikacjaDevice?.(k.srodowisko):null;
  if(k.zrodlo==='env'&&(!legacy||!legacy.wolnoWiazac||legacy.app.srodowisko!==k.srodowisko))return bladAllegro('brak_dostepu','Kanał działa albo brakuje przygotowanej aplikacji Device Flow.');
  if(k.zrodlo==='panel'&&!device)return bladAllegro('brak_dostepu','Aplikacja Allegro tego konta nie jest skonfigurowana.');
  if(proby.size+kandydaci.size>=1000)return bladAllegro('tymczasowy','Zbyt wiele rozpoczętych autoryzacji.');
  // Próba env żyje tylko w pamięci. Dotychczasowa para i import pracują do aktywacji.
  const app=legacy?.app??{...device!,clientName:'Device',softwareStatementId:'',redirectUri:'',srodowisko:k.srodowisko};
  const p:Proba={id:randomUUID(),klucz,sesjaId,aktor:{...aktor},wersja:k.wersja,generacja:k.generacja,wygasa:teraz().getTime()+600000,state:randomBytes(32).toString('base64url'),verifier:'',app,adres:'',userAgent:legacy?.userAgent,legacy:k.zrodlo==='env'};
  proby.set(p.state,p);
  try{
   const r=await http(HOSTY_ALLEGRO[k.srodowisko].auth+'/device',{method:'POST',signal:AbortSignal.timeout(30000),headers:{Authorization:'Basic '+Buffer.from(p.app.clientId+':'+p.app.clientSecret).toString('base64'),'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json','User-Agent':p.userAgent??userAgent()},body:new URLSearchParams({client_id:p.app.clientId,...(p.legacy?{}:{scope:UPRAWNIENIA_NOWEGO_POLACZENIA.join(' ')})})});
   if(!r.ok)throw Error('odmowa');const d=await r.json();
   const adres=new URL(d.verification_uri);
   if(typeof d.device_code!=='string'||!d.device_code||d.device_code.length>4096||typeof d.user_code!=='string'||!d.user_code||d.user_code.length>128||adres.origin!==new URL(HOSTY_ALLEGRO[k.srodowisko].auth).origin||adres.username||adres.password)throw Error('ksztalt');
   // Stan kanału z panelu zmienia dopiero udany /device: nieudany start nie blokuje zmiany aplikacji.
   if(k.zrodlo==='panel'){
    // Aplikację zmieniono w trakcie /device: kod wydano starej parze, więc próba jest nieważna.
    const obecnaApp=o.aplikacjaDevice?.(k.srodowisko);
    if(!obecnaApp||obecnaApp.clientId!==p.app.clientId||obecnaApp.clientSecret!==p.app.clientSecret){proby.delete(p.state);return bladAllegro('konflikt','Aplikacja Allegro zmieniła się w trakcie autoryzacji. Zacznij od nowa.');}
    const z=o.repozytorium.zapiszZmiane(klucz,p.wersja,{aplikacja:'device',autoryzacja:'oczekuje_potwierdzenia',pobieranie:'wylaczone'},aktor);
    if(!z.ok){proby.delete(p.state);return z;}p.wersja=z.dane.wersja;p.generacja=z.dane.generacja;
   }
   if(!aktualna(p)||p.wygasa<=teraz().getTime())return niewazna();
   const czas=Number(d.expires_in),interval=Number(d.interval);
   p.wygasa=Math.min(p.wygasa,teraz().getTime()+(Number.isFinite(czas)&&czas>0?czas:600)*1000);
   const odstepMs=Math.min(60000,Math.max(1000,(Number.isFinite(interval)&&interval>0?interval:5)*1000));
   p.device={deviceCode:d.device_code,userCode:d.user_code,adres:adres.href,odstepMs,nastepna:teraz().getTime()+odstepMs};
   return {ok:true,dane:publicznyDevice(p)};
  }catch{proby.delete(p.state);return bladAllegro('tymczasowy','Nie udało się uzyskać kodu Device Flow z Allegro.');}
 }
 async function sprawdzDevice(id:string,aktor:Aktor,sesjaId:string):Promise<WynikDevice>{
  sprzataj();const kandydat=pobierzKandydata(id,sesjaId);
  if(kandydat&&kandydat.aktor.id===aktor.id)return {ok:true,dane:{gotowe:true,probaId:id,kontoId:kandydat.kontoId,login:kandydat.login,wersja:kandydat.wersja}};
  const p=[...proby.values()].find(p=>p.id===id&&p.device);
  if(!p?.device||p.sesjaId!==sesjaId||p.aktor.id!==aktor.id||!aktualna(p))return niewazna();
  const device=p.device;if(device.polling)return device.polling;
  if(teraz().getTime()<device.nastepna)return {ok:true,dane:{gotowe:false,odstepMs:device.nastepna-teraz().getTime()}};
  device.nastepna=teraz().getTime()+device.odstepMs;
  device.polling=pollLegacy(p,device).finally(()=>{device.polling=undefined;});return device.polling;
 }
 async function pollLegacy(p:Proba,device:KodDevice):Promise<WynikDevice>{
  try{
   const r=await http(HOSTY_ALLEGRO[p.app.srodowisko].auth+'/token',{method:'POST',signal:AbortSignal.timeout(30000),headers:{Authorization:'Basic '+Buffer.from(p.app.clientId+':'+p.app.clientSecret).toString('base64'),'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json','User-Agent':p.userAgent??userAgent()},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:device.deviceCode})});
   const d=await r.json().catch(()=>null);if(!aktualna(p)||p.wygasa<=teraz().getTime())return niewazna();
   if(!r.ok){
    if(d?.error==='authorization_pending'||d?.error==='slow_down'||r.status>=500){
     if(d?.error==='slow_down')device.odstepMs=Math.min(60000,device.odstepMs+5000);
     device.nastepna=teraz().getTime()+device.odstepMs;return {ok:true,dane:{gotowe:false,odstepMs:device.odstepMs}};
    }
    proby.delete(p.state);return bladAllegro('ponow_autoryzacje','Allegro nie przyjęło zgody Device Flow.');
   }
   // Para pozostaje tylko w pamięci; próby nie można odebrać drugi raz.
   proby.delete(p.state);const para=odczytajPare(d,teraz,p.legacy===true);if(!para.ok)return para;
   const wynik=await sprawdzPare(p,para.dane);return wynik.ok?{ok:true,dane:{gotowe:true,...wynik.dane}}:wynik;
  }catch{return bladAllegro('tymczasowy','Nie udało się sprawdzić zgody Device Flow. Spróbuj po upływie interwału.');}
 }
 function pobierzKandydata(id:string,sesjaId:string):KandydatAllegro|null {sprzataj();const k=kandydaci.get(id);return k&&k.sesjaId===sesjaId&&aktualna(k)?k:null;}
 function przeniesKandydata(klucz:string,zWersji:number,naWersje:number):void {for(const k of kandydaci.values())if(k.klucz===klucz&&k.wersja===zWersji)k.wersja=naWersje;}
 const zuzyjKandydata=(id:string)=>{kandydaci.delete(id);};
 const uniewaznij=(klucz:string)=>{for(const [s,p]of proby)if(p.klucz===klucz)proby.delete(s);for(const [id,k]of kandydaci)if(k.klucz===klucz)kandydaci.delete(id);};
 const rozpocznijLegacy=(klucz:string,aktor:Aktor,sesjaId:string):Promise<StartDevice>=>o.repozytorium.pobierz(klucz)?.zrodlo==='env'?rozpocznijDevice(klucz,aktor,sesjaId):Promise.resolve(niewazna());
 return {przeniesKandydata,rozpocznijAutoryzacje,obsluzPowrot,rozpocznijDevice,sprawdzDevice,rozpocznijLegacy,sprawdzLegacy:sprawdzDevice,pobierzKandydata,zuzyjKandydata,uniewaznij};
}
export type AutoryzacjaAllegro=ReturnType<typeof createAutoryzacjaAllegro>;
