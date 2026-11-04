import {isIP} from 'node:net';
import {utworzHttp} from '../../src/core/http.ts';
import type {HttpAllegro} from '../../src/oms/allegro/dcr.ts';

const API='https://api.allegro.pl.allegrosandbox.pl';
const AUTH='https://allegro.pl.allegrosandbox.pl';

/** Transport rzeczywistych serwerów testowych. Osłona nie zastępuje zapory VM.
 * Nigdy nie używać do kanałów demo ani z poświadczeniami produkcyjnymi. */
export function transportAllegroSandbox(o:{tryb:string;fetchImpl?:typeof fetch}):HttpAllegro{
 if(o.tryb!=='proba')throw new Error('Allegro Sandbox jest dostępne wyłącznie w lokalnym trybie próby.');
 const http=utworzHttp({fetchImpl:o.fetchImpl,ponowien:0});
 return async(adres,init={})=>{
  let url:URL;try{url=new URL(adres);}catch{throw new Error('Niepoprawny adres Allegro Sandbox.');}
  if(url.username||url.password||url.hash||!([API,AUTH] as string[]).includes(url.origin)
    ||(url.origin===AUTH&&!['/auth/oauth/device','/auth/oauth/token','/api/register'].includes(url.pathname))){
   throw new Error('Cel nie jest dozwolonym zasobem Allegro Sandbox.');
  }
  return http(url.href,{...init,redirect:'error'});
 };
}

/** Allegro zabrania IP w redirect_uri. DNS musi być przygotowany i sprawdzony
 * przed rejestracją aplikacji; nie zastępujemy hosta nagłówkiem żądania. */
export function sprawdzCallbackSandbox(adres:string):string{
 let u:URL;try{u=new URL(adres);}catch{throw new Error('Podaj poprawny adres powrotu Allegro Sandbox.');}
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.hash||u.search
  ||isIP(u.hostname.replace(/^\[|\]$/g,''))||!u.hostname){
  throw new Error('Adres powrotu musi mieć nazwę hosta i protokół HTTP(S), bez hasła, fragmentu ani parametrów.');
 }
 return u.href;
}
