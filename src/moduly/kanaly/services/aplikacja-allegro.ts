import type {DatabaseSync} from 'node:sqlite';
import type {SrodowiskoAllegro,Wynik,Aktor} from '../kontrakty-allegro.ts';
import type {AplikacjaWewnetrzna,HttpAllegro} from '../../../oms/allegro/dcr.ts';
import {zarejestrujInstalacje} from '../../../oms/allegro/dcr.ts';
import {randomUUID} from 'node:crypto';
import {wczytajKonfiguracjeIntegracji,zapiszKonfiguracjeIntegracji} from '../../../oms/db/konfiguracja-integracji.js';
import {bladAllegro} from '../kontrakty-allegro.ts';
import {HOSTY_ALLEGRO} from '../../../oms/allegro/dcr.ts';
import {UPRAWNIENIA_NOWEGO_POLACZENIA} from '../../../oms/allegro/oauth-code.ts';
import {OPISY_UPRAWNIEN} from '../instrukcja-aplikacji-allegro.ts';
import type {AplikacjeDeviceEnv} from '../konfiguracja.ts';
type BrakujaceUprawnienie={nazwa:string;opis:string;sekcja:string};
const SEKCJE_UPRAWNIEN:Readonly<Record<string,string>>={
 'allegro:api:orders:read':'Zamówienia i obsługa posprzedażowa',
 'allegro:api:orders:write':'Zamówienia i obsługa posprzedażowa',
 'allegro:api:sale:offers:read':'Zarządzanie ofertami',
 'allegro:api:shipments:read':'Zarządzanie przesyłkami',
 'allegro:api:shipments:write':'Zarządzanie przesyłkami',
 'allegro:api:messaging':'Zarządzanie wiadomościami',
 'allegro:api:disputes':'Zamówienia i obsługa posprzedażowa',
 'allegro:api:profile:read':'Dane osobowe',
};
const BRAK_UPRAWNIEN='Aplikacja nie ma wszystkich uprawnień. W Zarządzanie aplikacjami zaznacz wszystkie z listy w kroku 0 i zapisz.';
type ParaDevice={clientId:string;clientSecret:string};
type KodDevice='walidacja'|'dane_aplikacji'|'typ_aplikacji'|'z_pliku'|'w_uzyciu'|'tymczasowy';
type WynikDevice={ok:true;dane:{gotowa:boolean}}|{ok:false;kod:KodDevice;komunikat:string;brakujace?:BrakujaceUprawnienie[]};
const trwajace=new WeakMap<DatabaseSync,Map<string,Promise<Wynik<{gotowa:boolean}>>>>();
export function createAplikacjaAllegro(o:{db:DatabaseSync;softwareStatementId:string;redirectUri:string;http:HttpAllegro;deviceEnv?:AplikacjeDeviceEnv;userAgent?:string|(()=>string);limitSprawdzaniaMs?:number}){
 const deviceKey=(s:SrodowiskoAllegro)=>'allegro_aplikacja_device:'+s;
 function aplikacjaDevice(s:SrodowiskoAllegro):(ParaDevice&{zrodlo:'env'|'panel'})|null{
  const zPliku=o.deviceEnv?.[s];
  if(zPliku)return {...zPliku,zrodlo:'env'};
  const t=wczytajKonfiguracjeIntegracji(o.db,deviceKey(s))?.sekrety;
  return typeof t?.clientId==='string'&&t.clientId&&typeof t.clientSecret==='string'&&t.clientSecret?{clientId:t.clientId,clientSecret:t.clientSecret,zrodlo:'panel'}:null;
 }
 function stanAplikacji(s:SrodowiskoAllegro){
  const a=aplikacjaDevice(s);
  return {device:a?{zrodlo:a.zrodlo,koncowkaId:a.clientId.slice(-4)}:null,dcrGotowe:Boolean(o.softwareStatementId.trim())};
 }
 const deviceBlad=(kod:KodDevice,komunikat:string):WynikDevice=>({ok:false,kod,komunikat});
 function blokadaDevice(s:SrodowiskoAllegro):WynikDevice|null{
  if(o.deviceEnv?.[s])return deviceBlad('z_pliku','Ustawione w pliku konfiguracji (oms.env) — tam je zmień.');
  if(o.db.prepare("SELECT 1 FROM kanaly_sprzedazy WHERE typ='allegro' AND srodowisko=? AND aplikacja='device' AND autoryzacja IN ('polaczone','oczekuje_potwierdzenia') LIMIT 1").get(s))return deviceBlad('w_uzyciu','Najpierw odłącz konta Allegro połączone tą aplikacją.');
  return null;
 }
 async function sprawdzIZapiszAplikacjeDevice(s:SrodowiskoAllegro,para:ParaDevice,aktor:Aktor):Promise<WynikDevice>{
  if(!['produkcja','sandbox'].includes(s)||![para?.clientId,para?.clientSecret].every(v=>typeof v==='string'&&v.length>0&&v.length<=200&&!/\s/.test(v)))return deviceBlad('walidacja','Wklej Client ID i Client Secret z karty aplikacji w Allegro.');
  const blokada=blokadaDevice(s);if(blokada)return blokada;
  // PRZ-148.06: jeden łączny limit na całe sprawdzenie (zapytanie główne + do 8 zapytań o pojedyncze uprawnienia),
  // żeby wolne Allegro nie trzymało ekranu 9 × 30 s; każde zapytanie ma nadal własne 30 s.
  const lacznie=AbortSignal.timeout(o.limitSprawdzaniaMs??45000);
  const zapytaj=(scope:string)=>o.http(HOSTY_ALLEGRO[s].auth+'/device',{method:'POST',redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(30000),lacznie]),headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded',Authorization:'Basic '+Buffer.from(para.clientId+':'+para.clientSecret).toString('base64'),...(o.userAgent?{'User-Agent':typeof o.userAgent==='function'?o.userAgent():o.userAgent}:{})},body:new URLSearchParams({client_id:para.clientId,scope}).toString()});
  try{
   const r=await zapytaj(UPRAWNIENIA_NOWEGO_POLACZENIA.join(' '));
   const d=await r.json().catch(()=>null);
   if(r.status===400){
    // Do logu trafia wyłącznie jednowyrazowy kod OAuth, nigdy opis odpowiedzi.
    const error=typeof d?.error==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(d.error)&&!d.error.includes(para.clientSecret)&&!d.error.includes(para.clientId)?d.error:'unknown_error';
    console.warn(error);
    if(error==='unauthorized_client'||error==='unsupported_grant_type')return deviceBlad('typ_aplikacji','Ta aplikacja nie obsługuje łączenia kodem — załóż nową aplikację i w polu typu zaznacz „bez dostępu do przeglądarki albo klawiatury”.');
    if(error==='invalid_client')return deviceBlad('dane_aplikacji',`Client ID albo sekret nie pasują do środowiska ${s==='sandbox'?'Sandbox':'sprzedażowe'} — sprawdź, czy aplikacja jest założona w tym środowisku.`);
    if(error==='invalid_scope'){
     const brakujace:BrakujaceUprawnienie[]=[];
     try{
      for(const nazwa of UPRAWNIENIA_NOWEGO_POLACZENIA){
       const proba=await zapytaj(nazwa);
       if(proba.ok)continue; // Nieużywany device_code nie jest nawet odczytywany.
       const blad=await proba.json().catch(()=>null);
       if(proba.status!==400||blad?.error!=='invalid_scope')return deviceBlad('tymczasowy',BRAK_UPRAWNIEN);
       brakujace.push({nazwa,opis:OPISY_UPRAWNIEN[nazwa]??'',sekcja:SEKCJE_UPRAWNIEN[nazwa]??''});
      }
     }catch{return deviceBlad('tymczasowy',BRAK_UPRAWNIEN);}
     return {ok:false,kod:'walidacja',komunikat:BRAK_UPRAWNIEN,brakujace};
    }
    return deviceBlad('tymczasowy',`Nie udało się sprawdzić aplikacji Allegro (${error}). Spróbuj ponownie.`);
   }
   if(r.status===401||d?.error==='invalid_client')return deviceBlad('dane_aplikacji','Allegro nie rozpoznało Client ID albo Client Secret — skopiuj je jeszcze raz.');
   if(!r.ok||typeof d?.device_code!=='string'||!d.device_code)return deviceBlad('tymczasowy','Nie udało się sprawdzić aplikacji Allegro. Spróbuj ponownie.');
   // W trakcie HTTP konto mogło zostać połączone — sprawdzamy ponownie przed zapisem.
   const ponownaBlokada=blokadaDevice(s);if(ponownaBlokada)return ponownaBlokada;
   // Pomocnik JS wywodzi typ konta z domyślnego null; w wykonaniu przyjmuje id i login.
   zapiszKonfiguracjeIntegracji(o.db,deviceKey(s),{ustawienia:{},sekrety:{clientId:para.clientId,clientSecret:para.clientSecret}},{konto:aktor as any});
   return {ok:true,dane:{gotowa:true}};
  }catch{return deviceBlad('tymczasowy','Nie udało się sprawdzić aplikacji Allegro. Spróbuj ponownie.');}
 }
 const key=(s:SrodowiskoAllegro)=>'allegro_aplikacja:'+s;
 const zapis=(s:SrodowiskoAllegro)=>wczytajKonfiguracjeIntegracji(o.db,key(s));
 function aplikacjaDlaInstalacji(s:SrodowiskoAllegro):AplikacjaWewnetrzna|null{
  const r=zapis(s);if(r?.ustawienia.status!=='gotowa')return null;
  const u=r.ustawienia,t=r.sekrety;
  if(typeof t.clientId!=='string'||!t.clientId||typeof t.clientSecret!=='string'||!t.clientSecret)return null;
  return {clientId:t.clientId,clientSecret:t.clientSecret,clientName:String(u.clientName),redirectUri:String(u.redirectUri),softwareStatementId:String(u.softwareStatementId),srodowisko:s};
 }
 const niejasne=()=>bladAllegro('niejednoznaczny','Poprzednia rejestracja aplikacji wymaga sprawdzenia. Dane nie zostaną nadpisane.');
 function zarejestruj(kod:string,s:SrodowiskoAllegro):Promise<Wynik<{gotowa:boolean}>>{
  let mapa=trwajace.get(o.db);if(!mapa){mapa=new Map();trwajace.set(o.db,mapa);}const m=mapa;
  const wToku=m.get(s);if(wToku)return wToku;
  const praca=Promise.resolve().then(async():Promise<Wynik<{gotowa:boolean}>>=>{
   if(!['produkcja','sandbox'].includes(s))return bladAllegro('walidacja','Niepoprawne środowisko Allegro.');
   const gotowa=aplikacjaDlaInstalacji(s);
   if(gotowa)return gotowa.redirectUri===o.redirectUri?{ok:true,dane:{gotowa:true}}:bladAllegro('konflikt','Adres powrotu różni się od zarejestrowanej aplikacji.');
   const r=zapis(s);if(r&&['rejestracja_w_toku','niejednoznaczny','gotowa'].includes(String(r.ustawienia.status)))return niejasne();
   if(!o.softwareStatementId.trim())return bladAllegro('brak_dostepu','Konfiguracja Allegro nie jest jeszcze gotowa (brak SSI).');
   // Identyfikator i nazwa przetrwają błędny kod, przerwaną kartę oraz restart procesu.
   let instalacja=wczytajKonfiguracjeIntegracji(o.db,'allegro_instalacja');
   if(!instalacja){zapiszKonfiguracjeIntegracji(o.db,'allegro_instalacja',{ustawienia:{id:randomUUID().replaceAll('-','')},sekrety:{}});instalacja=wczytajKonfiguracjeIntegracji(o.db,'allegro_instalacja');}
   const ustawienia={clientName:r?.ustawienia.clientName??'TwojOMS '+instalacja!.ustawienia.id,redirectUri:o.redirectUri,softwareStatementId:o.softwareStatementId,status:'rejestracja_w_toku'};
   try{
    zapiszKonfiguracjeIntegracji(o.db,key(s),{ustawienia,sekrety:{}});
    const wynik=await zarejestrujInstalacje({kod,softwareStatementId:o.softwareStatementId,clientName:String(ustawienia.clientName),redirectUri:o.redirectUri,srodowisko:s},o.http);
    if(!wynik.ok){zapiszKonfiguracjeIntegracji(o.db,key(s),{ustawienia:{...ustawienia,status:wynik.kod==='niejednoznaczny'?'niejednoznaczny':'niezarejestrowana'},sekrety:{}});return wynik;}
    zapiszKonfiguracjeIntegracji(o.db,key(s),{ustawienia:{...ustawienia,status:'gotowa'},sekrety:{clientId:wynik.dane.clientId,clientSecret:wynik.dane.clientSecret}});
    return {ok:true,dane:{gotowa:true}};
   }catch{return niejasne();}
  });
  const p=praca.finally(()=>{if(m.get(s)===p)m.delete(s);});m.set(s,p);return p;
 }
 return {aplikacjaDlaInstalacji,zarejestruj,aplikacjaDevice,sprawdzIZapiszAplikacjeDevice,stanAplikacji};
}
