import type {RepozytoriumKanalow} from '../repozytorium-kanalow.ts';
import type {AutoryzacjaAllegro} from './autoryzacja-allegro.ts';
import type {RejestrKanalow} from './rejestr-kanalow.ts';
import type {Aktor,PolaczenieAllegro,SrodowiskoAllegro,Wynik} from '../kontrakty-allegro.ts';
import type {DatabaseSync} from 'node:sqlite';
import {DATA_STARTU_USTALONA,poprawnaDataStartu} from '../zakres-importu-allegro.ts';
import {bladAllegro} from '../kontrakty-allegro.ts';
import {zapiszTokeny} from '../../../oms/db/tokeny.js';
export function createZarzadzanieAllegro(o:{db:DatabaseSync;repozytorium:RepozytoriumKanalow;autoryzacja:AutoryzacjaAllegro;rejestr:RejestrKanalow;teraz?:()=>Date;poAktywacji?:(k:PolaczenieAllegro)=>void}){
 const teraz=o.teraz??(()=>new Date());
 const zakonczone=new Map<string,{sesjaId:string;aktorId:number;wersja:number;dane:PolaczenieAllegro;wygasa:number}>();
 async function aktywuj(klucz:string,probaId:string,wersja:number,pobieraj:boolean,aktor:Aktor,sesjaId:string):Promise<Wynik<PolaczenieAllegro>>{
  for(const [id,k]of zakonczone)if(k.wygasa<=teraz().getTime())zakonczone.delete(id);
  const zapis=zakonczone.get(probaId),obecny=o.repozytorium.pobierz(klucz);
  if(zapis&&zapis.sesjaId===sesjaId&&zapis.aktorId===aktor.id&&zapis.wersja===wersja&&zapis.dane.klucz===klucz&&obecny?.wersja===zapis.dane.wersja&&obecny.autoryzacja==='polaczone')return {ok:true,dane:obecny};
  const kandydat=o.autoryzacja.pobierzKandydata(probaId,sesjaId);
  if(!kandydat||kandydat.klucz!==klucz||kandydat.aktor.id!==aktor.id||kandydat.wersja!==wersja)return bladAllegro('konflikt','Zgoda lub formularz są nieaktualne. Odśwież ekran.');
  const k=o.repozytorium.pobierz(klucz);
  if(!k||k.wersja!==wersja||k.generacja!==kandydat.generacja||typeof pobieraj!=='boolean')return bladAllegro('konflikt','Połączenie zostało zmienione.');
  if(k.zrodlo!=='env'&&!poprawnaDataStartu(k.odUtc,teraz()))return bladAllegro('walidacja','Wybierz dzień z ostatnich 12 miesięcy, nie późniejszy niż dzisiaj.');
  try{
   const ile=await kandydat.sprawdzZakres(k.odUtc);if(ile>10000)return bladAllegro('walidacja','Zakres zawiera ponad 10 000 zamówień. Wybierz późniejszą datę.');
   // Nowe kanały panelu potwierdzają istniejące konta przez API. Legacy zachowuje
   // znane ID także przy historycznej zgodzie bez prawa odczytu profilu.
   const envSprawdzone:{klucz:string;wersja:number;generacja:number}[]=[];
   for(const e of o.repozytorium.lista().filter(e=>e.zrodlo==='env'&&e.autoryzacja==='polaczone'&&e.srodowisko===k.srodowisko&&e.klucz!==klucz)){
    const konto=k.zrodlo==='env'&&e.kontoId?{id:e.kontoId}:await o.rejestr.klient(e.klucz).pobierzMojeKonto();
    if(konto.id===kandydat.kontoId)return bladAllegro('konflikt','To konto Allegro jest już połączone z istniejącym kanałem.');
    envSprawdzone.push({klucz:e.klucz,wersja:e.wersja,generacja:e.generacja});
   }
   const wynik=o.repozytorium.transakcja(():Wynik<PolaczenieAllegro>=>{
    const p=o.autoryzacja.pobierzKandydata(probaId,sesjaId);if(!p||p.wersja!==wersja||p.aktor.id!==aktor.id)return bladAllegro('konflikt','Zgoda została unieważniona.');
    if(envSprawdzone.some(e=>{const n=o.repozytorium.pobierz(e.klucz);return !n||n.wersja!==e.wersja||n.generacja!==e.generacja;}))return bladAllegro('konflikt','Inne połączenie Allegro zostało zmienione. Spróbuj ponownie.');
    const z=o.repozytorium.zapiszZmiane(klucz,wersja,{kontoId:p.kontoId,login:p.login,autoryzacja:'polaczone',pobieranie:k.zrodlo==='env'?k.pobieranie:k.kontoId?'wylaczone':pobieraj?'wlaczone':'wylaczone'},aktor);if(!z.ok)return z;
    zapiszTokeny(o.db,klucz,p.tokeny,z.dane.generacja);o.poAktywacji?.(z.dane);return z;
   });
   if(wynik.ok){o.autoryzacja.zuzyjKandydata(probaId);zakonczone.set(probaId,{sesjaId,aktorId:aktor.id,wersja,dane:wynik.dane,wygasa:teraz().getTime()+600000});}
   return wynik;
  }catch{return bladAllegro('tymczasowy','Nie udało się zapisać i sprawdzić połączenia. Dane aktywnego konta nie zostały zmienione.');}
 }
 const konflikt=()=>bladAllegro('konflikt','Połączenie zostało zmienione. Odśwież ekran.');
 async function zakonczZatrzymanie(k:PolaczenieAllegro,zakres:'zamowienia'|'calosc',aktor:Aktor):Promise<Wynik<PolaczenieAllegro>>{
  const stan=await o.rejestr.zatrzymaj(k.klucz,zakres);
  if(stan==='gotowe')return {ok:true,dane:o.repozytorium.pobierz(k.klucz)??k};
  const current=o.repozytorium.pobierz(k.klucz);if(!current||current.wersja!==k.wersja)return konflikt();
  const wynik=o.repozytorium.zapiszZmiane(k.klucz,k.wersja,{pobieranie:'zatrzymywanie'},aktor);
  if(wynik.ok){
   const version=wynik.dane.wersja;
   void o.rejestr.poZatrzymaniu(k.klucz,zakres).then(()=>{
    const terazStan=o.repozytorium.pobierz(k.klucz);
    if(terazStan?.wersja===version&&terazStan.pobieranie==='zatrzymywanie')o.repozytorium.zapiszZmiane(k.klucz,version,{pobieranie:'wylaczone'},aktor);
   }).catch(()=>{/* Stan trwały pozostaje zatrzymywanie; operator może powtórzyć akcję. */});
  }
  return wynik;
 }
 async function zmienNazwe(klucz:string,nazwa:string,wersja:number,aktor:Aktor):Promise<Wynik<PolaczenieAllegro>>{
  return o.repozytorium.zapiszZmiane(klucz,wersja,{nazwa},aktor);
 }
 async function ustawDateStartu(klucz:string,od:string,wersja:number,aktor:Aktor):Promise<Wynik<PolaczenieAllegro>>{
  const k=o.repozytorium.pobierz(klucz);if(!k||k.wersja!==wersja||o.repozytorium.konfliktKlucza(klucz))return konflikt();
  if(k.zrodlo==='env')return bladAllegro('walidacja','Datę startu tego kanału ustawia administrator serwera (plik oms.env).');
  // Aktywacja z „Pozostaw wyłączone” nie podnosi generacji importu — zamraża ją pierwsze połączenie (generacja>0).
  if(k.generacja!==0||k.generacjaImportu!==0)return bladAllegro('walidacja',DATA_STARTU_USTALONA);
  if(!poprawnaDataStartu(od,teraz()))return bladAllegro('walidacja','Wybierz dzień z ostatnich 12 miesięcy, nie późniejszy niż dzisiaj.');
  const z=o.repozytorium.zapiszZmiane(klucz,wersja,{odUtc:od},aktor);
  if(z.ok)o.autoryzacja.przeniesKandydata(klucz,wersja,z.dane.wersja);
  return z;
 }
 async function ustawPobieranie(klucz:string,wlaczone:boolean,wersja:number,aktor:Aktor):Promise<Wynik<PolaczenieAllegro>>{
  const k=o.repozytorium.pobierz(klucz);if(!k||k.wersja!==wersja)return konflikt();
  if(k.autoryzacja!=='polaczone')return bladAllegro('odlaczone','Najpierw połącz konto Allegro.');
  if(typeof wlaczone!=='boolean')return bladAllegro('walidacja','Wybierz stan pobierania.');
  if(wlaczone&&o.rejestr.czyTrwa(klucz,'zamowienia'))return bladAllegro('konflikt','Poprzedni import jest jeszcze zatrzymywany. Poczekaj na zakończenie.');
  const cel=wlaczone?'wlaczone':'wylaczone';
  const wynik=k.pobieranie===cel?{ok:true as const,dane:k}:o.repozytorium.zapiszZmiane(klucz,wersja,{pobieranie:cel},aktor);
  if(!wynik.ok||wlaczone)return wynik;
  return zakonczZatrzymanie(wynik.dane,'zamowienia',aktor);
 }
 async function odlacz(klucz:string,wersja:number,aktor:Aktor):Promise<Wynik<PolaczenieAllegro>>{
  const k=o.repozytorium.pobierz(klucz);if(!k||k.wersja!==wersja)return konflikt();
  const wynik=o.repozytorium.transakcja(():Wynik<PolaczenieAllegro>=>{
   const z=k.autoryzacja==='odlaczone'?{ok:true as const,dane:k}:o.repozytorium.zapiszZmiane(klucz,wersja,{autoryzacja:'odlaczone',...(k.zrodlo==='env'?{}:{pobieranie:'wylaczone' as const})},aktor);
   if(z.ok&&k.zrodlo!=='env'){o.repozytorium.zablokujZapisy(klucz,aktor);o.db.prepare('DELETE FROM tokeny_kanalu WHERE kanal=?').run(klucz);}
   return z;
  });
  if(!wynik.ok)return wynik;
  o.autoryzacja.uniewaznij(klucz);
  if(k.zrodlo==='env'){await o.rejestr.zatrzymaj(klucz,'calosc');return wynik;}
  return zakonczZatrzymanie(wynik.dane,'calosc',aktor);
 }
 async function sprawdzPolaczenie(klucz:string,wersja:number):Promise<Wynik<{sprawdzonoAt:string;uwaga?:string}>>{
  const k=o.repozytorium.pobierz(klucz);if(!k||k.wersja!==wersja||o.repozytorium.konfliktKlucza(klucz))return konflikt();
  if(k.autoryzacja!=='polaczone')return bladAllegro('odlaczone','Najpierw połącz konto.');
  const aktualna=()=>{const n=o.repozytorium.pobierz(klucz);return n?.wersja===wersja&&n.generacja===k.generacja&&n.autoryzacja==='polaczone';};
  const at=teraz().toISOString();
  const zapisz=(blad:boolean)=>o.db.prepare(`INSERT INTO kanaly_diagnostyka(kanal,ostatnia_proba_at,ostatni_sukces_at,blad) VALUES (?,?,?,?)
   ON CONFLICT(kanal) DO UPDATE SET ostatnia_proba_at=excluded.ostatnia_proba_at,blad=excluded.blad,
   ostatni_sukces_at=CASE WHEN excluded.blad=0 THEN excluded.ostatni_sukces_at ELSE kanaly_diagnostyka.ostatni_sukces_at END`).run(klucz,at,blad?null:at,blad?1:0);
  try{
   const klient=o.rejestr.klient(klucz);let konto:{id:string}|null=null,uwaga:string|undefined;
   try{konto=await klient.pobierzMojeKonto();}catch(e){
    if(k.zrodlo!=='env'||(e as {status?:number}).status!==403)throw e;
    uwaga='Brak uprawnienia do odczytu profilu. Odczyt zamówień działa; tożsamość konta nie została sprawdzona.';
   }
   if(!aktualna())return konflikt();
   if(k.kontoId&&konto&&konto.id!==k.kontoId){zapisz(true);return bladAllegro('konflikt','Allegro zwróciło inne konto. Wstrzymaj obsługę tego połączenia.');}
   await klient.sprawdzZakresZamowien({odUtc:k.odUtc});if(!aktualna())return konflikt();
   zapisz(false);return {ok:true,dane:{sprawdzonoAt:at,...(uwaga?{uwaga}:{})}};
  }catch(e){
   if(aktualna())zapisz(true);
   // B5: odmowa (401/403) wymaga ponownego połączenia; sieć i 5xx miną same. Tokeny zostają bez zmian.
   const b=e as {status?:unknown;code?:unknown;cause?:{code?:unknown};name?:unknown};
   if(b?.status===401||b?.status===403)return bladAllegro('tymczasowy','Allegro odmówiło dostępu — odnów połączenie.');
   if((typeof b?.status==='number'&&b.status>=500)||typeof b?.code==='string'||typeof b?.cause?.code==='string'||b?.name==='AbortError'||b?.name==='TimeoutError')return bladAllegro('tymczasowy','Allegro nie odpowiada, spróbujemy ponownie.');
   return bladAllegro('tymczasowy','Nie udało się odczytać konta lub zamówień Allegro.');
  }
 }
 return {utworzSzkic:async(d:{nazwa:string;odUtc:string;srodowisko:SrodowiskoAllegro},a:Aktor):Promise<Wynik<PolaczenieAllegro>>=>poprawnaDataStartu(d.odUtc,teraz())?o.repozytorium.utworzSzkic(d,a):bladAllegro('walidacja','Wybierz dzień z ostatnich 12 miesięcy, nie późniejszy niż dzisiaj.'),
  aktywuj,
  zmienNazwe,ustawDateStartu,ustawPobieranie,odlacz,sprawdzPolaczenie};
}
