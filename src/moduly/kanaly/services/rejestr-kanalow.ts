import {MODULY_KANALOW,type TypKanaluZnany} from '../../../domena/moduly-kanalow.ts';
import type {RepozytoriumKanalow} from '../repozytorium-kanalow.ts';
import type {PolaczenieKanalu} from '../kontrakty-allegro.ts';
import {AsyncLocalStorage} from 'node:async_hooks';
import {utworzHttp} from '../../../core/http.ts';
import type {DefinicjaKanalu} from '../konfiguracja.ts';
import {createHash,randomUUID} from 'node:crypto';
/** W istniejącej kolumnie ścieżki przechowujemy również skrót zasobu.
 * Treść i nazwy plików nie trafiają do rejestru ani widoku przeglądu. */
function zasobZapisu(sciezka:string,init:RequestInit):string {
 const wiadomosc=/^\/messaging\/threads\/[^/]+\/messages$/.test(sciezka);
 if(!/^\/shipment-management\/(shipments|pickups)\/create-commands$/.test(sciezka)&&sciezka!=='/messaging/message-attachments'&&!wiadomosc)return sciezka;
 let body:any;try{body=JSON.parse(String(init.body));}catch{throw new Error('Brak identyfikatora zasobu operacji Allegro.');}
 const zasob=wiadomosc?[body?.text,body?.attachments??[]]:sciezka==='/messaging/message-attachments'?[body?.filename,body?.size]:body?.commandId;
 if(zasob==null||zasob==='')throw new Error('Brak identyfikatora zasobu operacji Allegro.');
 return sciezka+'#'+createHash('sha256').update(JSON.stringify(zasob)).digest('hex');
}
export type FabrykaKanalu = (o:{polaczenie:PolaczenieKanalu; http:(url:string,init?:RequestInit)=>Promise<Response>; httpAutoryzacji:(url:string,init?:RequestInit)=>Promise<Response>; sprawdzZapis:()=>void})=>{klient:Record<string,any>;tokeny?:any;poller:{przebieg:()=>Promise<any>;stan:()=>any}};
export function createRejestrKanalow(o:{repozytorium:RepozytoriumKanalow;fabryki:Record<TypKanaluZnany,FabrykaKanalu>|FabrykaKanalu;skonfigurowany?:(k:PolaczenieKanalu)=>boolean;db?:unknown;teraz?:()=>Date;fetchImpl?:typeof fetch;limitCzasuMs?:number;limitZatrzymaniaMs?:number}) {
 // Zgodność z odbiorcami sprzed rejestru po typie. Kompozycja używa pełnej mapy.
 const fabryki=typeof o.fabryki==='function'?{allegro:o.fabryki,woo:o.fabryki}:o.fabryki;
 for(const typ of Object.keys(MODULY_KANALOW))if(typeof fabryki[typ as TypKanaluZnany]!=='function')throw new Error(`Brak fabryki kanału: ${typ}`);
 for(const typ of Object.keys(fabryki))if(!Object.hasOwn(MODULY_KANALOW,typ))throw new Error(`Brak modułu kanału: ${typ}`);
 const lista=()=>Object.keys(MODULY_KANALOW).flatMap(t=>o.repozytorium.listaTypu(t as TypKanaluZnany));
 const pobierz=(klucz:string)=>lista().find(k=>k.klucz===klucz);
 type Operacja={klucz:string;generacja:number;generacjaImportu:number;zakres:'zamowienia'|'calosc';abort:AbortController;koniec:Promise<void>;zapisy:{id:string;metoda:string;sciezka:string}[]};
 const kontekst=new AsyncLocalStorage<Operacja>();
 const operacje=new Set<Operacja>();
 const cache=new Map<string,{generacja:number;uslugi:ReturnType<FabrykaKanalu>}>();
 const transport=utworzHttp({fetchImpl:o.fetchImpl,limitCzasuMs:o.limitCzasuMs??30000,ponowien:0});
 let wTrakcie=false;
 function odmowa():never {const e=new Error('Kanał Allegro jest odłączony, pobieranie wstrzymane lub zmieniono dostęp.');e.name='KanalZatrzymany';throw e;}
 function sprawdz(k:Operacja) {
  const s=pobierz(k.klucz);
  if(!s||o.skonfigurowany?.(s)===false||o.repozytorium.konfliktKlucza(k.klucz)||!(s.autoryzacja==='polaczone'||(s.zrodlo==='env'&&s.autoryzacja==='brak'))||s.generacja!==k.generacja||k.abort.signal.aborted)odmowa();
  if(k.zakres==='zamowienia'&&(s.pobieranie!=='wlaczone'||s.generacjaImportu!==k.generacjaImportu))odmowa();
 }
 async function wykonaj<T>(klucz:string,zakres:'zamowienia'|'calosc',generacja:number,fn:()=>Promise<T>,osobno=false):Promise<T> {
  const rodzic=kontekst.getStore();
  if(!osobno&&rodzic?.klucz===klucz){sprawdz(rodzic);if(rodzic.generacja!==generacja)odmowa();const result=await fn();sprawdz(rodzic);return result;}
  const s=pobierz(klucz);if(!s)odmowa();
  let zakoncz!:()=>void;
  const k:Operacja={klucz,generacja,generacjaImportu:s.generacjaImportu,zakres,abort:new AbortController(),koniec:new Promise<void>(r=>{zakoncz=r;}),zapisy:[]};
  sprawdz(k);operacje.add(k);
  try{return await kontekst.run(k,async()=>{const result=await fn();sprawdz(k);return result;});}
  catch(e){
   // Błąd po wysłaniu może oznaczać wykonanie operacji bez lokalnego potwierdzenia.
   // Dotyczy też zwykłego timeoutu i odczytu uszkodzonej odpowiedzi, bez odłączenia.
   if(k.zapisy.length)o.repozytorium.zapiszNiejednoznaczne(klucz,k.zapisy);
   throw e;
  }finally{operacje.delete(k);zakoncz();}
 }
 function uslugi(klucz:string) {
  const s=pobierz(klucz);if(!s||o.skonfigurowany?.(s)===false||!(s.autoryzacja==='polaczone'||(s.zrodlo==='env'&&s.autoryzacja==='brak'))||o.repozytorium.konfliktKlucza(klucz))odmowa();
  const previous=cache.get(klucz);if(previous?.generacja===s.generacja)return previous.uslugi;
  const generacja=s.generacja;
  const sprawdzZapis=()=>{
   const k=kontekst.getStore();if(k?.klucz===klucz){sprawdz(k);return;}
   const aktualny=pobierz(klucz);if(!aktualny||o.skonfigurowany?.(aktualny)===false||aktualny.autoryzacja!=='polaczone'||aktualny.generacja!==generacja||o.repozytorium.konfliktKlucza(klucz))odmowa();
  };
  const zHttp=(osobno:boolean)=>(url:string,init:RequestInit={})=>wykonaj(klucz,'calosc',generacja,async()=>{
   const k=kontekst.getStore()!;sprawdz(k);
   const metoda=(init.method??'GET').toUpperCase(),sciezka=new URL(url).pathname;
   const zapis=s.typ==='allegro'&&!osobno&&!['GET','HEAD','OPTIONS'].includes(metoda)&&!(metoda==='POST'&&['/shipment-management/label','/shipment-management/pickup-proposals'].includes(sciezka));
   const niejednoznaczny=zapis&&metoda!=='PUT';
   const zasob=niejednoznaczny?zasobZapisu(sciezka,init):sciezka;
   if(zapis&&o.repozytorium.zapisyZablokowane(klucz))throw new Error('Operacje zapisu Allegro są wstrzymane. Przejrzyj i zatwierdź je po ponownym połączeniu konta.');
   if(niejednoznaczny&&o.repozytorium.operacjaZablokowana(klucz,metoda,zasob))throw new Error('Wynik poprzedniej operacji Allegro jest niejednoznaczny. Sprawdź go przed ponowieniem.');
   const operacja=niejednoznaczny?{id:randomUUID(),metoda,sciezka:zasob}:null;if(operacja)k.zapisy.push(operacja);
   const sygnaly=[k.abort.signal,...(init.signal?[init.signal]:[])];
   const r=await transport(url,{...init,redirect:s.typ==='woo'?init.redirect:'error',signal:AbortSignal.any(sygnaly)});
   if(operacja&&r.status>=400&&r.status<500)k.zapisy=k.zapisy.filter(p=>p.id!==operacja.id);
   if(zapis&&r.status>=500){
    const blad:Error&{status:number;retryAfterS?:number}=Object.assign(new Error(`Allegro: HTTP ${r.status}. Nie potwierdzono wyniku operacji.`),{status:r.status});
    const retryAfter=r.headers.get('Retry-After')?.trim();
    if(retryAfter&&/^\d+$/.test(retryAfter))blad.retryAfterS=Number(retryAfter);
    else if(retryAfter&&/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfter)){
     const data=Date.parse(retryAfter);if(Number.isFinite(data))blad.retryAfterS=Math.max(0,Math.ceil((data-(o.teraz?.()??new Date()).getTime())/1000));
    }
    throw blad;
   }
   sprawdz(k);return r;
  },osobno);
  const nowe=fabryki[s.typ]({polaczenie:s,http:zHttp(false),httpAutoryzacji:zHttp(true),sprawdzZapis});
  const klient=new Proxy(nowe.klient,{get(target,key){
   const f=Reflect.get(target,key);return typeof f==='function'?(...args:any[])=>wykonaj(klucz,'calosc',generacja,()=>Promise.resolve(f.apply(target,args))):f;
  }});
  const result={...nowe,klient};cache.set(klucz,{generacja,uslugi:result});return result;
 }
 async function przebiegZamowien() {
  if(wTrakcie)return;wTrakcie=true;
  try{
   const bledy:string[]=[];
   for(const k of lista()){
    if(o.skonfigurowany?.(k)===false||k.autoryzacja!=='polaczone'||k.pobieranie!=='wlaczone'||o.repozytorium.konfliktKlucza(k.klucz))continue;
    try{await wykonaj(k.klucz,'zamowienia',k.generacja,()=>uslugi(k.klucz).poller.przebieg());}
    catch(e){if((e as Error).name!=='KanalZatrzymany')bledy.push((e as Error).message);}
   }
   if(bledy.length)throw new Error(bledy.join(' | '));
  }finally{wTrakcie=false;}
 }
 async function zatrzymaj(klucz:string,zakres:'zamowienia'|'calosc'):Promise<'gotowe'|'zatrzymywanie'> {
  const oczekujace=[...operacje].filter(k=>k.klucz===klucz&&(zakres==='calosc'||k.zakres==='zamowienia'));
  for(const k of oczekujace)k.abort.abort();
  if(!oczekujace.length)return 'gotowe';
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([
   Promise.allSettled(oczekujace.map(k=>k.koniec)).then(()=>'gotowe' as const),
   new Promise<'zatrzymywanie'>(r=>{timer=setTimeout(()=>r('zatrzymywanie'),o.limitZatrzymaniaMs??30000);}),
  ]);}finally{clearTimeout(timer);}
 }
 const definicje=():DefinicjaKanalu[]=>lista().filter(k=>k.zrodlo==='env'||(k.typ==='woo'?k.autoryzacja==='polaczone':k.kontoId!==null)).map(k=>({klucz:k.klucz,typ:k.typ,prefiks:k.klucz.toUpperCase(),etykieta:k.nazwa,raport:k.raport}));
 const czyTrwa=(klucz:string,zakres:'zamowienia'|'calosc')=>[...operacje].some(k=>k.klucz===klucz&&(zakres==='calosc'||k.zakres==='zamowienia'));
 const poZatrzymaniu=(klucz:string,zakres:'zamowienia'|'calosc')=>Promise.allSettled([...operacje].filter(k=>k.klucz===klucz&&(zakres==='calosc'||k.zakres==='zamowienia')).map(k=>k.koniec)).then(()=>{});
 const stany=()=>lista().filter(k=>o.skonfigurowany?.(k)!==false&&k.autoryzacja==='polaczone'&&k.pobieranie==='wlaczone').map(k=>uslugi(k.klucz).poller.stan());
 const wolnoZapisywac=(klucz:string)=>{const k=pobierz(klucz);return Boolean(k?.autoryzacja==='polaczone'&&o.skonfigurowany?.(k)!==false&&!o.repozytorium.konfliktKlucza(klucz)&&(k.typ!=='allegro'||!o.repozytorium.zapisyZablokowane(klucz)));};
 return {lista:()=>o.repozytorium.lista(),definicje,klient:(k:string)=>uslugi(k).klient,tokeny:(k:string)=>uslugi(k).tokeny,przebiegZamowien,zatrzymaj,czyTrwa,poZatrzymaniu,stany,wolnoZapisywac};
}
export type RejestrKanalow=ReturnType<typeof createRejestrKanalow>;
