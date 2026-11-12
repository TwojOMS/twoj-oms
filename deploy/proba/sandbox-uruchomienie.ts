import type {DatabaseSync} from 'node:sqlite';
import type {ModulOms,Srodowisko} from '../../src/core/kontrakty.ts';
import {createModulKanaly} from '../../src/moduly/kanaly/modul.ts';
import {konfiguracjaKanalow,definicjeKanalow} from '../../src/moduly/kanaly/konfiguracja.ts';
import {poczatekDniaWarszawa} from '../../src/moduly/kanaly/zakres-importu-allegro.ts';
import {modulyPiaskownicy,nadpisaniaPiaskownicy} from './atrapy/index.mjs';
import {zbudujAtrapyKanalow,scalUslugiKanalow} from './atrapy/kanaly.mjs';
import {transportErliPiaskownicy} from './atrapy/erli.mjs';
import {transportAllegroSandbox} from './allegro-sandbox.ts';
import {HOSTY_ALLEGRO} from '../../src/oms/allegro/dcr.ts';

type Konfiguracja={srodowisko:'sandbox';klucz:string;clientId:string;clientSecret:string;clientName:string;userAgent:string;od:string};
// PRZ-150.03 (właściciel 04.11): plik bez `klucz` = sam profil Sandbox (transport i straż) bez stałego kanału —
// konta Allegro powstają w kreatorze. Health nie zgłasza wtedy niepodłączonego kanału z pliku.
type Profil={srodowisko:'sandbox';klucz?:undefined}|Konfiguracja;
function sprawdz(env:Srodowisko,d:unknown):Profil{
 if(env.OMS_TRYB!=='proba'||env.OMS_DEMO_LOGIN||env.OMS_DEMO_HASLO)throw Error('Rzeczywiste Allegro Sandbox jest dostępne tylko w prywatnej piaskownicy.');
 const a=d as Partial<Konfiguracja>|null;
 if(a&&a.srodowisko==='sandbox'&&a.klucz===undefined)return {srodowisko:'sandbox'};
 if(!a||a.srodowisko!=='sandbox'||typeof a.klucz!=='string'||!/^allegro_sandbox_[a-z0-9_]{1,48}$/.test(a.klucz)
  ||typeof a.clientId!=='string'||!a.clientId||a.clientId.length>4096||typeof a.clientSecret!=='string'||!a.clientSecret||a.clientSecret.length>4096
  ||typeof a.clientName!=='string'||a.clientName.length<3||a.clientName.length>50||typeof a.userAgent!=='string'||!/^\S+\/\d[^\s]* \(\+https:\/\/[^\s()]+\)$/.test(a.userAgent)
  ||typeof a.od!=='string'||!poczatekDniaWarszawa(a.od))throw Error('Niepoprawna prywatna konfiguracja Allegro Sandbox. Sprawdź instrukcję, bez wypisywania pliku.');
 return {srodowisko:'sandbox',klucz:a.klucz,clientId:a.clientId,clientSecret:a.clientSecret,clientName:a.clientName,userAgent:a.userAgent,od:a.od};
}

/** Allegro Device Flow i sandbox ERLI mogą korzystać z sieci. Pozostałe integracje
 * używają atrap; sekret nie trafia do env, logów ani konfiguracji publicznego demo. */
export function przygotujUruchomienieSandbox(env:Srodowisko,d:unknown,fetchImpl?:typeof fetch){
 const a=sprawdz(env,d),http=transportAllegroSandbox({tryb:'proba',fetchImpl});
 // ERLI: oficjalny sandbox z własnym kluczem używa sieci, klucz atrapy zostaje lokalny.
 // Produkcję i pozostałe hosty ERLI blokuje transport ERLI, Allegro ma osobną straż.
 let baza:DatabaseSync|null=null;
 const erli=transportErliPiaskownicy({baza:()=>baza,env,log:undefined,fetchImpl});
 const fetchSandbox:typeof fetch=(u,i)=>/(^|\.)(polcien\.example|erli\.pl|erli\.dev)\.?$/.test(new URL(u instanceof Request?u.url:String(u)).hostname)?erli(u,i):http(String(u),i);
 const def=a.klucz?{klucz:a.klucz,typ:'allegro' as const,prefiks:a.klucz.toUpperCase(),etykieta:'Allegro Sandbox',raport:a.klucz.toUpperCase()}:null;
 // PRZ-148.07: prywatny plik profilu jest jawnym profilem Sandbox — straż próby przepuszcza allegrosandbox.pl,
 // a prawdziwe allegro.pl odrzuca, zanim żądanie dotrze do transportu.
 const bazowy=createModulKanaly(def?[def]:[],false,{fetchImpl:fetchSandbox,strazAllegro:'sandbox'});
 const demo=konfiguracjaKanalow(definicjeKanalow(env),env,true);
 const modul:ModulOms<ReturnType<typeof konfiguracjaKanalow>>={...bazowy,
  konfiguracja:()=>{
   sprawdz(env,d);
   if(!a.klucz)return {...konfiguracjaKanalow([],env),definicje:[],kanaly:{}};
   return {...konfiguracjaKanalow([],env),definicje:[def!],kanaly:{[a.klucz]:{...HOSTY_ALLEGRO.sandbox,clientId:a.clientId,clientSecret:a.clientSecret,userAgent:a.userAgent,od:poczatekDniaWarszawa(a.od)!}}};
  },
  zbuduj:ctx=>{
   const z=bazowy.zbuduj(ctx),s=z.uslugi as any;
   const atrapy=zbudujAtrapyKanalow({db:ctx.db,config:demo,env,log:ctx.log});
   // Pollery powstały wyłącznie dla prawdziwego profilu. Mapy konsumentów
   // dokładamy dopiero teraz: fikcyjne sklepy nie zaczną importować przez sieć.
   scalUslugiKanalow(s,atrapy,ctx.teraz);
   return z;
  },
 };
 const moduly=modulyPiaskownicy(env,{baza:()=>baza}).map(m=>m.nazwa==='kanaly'?modul:m) as ModulOms[];
 return {moduly,nadpisania:(db:DatabaseSync)=>{
  baza=db;const n=nadpisaniaPiaskownicy({db,env,log:()=>{}}) as Record<string,unknown>;
  for(const k of Object.keys(n))if(k.startsWith('kanaly.'))delete n[k];return n;
 }};
}
