import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {Aktor} from '../kontrakty-allegro.ts';
import {createErliClient} from '../../../oms/erli/client.js';
import {wczytajKonfiguracjeIntegracji,zapiszKonfiguracjeIntegracji,usunKonfiguracjeIntegracji,stanDlaEkranu} from '../../../oms/db/konfiguracja-integracji.js';
import {poczatekDniaWarszawa,poprawnaDataStartu} from '../zakres-importu-allegro.ts';
import {KURIERZY_MAPY_ERLI} from '../../../domena/erli-droga-nadania.js';

export const SRODOWISKA_ERLI=[
 {adres:'https://erli.pl/svc/shop-api',nazwa:'ERLI — sklep'},
 {adres:'https://sandbox.erli.dev/svc/shop-api',nazwa:'ERLI — sandbox'},
] as const;
export const adresErliOk=(adres:unknown):adres is string=>SRODOWISKA_ERLI.some(s=>s.adres===adres);
// Zamknięty znacznik lokalnego transportu próby; nigdy nie pokazujemy dowolnej treści błędu ani klucza.
const odmowaProby=(e:unknown)=>(e as any)?.status===403&&(e as any)?.message==='ERLI: OMS_PROBA_ERLI_PRODUKCJA (HTTP 403)'
 ?'Piaskownica nie łączy się z prawdziwym ERLI — wybierz środowisko sandbox albo klucz atrapy atrapa-polcien.':null;
type Wynik={ok:true;klucz:string}|{ok:false;status:number;komunikat:string};
const blad=(status:number,komunikat:string):Wynik=>({ok:false,status,komunikat});
export type MetodaSklepu={id:string;nazwa:string;erli:boolean;vendor:string|null};
export type PunktNadania={id:string;nazwa:string;adres:string;domyslny:boolean};
const tekst=(v:unknown,max=160)=>typeof v==='string'?v.trim().slice(0,max):'';
/** Kroki 3–4 kreatora: metody z cenników sklepu i punkty nadania (te ostatnie tylko, gdy sklep ma Przesyłki Erli). */
async function pobierzSlownikiNadania(klient:any):Promise<{metodySklepu:MetodaSklepu[];punktyNadania:PunktNadania[]}> {
 const [cenniki,metodyErli,metodyDostawy]=await Promise.all([klient.cennikiDostawSzczegoly(),klient.metodyErli(),klient.metodyDostawy()]);
 if(!Array.isArray(cenniki)||!Array.isArray(metodyErli)||!Array.isArray(metodyDostawy))throw new Error('Niepoprawne słowniki');
 const ids=[...new Set(cenniki.flatMap((c:any)=>Array.isArray(c?.prices)?c.prices.map((x:any)=>x?.deliveryMethod?.id):[]))]
  .filter((id):id is string=>typeof id==='string'&&id.length>0&&id.length<=100&&id!=='__proto__'&&!/[\u0000-\u001f\u007f]/.test(id)).slice(0,200);
 const metodySklepu=ids.map(id=>{
  const e=metodyErli.find((m:any)=>m?.id===id),d=metodyDostawy.find((m:any)=>m?.id===id);
  return {id,nazwa:tekst(e?.name)||tekst(d?.name)||id,erli:Boolean(e),vendor:typeof d?.vendor==='string'?d.vendor:null};
 });
 if(!metodySklepu.some(m=>m.erli))return {metodySklepu,punktyNadania:[]};
 const punkty=await klient.punktyNadania();
 if(!Array.isArray(punkty))throw new Error('Niepoprawne punkty nadania');
 const punktyNadania=punkty.filter((x:any)=>Number.isSafeInteger(Number(x?.id))&&Number(x.id)>0).slice(0,100).map((x:any)=>({
  id:String(Number(x.id)),nazwa:tekst(x.name)||tekst(x.companyName)||`Punkt ${x.id}`,
  adres:[[tekst(x.street),tekst(x.buildingNumber)].filter(Boolean).join(' '),[tekst(x.zip),tekst(x.city)].filter(Boolean).join(' ')].filter(Boolean).join(', '),
  domyslny:x.isDefault===true}));
 return {metodySklepu,punktyNadania};
}
export const KOMUNIKAT_KOLIZJI_ERLI='Ten sklep ERLI jest już zapisany w innym kanale. Oba kanały wstrzymano — odłącz albo usuń duplikat i ponownie sprawdź połączenie.';
export function createSklepyErli(o:{db:DatabaseSync;teraz:()=>Date;ustawieniaEnv:Record<string,any>;definicje:readonly {klucz:string;etykieta?:string}[];fetchImpl?:typeof fetch}){
 const {db}=o;
 const zapis=(k:string)=>o.ustawieniaEnv[k]?{ustawienia:{adresApi:o.ustawieniaEnv[k].adresApi,od:o.ustawieniaEnv[k].od},sekrety:{kluczApi:o.ustawieniaEnv[k].kluczApi}}:wczytajKonfiguracjeIntegracji(db,'erli:'+k);
 const rows=()=>db.prepare("SELECT * FROM kanaly_sprzedazy WHERE typ='erli' ORDER BY utworzono_at,klucz").all() as any[];
 function lista(){
  return [...o.definicje.map(d=>({klucz:d.klucz,nazwa:d.etykieta??d.klucz,zrodlo:'env',wersja:0,generacja:1,autoryzacja:'polaczone',pobieranie:'wlaczone',od_utc:o.ustawieniaEnv[d.klucz]?.od??''})),...rows().filter(r=>!o.definicje.some(d=>d.klucz===r.klucz))].map(r=>{
   const s=stanDlaEkranu(zapis(r.klucz));
   return {...r,ustawienia:s?.ustawienia??{},kluczZapisany:s?.zapisaneSekrety.kluczApi===true};
  });
 }
 const pobierz=(k:string)=>lista().find(r=>r.klucz===k);
 function transakcja<T>(fn:()=>T):T {db.exec('SAVEPOINT erli_konfigurator');try{const r=fn();db.exec('RELEASE erli_konfigurator');return r;}catch(e){db.exec('ROLLBACK TO erli_konfigurator; RELEASE erli_konfigurator');throw e;}}
 function audit(k:string,a:Aktor,operacja:string){db.prepare('INSERT INTO kanaly_audit(kanal,operacja,wersja,aktor_id,aktor_login,zmieniono_at) SELECT klucz,?,wersja,?,?,? FROM kanaly_sprzedazy WHERE klucz=?').run(operacja,a.id,a.login,o.teraz().toISOString(),k);}
 function zmien(k:string,a:Aktor,operacja:string){db.prepare('UPDATE kanaly_sprzedazy SET wersja=wersja+1,generacja=generacja+1,generacja_importu=generacja_importu+1,zmieniono_at=?,aktor_id=?,aktor_login=? WHERE klucz=?').run(o.teraz().toISOString(),a.id,a.login,k);audit(k,a,operacja);}
 const zapiszIntegracje=zapiszKonfiguracjeIntegracji as unknown as (db:DatabaseSync,id:string,dane:{ustawienia:unknown;sekrety:unknown},opcje:{konto:Aktor;teraz:Date})=>void;
 // Kroki 3–4 nie zmieniają połączenia: tylko wersja formularza i audyt, bez nowej generacji kanału (słowniki zostają w pamięci).
 function zmienWersje(k:string,a:Aktor,operacja:string){db.prepare('UPDATE kanaly_sprzedazy SET wersja=wersja+1,zmieniono_at=?,aktor_id=?,aktor_login=? WHERE klucz=?').run(o.teraz().toISOString(),a.id,a.login,k);audit(k,a,operacja);}
 function zapisz(k:string,u:any,s:any,a:Aktor){zapiszIntegracje(db,'erli:'+k,{ustawienia:u,sekrety:s},{konto:a,teraz:o.teraz()});}
 function blokada(k:string,tak:boolean,a:Aktor){db.prepare('INSERT INTO kanaly_blokady_zapisu(kanal,zablokowane,aktor_id,aktor_login,zmieniono_at) VALUES (?,?,?,?,?) ON CONFLICT(kanal) DO UPDATE SET zablokowane=excluded.zablokowane,aktor_id=excluded.aktor_id,aktor_login=excluded.aktor_login,zmieniono_at=excluded.zmieniono_at').run(k,Number(tak),a.id,a.login,o.teraz().toISOString());}
 function blokadaUsuniecia(k:string):string|null{
  const r=pobierz(k);
  if(!r)return 'Nie znaleziono sklepu ERLI.';
  if(r.zrodlo==='env')return 'Ten sklep jest ustawiony w pliku konfiguracji — tam go zmień.';
  if(r.autoryzacja==='polaczone')return 'Najpierw odłącz sklep, potem go usuń.';
  const jest=(sql:string)=>Boolean(db.prepare(sql).get(k));
  if(jest('SELECT 1 FROM zamowienia WHERE sklep=? LIMIT 1')||jest('SELECT 1 FROM stan_importu_sklepu WHERE sklep=?')||jest('SELECT 1 FROM produkty_sklepowe WHERE kanal=? LIMIT 1'))return 'Sklep ma już pobrane dane — najpierw odłącz sklep. Pobranych danych nie można usuwać.';
  return null;
 }
 function usun(k:string,wersja:number,a:Aktor):Wynik{
  return transakcja(()=>{
   const r=pobierz(k);
   if(!r)return blad(404,'Nie znaleziono sklepu ERLI.');
   const blokada=blokadaUsuniecia(k);if(blokada)return blad(409,blokada);
   if(!Number.isSafeInteger(wersja)||wersja!==r.wersja)return blad(409,'Formularz jest nieaktualny. Odśwież ekran.');
   for(const sql of ['DELETE FROM stan_pollera WHERE sklep=?','DELETE FROM kanaly_blokady_zapisu WHERE kanal=?','DELETE FROM kanaly_operacje_niejednoznaczne WHERE kanal=?'])db.prepare(sql).run(k);
   // Słowniki dostaw, mapa kurierów i punkty nadania są w tej samej konfiguracji co klucz API.
   usunKonfiguracjeIntegracji(db,'erli:'+k);
   usunKonfiguracjeIntegracji(db,'erli_stan:'+k);
   db.prepare('DELETE FROM granice_historii WHERE kanal=?').run(r.raport);
   if(!db.prepare("DELETE FROM kanaly_sprzedazy WHERE klucz=? AND typ='erli' AND wersja=?").run(k,wersja).changes)throw new Error('usuniecie_sklepu');
   db.prepare('INSERT INTO kanaly_audit(kanal,operacja,wersja,aktor_id,aktor_login,zmieniono_at) VALUES (?,?,?,?,?,?)').run(k,'usuniecie_sklepu',wersja+1,a.id,a.login,o.teraz().toISOString());
   return {ok:true,klucz:k};
  });
 }
 async function operacja(k:string,op:string,b:Record<string,unknown>,a:Aktor):Promise<Wynik>{
  const nowy=k==='nowe',r=pobierz(k);
  if(!nowy&&!r)return blad(404,'Nie znaleziono sklepu ERLI.');
  if(r?.zrodlo==='env')return blad(409,'Ten sklep jest ustawiony w pliku konfiguracji — tam go zmień.');
  if(!Number.isSafeInteger(Number(b.wersja))||Number(b.wersja)!==(r?.wersja??0))return blad(409,'Formularz jest nieaktualny. Odśwież ekran.');
  const w=nowy?null:zapis(k),u=w?.ustawienia??{},s=w?.sekrety??{};
  if(op==='dane'){
   const nazwa=typeof b.nazwa==='string'?b.nazwa.trim():'';
   const adres=b.adresApi,klucz=typeof b.kluczApi==='string'?b.kluczApi.trim():'';
   const czas=b.domyslnyCzasWysylki===''||b.domyslnyCzasWysylki===undefined?null:Number(b.domyslnyCzasWysylki);
   if(!nazwa||[...nazwa].length>80||!adresErliOk(adres)||(!klucz&&!s.kluczApi)||(czas!==null&&(!Number.isInteger(czas)||czas<0||czas>365)))return blad(400,'Podaj nazwę, jedno z dwóch środowisk, klucz API i czas wysyłki (0–365 dni roboczych lub puste).');
   if(u.aktywowano&&adres!==u.adresApi)return blad(409,'Po aktywacji nie można zmienić środowiska sklepu.');
   return transakcja(()=>{
    if(nowy){k='erli_'+randomUUID().replaceAll('-','');const at=o.teraz().toISOString();
     db.prepare("INSERT INTO kanaly_sprzedazy(klucz,typ,nazwa,srodowisko,zrodlo,raport,autoryzacja,pobieranie,od_utc,wersja,generacja,generacja_importu,utworzono_at,zmieniono_at,aktor_id,aktor_login) VALUES (?,'erli',?,?,'panel',?,'brak','wylaczone',?,0,0,0,?,?,?,?)").run(k,nazwa,adres===SRODOWISKA_ERLI[0].adres?'produkcja':'sandbox',k.toUpperCase(),poczatekDniaWarszawa(new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'}).format(o.teraz()))!,at,at,a.id,a.login);
    }else db.prepare('UPDATE kanaly_sprzedazy SET nazwa=?,srodowisko=? WHERE klucz=?').run(nazwa,adres===SRODOWISKA_ERLI[0].adres?'produkcja':'sandbox',k);
    const zmianaKlucza=Boolean(klucz&&klucz!==s.kluczApi)||adres!==u.adresApi;
    zapisz(k,{...u,adresApi:adres,domyslnyCzasWysylki:czas,...(zmianaKlucza?{sprawdzono:false,sklepId:null,sklepNazwa:null}:{})},{kluczApi:klucz||s.kluczApi},a);
    if(zmianaKlucza)db.prepare("UPDATE kanaly_sprzedazy SET autoryzacja='brak',pobieranie='wylaczone' WHERE klucz=?").run(k);
    zmien(k,a,'dane');return {ok:true,klucz:k};
   });
  }
  if(nowy)return blad(400,'Najpierw zapisz dane sklepu.');
  if(op==='usun'){
   if(b.potwierdz!=='tak')return blad(400,'Potwierdź usunięcie sklepu.');
   return usun(k,Number(b.wersja),a);
  }
  if(op==='sprawdz'){
   let sklep:any;
   try{sklep=await (createErliClient as any)({adresApi:u.adresApi,kluczApi:s.kluczApi,fetchImpl:o.fetchImpl}).mojSklep();}
   catch(e){return blad(400,odmowaProby(e)??((e as any).status===401?'Nieprawidłowy klucz API. Sprawdź klucz w panelu ERLI.':'Nie udało się sprawdzić połączenia ERLI. Spróbuj ponownie.'));}
   if(pobierz(k)?.wersja!==r.wersja)return blad(409,'Połączenie zmieniono podczas sprawdzania. Odśwież ekran.');
   if(!/^\d{1,32}$/.test(String(sklep?.id))||typeof sklep?.name!=='string'||!sklep.name||sklep.name.length>128||[String(sklep.id),sklep.name].some(v=>v.includes(s.kluczApi)))return blad(400,'ERLI zwróciło niepoprawną tożsamość sklepu.');
   return transakcja(()=>{
    const kolizje=lista().filter(x=>x.klucz!==k&&x.autoryzacja!=='odlaczone'&&x.ustawienia.adresApi===u.adresApi&&String(x.ustawienia.sklepId)===String(sklep.id));
    const kolizja=kolizje.length>0;
    zapisz(k,{...u,sklepId:String(sklep.id),sklepNazwa:sklep.name,sprawdzono:!kolizja,kolizja},s,a);
    for(const x of [r,...kolizje]){if(x.zrodlo==='env')continue;if(kolizja){const st=zapis(x.klucz)!;zapisz(x.klucz,{...st.ustawienia,sprawdzono:false,kolizja:true},st.sekrety,a);db.prepare("UPDATE kanaly_sprzedazy SET pobieranie='wylaczone' WHERE klucz=?").run(x.klucz);blokada(x.klucz,true,a);}zmien(x.klucz,a,'sprawdz');}
    return kolizja?blad(409,KOMUNIKAT_KOLIZJI_ERLI):{ok:true,klucz:k};
   });
  }
  if(op==='pobierz-metody'){
   if(!u.sprawdzono||u.kolizja||!s.kluczApi)return blad(409,'Najpierw sprawdź połączenie i rozwiąż kolizję sklepu.');
   let slowniki:Awaited<ReturnType<typeof pobierzSlownikiNadania>>;
   try{slowniki=await pobierzSlownikiNadania((createErliClient as any)({adresApi:u.adresApi,kluczApi:s.kluczApi,fetchImpl:o.fetchImpl}));}
   catch(e){return blad(400,odmowaProby(e)??((e as any).status===401?'Nieprawidłowy klucz API. Sprawdź klucz w panelu ERLI.':'Nie udało się pobrać metod dostawy z ERLI. Spróbuj ponownie.'));}
   if(pobierz(k)?.wersja!==r.wersja)return blad(409,'Połączenie zmieniono podczas pobierania. Odśwież ekran.');
   return transakcja(()=>{
    const {metodySklepu,punktyNadania}=slowniki,ids=new Set(metodySklepu.map(m=>m.id));
    const mapaMetod=Object.fromEntries(Object.entries(u.mapaMetod??{}).filter(([id])=>ids.has(id)));
    const punktNadania=punktyNadania.some(x=>x.id===u.punktNadania)?u.punktNadania:punktyNadania.find(x=>x.domyslny)?.id??null;
    zapisz(k,{...u,metodySklepu,punktyNadania,mapaMetod,punktNadania},s,a);zmienWersje(k,a,op);return {ok:true,klucz:k};
   });
  }
  if(op==='pomin-metody'){
   if(!u.sprawdzono||u.kolizja||!s.kluczApi)return blad(409,'Najpierw sprawdź połączenie i rozwiąż kolizję sklepu.');
   return transakcja(()=>{zapisz(k,{...u,metodyPominiete:true},s,a);zmienWersje(k,a,op);return {ok:true,klucz:k};});
  }
  if(op==='metody'||op==='nadawanie'){
   const metody:MetodaSklepu[]|null=Array.isArray(u.metodySklepu)?u.metodySklepu:null;
   if(!metody)return blad(409,'Najpierw pobierz metody dostawy z ERLI.');
   if(op==='metody'){
    const mapaMetod:Record<string,string>={};
    for(const [pole,v] of Object.entries(b)){
     if(!pole.startsWith('kurier:'))continue;
     const m=metody.find(x=>x.id===pole.slice(7));
     if(!m||m.erli)return blad(400,'Metody Przesyłek Erli nadaje ERLI — kuriera wybiera się tylko dla metod Twojej umowy.');
     if(v===''||v===undefined)continue;
     if(!['brak',...KURIERZY_MAPY_ERLI].includes(String(v)))return blad(400,'Wybierz kuriera z listy.');
     mapaMetod[m.id]=String(v);
    }
    return transakcja(()=>{zapisz(k,{...u,mapaMetod,metodyZapisane:true},s,a);zmienWersje(k,a,op);return {ok:true,klucz:k};});
   }
   if(!metody.some(m=>m.erli))return blad(409,'Sklep nie ma metod Przesyłek Erli — ten krok jest pominięty.');
   const punkt=(u.punktyNadania as PunktNadania[]|undefined)?.find(x=>x.id===String(b.punktNadania));
   const wymiary=Object.fromEntries(['waga','dlugosc','szerokosc','wysokosc'].map(p=>[p,Number(String(b[p]??'').trim().replace(',','.'))]));
   if(!punkt||Object.values(wymiary).some(x=>!Number.isFinite(x)||x<=0||x>1000))return blad(400,'Wybierz punkt nadania z listy i podaj wagę oraz wymiary paczki większe od zera.');
   return transakcja(()=>{zapisz(k,{...u,punktNadania:punkt.id,wymiaryDomyslne:wymiary},s,a);zmienWersje(k,a,op);return {ok:true,klucz:k};});
  }
  return transakcja(()=>{
   if(op==='data-startu'){
    if(u.aktywowano)return blad(409,'Daty startu nie można zmienić po pierwszej aktywacji.');
    const od=typeof b.od==='string'?poczatekDniaWarszawa(b.od):null;
    if(!od||!poprawnaDataStartu(od,o.teraz()))return blad(400,'Podaj poprawną datę startu z ostatniego roku, nie późniejszą niż dzisiaj.');
    db.prepare('UPDATE kanaly_sprzedazy SET od_utc=? WHERE klucz=?').run(od,k);
   }else if(op==='aktywuj'){
    if(!u.sprawdzono||u.kolizja||!s.kluczApi)return blad(409,'Najpierw sprawdź połączenie i rozwiąż kolizję sklepu.');
    // Krok „Start” wysyła datę razem z aktywacją; ta sama walidacja co osobny zapis daty, przed każdym zapisem.
    if(typeof b.od==='string'&&b.od!==''){
     if(u.aktywowano)return blad(409,'Daty startu nie można zmienić po pierwszej aktywacji.');
     const od=poczatekDniaWarszawa(b.od);
     if(!od||!poprawnaDataStartu(od,o.teraz()))return blad(400,'Podaj poprawną datę startu z ostatniego roku, nie późniejszą niż dzisiaj.');
     db.prepare('UPDATE kanaly_sprzedazy SET od_utc=? WHERE klucz=?').run(od,k);
    }
    // Brak pola w starym formularzu zachowuje bezpieczny stan pierwszej aktywacji.
    const tylkoOdczyt=b.decyzjaOdczytu==='1'?b.tylkoOdczyt==='tak':u.tylkoOdczyt??u.adresApi===SRODOWISKA_ERLI[0].adres;
    zapisz(k,{...u,aktywowano:true,tylkoOdczyt},s,a);blokada(k,tylkoOdczyt,a);
    db.prepare("UPDATE kanaly_sprzedazy SET autoryzacja='polaczone',pobieranie='wlaczone' WHERE klucz=?").run(k);
   }else if(op==='odczyt'){
    const tylkoOdczyt=b.tylkoOdczyt==='tak';zapisz(k,{...u,tylkoOdczyt},s,a);blokada(k,tylkoOdczyt||Boolean(u.kolizja),a);
   }else if(op==='pobieranie'){
    if(!['tak','nie'].includes(String(b.wlaczone)))return blad(400,'Wybierz stan pobierania.');
    if(b.wlaczone==='tak'&&(!u.sprawdzono||u.kolizja||r.autoryzacja!=='polaczone'))return blad(409,'Najpierw aktywuj sprawdzone połączenie.');
    db.prepare('UPDATE kanaly_sprzedazy SET pobieranie=? WHERE klucz=?').run(b.wlaczone==='tak'?'wlaczone':'wylaczone',k);
   }else if(op==='odlacz'){
    if(b.potwierdz!=='tak')return blad(400,'Potwierdź odłączenie sklepu.');
    zapisz(k,{...u,sprawdzono:false,kolizja:false},{},a);blokada(k,true,a);
    db.prepare("UPDATE kanaly_sprzedazy SET autoryzacja='odlaczone',pobieranie='wylaczone' WHERE klucz=?").run(k);
   }else return blad(400,'Nieznana operacja.');
   zmien(k,a,op);return {ok:true,klucz:k};
  });
 }
 return {lista,pobierz,operacja,blokadaUsuniecia,usun};
}
