import type {SrodowiskoAllegro,Wynik} from '../../moduly/kanaly/kontrakty-allegro.ts';
import {bladAllegro} from '../../moduly/kanaly/kontrakty-allegro.ts';
export type AplikacjaWewnetrzna={clientId:string;clientSecret:string;clientName:string;redirectUri:string;softwareStatementId:string;srodowisko:SrodowiskoAllegro};
export type HttpAllegro=(url:string,init?:RequestInit)=>Promise<Response>;
export const HOSTY_ALLEGRO={produkcja:{api:'https://api.allegro.pl',auth:'https://allegro.pl/auth/oauth'},sandbox:{api:'https://api.allegro.pl.allegrosandbox.pl',auth:'https://allegro.pl.allegrosandbox.pl/auth/oauth'}} as const;
export async function zarejestrujInstalacje(o:{kod:string;softwareStatementId:string;clientName:string;redirectUri:string;srodowisko:SrodowiskoAllegro},http:HttpAllegro):Promise<Wynik<AplikacjaWewnetrzna>>{
 if(!o.softwareStatementId.trim())return bladAllegro('brak_dostepu','Konfiguracja Allegro nie jest jeszcze gotowa (brak SSI).');
 let callback:URL;try{callback=new URL(o.redirectUri);}catch{return bladAllegro('walidacja','Niepoprawny skonfigurowany adres powrotu.');}
 if(!HOSTY_ALLEGRO[o.srodowisko]||!['http:','https:'].includes(callback.protocol)||callback.username||callback.password||callback.search||callback.hash
  ||!o.kod.trim()||o.kod.length>512||o.clientName.length<3||o.clientName.length>50)return bladAllegro('walidacja','Sprawdź kod i konfigurację rejestracji Allegro.');
 const niejasne=()=>bladAllegro('niejednoznaczny','Wynik rejestracji aplikacji wymaga sprawdzenia. Nie rejestruj jej ponownie automatycznie.');
 try{
  const r=await http(HOSTY_ALLEGRO[o.srodowisko].api+'/register',{
   method:'POST',redirect:'error',headers:{Accept:'application/json','Content-Type':'application/json'},signal:AbortSignal.timeout(30000),
   body:JSON.stringify({code:o.kod.trim(),client_name:o.clientName,redirect_uris:[o.redirectUri],software_statement_id:o.softwareStatementId}),
  });
  if(r.status>=500)return niejasne();
  if(!r.ok)return bladAllegro(r.status===429?'tymczasowy':'walidacja',`Rejestracja Allegro została odrzucona (HTTP ${r.status}). Sprawdź kod i spróbuj ponownie.`);
  const d=await r.json();
  if(r.status!==201||typeof d.client_id!=='string'||!d.client_id||typeof d.client_secret!=='string'||!d.client_secret||d.client_name!==o.clientName
   ||d.software_statement_id!==o.softwareStatementId||!Array.isArray(d.redirect_uris)||d.redirect_uris.length!==1||d.redirect_uris[0]!==o.redirectUri
   ||!Array.isArray(d.grant_types)||!['authorization_code','refresh_token'].every(x=>d.grant_types.includes(x)))return niejasne();
  return {ok:true,dane:{clientId:d.client_id,clientSecret:d.client_secret,clientName:o.clientName,redirectUri:o.redirectUri,softwareStatementId:o.softwareStatementId,srodowisko:o.srodowisko}};
 }catch{return niejasne();}
}
