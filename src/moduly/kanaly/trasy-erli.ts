import type {FastifyInstance,FastifyRequest} from 'fastify';
import {stronaOdmowy} from '../../core/web/odmowa.js';
import type {createSklepyErli,MetodaSklepu,PunktNadania} from './services/sklepy-erli.ts';
import {KOMUNIKAT_KOLIZJI_ERLI,SRODOWISKA_ERLI} from './services/sklepy-erli.ts';
import {MODUL_ERLI} from '../../domena/modul-erli.ts';
import {stanKrokow} from '../../core/web/konfigurator/konfigurator.ts';
import {nawigacjaUstawien} from '../ustawienia/nawigacja.js';
import {zakresDatyStartu} from './zakres-importu-allegro.ts';

/** Komunikat paska „zapisano” po przekierowaniu z operacji (PRZ-157.12u). */
const ZAPISANO:Record<string,string>={
 'pobierz-metody':'Pobrano metody dostawy z ERLI.',metody:'Metody dostawy zapisane.','pomin-metody':'Metody dostawy pominięte — ustawisz je później.',
 nadawanie:'Nadawanie zapisane.','data-startu':'Data startu zapisana.',aktywuj:'Sklep aktywowany.',odczyt:'Tryb odczytu zapisany.',
 pobieranie:'Stan pobierania zapisany.',odlacz:'Sklep odłączony — wpisz klucz i sprawdź połączenie, aby podłączyć go ponownie.',
};
/** Sekcja ekranu, którą rozwijamy po błędzie danej operacji. */
const SEKCJA_OPERACJI:Record<string,string>={dane:'dane',sprawdz:'dane','pobierz-metody':'metody','pomin-metody':'metody',metody:'metody',nadawanie:'nadawanie',odlacz:'odlacz',usun:'usun'};
/** Kurier OMS wynikający z dostawcy w słowniku ERLI, gdy sprzedawca nic nie wybrał. */
export const domyslnyKurierErli=(m:{vendor?:string|null})=>m.vendor==='dpd'?'dpd':m.vendor==='inpost'?'inpost_paczkomat':m.vendor==='selfPickup'?'odbior':null;
/** Czytelna nazwa metody: nazwa z ERLI, a gdy jej brak — identyfikator rozbity na słowa („odbiorOsobisty” → „Odbior osobisty”). */
export function nazwaMetodyErli(m:{id:string;nazwa?:string}){
 if(m.nazwa&&m.nazwa!==m.id)return m.nazwa;
 const slowa=m.id.replace(/([a-ząćęłńóśźż0-9])([A-ZĄĆĘŁŃÓŚŹŻ])/g,'$1 $2').replace(/[_-]+/g,' ').trim().toLowerCase();
 return slowa?slowa[0].toUpperCase()+slowa.slice(1):m.id;
}
const odmiana=(n:number,[jeden,kilka,wiele]:[string,string,string])=>n===1?jeden:n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?kilka:wiele;
const liczba=(x:unknown)=>String(x).replace('.',',');
const dataPl=(iso:string)=>iso?new Intl.DateTimeFormat('pl-PL',{timeZone:'Europe/Warsaw',day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(iso)):'';

function podsumowania(k:any,u:Record<string,any>,metody:MetodaSklepu[]|null){
 const srodowisko=u.adresApi===SRODOWISKA_ERLI[1].adres?'sandbox':'produkcja';
 const dane=`${k.nazwa}, ${srodowisko}, ${k.kluczZapisany?'klucz zapisany':'brak klucza'}`;
 let met='nieustawione — OMS nada według dostawcy z ERLI';
 if(u.metodyPominiete&&!u.metodyZapisane)met='pominięte, ustawisz później';
 else if(metody&&u.metodyZapisane){
  const mapa=u.mapaMetod??{},ile={erli:0,umowa:0,brak:0};
  for(const m of metody){const w=mapa[m.id]??'',efekt=w==='brak'?null:w||domyslnyKurierErli(m);ile[m.erli?'erli':efekt?'umowa':'brak']++;}
  const czesci=[ile.erli&&`${ile.erli} Przesyłki Erli`,ile.umowa&&`${ile.umowa} Twoja umowa`,ile.brak&&`${ile.brak} bez kuriera ⚠`].filter(Boolean);
  met=metody.length?`${metody.length} ${odmiana(metody.length,['metoda','metody','metod'])}: ${czesci.join(', ')}`:'brak metod w cennikach ERLI';
 }
 const punkt=(u.punktyNadania as PunktNadania[]|undefined)?.find(x=>x.id===String(u.punktNadania)),w=u.wymiaryDomyslne;
 const nadawanie=w?`punkt ${punkt?.nazwa??'nieznany'}, paczka ${liczba(w.waga)} kg ${liczba(w.dlugosc)}×${liczba(w.szerokosc)}×${liczba(w.wysokosc)} cm`:'nieustawione';
 return {dane,metody:met,nadawanie};
}

export function registerTrasyErli(app:FastifyInstance,sklepy:ReturnType<typeof createSklepyErli>,teraz:()=>Date){
 const root=MODUL_ERLI.konfigurator.sciezka;
 const konto=(r:FastifyRequest)=>(r as FastifyRequest&{konto?:{id?:number;login:string;admin:boolean}}).konto;
 const url=(k:string)=>root+'/'+encodeURIComponent(k);
 for(const method of ['GET','POST'] as const)app.route({method,url:root+(method==='GET'?'/:kanal':'/:kanal/:operacja'),logLevel:'silent',preHandler:async(r,p)=>{
  p.header('Cache-Control','no-store').header('Referrer-Policy','strict-origin');
  if(konto(r)?.admin!==true)return stronaOdmowy(p,403,'Tylko administrator może konfigurować ERLI.',{wroc:'/ustawienia/integracje',napisWroc:'Wróć do integracji'});
 },handler:async(r,p)=>{
  const params=r.params as {kanal:string;operacja?:string};
  const widok=(blad:string|null=null)=>{
   const k=sklepy.pobierz(params.kanal);
   if(!k&&params.kanal!=='nowe')return stronaOdmowy(p,404,'Nie znaleziono sklepu ERLI.',{wroc:'/ustawienia/integracje',napisWroc:'Wróć do integracji'});
   const u:Record<string,any>=k?.ustawienia??{},metody=Array.isArray(u.metodySklepu)?u.metodySklepu as MetodaSklepu[]:null;
   // Krok 4 dotyczy tylko sklepów z metodą Przesyłek Erli; bez niej znika, a dalsze kroki przesuwają numery.
   const pominietoMetody=Boolean(u.metodyPominiete&&!u.metodyZapisane);
   const maErli=metody?.some(m=>m.erli)===true,pominNadawanie=pominietoMetody||metody!==null&&!maErli;
   // Kreator dla sklepu, który jeszcze nie działa; aktywny sklep i sklep z pliku mają ekran zarządzania bez kroków.
   const kreator=k?.zrodlo!=='env'&&k?.autoryzacja!=='polaczone';
   const biezacy=!k?'dane':!u.sprawdzono?'polaczenie':pominietoMetody?'start':!metody||!u.metodyZapisane?'metody':maErli&&!u.wymiaryDomyslne?'nadawanie':'start';
   const q=(r.query??{}) as Record<string,unknown>,polaczenie=q.polaczenie;
   // Kolizja oznacza oba kanały (także ten, który już działał), więc pokazujemy ją bez względu na adres.
   if(!blad&&u.kolizja)blad=KOMUNIKAT_KOLIZJI_ERLI;
   if(!blad&&polaczenie==='blad')blad='Klucz zapisany, ale połączenie z ERLI nie działa. Sprawdź klucz i środowisko.';
   const opis={...MODUL_ERLI.konfigurator,kroki:MODUL_ERLI.konfigurator.kroki.filter(x=>!(pominNadawanie&&x.id==='nadawanie')).map((x,i)=>({...x,numer:i+1}))};
   const numer=Object.fromEntries(opis.kroki.map(x=>[x.id,x.numer]));
   const iBiez=opis.kroki.findIndex(x=>x.id===biezacy),zrobione=opis.kroki.slice(0,iBiez).map(x=>x.id);
   // Zrobione kroki w pasku prowadzą do swoich zwiniętych sekcji; krok 2 nie ma osobnej sekcji, gdy połączenie działa.
   const kotwica=(id:string)=>'#erli-krok-'+(id==='polaczenie'?'dane':id);
   const kroki=stanKrokow(opis,{biezacy,zrobione}).map((x,i)=>x.stan==='zrobione'?{...x,href:kotwica(opis.kroki[i].id)}:x);
   const zapisano=!blad&&typeof q.zapisano==='string'&&Object.hasOwn(ZAPISANO,q.zapisano)?ZAPISANO[q.zapisano]:null;
   const okPolaczenia=!blad&&!zapisano&&Boolean(u.sprawdzono)&&(polaczenie==='ok'||params.operacja==='sprawdz');
   // Po błędzie operacji rozwijamy jej sekcję; po pobraniu metod w aktywnym sklepie — tabelę metod.
   const otwarte=blad&&params.operacja?SEKCJA_OPERACJI[params.operacja]??null:u.kolizja||polaczenie==='blad'?'dane':q.zapisano==='pobierz-metody'?'metody':null;
   // Fokus i przewinięcie do następnego kroku tylko po zapisie, nie przy zwykłym wejściu na ekran.
   const fokus=kreator&&!blad&&(zapisano!==null||polaczenie==='ok'||params.operacja==='sprawdz');
   return p.view('erli-konfigurator.ejs',{title:k?'ERLI — '+k.nazwa:'Dodaj sklep ERLI',szerokosc:'formularz',nawigacja:nawigacjaUstawien(r,p),k,moznaUsunac:Boolean(k&&sklepy.blokadaUsuniecia(params.kanal)===null),adres:url(params.kanal),srodowiska:SRODOWISKA_ERLI,zakresDatyStartu:zakresDatyStartu(teraz()),konfigurator:opis,kroki,numer,biezacy,kreator,pominNadawanie,maErli,blad,zapisano,okPolaczenia,otwarte,fokus,
    podsumowanie:k?podsumowania(k,u,metody):null,dataStartu:k?.od_utc?dataPl(k.od_utc):'',domyslnyKurier:domyslnyKurierErli,nazwaMetody:nazwaMetodyErli});
  };
  if(method==='GET')return widok();
  try{
   const b=r.body&&typeof r.body==='object'&&!Array.isArray(r.body)?r.body as Record<string,unknown>:{};
   const w=await sklepy.operacja(params.kanal,params.operacja!,b,{id:konto(r)?.id??0,login:konto(r)!.login});
   if(!w.ok){p.code(w.status);return widok(w.komunikat);}
   if(params.operacja==='usun')return p.code(303).redirect('/ustawienia/integracje?zapisano=usunieto_sklep');
   if(params.operacja==='dane'){
    const k=sklepy.pobierz(w.klucz);
    if(k?.kluczZapisany&&k.zrodlo!=='env'){
     let polaczenie='blad';
     try{const wynik=await sklepy.operacja(w.klucz,'sprawdz',{wersja:k.wersja},{id:konto(r)?.id??0,login:konto(r)!.login});polaczenie=wynik.ok?'ok':'blad';}catch{/* Dane są już zapisane; błąd sprawdzenia ich nie cofa. */}
     return p.code(303).redirect(url(w.klucz)+'?polaczenie='+polaczenie);
    }
   }
   if(params.operacja==='sprawdz')return widok();
   return p.code(303).redirect(url(w.klucz)+(Object.hasOwn(ZAPISANO,params.operacja!)?'?zapisano='+params.operacja:''));
  }catch{p.code(503);return widok('Nie udało się wykonać operacji ERLI. Odśwież ekran i spróbuj ponownie.');}
 }});
}
