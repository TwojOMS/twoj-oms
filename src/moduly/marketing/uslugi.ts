import type {DatabaseSync} from 'node:sqlite';
import {createCzuwaczKampanii} from './uslugi/czuwacz-kampanii.js';
import {createCzuwaczReklam} from './uslugi/czuwacz-reklam.js';
import {createMagazynSekretow} from './uslugi/reklamy-sekrety.js';
import {createMetaClient} from '../../oms/meta/client.js';
import {createGa4Client} from '../../oms/ga4/client.js';
import type {konfiguracjaMarketingu} from './konfiguracja.ts';
export type FabrykiMarketingu={createMeta?:(o:any)=>any;createGa4?:(o:any)=>any;createMagazyn?:(o:any)=>any};
export function utworzUslugiMarketingu({db,config,teraz=()=>new Date(),fabryki={}}:{db:DatabaseSync;config:ReturnType<typeof konfiguracjaMarketingu>;teraz?:()=>Date;fabryki?:FabrykiMarketingu}){
 const createMeta=fabryki.createMeta??createMetaClient,createGa4=fabryki.createGa4??createGa4Client;
 const metaKlient=config.meta?createMeta(config.meta):null,ga4Klient=config.ga4?createGa4(config.ga4):null;
 const czuwaczKampanii=metaKlient||ga4Klient?createCzuwaczKampanii({db,meta:metaKlient,ga4:ga4Klient,teraz}):null;
 const magazyn=(fabryki.createMagazyn??createMagazynSekretow)({katalog:config.reklamy.katalogSekretow});
 const magazynDlaTestu={...magazyn,odczytaj:async(ref:string)=>{
  if(ref==='legacy-ga4'&&config.ga4)return config.ga4.sciezkaKlucza;
  if(ref==='legacy-meta'&&config.meta)return config.meta.token;
  return magazyn.odczytaj(ref);
 }};
 const klienci={ga4:({sekretRef}:any)=>createGa4({sciezkaKlucza:sekretRef==='legacy-ga4'?config.ga4?.sciezkaKlucza:magazyn.sciezka(sekretRef)}),
  meta:({sekret,kontoId}:any)=>createMeta({token:sekret,konta:[kontoId]})};
 const klientDlaPolaczenia=async(p:any)=>{
  if(p.sekretRef==='legacy-ga4'&&p.typ==='ga4'&&ga4Klient)return ga4Klient;
  if(p.sekretRef==='legacy-meta'&&p.typ==='meta'&&metaKlient)return metaKlient;
  if(p.typ==='ga4')return klienci.ga4({sekretRef:p.sekretRef});
  if(p.typ==='meta')return klienci.meta({sekret:await magazyn.odczytaj(p.sekretRef),kontoId:p.kontoId});
  return null;
 };
 const czuwaczReklam=createCzuwaczReklam({db,klientDlaPolaczenia,teraz});
 return {config,metaKlient,ga4Klient,czuwaczKampanii,czuwaczReklam,reklamy:{magazyn:magazynDlaTestu,klienci}};
}
export type UslugiMarketingu=ReturnType<typeof utworzUslugiMarketingu>;
