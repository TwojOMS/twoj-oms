// PRZ-157.04 — fabryka kanału ERLI dla rejestru kanałów (D9: typ z kanaly_sprzedazy.typ).
// Konfiguracja połączenia: wiersz `erli:<klucz kanału>` w `konfiguracja_integracji`
// (ustawienia `{adresApi, domyslnyCzasWysylki}`, sekret `{kluczApi}`) — ten sam kształt zapisuje kreator (zmiana 11).
// Klucz API trafia wyłącznie do nagłówka klienta; nie do błędów, logu ani stanu pollera.
import type {FabrykaKanalu} from './rejestr-kanalow.ts';
import {wczytajKonfiguracjeIntegracji} from '../../../oms/db/konfiguracja-integracji.js';
import {createErliClient,createErliAdapter} from '../../../integracje/fabryki.ts';
import {stanErliWBazie} from '../../../oms/erli/adapter.js';
import {createPoller} from './poller.js';
import {drogaNadaniaErli} from '../../../domena/erli-droga-nadania.js';
import {metodaKuriera} from '../../../domena/moduly-kurierow.ts';

type Metoda = {id:string;name?:string;vendor?:string};
type Dostawa = {typeId?:string;name?:string;pickupPlace?:unknown};
const DOBA_MS=86400000;
const NIEDOSTEPNE='ERLI: słowniki metod dostawy są niedostępne — nadanie zablokowane. Spróbuj ponownie po odświeżeniu kanału.';

/** Cache jednej instancji kanału. Jedna próba na pobraną paczkę zamówień, także przy błędzie HTTP. */
export function createSlownikiErli(klient:{metodyErli:()=>Promise<any>;metodyDostawy:()=>Promise<any>},teraz=()=>new Date()) {
 let slowniki:{metodyErli:Metoda[];metodyDostawy:Metoda[]}|null=null;
 let odswiezono:number|null=null;
 let blad=false;
 let nieznanaNaKarcie=false;
 const nieznana=(d:Dostawa)=>!slowniki||![...slowniki.metodyErli,...slowniki.metodyDostawy].some(m=>m.id===d.typeId);
 async function przygotuj(zamowienia:{delivery?:Dostawa}[]) {
  const nalezne=odswiezono===null||teraz().getTime()-odswiezono>=DOBA_MS;
  if(!nalezne&&!blad&&!nieznanaNaKarcie&&!zamowienia.some(z=>nieznana(z.delivery??{})))return;
  nieznanaNaKarcie=false;
  try {
   const [metodyErli,metodyDostawy]=await Promise.all([klient.metodyErli(),klient.metodyDostawy()]);
   if(!Array.isArray(metodyErli)||!Array.isArray(metodyDostawy))throw new Error('Niepoprawne słowniki');
   slowniki={metodyErli,metodyDostawy};blad=false;
  } catch(e) {
   if((e as Error).name==='KanalZatrzymany')throw e;
   // Treść błędu transportu może zawierać dane połączenia. Do karty idzie tylko stały komunikat.
   blad=true;
  }
  odswiezono=teraz().getTime();
 }
 function rozpoznaj(d:Dostawa,mapa:Record<string,string>={}):ReturnType<typeof drogaNadaniaErli>|null {
  if(blad&&!slowniki)return {droga:'blokada',komunikat:NIEDOSTEPNE};
  if(!slowniki)return null;
  if(nieznana(d))nieznanaNaKarcie=true;
  return drogaNadaniaErli({typeId:d.typeId,pickupPlace:d.pickupPlace,nazwa:d.name,...slowniki,mapa});
 }
 return {przygotuj,rozpoznaj,dostepne:()=>slowniki!==null};
}

// WeakMap izoluje bazy (także testowe), a klucz izoluje połączenia. Nowa generacja fabryki zastępuje cache.
const pamiec=new WeakMap<object,Map<string,ReturnType<typeof createSlownikiErli>>>();

/** Wyłącznie lokalny odczyt; karta nie tworzy klienta i nie wykonuje HTTP. */
export function nadanieErliNaKarcie(db:any,z:{sklep:string;surowe_json?:string}) {
 const wynik=drogaErliDlaZamowienia(db,z);
 if(wynik===undefined)return null;
 if(!wynik)return {linia:'Nadanie: ustalane…',sprawa:null};
 if(wynik.droga==='blokada')return {linia:null,sprawa:wynik.komunikat};
 const nazwy:Record<string,string>={dpd:'DPD',inpost_paczkomat:'Paczkomat InPost',inpost_kurier:'Kurier InPost',odbior:'Odbiór osobisty'};
 return {linia:wynik.droga==='przesylki_erli'
  ? `Nadanie: Przesyłki Erli — ${wynik.metoda.name??wynik.metoda.id}`
  : `Nadanie: Twoja umowa — ${nazwy[wynik.kurier]}`,sprawa:null};
}

export const ADRES_API_ERLI='https://erli.pl/svc/shop-api';
// client.js (bez checkJs) ma typ opcji wywiedziony z samych wartości domyślnych — tu podajemy pełny kształt.
const klientErli=createErliClient as unknown as (o:{adresApi:string;kluczApi:string;fetchImpl:(url:string,init?:RequestInit)=>Promise<Response>})=>ReturnType<typeof createErliClient>;

export function createFabrykaErli({db,teraz=()=>new Date(),ustawieniaEnv={}}:{db:any;teraz?:()=>Date;ustawieniaEnv?:Record<string,any>}):FabrykaKanalu{
 return ({polaczenie,http,sprawdzZapis})=>{
  const zEnv=ustawieniaEnv[polaczenie.klucz];
  const zapis=zEnv?{ustawienia:zEnv,sekrety:{kluczApi:zEnv.kluczApi}}:wczytajKonfiguracjeIntegracji(db,`erli:${polaczenie.klucz}`);
  const kluczApi=zapis?.sekrety?.kluczApi;
  if(typeof kluczApi!=='string'||!kluczApi)throw new Error('Kanał ERLI nie ma zapisanego klucza API.');
  const u=zapis?.ustawienia??{};
  const klient=klientErli({adresApi:typeof u.adresApi==='string'&&u.adresApi?u.adresApi:ADRES_API_ERLI,kluczApi,fetchImpl:(url:RequestInfo|URL,init?:RequestInit)=>http(String(url),init)});
  const kanal=createErliAdapter({klient,stan:stanErliWBazie(db,polaczenie.klucz),domyslnyCzasWysylki:u.domyslnyCzasWysylki??null,teraz});
  const slowniki=createSlownikiErli(klient,teraz);
  if(!pamiec.has(db))pamiec.set(db,new Map());
  pamiec.get(db)!.set(polaczenie.klucz,slowniki);
  const pobierzStrone=kanal.pobierzStrone;
  kanal.pobierzStrone=async opcje=>{
   const strona=await pobierzStrone(opcje);
   await slowniki.przygotuj(strona.zamowienia);
   return strona;
  };
  const poller=createPoller({db,sklep:polaczenie.klucz,od:polaczenie.odUtc,kontrola:sprawdzZapis,kanal});
  // Wybór toru (D1) i ostatni błąd uzgodnienia widoczne w diagnostyce kanałów razem ze stanem pollera.
  return {klient,poller:{przebieg:poller.przebieg,stan:()=>({...poller.stan(),tor_importu:kanal.tor(),uzgodnienie_blad:kanal.bladUzgodnienia()})}};
 };
}

/** Uwaga dla diagnostyki: kanał ERLI czyta zamówienia zapasowym torem /inbox (API odpowiedziało 404 na /orders/changes). */
export function uwagaToruErli(stan:{sklep?:string;tor_importu?:string}|null|undefined):string|null{
 if(stan?.tor_importu!=='inbox')return null;
 return `ERLI: kanał ${stan.sklep} pobiera zamówienia zapasowym torem /inbox (API odpowiedziało 404 na /orders/changes).`;
}

/**
 * Odczyt drogi z pamięci kanału; nigdy nie odświeża słowników przez HTTP. Jedno źródło dla karty
 * (`nadanieErliNaKarcie`) i wysyłki (`droga-nadania-erli.js`): undefined = nie ERLI, null = słowniki niegotowe.
 */
export function drogaErliDlaZamowienia(db:any,z:{sklep:string;surowe_json?:string}) {
 const kanal=db.prepare('SELECT typ,pobieranie FROM kanaly_sprzedazy WHERE klucz=?').get(z.sklep);
 if(kanal?.typ!=='erli')return undefined;
 if(kanal.pobieranie!=='wlaczone')return {droga:'blokada' as const,komunikat:'Kanał ERLI wyłączony — włącz pobieranie'};
 let delivery:Dostawa={};
 try {delivery=JSON.parse(z.surowe_json??'null')?.delivery??{};}catch { /* rozpoznaj zwróci blokadę */ }
 // Mapa z kroku 3 kreatora czytana przy każdym wywołaniu: zmiana działa od następnego nadania, bez restartu.
 const droga=pamiec.get(db)?.get(z.sklep)?.rozpoznaj(delivery,ustawieniaSklepuErli(db,z.sklep).mapaMetod??{})??null;
 // Plan rozdz. 3 pkt 3: kurier z umowy firmy, dla którego OMS nie ma metody (Kurier InPost) = nadanie zablokowane.
 // Reguła stoi tylko tu, więc karta i usługa nadania mówią to samo.
 if(droga?.droga==='umowa'&&droga.kurier!=='odbior'&&!metodaKuriera(droga.kurier))
  return {droga:'blokada' as const,komunikat:`ERLI: „${droga.metoda.name??droga.metoda.id}” jedzie kurierem z Twojej umowy, a OMS nie ma modułu tego kuriera — nadaj paczkę w panelu ERLI albo u przewoźnika, a numer listu zarejestruj na karcie zamówienia.`};
 return droga;
}

function ustawieniaSklepuErli(db:any,sklep:unknown):Record<string,any> {
 if(typeof sklep!=='string'||!sklep)return {};
 return wczytajKonfiguracjeIntegracji(db,'erli:'+sklep)?.ustawienia??{};
}

/** Punkt nadania Przesyłek Erli z kroku 4 kreatora (id z /shipping/postingPoints) albo null = domyślny w ERLI. */
export function punktNadaniaErli(db:any,sklep:unknown):number|null {
 const id=Number(ustawieniaSklepuErli(db,sklep).punktNadania);
 return Number.isSafeInteger(id)&&id>0?id:null;
}

/** Domyślne wymiary paczki Przesyłek Erli z kroku 4 (waga kg, wymiary cm) albo null. */
export function wymiaryErli(db:any,sklep:unknown):{waga:number;dlugosc:number;szerokosc:number;wysokosc:number}|null {
 const w=ustawieniaSklepuErli(db,sklep).wymiaryDomyslne;
 return w&&['waga','dlugosc','szerokosc','wysokosc'].every(p=>Number(w[p])>0)?w:null;
}
