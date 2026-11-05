import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {stronaOdmowy} from '../../core/web/odmowa.js';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {zbudujUslugiKanalow} from './services/kompozycja-kanalow.ts';
import type {Aktor,Wynik} from './kontrakty-allegro.ts';
import {poczatekDniaWarszawa,poprawnaDataStartu,zakresDatyStartu} from './zakres-importu-allegro.ts';
import {nawigacjaUstawien} from '../ustawienia/nawigacja.js';
import {CEL_APLIKACJI,krokiInstrukcji,uprawnieniaDoZaznaczenia} from './instrukcja-aplikacji-allegro.ts';
import {POLITYKA_REFERERA_LINKU} from '../ustawienia/trasy/haslo-link.js';
import {zlozUserAgentAllegro,userAgentAllegro,userAgentZZapisu,type PolaUserAgentAllegro} from './konfiguracja.ts';
import {wczytajKonfiguracjeIntegracji,zapiszKonfiguracjeIntegracji} from '../../oms/db/konfiguracja-integracji.js';

import {modulKanalu} from '../../domena/moduly-kanalow.ts';
import {polaczeniaIntegracji} from '../ustawienia/services/polaczenia-integracji.ts';

const root='/ustawienia/integracje/allegro';
const cookieName='oms_allegro_flow';
type Uslugi=ReturnType<typeof zbudujUslugiKanalow>;
type Formularz={skrot?:string;praca?:Promise<Wynik<{klucz:string}>>};
type Sesja={id:string;autoryzacja:string;wygasa:number;formularze:Map<string,Formularz>;proby:Map<string,string>;przeglady:Map<string,string>;potwierdzone:Set<string>;blad?:string;komunikat?:string};
type Konto={id?:number;login:string;admin:boolean};
const tekst=(v:unknown)=>typeof v==='string'?v:'';
const wersja=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:typeof v==='string'&&/^\d{1,10}$/.test(v)?Number(v):-1;
const body=(r:FastifyRequest):Record<string,unknown>=>r.body&&typeof r.body==='object'&&!Array.isArray(r.body)?r.body as Record<string,unknown>:{};
const urlKanalu=(k:string)=>root+'/'+encodeURIComponent(k);
const status=(w:Extract<Wynik<unknown>,{ok:false}>)=>({walidacja:400,konflikt:409,brak_dostepu:403,odlaczone:409,ponow_autoryzacje:409,tymczasowy:503,niejednoznaczny:409})[w.kod];

/** Każda przeglądarka ma własną próbę powiązaną również z uwierzytelnioną sesją
 * OMS. Cookie próby nie daje dostępu do panelu; nie zawiera kodów ani tokenów. */
export function registerTrasyAllegro(app:FastifyInstance,o:Uslugi,teraz:()=>Date,usluga?:<T>(modul:string,nazwa:string)=>T){
 // #6: konfiguracja i stany tak, jak widzi je lista „Moje połączenia” (ctx.usluga — w piaskownicy z nadpisaniami atrap).
 const configListy=():any=>{try{return usluga?usluga<any>('kanaly','config'):o.config;}catch{return o.config;}};
 const stanyListy=():any[]=>{try{return usluga?usluga<()=>any[]>('kanaly','stanyKanalow')():o.stanyKanalow();}catch{return o.stanyKanalow();}};
 const sesje=new Map<string,Sesja>();
 const sesjeZadan=new WeakMap<FastifyRequest,Sesja>();
 const konto=(req:FastifyRequest)=>(req as FastifyRequest&{konto?:Konto}).konto;
 const aktor=(req:FastifyRequest):Aktor=>({id:konto(req)?.id??0,login:konto(req)!.login});
 function sesja(req:FastifyRequest,reply:FastifyReply):Sesja{
  const biezaca=sesjeZadan.get(req);if(biezaca)return biezaca;
  for(const [id,s]of sesje)if(s.wygasa<=teraz().getTime())sesje.delete(id);
  const cookies=String(req.headers.cookie??'').split(';').map(c=>c.trim());
  const id=cookies.find(c=>c.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  const auth=cookies.filter(c=>/^sesja_oms(?:_proba)?=/.test(c)).join(';')+'|'+String(req.headers.authorization??'')+'|'+JSON.stringify(aktor(req));
  const autoryzacja=createHash('sha256').update(auth).digest('hex');
  let s=id?sesje.get(id):undefined;
  if(!s||s.autoryzacja!==autoryzacja){
   if(sesje.size>=1000)throw Error('limit sesji');
   s={id:randomBytes(32).toString('base64url'),autoryzacja,wygasa:0,formularze:new Map(),proby:new Map(),przeglady:new Map(),potwierdzone:new Set()};sesje.set(s.id,s);
   reply.header('Set-Cookie',`${cookieName}=${s.id}; Path=/ustawienia; HttpOnly; SameSite=Lax${req.protocol==='https'?'; Secure':''}`);
  }
  s.wygasa=teraz().getTime()+1200000;sesjeZadan.set(req,s);return s;
 }
 /** #6: wiersz konta z listy „Moje połączenia” — te same dane i ta sama funkcja co ustawienia/modul.ts. */
 function wierszListy(klucz:string){
  try{
   const cfg=configListy();
   const atrapa=(k:string)=>{try{return Boolean(cfg.kanaly[k]?.atrapa);}catch{return false;}};
   return polaczeniaIntegracji({db:o.db,kanaly:cfg,stanyKanalow:stanyListy(),proba:atrapa(klucz),
    polaczeniaAllegro:o.repozytoriumKanalow.lista().filter(p=>!atrapa(p.klucz))}).find(w=>w.id==='allegro:'+klucz)??null;
  }catch{return null;}
 }
 function widok(req:FastifyRequest,reply:FastifyReply,klucz?:string,extra:Record<string,unknown>={}){
  const k=klucz?o.repozytoriumKanalow.pobierz(klucz):null;
  if(klucz&&!k){
   // PRZ-146.01: konto przykładowe piaskownicy jest tylko w konfiguracji kanałów (atrapa) — ekran bez akcji; reszta to 404 w układzie panelu.
   let przykladowe=false;try{przykladowe=Boolean(configListy().kanaly?.[klucz]?.atrapa);}catch{}
   const nazwa=przykladowe?(configListy().definicje??[]).find((d:any)=>d?.klucz===klucz)?.etykieta:null;
   return reply.code(przykladowe?200:404).view('allegro-przykladowe.ejs',{przykladowe,
    title:przykladowe?(nazwa?(/^allegro(\s|$)/i.test(nazwa)?nazwa:'Allegro: '+nazwa):'Allegro: '+klucz):'Nie znaleziono połączenia Allegro',
    nawigacja:nawigacjaUstawien(req,reply)});
  }
  const s=sesja(req,reply),p=k?s.proby.get(k.klucz):undefined;
  const c=p?o.autoryzacjaAllegro.pobierzKandydata(p,s.id):null;
  const kandydat=c&&c.aktor.id===aktor(req).id?{probaId:c.probaId,kontoId:c.kontoId,login:c.login,wersja:c.wersja}:null;
  const stan=k?o.db.prepare('SELECT ostatni_przebieg_at,zsynchronizowane_do,ostatni_blad FROM stan_pollera WHERE sklep=?').get(k.klucz):null;
  const historia=k?Number(o.db.prepare('SELECT count(*) AS n FROM zamowienia WHERE sklep=?').get(k.klucz)?.n):0;
  const blad=s.blad??null;delete s.blad;const komunikat=s.komunikat??null;delete s.komunikat;
  const dzis=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw',year:'numeric',month:'2-digit',day:'2-digit'}).format(teraz());
  let formularzId:string|null=null;
  if(!k){if(s.formularze.size>=50)s.formularze.delete(s.formularze.keys().next().value!);formularzId=randomUUID();s.formularze.set(formularzId,{});}
  // U25: konto z pliku serwera (bez tokenów w bazie, ale z dostępem) działa jak połączone — bez kroków kreatora.
  const zSerwera=Boolean(k&&k.zrodlo==='env'&&k.autoryzacja==='brak'&&k.klucz in (configListy().kanaly??{}));
  // PRZ-146.05 (B1): kreator bez aplikacji Device w żadnym środowisku zaczyna od kroku 0.
  const deviceGotowe={produkcja:Boolean(o.aplikacjaAllegro.stanAplikacji('produkcja').device),sandbox:Boolean(o.aplikacjaAllegro.stanAplikacji('sandbox').device)};
  const numerKroku=!k?(deviceGotowe.produkcja||deviceGotowe.sandbox?1:0):kandydat?s.potwierdzone.has(kandydat.probaId)?4:3:extra.device||extra.oczekujacaProba?2:k.autoryzacja==='polaczone'||zSerwera?5:2;
  const kroki=modulKanalu('allegro').konfigurator.kroki.map(krok=>({...krok,stan:krok.numer===numerKroku?'biezacy':krok.numer<numerKroku?'zrobione':'przyszly'}));
  return reply.view(k?'allegro-polaczenie.ejs':'allegro-konfigurator.ejs',{
   zakresDatyStartu:zakresDatyStartu(teraz()),
   title:k?(/^allegro(\s|$)/i.test(k.nazwa)?k.nazwa:'Allegro: '+k.nazwa):'Podłącz konto Allegro',nawigacja:nawigacjaUstawien(k?req:{...req,url:'/ustawienia/integracje/katalog'} as FastifyRequest,reply),
   wiersz:k?wierszListy(k.klucz):null,zSerwera,teraz:teraz(),
   kroki,numerKroku,krok:kroki.find(k=>k.numer===numerKroku),wersja:k?.wersja??0,wartosci:{od:k?.odUtc&&!Number.isNaN(Date.parse(k.odUtc))?new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'}).format(new Date(k.odUtc)):dzis,...(k?{}:{srodowisko:domyslneSrodowisko()})},
   root,k,adres:k?urlKanalu(k.klucz):null,kandydat,stan,historia,dzis,formularzId,
   zapisyZablokowane:k?o.repozytoriumKanalow.zapisyZablokowane(k.klucz):false,
   aplikacjaGotowa:k?k.zrodlo==='env'||Boolean(o.aplikacjaAllegro.stanAplikacji(k.srodowisko).device)||Boolean(o.aplikacjaAllegro.aplikacjaDlaInstalacji(k.srodowisko)):false,
   diagnostyka:k?o.db.prepare('SELECT ostatnia_proba_at,ostatni_sukces_at,blad FROM kanaly_diagnostyka WHERE kanal=?').get(k.klucz)??null:null,
   deviceGotowe,
   blad,brakUprawnien:Boolean(blad?.startsWith('Brakuje uprawnień Allegro:')),dcrDostepne:o.aplikacjaAllegro.stanAplikacji('produkcja').dcrGotowe,komunikat,device:null,przeglad:null,oczekujacaProba:null,...extra,
  });
 }
 function blad(req:FastifyRequest,reply:FastifyReply,w:Extract<Wynik<unknown>,{ok:false}>,klucz?:string){
  const brakUprawnien=w.komunikat.startsWith('Brakuje uprawnień Allegro:');
  const komunikat=brakUprawnien?w.komunikat+' Otwórz aplikację w Allegro (Zarządzanie aplikacjami), zaznacz brakujące uprawnienia i połącz konto jeszcze raz.':w.komunikat==='Allegro nie przyjęło zgody Device Flow.'?'Zgoda odrzucona w Allegro. Zacznij od nowa.':w.komunikat;
  return widok(req,reply.code(status(w)),klucz,{blad:komunikat,brakUprawnien});
 }
 const odmowa=(req:FastifyRequest,reply:FastifyReply,status:number,komunikat:string,wroc=klucz(req)?urlKanalu(klucz(req)):root+'/nowe')=>stronaOdmowy(reply,status,komunikat,{tytul:'Nie zapisano ustawień Allegro',wroc,napisWroc:'Wróć do ustawień połączenia'});
 function trasa(method:'GET'|'POST',url:string,fn:(req:FastifyRequest,reply:FastifyReply)=>unknown){
  app.route({method,url,logLevel:'silent',preHandler:async(req,reply)=>{
   reply.header('Cache-Control','no-store').header('Referrer-Policy',POLITYKA_REFERERA_LINKU);
   if(konto(req)?.admin!==true)return odmowa(req,reply,403,'Tylko administrator może konfigurować Allegro.');
  },handler:async(req,reply)=>{
   try{return await fn(req,reply);}catch{
    // Odpowiedzi zewnętrznego API i wyjątki nigdy nie trafiają do widoku/logu.
    return odmowa(req,reply,503,'Nie udało się wykonać operacji Allegro. Odśwież ekran i sprawdź stan połączenia.');
   }
  }});
 }
 const klucz=(req:FastifyRequest)=>tekst((req.params as {kanal?:string})?.kanal);
 const aktualny=(req:FastifyRequest)=>{const k=o.repozytoriumKanalow.pobierz(klucz(req));return k&&k.wersja===wersja(body(req).wersja)&&!o.repozytoriumKanalow.konfliktKlucza(k.klucz)?k:null;};
 const konflikt=(req:FastifyRequest,reply:FastifyReply)=>blad(req,reply,{ok:false,kod:'konflikt',komunikat:'Formularz jest nieaktualny. Odśwież ekran.'},klucz(req));
 const staraProba=(req:FastifyRequest,reply:FastifyReply)=>blad(req,reply,{ok:false,kod:'konflikt',komunikat:'Ta próba połączenia jest nieaktualna. Odśwież ekran albo połącz konto od nowa.'},klucz(req));
 // PRZ-146.03: szkic z panelu, który nigdy nie był połączony i nie ma zamówień — wolno go usunąć
 // („Przerwij podłączanie”, a zapis z kroku 1 przez „Wróć do kroku 1” zastępuje go nowym). tylkoBrak: przed startem zgody.
 type Pol=NonNullable<ReturnType<Uslugi['repozytoriumKanalow']['pobierz']>>;
 const doUsuniecia=(k:Pol|null,tylkoBrak=false)=>Boolean(k&&k.zrodlo==='panel'&&!k.kontoId&&(tylkoBrak?k.autoryzacja==='brak':k.autoryzacja==='brak'||k.autoryzacja==='oczekuje_potwierdzenia')&&!o.db.prepare('SELECT 1 FROM zamowienia WHERE sklep=? LIMIT 1').get(k.klucz));
 function usunSzkic(klucz:string,wersjaK:number,a:Aktor,tylkoBrak=false):boolean{
  const usuniety=o.repozytoriumKanalow.transakcja(()=>{
   const k=o.repozytoriumKanalow.pobierz(klucz);if(!k||k.wersja!==wersjaK||!doUsuniecia(k,tylkoBrak))return false;
   for(const sql of ['DELETE FROM stan_pollera WHERE sklep=?','DELETE FROM kanaly_diagnostyka WHERE kanal=?','DELETE FROM kanaly_blokady_zapisu WHERE kanal=?','DELETE FROM kanaly_operacje_niejednoznaczne WHERE kanal=?','DELETE FROM tokeny_kanalu WHERE kanal=?'])o.db.prepare(sql).run(klucz);
   if(!o.db.prepare("DELETE FROM kanaly_sprzedazy WHERE klucz=? AND typ='allegro' AND zrodlo='panel' AND wersja=?").run(klucz,wersjaK).changes)throw new Error('usuniecie_szkicu');
   o.db.prepare('INSERT INTO kanaly_audit(kanal,operacja,wersja,aktor_id,aktor_login,zmieniono_at) VALUES (?,?,?,?,?,?)').run(klucz,'przerwanie_podlaczania',wersjaK+1,a.id,a.login,teraz().toISOString());
   return true;
  });
  if(usuniety)o.autoryzacjaAllegro.uniewaznij(klucz);
  return usuniety;
 }
 // Także przy pobieraniu w trakcie zatrzymywania: ekran kanału sam pokazuje „Pobieranie zamówień: Zatrzymywanie” (G16a).
 const powrot=(reply:FastifyReply,k:{klucz:string;pobieranie?:string})=>reply.code(303).redirect(urlKanalu(k.klucz));
 trasa('GET',root+'/nowe',(req,reply)=>widok(req,reply));
 trasa('POST',root+'/szkice',async(req,reply)=>{
  const b=body(req),nazwa=tekst(b.nazwa).trim(),odUtc=poczatekDniaWarszawa(tekst(b.od));
  if(!nazwa||[...nazwa].length>80||!odUtc||!poprawnaDataStartu(odUtc,teraz())||!['produkcja','sandbox'].includes(tekst(b.srodowisko)))return blad(req,reply,{ok:false,kod:'walidacja',komunikat:'Podaj nazwę (1–80 znaków), środowisko i dzień z ostatnich 12 miesięcy.'});
  const s=sesja(req,reply),f=s.formularze.get(tekst(b.formularzId));
  if(!f)return blad(req,reply,{ok:false,kod:'konflikt',komunikat:'Otwórz formularz podłączenia konta ponownie.'});
  const dane={nazwa,odUtc,srodowisko:tekst(b.srodowisko) as 'produkcja'|'sandbox'},skrot=JSON.stringify(dane);
  if(f.skrot&&f.skrot!==skrot)return blad(req,reply,{ok:false,kod:'konflikt',komunikat:'Ten formularz został już użyty. Otwórz nowy.'});
  f.skrot=skrot;f.praca??=o.zarzadzanieAllegro.utworzSzkic(dane,aktor(req));const w=await f.praca;
  if(!w.ok){f.praca=undefined;f.skrot=undefined;return blad(req,reply,w);}
  // PRZ-146.03 (B5b): zapis z „Wróć do kroku 1” zastępuje poprzedni szkic, póki nie zaczęła się zgoda.
  // PRZ-148.06: adres niesie wersję szkicu z chwili otwarcia kroku 1 — stary link nie usunie szkicu zmienionego później.
  const q=(req.query as Record<string,unknown>|undefined)??{},zastap=tekst(q.zastap),stary=zastap&&zastap!==w.dane.klucz?o.repozytoriumKanalow.pobierz(zastap):null;
  if(stary&&stary.wersja===wersja(q.wersja)&&doUsuniecia(stary,true)){usunSzkic(stary.klucz,stary.wersja,aktor(req),true);s.proby.delete(stary.klucz);}
  return powrot(reply,w.dane);
 });
 trasa('POST',root+'/aplikacja',async(req,reply)=>{
  const b=body(req);if(!['produkcja','sandbox'].includes(tekst(b.srodowisko)))return blad(req,reply,{ok:false,kod:'walidacja',komunikat:'Wybierz środowisko Allegro.'});
  const k=b.kanal?o.repozytoriumKanalow.pobierz(tekst(b.kanal)):null;
  if(b.kanal&&(!k||k.zrodlo!=='panel'||k.srodowisko!==b.srodowisko))return blad(req,reply,{ok:false,kod:'konflikt',komunikat:'Połączenie lub środowisko zostały zmienione.'});
  const w=await o.aplikacjaAllegro.zarejestruj(tekst(b.kod),tekst(b.srodowisko) as 'produkcja'|'sandbox');
  if(!w.ok)return blad(req,reply,w,k?.klucz);return k?powrot(reply,k):reply.code(303).redirect(root+'/nowe');
 });
 trasa('GET',root+'/oauth/powrot',async(req,reply)=>{
  const s=sesja(req,reply),q=req.query as Record<string,unknown>;
  const redirectUri=o.callbackAllegro;
  const w=await o.autoryzacjaAllegro.obsluzPowrot({state:tekst(q.state),code:tekst(q.code),error:tekst(q.error),redirectUri},s.id);
  if(!w.ok){s.blad=w.komunikat;return reply.code(303).redirect(root+'/nowe');}
  const c=o.autoryzacjaAllegro.pobierzKandydata(w.dane.probaId,s.id);
  if(!c)return reply.code(303).redirect(root+'/nowe');s.proby.set(c.klucz,c.probaId);return powrot(reply,{klucz:c.klucz});
 });
// Krok 0 kreatora: aplikacja Device tej instalacji. Sekret nigdy nie trafia do widoku.
 type Srod='produkcja'|'sandbox';
 const srodowiskoZ=(v:unknown):Srod|null=>v==='produkcja'||v==='sandbox'?v:null;
 // PRZ-148.06: domyślne środowisko kroków 0 i 1 — to, w którym jest aplikacja Device (obie albo żadna → produkcja).
 function domyslneSrodowisko():Srod{return !o.aplikacjaAllegro.stanAplikacji('produkcja').device&&o.aplikacjaAllegro.stanAplikacji('sandbox').device?'sandbox':'produkcja';}
 const statusDevice=({walidacja:400,z_pliku:409,w_uzyciu:409,dane_aplikacji:422,typ_aplikacji:422,tymczasowy:503} as Record<string,number>);
 function ekranAplikacji(reply:FastifyReply,s:Srod,extra:{blad?:string|null;brakujace?:{nazwa:string;opis:string;sekcja:string}[];clientId?:string;polaUserAgent?:PolaUserAgentAllegro;uaBlad?:string;uaZapisano?:boolean}={}){
  const st=o.aplikacjaAllegro.stanAplikacji(s).device;
  const zapisUserAgent=wczytajKonfiguracjeIntegracji(o.db,'allegro-user-agent');
  const polaUserAgent={nazwa:'',wersja:'',adres:'',...zapisUserAgent?.ustawienia};
  const wUzyciu=st?.zrodlo!=='env'&&Boolean(o.db.prepare("SELECT 1 FROM kanaly_sprzedazy WHERE typ='allegro' AND srodowisko=? AND aplikacja='device' AND autoryzacja IN ('polaczone','oczekuje_potwierdzenia') LIMIT 1").get(s));
  return reply.view('allegro-aplikacja.ejs',{
   userAgentZEnv:Boolean(o.config.userAgentZEnv),
   polaUserAgent:extra.polaUserAgent??polaUserAgent,
   naglowekUserAgent:o.config.userAgentZEnv||userAgentZZapisu(zapisUserAgent?.ustawienia)||userAgentAllegro({}),
   uaBlad:extra.uaBlad??null,uaZapisano:Boolean(extra.uaZapisano),
   title:'Allegro: aplikacja OMS',nawigacja:nawigacjaUstawien(reply.request,reply),root,srodowisko:s,cel:CEL_APLIKACJI,
   kroki:krokiInstrukcji(s),uprawnienia:uprawnieniaDoZaznaczenia(),
   krokiKreatora:modulKanalu('allegro').konfigurator.kroki.map(krok=>({...krok,stan:krok.numer===0?'biezacy':'przyszly'})),
   stan:st?st.zrodlo==='env'?'env':'zapisana':'brak',koncowka:st?.koncowkaId??'',wUzyciu,
   blad:extra.blad??null,brakujace:extra.brakujace??[],clientId:extra.clientId??'',
  });
 }
 trasa('GET',root+'/aplikacja',(req,reply)=>{
  // PRZ-148.06: bez parametru — środowisko, w którym aplikacja już jest (inaczej produkcja).
  const p=(req.query as Record<string,unknown>|undefined)?.srodowisko,s=p===undefined?domyslneSrodowisko():srodowiskoZ(p);
  if(!s)return odmowa(req,reply,400,'Wybierz środowisko Allegro: produkcja albo sandbox.',root+'/aplikacja');
  const ses=sesja(req,reply),blad=ses.blad;delete ses.blad;
  return ekranAplikacji(reply,s,{blad});
 });
 trasa('POST',root+'/aplikacja-urzadzenia',async(req,reply)=>{
  const b=body(req),s=srodowiskoZ(b.srodowisko);
  if(!s)return odmowa(req,reply,400,'Wybierz środowisko Allegro: produkcja albo sandbox.',root+'/aplikacja');
  const clientId=tekst(b.clientId).trim();
  const w=await o.aplikacjaAllegro.sprawdzIZapiszAplikacjeDevice(s,{clientId,clientSecret:tekst(b.clientSecret).trim()},aktor(req));
  if(!w.ok)return ekranAplikacji(reply.code(statusDevice[w.kod]??503),s,{blad:w.komunikat,brakujace:w.brakujace,clientId:w.kod==='z_pliku'||w.kod==='w_uzyciu'?'':clientId});
  return ekranAplikacji(reply,s);
 });
 trasa('POST',root+'/user-agent',(req,reply)=>{
  const b=body(req),s=srodowiskoZ(b.srodowisko);
  if(!s)return odmowa(req,reply,400,'Wybierz środowisko Allegro: produkcja albo sandbox.',root+'/aplikacja');
  if(o.config.userAgentZEnv)return ekranAplikacji(reply.code(409),s,{uaBlad:'Ustawione przez administratora serwera.'});
  const polaUserAgent={nazwa:tekst(b.nazwa),wersja:tekst(b.wersja),adres:tekst(b.adres)};
  try{zlozUserAgentAllegro(polaUserAgent);}catch(e){return ekranAplikacji(reply.code(400),s,{uaBlad:(e as Error).message,polaUserAgent});}
  zapiszKonfiguracjeIntegracji(o.db,'allegro-user-agent',{ustawienia:polaUserAgent,sekrety:{}},{konto:aktor(req) as any,teraz:teraz()});
  return ekranAplikacji(reply,s,{uaZapisano:true});
 });
 // Odświeżenie strony po zapisie trafia GET-em na adres formularza — wracamy na krok 0.
 trasa('GET',root+'/user-agent',(req,reply)=>reply.redirect(`${root}/aplikacja?srodowisko=${srodowiskoZ((req.query as Record<string,unknown>)?.srodowisko)??domyslneSrodowisko()}`,303));
 trasa('GET',root+'/:kanal',(req,reply)=>widok(req,reply,klucz(req)));
 // PRZ-146.03 (B5b): krok 1 z wartościami szkicu; tylko przed startem zgody, potem wraca na ekran połączenia.
 trasa('GET',root+'/:kanal/krok-1',(req,reply)=>{
  const k=o.repozytoriumKanalow.pobierz(klucz(req));
  if(!k||!doUsuniecia(k,true))return reply.code(303).redirect(k?urlKanalu(k.klucz):root+'/nowe');
  // PRZ-148.06: zapisana data wraca do formularza tylko, gdy nadal mieści się w oknie startu (poprawny zapis,
  // od 12 miesięcy wstecz do dziś czasu polskiego); zepsuta, za stara albo z przyszłości → dzisiejsza data.
  const od=poprawnaDataStartu(k.odUtc,teraz())?new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'}).format(new Date(k.odUtc)):undefined;
  return widok(req,reply,undefined,{wartosci:{nazwa:k.nazwa,srodowisko:k.srodowisko,od:od??new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'}).format(teraz())},zastap:k.klucz,zastapWersja:k.wersja});
 });
 trasa('POST',root+'/:kanal/przerwij',(req,reply)=>{
  if(body(req).potwierdz!=='tak')return blad(req,reply,{ok:false,kod:'walidacja',komunikat:'Potwierdź przerwanie podłączania.'},klucz(req));
  const k=aktualny(req);if(!k)return konflikt(req,reply);
  if(!doUsuniecia(k))return blad(req,reply,{ok:false,kod:'konflikt',komunikat:'To połączenie było już połączone albo ma zamówienia w OMS — nie można go usunąć.'},k.klucz);
  if(!usunSzkic(k.klucz,k.wersja,aktor(req)))return konflikt(req,reply);
  const s=sesja(req,reply),p=s.proby.get(k.klucz);if(p)s.potwierdzone.delete(p);s.proby.delete(k.klucz);
  return reply.code(303).redirect('/ustawienia/integracje');
 });
 async function autoryzuj(req:FastifyRequest,reply:FastifyReply,stary=false){
  const k=stary?o.repozytoriumKanalow.pobierz(klucz(req)):aktualny(req);if(!k)return konflikt(req,reply);
  const s=sesja(req,reply);
  if(k.zrodlo==='env'||o.aplikacjaAllegro.stanAplikacji(k.srodowisko).device){
   const w=await o.autoryzacjaAllegro.rozpocznijDevice(k.klucz,aktor(req),s.id);if(!w.ok)return blad(req,reply,w,k.klucz);
   s.proby.set(k.klucz,w.dane.probaId);return widok(req,reply,k.klucz,{device:w.dane});
  }
  if(!o.aplikacjaAllegro.aplikacjaDlaInstalacji(k.srodowisko)){s.blad='Najpierw załóż aplikację Allegro (krok 0).';return reply.code(303).redirect(root+'/aplikacja?srodowisko='+k.srodowisko);}
  const w=await o.autoryzacjaAllegro.rozpocznijAutoryzacje(k.klucz,aktor(req),s.id);if(!w.ok)return blad(req,reply,w,k.klucz);
  s.proby.set(k.klucz,w.dane.probaId);return reply.code(303).redirect(w.dane.adres);
 }
 trasa('POST',root+'/:kanal/autoryzacja',(req,reply)=>autoryzuj(req,reply));
 // Zachowany adres starych formularzy, lecz już bez samoczynnego zapisu pary.
 trasa('POST','/ustawienia/kanaly/:kanal/wiazanie',(req,reply)=>autoryzuj(req,reply,true));
 trasa('POST',root+'/:kanal/zgoda',async(req,reply)=>{
  const s=sesja(req,reply),id=tekst(body(req).probaId);
  if(s.proby.get(klucz(req))!==id)return konflikt(req,reply);
  const w=await o.autoryzacjaAllegro.sprawdzDevice(id,aktor(req),s.id);if(!w.ok)return blad(req,reply,w,klucz(req));
  return widok(req,reply,klucz(req),w.dane.gotowe?{}:{komunikat:'Zgoda jeszcze nie dotarła. Sprawdź ponownie za '+Math.ceil(w.dane.odstepMs/1000)+' s.',oczekujacaProba:id});
 });
 trasa('POST',root+'/:kanal/potwierdz',(req,reply)=>{
  const s=sesja(req,reply),id=tekst(body(req).probaId),c=o.autoryzacjaAllegro.pobierzKandydata(id,s.id);
  if(!aktualny(req))return konflikt(req,reply);
  if(s.proby.get(klucz(req))!==id||!c||c.klucz!==klucz(req)||c.aktor.id!==aktor(req).id)return staraProba(req,reply);
  s.potwierdzone.add(id);return powrot(reply,{klucz:c.klucz});
 });
 trasa('POST',root+'/:kanal/anuluj',(req,reply)=>{
  const s=sesja(req,reply),id=tekst(body(req).probaId),c=o.autoryzacjaAllegro.pobierzKandydata(id,s.id);
  if(!aktualny(req))return konflikt(req,reply);
  if(s.proby.get(klucz(req))!==id||!c||c.klucz!==klucz(req)||c.aktor.id!==aktor(req).id)return staraProba(req,reply);
  o.autoryzacjaAllegro.uniewaznij(c.klucz);s.proby.delete(c.klucz);s.potwierdzone.delete(id);return powrot(reply,{klucz:c.klucz});
 });
 trasa('POST',root+'/:kanal/data-startu',async(req,reply)=>{
  const b=body(req),od=poczatekDniaWarszawa(tekst(b.od));
  if(!od)return blad(req,reply,{ok:false,kod:'walidacja',komunikat:'Podaj poprawną datę startu.'},klucz(req));
  const w=await o.zarzadzanieAllegro.ustawDateStartu(klucz(req),od,wersja(b.wersja),aktor(req));
  return w.ok?powrot(reply,w.dane):blad(req,reply,w,klucz(req));
 });
 trasa('POST',root+'/:kanal/aktywuj',async(req,reply)=>{
  const b=body(req);if(b.potwierdz!=='tak'||!['tak','nie'].includes(tekst(b.pobieraj)))return blad(req,reply,{ok:false,kod:'walidacja',komunikat:'Potwierdź pokazane konto i wybierz stan pobierania.'},klucz(req));
  const s=sesja(req,reply);if(!s.potwierdzone.has(tekst(b.probaId)))return blad(req,reply,{ok:false,kod:'konflikt',komunikat:'Najpierw potwierdź konto Allegro przyciskiem „To moje konto — dalej”.'},klucz(req));
  const w=await o.zarzadzanieAllegro.aktywuj(klucz(req),tekst(b.probaId),wersja(b.wersja),b.pobieraj==='tak',aktor(req),s.id);
  if(!w.ok)return blad(req,reply,w,klucz(req));
  // PRZ-146.06 (B8): od razu ten sam test co „Sprawdź” (wynik w kanaly_diagnostyka). Nieudany test nie cofa
  // aktywacji; po limicie transportu odpowiadamy bez wyniku (stan „Niesprawdzone”), test kończy się w tle.
  let timer:ReturnType<typeof setTimeout>|undefined;
  const test=o.zarzadzanieAllegro.sprawdzPolaczenie(w.dane.klucz,w.dane.wersja).catch(()=>null);
  const t=await Promise.race([test,new Promise<null>(r=>{timer=setTimeout(()=>r(null),o.limitCzasuMs??30000);})]);
  clearTimeout(timer);
  if(t&&!t.ok)s.blad=t.komunikat;else if(t?.ok)s.komunikat='Konto podłączone. Połączenie sprawdzone — odczyt konta i zamówień działa.';
  return powrot(reply,w.dane);
 });
 trasa('POST',root+'/:kanal/nazwa',async(req,reply)=>{
  const b=body(req),w=await o.zarzadzanieAllegro.zmienNazwe(klucz(req),tekst(b.nazwa),wersja(b.wersja),aktor(req));return w.ok?powrot(reply,w.dane):blad(req,reply,w,klucz(req));
 });
 trasa('POST',root+'/:kanal/pobieranie',async(req,reply)=>{
  const b=body(req);if(!['tak','nie'].includes(tekst(b.wlaczone)))return blad(req,reply,{ok:false,kod:'walidacja',komunikat:'Wybierz stan pobierania.'},klucz(req));
  const w=await o.zarzadzanieAllegro.ustawPobieranie(klucz(req),b.wlaczone==='tak',wersja(b.wersja),aktor(req));return w.ok?powrot(reply,w.dane):blad(req,reply,w,klucz(req));
 });
 trasa('POST',root+'/:kanal/przywroc',(req,reply)=>{
  const w=o.repozytoriumKanalow.przywrocZKonfiguracji(klucz(req),wersja(body(req).wersja),aktor(req));
  return w.ok?powrot(reply,w.dane):blad(req,reply,w,klucz(req));
 });
 trasa('POST',root+'/:kanal/odlacz',async(req,reply)=>{
  const b=body(req);if(b.potwierdz!=='tak')return blad(req,reply,{ok:false,kod:'walidacja',komunikat:'Potwierdź odłączenie konta.'},klucz(req));
  const w=await o.zarzadzanieAllegro.odlacz(klucz(req),wersja(b.wersja),aktor(req));return w.ok?powrot(reply,w.dane):blad(req,reply,w,klucz(req));
 });
 trasa('POST',root+'/:kanal/sprawdz',async(req,reply)=>{
  const w=await o.zarzadzanieAllegro.sprawdzPolaczenie(klucz(req),wersja(body(req).wersja));
  return w.ok?widok(req,reply,klucz(req),{komunikat:w.dane.uwaga??'Odczyt konta i zamówień działa. Test nie sprawdza nadania przesyłki ani wysyłania wiadomości.'}):blad(req,reply,w,klucz(req));
 });
 trasa('POST',root+'/:kanal/przeglad',(req,reply)=>{
  const s=sesja(req,reply),w=o.przegladZapisowAllegro.przygotuj(klucz(req),wersja(body(req).wersja),aktor(req),s.id);
  if(!w.ok)return blad(req,reply,w,klucz(req));s.przeglady.set(w.dane.przegladId,klucz(req));return widok(req,reply,klucz(req),{przeglad:w.dane});
 });
 trasa('POST',root+'/:kanal/zapisy',(req,reply)=>{
  const b=body(req),s=sesja(req,reply);
  if(b.potwierdz!=='tak')return blad(req,reply,{ok:false,kod:'walidacja',komunikat:'Potwierdź przegląd operacji.'},klucz(req));
  // Tylko przegląd przypisany do tego kanału i sesji może odblokować zapisy.
  const c=o.repozytoriumKanalow.pobierz(klucz(req));if(!c||s.przeglady.get(tekst(b.przegladId))!==c.klucz)return konflikt(req,reply);
  const ids=Array.isArray(b.pozostaw)?b.pozostaw.map(tekst):b.pozostaw===undefined?[]:[tekst(b.pozostaw)];
  const w=o.przegladZapisowAllegro.zatwierdz(tekst(b.przegladId),ids,aktor(req),s.id);if(w.ok)s.przeglady.delete(tekst(b.przegladId));return w.ok?powrot(reply,w.dane):blad(req,reply,w,c.klucz);
 });
}
