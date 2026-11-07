import {createHash,randomUUID} from 'node:crypto';
import {stronaOdmowy} from '../../core/web/odmowa.js';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {DatabaseSync} from 'node:sqlite';
import type {PolaczenieKanalu,Aktor} from './kontrakty-allegro.ts';
import type {createRepozytoriumKanalow} from './repozytorium-kanalow.ts';
import type {createSklepyWoo} from './services/sklepy-woo.ts';
import {MODUL_WOO} from '../../domena/modul-woo.ts';
import {METODY_WYSYLKI,ETYKIETY_WYSYLKI} from '../../domena/wysylka.js';
import {adresAkcji,polaZFormularza,stanKrokow} from '../../core/web/konfigurator/konfigurator.ts';
import {normalizujAdresSklepu} from './adres-sklepu.ts';
import {zakresDatyStartu} from './zakres-importu-allegro.ts';
import {nawigacjaUstawien} from '../ustawienia/nawigacja.js';
import {POLITYKA_REFERERA_LINKU} from '../ustawienia/trasy/haslo-link.js';
import {UPRAWNIENIA,uprawnieniaSklepu} from '../../domena/woo-uprawnienia.js';
import {wlaczoneReguly} from '../automatyzacje/db/reguly.js';
import {czyPasujeKanalom} from '../../domena/automatyzacje.js';

const konfigurator=MODUL_WOO.konfigurator,root=konfigurator.sciezka;
const tekst=(v:unknown)=>typeof v==='string'?v:'';
const wersja=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:typeof v==='string'&&/^\d{1,10}$/.test(v)?Number(v):-1;
const uprawnieniaZFormularza=(v:unknown)=>typeof v==='string'&&(UPRAWNIENIA as readonly string[]).includes(v)?v as 'odczyt'|'zapis':undefined;
const body=(r:FastifyRequest):Record<string,unknown>=>r.body&&typeof r.body==='object'&&!Array.isArray(r.body)?r.body as Record<string,unknown>:{};
const url=(k:string)=>root+'/'+encodeURIComponent(k);
type Metoda={strefa:string;instanceId:number;tytul:string;metodaWoo:string};
type EnvSklep={klucz:string;nazwa:string;adres:string;od:string;mapowanie:unknown};
type Blad={ok:false;kod:string;komunikat:string};
export function registerTrasyWoo(app:FastifyInstance,o:{db:DatabaseSync;repozytorium:ReturnType<typeof createRepozytoriumKanalow>;sklepyWoo:ReturnType<typeof createSklepyWoo>;envSklepy:readonly EnvSklep[];teraz:()=>Date;tryb:string;config?:()=>any}){
 const {db,repozytorium:repo,sklepyWoo:woo,teraz}=o;
 const configListy=():any=>{try{return o.config?.()??{};}catch{return {};}};
 // Tylko niesekretne dane kroku 1, związane z konkretną sesją administratora.
 const szkice=new Map<string,{nazwa:string;adres:string;sesja:string;wygasa:number;klucz?:string;praca?:Promise<{ok:boolean}>}>();
 const konto=(r:FastifyRequest)=>(r as FastifyRequest&{konto?:{id?:number;login:string;admin:boolean}}).konto;
 const aktor=(r:FastifyRequest):Aktor=>({id:konto(r)?.id??0,login:konto(r)!.login});
 const sesja=(r:FastifyRequest)=>createHash('sha256').update(JSON.stringify(aktor(r))+'|'+String(r.headers.cookie??'').split(';').map(c=>c.trim()).filter(c=>/^sesja_oms(?:_proba)?=/.test(c)).join(';')+'|'+String(r.headers.authorization??'')).digest('hex');
 const klucz=(r:FastifyRequest)=>tekst((r.params as {kanal?:string})?.kanal);
 function kanal(k:string):PolaczenieKanalu|null{
  const e=o.envSklepy.find(s=>s.klucz===k);
  if(e)return {klucz:k,typ:'woo',nazwa:e.nazwa,zrodlo:'env',odUtc:e.od,wersja:0,generacja:0,generacjaImportu:0,autoryzacja:'polaczone',pobieranie:'wlaczone',srodowisko:'produkcja',kontoId:null,login:null,raport:k.toUpperCase(),aplikacja:null};
  return repo.listaTypu('woo').find(s=>s.klucz===k)??null;
 }
 // PRZ-149.04: czy mail o wysyłce wysyła OMS (włączona reguła z szablonem „wyslane” dla tego sklepu). null = skład bez
 // modułu automatyzacji — wtedy nie ma do czego odsyłać. Tylko odczyt: nic się tu nie włącza.
 const mailWyslane=(sklep:string|undefined):boolean|null=>{
  if(!app.hasRoute({method:'GET',url:'/ustawienia/automatyzacje/:id'}))return null;
  try{return sklep!==undefined&&wlaczoneReguly(db).some((r:any)=>r.akcja_param?.szablon==='wyslane'&&czyPasujeKanalom(sklep,r.warunki));}catch{return false;}
 };
 const dzis=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw',year:'numeric',month:'2-digit',day:'2-digit'}).format(teraz());
 async function widok(req:FastifyRequest,reply:FastifyReply,k?:PolaczenieKanalu,extra:Record<string,unknown>={}){
  const e=k?o.envSklepy.find(s=>s.klucz===k.klucz):null;
  const d=k&&!e?db.prepare('SELECT adres,ustawienia_json,sprawdzono_at FROM kanaly_sklepy WHERE klucz=?').get(k.klucz):null;
  let metody:Metoda[]=[],mapowanie:any=e?.mapowanie??(d?JSON.parse(String(d.ustawienia_json)).mapowanie:null)??{instancje:{}};
  let bladMetod:string|null=null;
  // PRZ-134.PT9: przed udanym sprawdzeniem kluczy szkic nie pyta sklepu o metody — krok 3 i tak nie jest widoczny.
  if(k?.zrodlo==='panel'&&k.autoryzacja!=='odlaczone'&&(k.autoryzacja==='polaczone'||d?.sprawdzono_at)){
   const w=await woo.metodyWysylki(k.klucz);
   if(w.ok){metody=Array.isArray(w.dane.metody)?w.dane.metody as Metoda[]:[];mapowanie=w.dane.mapowanie;extra={bramki:w.dane.bramki,bladBramek:w.dane.bladBramek,...extra};}else{bladMetod=w.komunikat;extra={mapowanieBezSklepu:true,...extra};}
  }
  if(k&&(k.zrodlo!=='panel'||k.autoryzacja==='odlaczone'||bladMetod)){metody=Object.keys(mapowanie.instancje??{}).map(id=>({strefa:'Z konfiguracji',instanceId:Number(id),tytul:'Instancja '+id,metodaWoo:''}));}
  const biezacy=!k?(extra.formularzId?'klucze':'nazwa'):k.autoryzacja==='polaczone'?'stan':!d?.sprawdzono_at?'klucze':Object.keys(mapowanie.instancje??{}).length&&Array.isArray(mapowanie.bramkiPobrania)?'start':'mapowanie';
  const indeks=konfigurator.kroki.findIndex(s=>s.id===biezacy);
  return reply.view(k?'woo-sklep.ejs':'woo-konfigurator.ejs',{
    ...(!k ? { szerokosc: 'formularz' } : {}),
   zakresDatyStartu:zakresDatyStartu(teraz()),
   title:k?'WooCommerce — '+k.nazwa:'Podłącz sklep WooCommerce',nawigacja:nawigacjaUstawien(k?req:{...req,url:'/ustawienia/integracje/katalog'},reply),
   k,root,adres:k?url(k.klucz):url('nowy'),adresSklepu:e?.adres??d?.adres??'',konfigurator,adresAkcji,
   kroki:stanKrokow(konfigurator,{biezacy,zrobione:konfigurator.kroki.slice(0,indeks).map(s=>s.id)}),
   wartosci:{ck:Boolean(d&&k?.autoryzacja!=='odlaczone'),cs:Boolean(d&&k?.autoryzacja!=='odlaczone'),od:k?.odUtc?new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'}).format(new Date(k.odUtc)):dzis(),
    uprawnienia:d?uprawnieniaSklepu(JSON.parse(String(d.ustawienia_json))):k?'zapis':uprawnieniaZFormularza(extra.uprawnienia)??'zapis'},
   mailWyslane:mailWyslane(k?.klucz),
   formularzId:'',metody,mapowanie,metodyOms:METODY_WYSYLKI.filter(m=>!m.startsWith('allegro_')),etykiety:ETYKIETY_WYSYLKI,
   stan:k?db.prepare('SELECT ostatni_przebieg_at,zsynchronizowane_do,ostatni_blad FROM stan_pollera WHERE sklep=?').get(k.klucz):null,
   moznaUsunac:Boolean(k&&k.zrodlo==='panel'&&woo.blokadaUsuniecia(k.klucz)===null),
   // PRZ-150.01: w piaskownicy jedyny działający adres to sklep przykładowy z konfiguracji — mówimy jaki.
   adresPrzykladowy:o.tryb==='proba'?(Object.values(configListy().sklepy??{}) as any[]).find(s=>s?.atrapa===true&&s.baseUrl)?.baseUrl??null:null,
   blad:bladMetod,komunikat:d?.sprawdzono_at?'Połączenie ze sklepem działa.':null,...extra,
  });
 }
 const status=(w:Blad)=>({walidacja:400,konflikt:409,z_pliku:409,odlaczone:409,tymczasowy:503} as Record<string,number>)[w.kod]??503;
 const blad=(req:FastifyRequest,reply:FastifyReply,w:Blad,k?:PolaczenieKanalu)=>widok(req,reply.code(status(w)),k,{blad:w.komunikat});
 const odmowa=(req:FastifyRequest,reply:FastifyReply,status:number,komunikat:string)=>stronaOdmowy(reply,status,komunikat,{tytul:'Nie zapisano ustawień sklepu WooCommerce',wroc:url(klucz(req)||'nowy'),napisWroc:'Wróć do ustawień połączenia'});
 function trasa(method:'GET'|'POST',path:string,fn:(r:FastifyRequest,p:FastifyReply)=>unknown){
  app.route({method,url:root+path,logLevel:'silent',preHandler:async(req,reply)=>{
   reply.header('Cache-Control','no-store').header('Referrer-Policy',POLITYKA_REFERERA_LINKU);
   if(konto(req)?.admin!==true)return odmowa(req,reply,403,'Tylko administrator może konfigurować WooCommerce.');
  },handler:async(req,reply)=>{try{return await fn(req,reply);}catch{return odmowa(req,reply,503,'Nie udało się wykonać operacji WooCommerce. Odśwież ekran i sprawdź stan sklepu.');}}});
 }
 trasa('GET','/nowy',(req,reply)=>widok(req,reply));
 trasa('POST','/szkice',(req,reply)=>{
  for(const [id,s] of szkice)if(s.wygasa<=teraz().getTime())szkice.delete(id);
  const pola=polaZFormularza(konfigurator.kroki[0],body(req));
  if(!pola.nazwa||[...pola.nazwa].length>80||!normalizujAdresSklepu(pola.adres,o.tryb))return blad(req,reply,{ok:false,kod:'walidacja',komunikat:'Podaj nazwę (1–80 znaków) i poprawny adres sklepu.'});
  if(szkice.size>=1000)return odmowa(req,reply,503,'Otwórz konfigurator ponownie za chwilę.');
  const id=randomUUID();szkice.set(id,{nazwa:pola.nazwa,adres:pola.adres,sesja:sesja(req),wygasa:teraz().getTime()+1200000});
  return widok(req,reply,undefined,{formularzId:id,komunikat:/^http:\/\//i.test(pola.adres.trim())?'Zmieniliśmy http:// na https://.':null});
 });
 trasa('GET','/:kanal',(req,reply)=>{
  const k=kanal(klucz(req));if(k)return widok(req,reply,k);
  // PRZ-148.04: sklep przykładowy piaskownicy jest tylko w konfiguracji (atrapa) — ekran bez akcji; reszta to 404 w układzie panelu.
  const kl=klucz(req);let przykladowe=false;try{przykladowe=Boolean(configListy().sklepy?.[kl]?.atrapa);}catch{}
  const nazwa=przykladowe?(configListy().definicje??[]).find((d:any)=>d?.klucz===kl)?.etykieta:null;
  return reply.code(przykladowe?200:404).view('woo-przykladowe.ejs',{przykladowe,
   title:przykladowe?'WooCommerce — '+(nazwa||kl):'Nie znaleziono sklepu WooCommerce',nawigacja:nawigacjaUstawien(req,reply)});
 });
 const powrot=(reply:FastifyReply,k:string)=>reply.code(303).redirect(url(k));
 async function utworz(req:FastifyRequest,reply:FastifyReply){
  const b=body(req),id=tekst(b.formularzId),s=szkice.get(id);
  if(!s||s.sesja!==sesja(req)||s.wygasa<=teraz().getTime()||wersja(b.wersja)!==0)return odmowa(req,reply,409,'Otwórz konfigurator ponownie.');
  if(s.klucz)return powrot(reply,s.klucz);
  if(s.praca){await s.praca;return s.klucz?powrot(reply,s.klucz):odmowa(req,reply,409,'Odśwież konfigurator.');}
  const pola=polaZFormularza(konfigurator.kroki[1],b),ck=pola.ck??'',cs=pola.cs??'';
  // PRZ-134.PT8: najpierw sklep musi przyjąć klucze; odmowa zostawia konfigurator na kroku kluczy i NIC w bazie.
  const proba=await (s.praca=woo.sprawdzNowe({adres:s.adres,ck,cs}));s.praca=undefined;
  const uprawnienia=tekst(b.uprawnienia)||undefined;
  if(!proba.ok)return widok(req,reply.code(status(proba)),undefined,{formularzId:id,blad:proba.komunikat,uprawnienia});
  if(s.klucz)return powrot(reply,s.klucz);
  const w=woo.utworzSzkic({nazwa:s.nazwa,adres:s.adres,ck,cs,od:dzis(),...(uprawnienia?{uprawnienia}:{})},aktor(req));
  if(!w.ok)return widok(req,reply.code(status(w)),undefined,{formularzId:id,blad:w.komunikat,uprawnienia});
  s.klucz=w.dane.klucz;
  const sprawdzenie=await (s.praca=woo.sprawdz(s.klucz));
  return sprawdzenie.ok?powrot(reply,s.klucz):blad(req,reply,sprawdzenie,kanal(s.klucz)!);
 }
 const operacje=['klucze','sprawdz','mapowanie','data-startu','aktywuj','pobieranie','nazwa','odlacz','usun'] as const;
 for(const operacja of operacje)trasa('POST','/:kanal/'+operacja,async(req,reply)=>{
  if(operacja==='klucze'&&klucz(req)==='nowy')return utworz(req,reply);
  const k=kanal(klucz(req)),b=body(req),v=wersja(b.wersja),a=aktor(req);
  if(!k)return odmowa(req,reply,409,'Nie znaleziono sklepu. Odśwież ekran.');
  if(k.zrodlo==='env')return odmowa(req,reply,409,'Ten sklep jest ustawiony w pliku konfiguracji (oms.env) — tam go zmień. Formularz niczego nie zapisał.');
  if(k.wersja!==v)return blad(req,reply,{ok:false,kod:'konflikt',komunikat:'Formularz jest nieaktualny. Odśwież ekran.'},k);
  let w;
  switch(operacja){
   case 'klucze':{const p=polaZFormularza(konfigurator.kroki[1],b);let v2=v;
    // PRZ-149.04: wybór „Jakie uprawnienia ma klucz?” zapisujemy przed kluczami; brak pola (stary formularz) = bez zmiany.
    if(b.uprawnienia!==undefined){
     const zapisane=uprawnieniaSklepu(JSON.parse(String((db.prepare('SELECT ustawienia_json FROM kanaly_sklepy WHERE klucz=?').get(k.klucz) as any)?.ustawienia_json??'{}')));
     if(tekst(b.uprawnienia)!==zapisane||!uprawnieniaZFormularza(b.uprawnienia)){const u=woo.ustawUprawnienia(k.klucz,tekst(b.uprawnienia),v,a);if(!u.ok){w=u;break;}v2=u.dane.wersja;}
    }
    // Puste pola przy zapisanych kluczach = sprawdź zapisane (jeden przycisk w kroku 2).
    if(!p.ck&&!p.cs&&k.autoryzacja!=='odlaczone'){w=await woo.sprawdz(k.klucz);break;}
    w=woo.zmienKlucze(k.klucz,{ck:p.ck??'',cs:p.cs??''},v2,a);if(w.ok)w=await woo.sprawdz(k.klucz);break;}
   case 'sprawdz':w=await woo.sprawdz(k.klucz);break;
   case 'mapowanie':{
    // PRZ-134: ukryte pole = formularz z decyzją o pobraniu; stary formularz (bez niego) niczego nie zapisuje.
    if(tekst(b.pobranie_decyzja)!=='1')return blad(req,reply,{ok:false,kod:'walidacja',komunikat:'Odśwież ekran i zapisz mapowanie jeszcze raz.'},k);
    const instancje=Object.fromEntries(Object.entries(b).filter(([id,val])=>/^instancja_\d+$/.test(id)&&tekst(val)).map(([id,val])=>[id.slice(10),{metoda:tekst(val),...(b['pobranie_'+id.slice(10)]==='tak'?{pobranie:true}:{})}]));
    const zPol=(Array.isArray(b.bramki)?b.bramki:[b.bramki]).map(tekst);
    const bramkiPobrania=[...new Set([...zPol,...tekst(b.bramki_tekst).split(',')].map(x=>x.trim()).filter(Boolean))];
    w=woo.zapiszMapowanie(k.klucz,{instancje,bramkiPobrania},v,a);break;
   }
   case 'data-startu':w=woo.ustawDateStartu(k.klucz,polaZFormularza(konfigurator.kroki[3],b).od??'',v,a);break;
   case 'aktywuj':w=woo.aktywuj(k.klucz,v,a);break;
   case 'pobieranie':if(!['tak','nie'].includes(tekst(b.wlaczone)))return blad(req,reply,{ok:false,kod:'walidacja',komunikat:'Wybierz stan pobierania.'},k);w=woo.ustawPobieranie(k.klucz,b.wlaczone==='tak',v,a);break;
   case 'nazwa':w=woo.zmienNazwe(k.klucz,tekst(b.nazwa),v,a);break;
   case 'odlacz':if(b.potwierdz!=='tak')return blad(req,reply,{ok:false,kod:'walidacja',komunikat:'Potwierdź odłączenie sklepu.'},k);w=woo.odlacz(k.klucz,v,a);break;
   case 'usun':{
    // PRZ-134.PT9: po udanym usunięciu sklepu już nie ma — wracamy na listę integracji.
    if(b.potwierdz!=='tak')return blad(req,reply,{ok:false,kod:'walidacja',komunikat:'Potwierdź usunięcie sklepu.'},k);
    const u=woo.usun(k.klucz,v,a);
    if(u.ok)return reply.code(303).redirect('/ustawienia/integracje?zapisano=usunieto_sklep');
    return blad(req,reply,u,kanal(k.klucz)??k);
   }
  }
  const aktualny=kanal(k.klucz)!;
  if(!w.ok)return blad(req,reply,w,aktualny);
  return operacja==='sprawdz'||operacja==='klucze'?widok(req,reply,aktualny,{komunikat:'Połączenie ze sklepem działa.'}):powrot(reply,k.klucz);
 });
}
