import type {DatabaseSync} from 'node:sqlite';
import type {RepozytoriumKanalow} from '../repozytorium-kanalow.ts';
import type {FabrykaKanalu} from './rejestr-kanalow.ts';
import {wczytajKonfiguracjeIntegracji} from '../../../oms/db/konfiguracja-integracji.js';
import {createWooClient} from '../../../oms/woo/client.js';
import {createWooAdapter} from '../../../integracje/fabryki.ts';
import {createPoller} from './poller.js';
import {uprawnieniaSklepu,czyOdmowaZapisu,bladKluczaTylkoOdczyt} from '../../../domena/woo-uprawnienia.js';

/** Klient i adapter powstają leniwie w rejestrze; jego pamięć klucz+generacja
 * unieważnia oba po zmianie kluczy, adresu albo mapowania. */
export function createSklepyWooRuntime(o:{db:DatabaseSync;repozytorium:RepozytoriumKanalow;klientWooZastepczy?:(u:{baseUrl:string;ck:string;cs:string})=>Record<string,any>|null}) {
 function ustawienia(klucz:string){
  const k=o.repozytorium.listaTypu('woo').find(k=>k.klucz===klucz);
  const d=o.db.prepare('SELECT adres,ustawienia_json FROM kanaly_sklepy WHERE klucz=?').get(klucz) as {adres:string;ustawienia_json:string}|undefined;
  const s=wczytajKonfiguracjeIntegracji(o.db,'woo_klucze:'+klucz)?.sekrety;
  if(!k||k.autoryzacja!=='polaczone'||!d||!s?.ck||!s?.cs)throw new Error('Sklep WooCommerce nie jest połączony.');
  const z=JSON.parse(d.ustawienia_json);
  return {baseUrl:d.adres,ck:s.ck,cs:s.cs,od:k.odUtc,mapowanie:z.mapowanie??{instancje:{},poPozycji:[]},uprawnienia:uprawnieniaSklepu(z)};
 }
 const fabryka:FabrykaKanalu=({polaczenie,http,sprawdzZapis})=>{
  const u=ustawienia(polaczenie.klucz);
  // Odpowiedź sklepu i wyjątki transportu są niezaufane. Nie przekazujemy ich
  // treści klientowi ani pollerowi, który zapisuje komunikat w bazie.
  const bezpieczneHttp=async(url:string,init?:RequestInit)=>{
   let r:Response;
   try{r=await http(url,init);}catch{throw new Error('Nie udało się połączyć ze sklepem WooCommerce.');}
   // PRZ-149.04: klucz bez prawa zapisu przy trybie „Zapis/odczyt” — własny komunikat (treść sklepu tylko do porównania).
   if(r.status===401||r.status===403){let dane:unknown=null;try{dane=await r.clone().json();}catch{dane=null;}
    if(czyOdmowaZapisu(r.status,dane,init?.method))throw bladKluczaTylkoOdczyt();}
   if(!r.ok&&(r.status<300||r.status>=400))throw new Error(`WooCommerce: HTTP ${r.status}.`);
   return r;
  };
  const zastepczy=o.klientWooZastepczy?.(u);
  const klient=new Proxy(zastepczy??createWooClient({...u,fetchImpl:undefined,http:bezpieczneHttp,tylkoTenSamOrigin:true}),{get(target,key){
   const f=Reflect.get(target,key);
   return typeof f==='function'?async(...args:unknown[])=>{
    try{return await f.apply(target,args);}catch(e){
     sprawdzZapis();
     if(e instanceof Error&&e.name==='KanalZatrzymany')throw e;
     // Komunikat budujemy sami z URL (znormalizowany origin), bez treści odpowiedzi sklepu.
     if(e instanceof Error&&e.name==='WooInnyOrigin')throw e;
     if(e instanceof Error&&(e.name==='WooTylkoOdczyt'||e.name==='WooKluczTylkoOdczyt'))throw e;
     if(zastepczy&&e instanceof Error&&e.name==='WooOperacjaPrzykladowa')throw e;
     throw new Error('Nie udało się wykonać operacji sklepu WooCommerce.');
    }
   }:f;
  }});
  return {klient,poller:createPoller({db:o.db,sklep:polaczenie.klucz,od:u.od,kontrola:sprawdzZapis,kanal:createWooAdapter({woo:klient as any,mapowanie:u.mapowanie})})};
 };
 return {ustawienia,fabryka};
}
