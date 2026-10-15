import type {ModulOms,Zegar} from '../../core/kontrakty.ts';
import {zarejestrujTrasyCelow} from './trasy/cele.js';
import {zarejestrujTrasyKampanii} from './trasy/kampania.js';
import {konfiguracjaMarketingu} from './konfiguracja.ts';
import {utworzUslugiMarketingu,type FabrykiMarketingu,type UslugiMarketingu} from './uslugi.ts';
import {zegarKampanii,zegarReklam} from './zegary.ts';
export {utworzUslugiMarketingu} from './uslugi.ts';
export function createModulMarketing({fabryki={},uslugi}:{fabryki?:FabrykiMarketingu;uslugi?:UslugiMarketingu}={}):ModulOms<ReturnType<typeof konfiguracjaMarketingu>>{
 return {
 nazwa:'marketing',wersja:'1.1.0',wymaga:['rdzen','web'],migracje:[],konfiguracja:konfiguracjaMarketingu,
 kluczeIntegracji:['META_TOKEN','GA4_KLUCZ'],
 uprawnienia:[{klucz:'kampania',etykieta:'Kampania',role:['administrator','sprzedaz']},{klucz:'cele',etykieta:'Cele',role:['administrator','sprzedaz']}],
 menu:[{dzial:'analizy-cele',grupa:'analizy-cele',etykieta:'Reklamy',adres:'/kampania',uprawnienie:'kampania',kolejnosc:30},
  {dzial:'analizy-cele',grupa:'analizy-cele',etykieta:'Cele',adres:'/cele',uprawnienie:'cele',kolejnosc:60}],
 zbuduj:ctx=>{
  const u=uslugi??utworzUslugiMarketingu({db:ctx.db,config:ctx.konfiguracja,teraz:ctx.teraz,fabryki});
  const zegary:Zegar[]=[];
  if(!ctx.konfiguracja.proba){if(u.czuwaczKampanii)zegary.push(zegarKampanii({czuwaczKampanii:u.czuwaczKampanii,log:ctx.log}));zegary.push(zegarReklam({czuwaczReklam:u.czuwaczReklam,log:ctx.log}));}
  return {uslugi:u,zegary,trasy:app=>{
   zarejestrujTrasyCelow(app,{db:ctx.db});
   zarejestrujTrasyKampanii(app,{db:ctx.db,config:ctx.usluga('marketing','config'),definicje:ctx.usluga<{definicje:readonly {klucz:string;etykieta?:string}[]}>('web','config').definicje,czuwaczKampanii:ctx.usluga('marketing','czuwaczKampanii'),czuwaczReklam:ctx.usluga('marketing','czuwaczReklam')});
  }};
 }};
}
export const modulMarketing=createModulMarketing();
