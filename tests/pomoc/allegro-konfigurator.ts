import {openOmsDb} from '../../src/oms/db/db.ts';
import {migracjaKanalowSprzedazy} from '../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import {migracjaTypuKanaluISklepow} from '../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import {createRepozytoriumKanalow} from '../../src/moduly/kanaly/repozytorium-kanalow.ts';
import {createAutoryzacjaAllegro} from '../../src/moduly/kanaly/services/autoryzacja-allegro.ts';
import type {Wynik} from '../../src/moduly/kanaly/kontrakty-allegro.ts';
export const aktorAllegro={id:1,login:'admin'};
export const callbackAllegro='http://192.168.0.33:3005/ustawienia/integracje/allegro/oauth/powrot';
export const scopesAllegro=['allegro:api:orders:read','allegro:api:orders:write','allegro:api:sale:offers:read','allegro:api:shipments:read','allegro:api:shipments:write','allegro:api:messaging','allegro:api:disputes','allegro:api:profile:read'];
export function daneAllegro<T>(w:Wynik<T>):T{if(!w.ok)throw Error(w.komunikat);return w.dane;}
export function fixtureAllegro(){
 const db=openOmsDb();migracjaKanalowSprzedazy.wykonaj(db);migracjaTypuKanaluISklepow.wykonaj(db);let czas=new Date('2026-11-01T12:00:00Z');
 const repo=createRepozytoriumKanalow({db,definicjeEnv:[],konfiguracjaEnv:{},teraz:()=>czas});
 const app={clientId:'client-atrapa',clientSecret:'SEKRET-APLIKACJI',clientName:'TwojOMS test',softwareStatementId:'ssi-atrapa',redirectUri:callbackAllegro,srodowisko:'produkcja' as const};
 let kontoId='123',scope=[...scopesAllegro],totalCount=5,meStatus=200;let tokenStatus=200;
 const calls:{url:string;init:RequestInit}[]=[];
 const http=async(url:string,init:RequestInit={})=>{
  calls.push({url,init});
  if(url==='https://allegro.pl/auth/oauth/token')return Response.json({access_token:'ACCESS-WABIK',refresh_token:'REFRESH-WABIK',expires_in:3600,scope:scope.join(' ')},{status:tokenStatus});
  if(url==='https://api.allegro.pl/me')return Response.json({id:kontoId,login:'konto-'+kontoId,privateField:'nigdy-na-ekran'},{status:meStatus});
  if(url.startsWith('https://api.allegro.pl/order/checkout-forms?'))return Response.json({checkoutForms:[],totalCount});
  throw Error('Nieoczekiwany adres: '+url);
 };
 const auth=createAutoryzacjaAllegro({repozytorium:repo,aplikacjaDlaInstalacji:()=>app,http,userAgent:'OMS/1 (+https://example.invalid)',teraz:()=>czas});
 const szkic=()=>daneAllegro(repo.utworzSzkic({nazwa:'Konto główne',odUtc:'2026-10-31T23:00:00.000Z',srodowisko:'produkcja'},aktorAllegro));
 return {db,repo,app,auth,calls,http,szkic,teraz:()=>czas,setCzas:(c:string)=>{czas=new Date(c);},setKonto:(id:string)=>{kontoId=id;},setScopes:(s:string[])=>{scope=s;},setCount:(n:number)=>{totalCount=n;},setMeStatus:(n:number)=>{meStatus=n;},setTokenStatus:(n:number)=>{tokenStatus=n;}};
}
