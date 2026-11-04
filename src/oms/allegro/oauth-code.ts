import type {Wynik} from '../../moduly/kanaly/kontrakty-allegro.ts';
import type {AplikacjaWewnetrzna,HttpAllegro} from './dcr.ts';
import {HOSTY_ALLEGRO} from './dcr.ts';
import {bladAllegro} from '../../moduly/kanaly/kontrakty-allegro.ts';
import {uprawnieniaZTokenu,WYMAGANE_UPRAWNIENIA} from '../../domena/uprawnienia-kanalu.js';
export type ParaTokenow={accessToken:string;refreshToken:string;wygasaAt:string;refreshWygasaAt:string;uprawnienia:string[]};
// Nowy konfigurator potwierdza ID/login przez GET /me. Wymaga to profile:read;
// historyczna diagnostyka siedmiu zakresów istniejących kanałów pozostaje osobna.
export const UPRAWNIENIA_NOWEGO_POLACZENIA=Object.freeze([...WYMAGANE_UPRAWNIENIA,'allegro:api:profile:read']);
/** Wspólny kontrakt nowych zgód Code/Device Flow; nigdy nie zapisuje aktywnej pary. */
export function odczytajPare(body:unknown,teraz=()=>new Date(),legacy=false):Wynik<ParaTokenow>{
 if(!body||typeof body!=='object')return bladAllegro('ponow_autoryzacje','Allegro nie zwróciło kompletnej zgody.');
 const d=body as Record<string,unknown>;
 if(typeof d.access_token!=='string'||!d.access_token||typeof d.refresh_token!=='string'||!d.refresh_token)return bladAllegro('ponow_autoryzacje','Allegro nie zwróciło kompletnej zgody.');
 const scopes=typeof d.scope==='string'?d.scope.split(/\s+/).filter(Boolean):uprawnieniaZTokenu(d.access_token);
 const wymagane=legacy?WYMAGANE_UPRAWNIENIA:UPRAWNIENIA_NOWEGO_POLACZENIA;
 const brak=wymagane.filter(s=>!scopes.includes(s));if(brak.length)return bladAllegro('ponow_autoryzacje','Brakuje uprawnień Allegro: '+brak.join(', '));
 const sekundy=Number(d.expires_in);const zycie=Number.isFinite(sekundy)&&sekundy>0?sekundy:600;
 return {ok:true,dane:{accessToken:d.access_token,refreshToken:d.refresh_token,wygasaAt:new Date(teraz().getTime()+zycie*1000).toISOString(),refreshWygasaAt:new Date(teraz().getTime()+90*86400000).toISOString(),uprawnienia:scopes}};
}
export async function wymienKod(app:AplikacjaWewnetrzna,d:{kod:string;verifier:string;redirectUri:string},http:HttpAllegro,teraz=()=>new Date()):Promise<Wynik<ParaTokenow>>{
 if(d.redirectUri!==app.redirectUri||!d.kod||d.kod.length>2048||!/^[a-zA-Z0-9_-]{43,128}$/.test(d.verifier))return bladAllegro('walidacja','Niepoprawny powrót z Allegro. Rozpocznij autoryzację ponownie.');
 try{
  const r=await http(HOSTY_ALLEGRO[app.srodowisko].auth+'/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),
   headers:{Authorization:'Basic '+Buffer.from(app.clientId+':'+app.clientSecret).toString('base64'),'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},
   body:new URLSearchParams({grant_type:'authorization_code',code:d.kod,redirect_uri:app.redirectUri,code_verifier:d.verifier}),
  });
  if(!r.ok)return bladAllegro('ponow_autoryzacje',`Allegro nie przyjęło zgody (HTTP ${r.status}). Rozpocznij autoryzację ponownie.`);
  return odczytajPare(await r.json(),teraz);
 }catch{return bladAllegro('niejednoznaczny','Wymiana zgody nie została potwierdzona. Nie ponawiamy kodu; rozpocznij autoryzację ponownie.');}
}
