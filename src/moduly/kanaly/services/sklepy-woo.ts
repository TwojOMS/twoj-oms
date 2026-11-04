import type {DatabaseSync} from 'node:sqlite';
import type {Aktor,PolaczenieKanalu,Wynik} from '../kontrakty-allegro.ts';
import {bladAllegro} from '../kontrakty-allegro.ts';
import type {createRepozytoriumKanalow} from '../repozytorium-kanalow.ts';
import {mapowanieSklepu,RAPORTY_ZASTRZEZONE} from '../konfiguracja.ts';
import {normalizujAdresSklepu} from '../adres-sklepu.ts';
import {poczatekDniaWarszawa,poprawnaDataStartu} from '../zakres-importu-allegro.ts';
import {wczytajKonfiguracjeIntegracji,zapiszKonfiguracjeIntegracji,usunKonfiguracjeIntegracji} from '../../../oms/db/konfiguracja-integracji.js';
import {MODULY_KURIEROW,type RejestrKurierow} from '../../../domena/moduly-kurierow.ts';
import {UPRAWNIENIA} from '../../../domena/woo-uprawnienia.js';

// PRZ-135 D5 (pieniądze): pobranie w mapowaniu Woo tylko przy metodach kurierów na NASZEJ umowie, które umieją pobranie
// (`pobranie !== 'brak'`: DPD 'umowa', InPost 'adapter'). WzA ma 'umowa', ale umowę platformy — sklep Woo jej nie nadaje.
const METODY_Z_POBRANIEM_WOO:ReadonlySet<unknown>=new Set(Object.values(MODULY_KURIEROW as RejestrKurierow).filter(o=>o.umowa==='wlasna'&&o.umiejetnosci.pobranie!=='brak').flatMap(o=>o.metody.map(m=>m.klucz)));

type EnvSklep={klucz:string;adres?:string;baseUrl?:string;raport?:string};
type Klient={sprawdzPolaczenie:()=>Promise<{ok:boolean;powod?:string}>;pobierzMetodyWysylki:()=>Promise<unknown>;pobierzBramkiPlatnosci:()=>Promise<unknown>};
export function createSklepyWoo(o:{db:DatabaseSync;repozytorium:ReturnType<typeof createRepozytoriumKanalow>;klient:(d:{baseUrl:string;ck:string;cs:string})=>Klient;envSklepy:readonly EnvSklep[];teraz?:()=>Date;tryb:string;przykladowySklep?:(adres:string)=>boolean;poAktywacji?:(k:PolaczenieKanalu)=>void}) {
 const {db,repozytorium:repo}=o,teraz=o.teraz??(()=>new Date());
 const env=(k:string)=>o.envSklepy.some(s=>s.klucz===k);
 const zPliku=()=>({ok:false as const,kod:'z_pliku' as const,komunikat:'Sklep jest ustawiony w pliku konfiguracji.'});
 const konflikt=()=>bladAllegro('konflikt','Połączenie zostało zmienione. Odśwież ekran.');
 const walidacja=(s:string)=>bladAllegro('walidacja',s);
 const blokadaPiaskownicy=(adres:string)=>o.tryb==='proba'&&!o.przykladowySklep?.(adres)?walidacja('Piaskownica nie łączy się z prawdziwymi sklepami — działa tu tylko sklep przykładowy.'):null;
 const sklep=(k:string)=>repo.listaTypu('woo').find(s=>s.klucz===k&&s.zrodlo==='panel');
 const daneSklepu=(k:string)=>db.prepare('SELECT adres,ustawienia_json,sprawdzono_at FROM kanaly_sklepy WHERE klucz=?').get(k) as {adres:string;ustawienia_json:string;sprawdzono_at:string|null}|undefined;
 const klucze=(k:string)=>wczytajKonfiguracjeIntegracji(db,'woo_klucze:'+k)?.sekrety;
 const sprawdzKlucze=(ck:unknown,cs:unknown):ck is string=>typeof ck==='string'&&!!ck.trim()&&ck.length<=500&&typeof cs==='string'&&!!cs.trim()&&cs.length<=500;
 function zmien(k:string,wersja:number,a:Aktor,z:Partial<PolaczenieKanalu>,operacja:string,zwiekszGeneracje=false):Wynik<PolaczenieKanalu> {
  const s=sklep(k);if(!s||s.wersja!==wersja)return konflikt();
  const n={...s,...z,wersja:s.wersja+1,generacja:s.generacja+(zwiekszGeneracje||z.autoryzacja!==undefined&&z.autoryzacja!==s.autoryzacja?1:0),generacjaImportu:s.generacjaImportu+(z.pobieranie!==undefined&&z.pobieranie!==s.pobieranie?1:0)};
  const at=teraz().toISOString();
  const w=db.prepare('UPDATE kanaly_sprzedazy SET nazwa=?,od_utc=?,autoryzacja=?,pobieranie=?,wersja=?,generacja=?,generacja_importu=?,zmieniono_at=?,aktor_id=?,aktor_login=? WHERE klucz=? AND typ=? AND wersja=?').run(n.nazwa,n.odUtc,n.autoryzacja,n.pobieranie,n.wersja,n.generacja,n.generacjaImportu,at,a.id,a.login,k,'woo',wersja);
  if(!w.changes)return konflikt();
  db.prepare('INSERT INTO kanaly_audit(kanal,operacja,wersja,aktor_id,aktor_login,zmieniono_at) VALUES (?,?,?,?,?,?)').run(k,operacja,n.wersja,a.id,a.login,at);
  return {ok:true,dane:n};
 }
 function utworzSzkic(d:{nazwa:string;adres:string;ck:string;cs:string;od:string;uprawnienia?:unknown},a:Aktor){
  const adres=normalizujAdresSklepu(d.adres,o.tryb),od=poczatekDniaWarszawa(d.od);
  if(!adres||!od||!poprawnaDataStartu(od,teraz())||!sprawdzKlucze(d.ck,d.cs))return walidacja('Podaj poprawny adres, klucze i datę startu.');
  // PRZ-149.04: brak wyboru = dawne zachowanie (Zapis/odczyt); nieznana wartość to błąd formularza.
  if(d.uprawnienia!==undefined&&!UPRAWNIENIA.includes(d.uprawnienia as string))return walidacja('Wybierz uprawnienia klucza.');
  const uprawnienia=d.uprawnienia as 'odczyt'|'zapis'|undefined;
  const blokada=blokadaPiaskownicy(adres);if(blokada)return blokada;
  if(o.envSklepy.some(s=>normalizujAdresSklepu(s.adres??s.baseUrl,'proba')?.replace(/^https?:\/\//,'')===adres.replace(/^https?:\/\//,'')))return bladAllegro('konflikt','Ten sklep jest już w pliku konfiguracji.');
  const kolizja=Symbol('kolizja raportu');
  for(let proba=0;proba<20;proba++)try{return repo.transakcja(()=>{
   const w=repo.utworzSzkicSklepu({nazwa:d.nazwa,adres,odUtc:od,aktor:a,...(uprawnienia?{uprawnienia}:{})});if(!w.ok)return w;
   if(RAPORTY_ZASTRZEZONE.includes(w.dane.raport)||o.envSklepy.some(s=>(s.raport??s.klucz.toUpperCase())===w.dane.raport))throw kolizja;
   zapiszKonfiguracjeIntegracji(db,'woo_klucze:'+w.dane.klucz,{ustawienia:{},sekrety:{ck:d.ck.trim(),cs:d.cs.trim()}},{teraz:teraz()});return w;
  });}catch(e){if(e!==kolizja)throw e;}
  return bladAllegro('konflikt','Nie udało się przydzielić identyfikatora raportu. Spróbuj ponownie.');
 }
 const komunikatSprawdzenia=(powod?:string)=>({klucze:'Sklep odrzucił klucze. Sprawdź, czy skopiowałeś oba i czy klucz ma uprawnienie „Zapis/odczyt”.',siec:'Sklep nie odpowiada. Sprawdź, czy działa, i spróbuj ponownie za chwilę.',adres:'Nie udało się odnaleźć sklepu. Sprawdź adres sklepu i popraw ewentualną literówkę.',brak_api:'Pod tym adresem nie znaleziono API WooCommerce. Sprawdź, czy WooCommerce jest włączone i czy adres prowadzi do sklepu.',certyfikat:'Sklep ma nieważny lub niezaufany certyfikat HTTPS. Sprawdź certyfikat sklepu (np. czy nie wygasł) i spróbuj ponownie.',przekierowanie:'Adres przekierowuje na inną stronę. Wpisz adres, pod którym sklep działa naprawdę (np. z www albo https).'} as Record<string,string>)[powod??'']??'Nie udało się połączyć ze sklepem.';
 // PRZ-134.PT8: klucze nowego sklepu sprawdzane PRZED zapisem — odrzucone nie zostawiają szkicu, którego adres blokował ponowne dodanie.
 async function sprawdzNowe(d:{adres:string;ck:string;cs:string}){
  const adres=normalizujAdresSklepu(d.adres,o.tryb);if(!adres||!sprawdzKlucze(d.ck,d.cs))return walidacja('Podaj poprawny adres i oba klucze REST.');
  const blokada=blokadaPiaskownicy(adres);if(blokada)return blokada;
  try{const w=await o.klient({baseUrl:adres,ck:d.ck.trim(),cs:d.cs.trim()}).sprawdzPolaczenie();return w.ok?{ok:true as const,dane:null}:bladAllegro('tymczasowy',komunikatSprawdzenia(w.powod));}
  catch{return bladAllegro('tymczasowy',komunikatSprawdzenia());}
 }
 async function sprawdz(k:string){
  if(env(k))return zPliku();const s=sklep(k),d=daneSklepu(k),sekrety=klucze(k);if(!s||!d||!sekrety)return konflikt();
  const blokada=blokadaPiaskownicy(d.adres);if(blokada)return blokada;
  try{const w=await o.klient({baseUrl:d.adres,ck:sekrety.ck,cs:sekrety.cs}).sprawdzPolaczenie();
   if(sklep(k)?.wersja!==s.wersja)return konflikt();
   if(!w.ok){db.prepare('UPDATE kanaly_sklepy SET sprawdzono_at=NULL WHERE klucz=?').run(k);return bladAllegro('tymczasowy',komunikatSprawdzenia(w.powod));}
   const at=teraz().toISOString();db.prepare('UPDATE kanaly_sklepy SET sprawdzono_at=? WHERE klucz=?').run(at,k);return {ok:true as const,dane:{sprawdzonoAt:at}};
  }catch{return bladAllegro('tymczasowy','Nie udało się połączyć ze sklepem.');}
 }
 async function metodyWysylki(k:string){
  if(env(k))return zPliku();const d=daneSklepu(k),s=klucze(k);if(!sklep(k)||!d||!s)return konflikt();
  const blokada=blokadaPiaskownicy(d.adres);if(blokada)return blokada;
  const kl=o.klient({baseUrl:d.adres,ck:s.ck,cs:s.cs});let metody:unknown;try{metody=await kl.pobierzMetodyWysylki();}catch{return bladAllegro('tymczasowy','Nie udało się pobrać metod wysyłki.');}let bramki:unknown=null;try{bramki=await kl.pobierzBramkiPlatnosci();if(!Array.isArray(bramki))bramki=null;}catch{bramki=null;}return {ok:true as const,dane:{metody,mapowanie:JSON.parse(d.ustawienia_json).mapowanie??{instancje:{},poPozycji:[]},bramki,bladBramek:bramki===null?'Nie udało się odczytać bramek płatności ze sklepu.':null}};
 }
 // PRZ-134 D5: zapis z panelu = decyzja o pobraniu; wzór i limit bramek sprawdza mapowanieSklepu (konfiguracja.ts)
 function zapiszMapowanie(k:string,d:{instancje:unknown;bramkiPobrania:unknown},wersja:number,a:Aktor){if(env(k))return zPliku();const i=d?.instancje,b=d?.bramkiPobrania;if(!i||typeof i!=='object'||Array.isArray(i)||Object.keys(i).length>50)return walidacja('Niepoprawne mapowanie wysyłki.');
  if(!Array.isArray(b)||new Set(b).size!==b.length)return walidacja('Niepoprawna lista bramek płatności za pobraniem.');
  // PRZ-134.03k: ten sam wzór i limit co mapowanieSklepu (konfiguracja.ts) — tu z komunikatem, który mówi, co poprawić
  if(b.length>20)return walidacja('Za dużo bramek płatności za pobraniem — najwyżej 20.');
  const zla=b.find(x=>typeof x!=='string'||!/^[A-Za-z0-9_.:-]{1,64}$/.test(x));if(zla!==undefined)return walidacja(`Niepoprawny identyfikator bramki „${String(zla).slice(0,64)}” — dozwolone litery łacińskie, cyfry i znaki _ . : - (do 64 znaków), np. cod.`);
  const wpisy=Object.values(i) as {metoda?:unknown;pobranie?:unknown}[];let zPobraniem=0;
  for(const m of wpisy){if(!m||typeof m!=='object'||!('pobranie'in m))continue;if(m.pobranie!==true)return walidacja('Niepoprawne mapowanie wysyłki.');
   if(m.metoda==='odbior_osobisty')return walidacja('Odbiór osobisty i pobranie wykluczają się — pobranie inkasuje kurier, a przy odbiorze osobistym kuriera nie ma.');
   if(!METODY_Z_POBRANIEM_WOO.has(m.metoda))return walidacja('Pobranie można zaznaczyć tylko przy kurierze DPD albo paczkomacie InPost.');zPobraniem++;}
  if(zPobraniem&&!b.length)return walidacja('Zaznaczono metodę wysyłki za pobraniem, ale żadnej bramki płatności za pobraniem. Zaznacz bramkę (np. cod) albo odznacz pobranie przy metodzie.');
  try{const tekst=JSON.stringify({instancje:i,poPozycji:[],bramkiPobrania:b});if(tekst.length>16384)return walidacja('Niepoprawne mapowanie wysyłki.');const mapowanie=mapowanieSklepu(tekst,'Mapowanie');
   return repo.transakcja(()=>{const w=repo.zapiszSklep(k,{mapowanie},wersja,a);if(w.ok)db.prepare('INSERT INTO kanaly_audit(kanal,operacja,wersja,aktor_id,aktor_login,zmieniono_at) VALUES (?,?,?,?,?,?)').run(k,`mapowanie_pobrania:bramki=${b.length},instancje_pobranie=${zPobraniem}`,w.dane.wersja,a.id,a.login,teraz().toISOString());return w;});
  }catch{return walidacja('Niepoprawne mapowanie wysyłki.');}}
 // PRZ-149.04: „Jakie uprawnienia ma klucz?” z kroku 2 — w ustawienia_json, bez migracji; generacja rośnie, więc klient
 // sklepu buduje się od nowa i od razu odmawia (albo znów wysyła) zapisy.
 function ustawUprawnienia(k:string,u:unknown,wersja:number,a:Aktor){if(env(k))return zPliku();if(!UPRAWNIENIA.includes(u as string))return walidacja('Wybierz uprawnienia klucza.');
  return repo.transakcja(()=>repo.zapiszSklep(k,{uprawnienia:u as 'odczyt'|'zapis'},wersja,a));}
 function zmienKlucze(k:string,d:{ck:string;cs:string},wersja:number,a:Aktor){if(env(k))return zPliku();if(!sprawdzKlucze(d?.ck,d?.cs))return walidacja('Podaj oba klucze REST.');return repo.transakcja(()=>{const w=zmien(k,wersja,a,{autoryzacja:'brak',pobieranie:'wylaczone'},'klucze_sklepu',true);if(w.ok){zapiszKonfiguracjeIntegracji(db,'woo_klucze:'+k,{ustawienia:{},sekrety:{ck:d.ck.trim(),cs:d.cs.trim()}},{teraz:teraz()});db.prepare('UPDATE kanaly_sklepy SET sprawdzono_at=NULL WHERE klucz=?').run(k);}return w;});}
 function aktywuj(k:string,wersja:number,a:Aktor){if(env(k))return zPliku();return repo.transakcja(()=>{const ds=daneSklepu(k);if(!ds?.sprawdzono_at||!klucze(k))return walidacja('Najpierw sprawdź połączenie ze sklepem.');if(!Array.isArray(JSON.parse(ds.ustawienia_json).mapowanie?.bramkiPobrania))return walidacja('Najpierw zapisz krok 3 „Metody wysyłki”: zaznacz bramki płatności za pobraniem (albo żadnej, jeśli sklep nie sprzedaje za pobraniem) i kliknij „Zapisz mapowanie”.');const w=zmien(k,wersja,a,{autoryzacja:'polaczone',pobieranie:'wlaczone'},'aktywacja_sklepu');if(w.ok)o.poAktywacji?.(w.dane);return w;});}
 function ustawPobieranie(k:string,wlaczone:boolean,wersja:number,a:Aktor){if(env(k))return zPliku();if(typeof wlaczone!=='boolean')return walidacja('Wybierz stan pobierania.');if(sklep(k)?.autoryzacja!=='polaczone')return bladAllegro('odlaczone','Najpierw połącz sklep.');return repo.transakcja(()=>zmien(k,wersja,a,{pobieranie:wlaczone?'wlaczone':'wylaczone'},'pobieranie_sklepu'));}
 function zmienNazwe(k:string,nazwa:string,wersja:number,a:Aktor){if(env(k))return zPliku();if(typeof nazwa!=='string'||![...nazwa.trim()].length||[...nazwa.trim()].length>80)return walidacja('Podaj nazwę sklepu.');return repo.transakcja(()=>zmien(k,wersja,a,{nazwa:nazwa.trim()},'nazwa_sklepu'));}
 function ustawDateStartu(k:string,od:string,wersja:number,a:Aktor){if(env(k))return zPliku();const s=sklep(k),data=poczatekDniaWarszawa(od);if(!s||s.wersja!==wersja)return konflikt();if(s.generacjaImportu>0||!data||!poprawnaDataStartu(data,teraz()))return walidacja('Nie można ustawić tej daty startu.');return repo.transakcja(()=>zmien(k,wersja,a,{odUtc:data},'data_sklepu'));}
 function odlacz(k:string,wersja:number,a:Aktor){if(env(k))return zPliku();return repo.transakcja(()=>{const w=zmien(k,wersja,a,{autoryzacja:'odlaczone',pobieranie:'wylaczone'},'odlaczenie_sklepu');if(w.ok){usunKonfiguracjeIntegracji(db,'woo_klucze:'+k);db.prepare('UPDATE kanaly_sklepy SET sprawdzono_at=NULL WHERE klucz=?').run(k);}return w;});}
 // PRZ-134.PT9: usunąć wolno tylko szkic z panelu, z którego OMS niczego nie pobrał — inaczej zostaje odłączenie.
 const POBRANE='Sklep ma już pobrane zamówienia — możesz go tylko odłączyć.';
 function blokadaUsuniecia(k:string):string|null{
  if(env(k))return zPliku().komunikat;const s=sklep(k);if(!s)return 'Nie znaleziono sklepu. Odśwież ekran.';
  if(s.autoryzacja==='polaczone')return 'Najpierw odłącz sklep, potem go usuń.';
  // Blokują tylko prawdziwe dane; sama aktywacja (generacja_importu, stan pollera) nie — inaczej adres zostaje zajęty na zawsze.
  const jest=(sql:string)=>Boolean(db.prepare(sql).get(k));
  if(jest('SELECT 1 FROM zamowienia WHERE sklep=? LIMIT 1'))return POBRANE;
  if(jest('SELECT 1 FROM stan_importu_sklepu WHERE sklep=?')||jest('SELECT 1 FROM produkty_sklepowe WHERE kanal=? LIMIT 1'))return POBRANE;
  return null;
 }
 function usun(k:string,wersja:number,a:Aktor){
  if(env(k))return zPliku();
  return repo.transakcja(():Wynik<{klucz:string}>=>{
   const s=sklep(k);if(!s||s.wersja!==wersja)return konflikt();
   const b=blokadaUsuniecia(k);if(b)return bladAllegro('konflikt',b);
   for(const sql of ['DELETE FROM stan_pollera WHERE sklep=?','DELETE FROM kanaly_blokady_zapisu WHERE kanal=?','DELETE FROM kanaly_operacje_niejednoznaczne WHERE kanal=?','DELETE FROM kanaly_sklepy WHERE klucz=?'])db.prepare(sql).run(k);
   usunKonfiguracjeIntegracji(db,'woo_klucze:'+k);
   // Granica „bez historii” z aktywacji jest kluczowana raportem tego sklepu (WOO_xxxx); sklep bez zamówień nie ma historii, którą by opisywała.
   db.prepare('DELETE FROM granice_historii WHERE kanal=?').run(s.raport);
   if(!db.prepare('DELETE FROM kanaly_sprzedazy WHERE klucz=? AND typ=? AND wersja=?').run(k,'woo',wersja).changes)throw new Error('usuniecie_sklepu');
   db.prepare('INSERT INTO kanaly_audit(kanal,operacja,wersja,aktor_id,aktor_login,zmieniono_at) VALUES (?,?,?,?,?,?)').run(k,'usuniecie_sklepu',wersja+1,a.id,a.login,teraz().toISOString());
   return {ok:true as const,dane:{klucz:k}};
  });
 }
 return {utworzSzkic,sprawdzNowe,sprawdz,metodyWysylki,zapiszMapowanie,ustawUprawnienia,zmienKlucze,aktywuj,ustawPobieranie,zmienNazwe,ustawDateStartu,odlacz,blokadaUsuniecia,usun};
}
