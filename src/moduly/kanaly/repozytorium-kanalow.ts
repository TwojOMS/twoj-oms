import type { DatabaseSync } from 'node:sqlite';
import {randomBytes,randomUUID} from 'node:crypto';
import type { DefinicjaKanalu } from './konfiguracja.ts';
import type { Aktor, AplikacjaKanalu, PolaczenieAllegro, PolaczenieKanalu, SrodowiskoAllegro, Wynik } from './kontrakty-allegro.ts';
import {czyTypKanalu,type TypKanaluZnany} from '../../domena/moduly-kanalow.ts';
import {bladAllegro} from './kontrakty-allegro.ts';
import {kontoZTokenu} from '../../domena/tozsamosc-kanalu.js';
import {wczytajTokeny} from '../../oms/db/tokeny.js';
import {UPRAWNIENIA} from '../../domena/woo-uprawnienia.js';

const autoryzacje = ['brak','oczekuje_potwierdzenia','polaczone','wymaga_autoryzacji','odlaczone'];
const pobierania = ['wylaczone','wlaczone','zatrzymywanie'];
const nazwaOk = (n:unknown):n is string => typeof n==='string' && [...n.trim()].length>0 && [...n.trim()].length<=80;
const dataOk = (d:unknown):d is string => typeof d==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(d) && Number.isFinite(Date.parse(d));
const aplikacjaOk = (a:unknown):a is AplikacjaKanalu => a===null || a==='device' || a==='dcr';
const adresOk = (a:unknown):a is string => typeof a==='string' && a.trim().length>0 && a.trim().length<=500;
const konflikt=()=>bladAllegro('konflikt','Połączenie zostało zmienione. Odśwież ekran.');
const adresZajety=()=>bladAllegro('konflikt','Ten adres sklepu jest już zapisany w OMS.');
// Bez migracji 0003 (bazy testów z samym 0001) kolumn typ/aplikacja nie ma — wiersz jest wtedy Allegro sprzed PRZ-132.
const typWiersza=(r:any):string=>r.typ??'allegro';
function dto(r:any):PolaczenieKanalu {
 return {klucz:r.klucz,typ:typWiersza(r) as TypKanaluZnany,aplikacja:r.aplikacja??null,nazwa:r.nazwa,srodowisko:r.srodowisko,zrodlo:r.zrodlo,kontoId:r.konto_id,login:r.login,raport:r.raport,
  autoryzacja:r.autoryzacja,pobieranie:r.pobieranie,odUtc:r.od_utc,wersja:Number(r.wersja),generacja:Number(r.generacja),generacjaImportu:Number(r.generacja_importu)};
}
export function createRepozytoriumKanalow(o: {db:DatabaseSync; definicjeEnv:readonly DefinicjaKanalu[]; konfiguracjaEnv:Record<string, any>; teraz?:()=>Date}) {
 const {db}=o;const teraz=o.teraz??(()=>new Date());
 const definicje=o.definicjeEnv.filter(d=>d.typ==='allegro');
 const rows=()=>db.prepare('SELECT * FROM kanaly_sprzedazy ORDER BY utworzono_at,klucz').all() as any[];
 const env=(d:DefinicjaKanalu):PolaczenieKanalu=>{
  const c=o.konfiguracjaEnv[d.klucz]??{};const t=wczytajTokeny(db,d.klucz);
  return {klucz:d.klucz,typ:'allegro',aplikacja:null,nazwa:d.etykieta??d.klucz,srodowisko:String(c.api??'').includes('allegrosandbox.pl')?'sandbox':'produkcja',zrodlo:'env',
   kontoId:kontoZTokenu(t?.access_token),login:null,raport:d.raport??d.klucz.toUpperCase(),
   autoryzacja:t?.refresh_token?'polaczone':'brak',pobieranie:'wlaczone',odUtc:c.od?(String(c.od).endsWith('Z')?c.od:c.od+'Z'):'',wersja:0,generacja:0,generacjaImportu:0};
 };
 // lista() zwraca tylko Allegro — zakładają to wszyscy dzisiejsi odbiorcy; inne typy daje listaTypu(typ).
 function lista():PolaczenieKanalu[] {
  const zapisane=rows().filter(r=>typWiersza(r)==='allegro');
  return [...definicje.map(d=>{
   const bazowy=env(d),r=zapisane.find(r=>r.klucz===d.klucz);
   if(!r)return bazowy;
   if(r.zrodlo!=='env'||r.srodowisko!==bazowy.srodowisko)return {...dto(r),autoryzacja:'wymaga_autoryzacji' as const,pobieranie:'wylaczone' as const};
   const overlay=dto(r);
   // Env ma pierwszeństwo techniczne, overlay zachowuje tylko jawne ustawienia operacyjne/tożsamość.
   return {...bazowy,...overlay,odUtc:bazowy.odUtc};
  }),...zapisane.filter(r=>!definicje.some(d=>d.klucz===r.klucz)).map(dto)];
 }
 function konfliktKlucza(klucz:string) {
  const r=rows().find(r=>r.klucz===klucz),d=definicje.find(d=>d.klucz===klucz);
  return Boolean(r && ((d && (r.zrodlo!=='env'||r.srodowisko!==env(d).srodowisko)) || (!d&&r.zrodlo==='env')));
 }
 const pobierz=(klucz:string)=>lista().find(k=>k.klucz===klucz)??null;
 // PRZ-157.00 (D9): typ połączenia dla modułu zamówienia — definicja env (każdy typ), potem wiersz panelu; nigdy prefiks.
 // Zamknięta baza (stara kompozycja w testach) = klucz nieznany, domena zostaje przy dawnym wyborze.
 const typyEnv=new Map<string,string>(o.definicjeEnv.map(d=>[d.klucz,d.typ]));
 // Trafienia z bazy w pamięci: typ klucza po wstawieniu się nie zmienia, a wołają nas pętle list i raportów.
 const typyBazy=new Map<string,string>();
 let zapytanieTypu:ReturnType<typeof db.prepare>|null=null;
 function typKanalu(klucz:string):string|null {
  const zEnv=typyEnv.get(klucz)??typyBazy.get(klucz);if(zEnv)return zEnv;
  if(!db.isOpen)return null;
  try {
   zapytanieTypu??=db.prepare('SELECT * FROM kanaly_sprzedazy WHERE klucz=?');
   const r=zapytanieTypu.get(klucz);if(!r)return null;
   const typ=typWiersza(r);typyBazy.set(klucz,typ);return typ;
  } catch {return null;} // domena („nigdy nie rzuca”) wraca wtedy do dawnego wyboru
 }
 function audit(k:PolaczenieKanalu,aktor:Aktor,operacja:string) {
  db.prepare('INSERT INTO kanaly_audit(kanal,operacja,wersja,aktor_id,aktor_login,zmieniono_at) VALUES (?,?,?,?,?,?)').run(k.klucz,operacja,k.wersja,aktor.id,aktor.login,teraz().toISOString());
 }
 function insert(k:PolaczenieKanalu,aktor:Aktor) {
  const at=teraz().toISOString();
  // typ i aplikacja tylko, gdy różne od wartości domyślnych kolumn — wiersz Allegro zapisuje się jak przed 0003.
  const dodatkowe:[string,string|null][]=[...(k.typ!=='allegro'?[['typ',k.typ] as [string,string]]:[]),...(k.aplikacja!==null?[['aplikacja',k.aplikacja] as [string,string]]:[])];
  db.prepare(`INSERT INTO kanaly_sprzedazy(klucz,nazwa,srodowisko,zrodlo,konto_id,login,raport,autoryzacja,pobieranie,od_utc,wersja,generacja,generacja_importu,utworzono_at,zmieniono_at,aktor_id,aktor_login${dodatkowe.map(([c])=>','+c).join('')})
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?${',?'.repeat(dodatkowe.length)})`).run(k.klucz,k.nazwa,k.srodowisko,k.zrodlo,k.kontoId,k.login,k.raport,k.autoryzacja,k.pobieranie,k.odUtc,k.wersja,k.generacja,k.generacjaImportu,at,at,aktor.id,aktor.login,...dodatkowe.map(([,v])=>v));
 }
 // Savepoint pozwala aktywacji złożyć zapis kanału i pary tokenów w jednej transakcji.
 function transakcja<T>(fn:()=>T):T {
  db.exec('SAVEPOINT kanal_zapis');
  try {const w=fn();db.exec('RELEASE kanal_zapis');return w;}catch(e){db.exec('ROLLBACK TO kanal_zapis; RELEASE kanal_zapis');throw e;}
 }
 function utworzSzkic(d:{nazwa:string;odUtc:string;srodowisko:SrodowiskoAllegro},aktor:Aktor):Wynik<PolaczenieAllegro> {
  if(!nazwaOk(d.nazwa)||!dataOk(d.odUtc)||!['produkcja','sandbox'].includes(d.srodowisko))return bladAllegro('walidacja','Podaj nazwę (1–80 znaków), środowisko i datę UTC.');
  const id=randomUUID().replaceAll('-','');
  const k:PolaczenieKanalu={klucz:'allegro_'+id,typ:'allegro',aplikacja:null,nazwa:d.nazwa.trim(),srodowisko:d.srodowisko,zrodlo:'panel',kontoId:null,login:null,raport:'ALLEGRO_'+id.toUpperCase(),autoryzacja:'brak',pobieranie:'wylaczone',odUtc:d.odUtc,wersja:1,generacja:0,generacjaImportu:0};
  return transakcja(()=>{insert(k,aktor);audit(k,aktor,'szkic');return {ok:true,dane:k};});
 }
 function zapiszZmiane(klucz:string,wersja:number,z:Partial<PolaczenieKanalu>,aktor:Aktor):Wynik<PolaczenieKanalu> {
  if(!Number.isSafeInteger(wersja)||wersja<0)return konflikt();
  if(Object.keys(z).some(k=>!['nazwa','kontoId','login','autoryzacja','pobieranie','aplikacja','odUtc'].includes(k)))return bladAllegro('walidacja','Nie można zmienić technicznej tożsamości kanału.');
  if(('aplikacja'in z&&!aplikacjaOk(z.aplikacja))||('odUtc'in z&&!dataOk(z.odUtc)))return bladAllegro('walidacja','Niepoprawne dane połączenia.');
  if(('nazwa'in z&&!nazwaOk(z.nazwa))||('autoryzacja'in z&&!autoryzacje.includes(z.autoryzacja!))||('pobieranie'in z&&!pobierania.includes(z.pobieranie!))
   ||('kontoId'in z&&z.kontoId!==null&&(typeof z.kontoId!=='string'||!/^\d{1,32}$/.test(z.kontoId)))||('login'in z&&z.login!==null&&(typeof z.login!=='string'||z.login.length>128)))return bladAllegro('walidacja','Niepoprawne dane połączenia.');
  try{return transakcja(()=>{
   const a=pobierz(klucz);if(!a||a.wersja!==wersja||konfliktKlucza(klucz))return konflikt();
   if(a.autoryzacja==='polaczone'&&'aplikacja'in z&&z.aplikacja!==a.aplikacja)return bladAllegro('konflikt','Najpierw odłącz konto Allegro, aby zmienić aplikację.');
   if(a.kontoId&&'kontoId'in z&&a.kontoId!==z.kontoId)return bladAllegro('konflikt','Kanał należy do innego konta Allegro.');
   // Data startu: z pliku konfiguracji wygrywa plik; z panelu zamrożona po pierwszym połączeniu albo imporcie.
   if('odUtc'in z&&a.zrodlo==='env')return bladAllegro('walidacja','Datę startu tego kanału ustawia administrator serwera (plik oms.env).');
   if('odUtc'in z&&(a.generacja!==0||a.generacjaImportu!==0))return bladAllegro('walidacja','Daty startu nie można zmienić po pierwszej aktywacji.');
   const b={...a,...z,nazwa:z.nazwa?.trim()??a.nazwa,wersja:a.wersja+1};
   if(b.kontoId&&lista().some(k=>k.klucz!==klucz&&k.srodowisko===b.srodowisko&&k.kontoId===b.kontoId))return bladAllegro('konflikt','To konto Allegro jest już zapisane w OMS.');
   const zamyka=b.autoryzacja==='odlaczone'&&a.autoryzacja!=='odlaczone';
   b.generacja=a.generacja+(zamyka||(b.autoryzacja==='polaczone'&&a.autoryzacja!=='polaczone')?1:0);
   b.generacjaImportu=a.generacjaImportu+(zamyka||b.pobieranie!==a.pobieranie?1:0);
   // Env zachowuje wybór pobierania do przywrócenia; dostęp blokuje autoryzacja.
   if(b.zrodlo!=='env'&&b.autoryzacja==='odlaczone'&&b.pobieranie==='wlaczone')b.pobieranie='wylaczone';
   if(a.zrodlo==='env'&&!rows().some(r=>r.klucz===klucz))insert(a,aktor);
   // od_utc i aplikacja tylko na jawne żądanie: wiersz env zachowuje zapisaną datę, baza bez 0003 nie zna kolumny aplikacja.
   const opcjonalne:[string,string|null][]=[...('odUtc'in z?[['od_utc',b.odUtc] as [string,string]]:[]),...('aplikacja'in z?[['aplikacja',b.aplikacja] as [string,string|null]]:[])];
   const zapis=db.prepare(`UPDATE kanaly_sprzedazy SET nazwa=?,konto_id=?,login=?,autoryzacja=?,pobieranie=?,wersja=?,generacja=?,generacja_importu=?,zmieniono_at=?,aktor_id=?,aktor_login=?${opcjonalne.map(([c])=>`,${c}=?`).join('')} WHERE klucz=? AND wersja=?`)
    .run(b.nazwa,b.kontoId,b.login,b.autoryzacja,b.pobieranie,b.wersja,b.generacja,b.generacjaImportu,teraz().toISOString(),aktor.id,aktor.login,...opcjonalne.map(([,v])=>v),klucz,wersja);
   if(!zapis.changes)return konflikt();
   audit(b,aktor,Object.keys(z).sort().join(',')||'potwierdzenie_zapisow');return {ok:true,dane:b};
  });}catch(e){if(String((e as Error).message).includes('UNIQUE constraint failed'))return bladAllegro('konflikt','To konto Allegro jest już zapisane w OMS.');throw e;}
 }
 function listaTypu(typ:TypKanaluZnany):PolaczenieKanalu[] {
  if(!czyTypKanalu(typ))return [];
  if(typ==='allegro')return lista();
  if(typ==='erli')return [...o.definicjeEnv.filter(d=>d.typ==='erli').map(d=>{
   const c=o.konfiguracjaEnv[d.klucz]??{};
   return {klucz:d.klucz,typ:'erli',aplikacja:null,nazwa:d.etykieta??d.klucz,srodowisko:String(c.adresApi).includes('sandbox.erli.dev')?'sandbox':'produkcja',zrodlo:'env',kontoId:null,login:null,raport:d.raport??d.klucz.toUpperCase(),autoryzacja:c.kluczApi?'polaczone':'brak',pobieranie:'wlaczone',odUtc:c.od??'',wersja:0,generacja:0,generacjaImportu:0} as PolaczenieKanalu;
  }),...rows().filter(r=>typWiersza(r)===typ&&!o.definicjeEnv.some(d=>d.klucz===r.klucz)).map(dto)];
  return rows().filter(r=>typWiersza(r)===typ).map(dto);
 }
 const wierszSklepu=(klucz:string)=>db.prepare("SELECT k.*,s.adres,s.ustawienia_json FROM kanaly_sprzedazy k JOIN kanaly_sklepy s ON s.klucz=k.klucz WHERE k.klucz=? AND k.typ='woo'").get(klucz) as any;
 // Sklep WooCommerce z panelu: wiersz kanału i wiersz kanaly_sklepy powstają razem albo wcale.
 function utworzSzkicSklepu(d:{nazwa:string;adres:string;odUtc:string;aktor:Aktor;uprawnienia?:'odczyt'|'zapis'}):Wynik<PolaczenieKanalu> {
  if(!nazwaOk(d.nazwa)||!adresOk(d.adres)||!dataOk(d.odUtc)||(d.uprawnienia!==undefined&&!UPRAWNIENIA.includes(d.uprawnienia)))return bladAllegro('walidacja','Podaj nazwę (1–80 znaków), adres sklepu i datę UTC.');
  const raporty=new Set(rows().map(r=>r.raport));
  let raport='';do raport='WOO_'+randomBytes(4).toString('hex').toUpperCase();while(raporty.has(raport));
  const k:PolaczenieKanalu={klucz:'woo_'+randomUUID().replaceAll('-',''),typ:'woo',aplikacja:null,nazwa:d.nazwa.trim(),srodowisko:'produkcja',zrodlo:'panel',kontoId:null,login:null,raport,autoryzacja:'brak',pobieranie:'wylaczone',odUtc:d.odUtc,wersja:1,generacja:0,generacjaImportu:0};
  try{return transakcja(()=>{
   insert(k,d.aktor);
   db.prepare('INSERT INTO kanaly_sklepy(klucz,adres,ustawienia_json,sprawdzono_at,zmieniono_at) VALUES (?,?,?,NULL,?)').run(k.klucz,d.adres.trim(),JSON.stringify(d.uprawnienia?{uprawnienia:d.uprawnienia}:{}),teraz().toISOString());
   audit(k,d.aktor,'szkic_sklepu');return {ok:true,dane:k};
  });}catch(e){if(String((e as Error).message).includes('UNIQUE constraint failed: kanaly_sklepy.adres'))return adresZajety();throw e;}
 }
 // Zmiana adresu, mapowania albo uprawnień klucza podnosi wersję i generację — klient i poller sklepu budują się od nowa.
 function zapiszSklep(klucz:string,z:{adres?:string;mapowanie?:unknown;uprawnienia?:'odczyt'|'zapis'},wersja:number,aktor:Aktor):Wynik<PolaczenieKanalu> {
  if(!Number.isSafeInteger(wersja)||wersja<0)return konflikt();
  const pola=Object.keys(z);
  if(!pola.length||pola.some(p=>!['adres','mapowanie','uprawnienia'].includes(p))||('adres'in z&&!adresOk(z.adres))
   ||('uprawnienia'in z&&!UPRAWNIENIA.includes(z.uprawnienia as string))
   ||('mapowanie'in z&&(typeof z.mapowanie!=='object'||z.mapowanie===null||Array.isArray(z.mapowanie))))return bladAllegro('walidacja','Niepoprawne dane sklepu.');
  try{return transakcja(()=>{
   const r=wierszSklepu(klucz);if(!r||Number(r.wersja)!==wersja)return konflikt();
   const ustawienia={...JSON.parse(r.ustawienia_json),...('mapowanie'in z?{mapowanie:z.mapowanie}:{}),...('uprawnienia'in z?{uprawnienia:z.uprawnienia}:{})};
   const at=teraz().toISOString();
   const zapis=db.prepare('UPDATE kanaly_sprzedazy SET wersja=wersja+1,generacja=generacja+1,zmieniono_at=?,aktor_id=?,aktor_login=? WHERE klucz=? AND wersja=?').run(at,aktor.id,aktor.login,klucz,wersja);
   if(!zapis.changes)return konflikt();
   db.prepare('UPDATE kanaly_sklepy SET adres=?,ustawienia_json=?,zmieniono_at=? WHERE klucz=?').run('adres'in z?z.adres!.trim():r.adres,JSON.stringify(ustawienia),at,klucz);
   const b=dto(wierszSklepu(klucz));audit(b,aktor,'sklep:'+pola.sort().join(','));return {ok:true,dane:b};
  });}catch(e){if(String((e as Error).message).includes('UNIQUE constraint failed: kanaly_sklepy.adres'))return adresZajety();throw e;}
 }
 function przywrocZKonfiguracji(klucz:string,wersja:number,aktor:Aktor):Wynik<PolaczenieKanalu>{
  return transakcja(()=>{
   const k=pobierz(klucz);
   if(!k||k.zrodlo!=='env')return bladAllegro('brak_dostepu','Przywracanie jest dostępne tylko dla kanału ustawionego przez administratora serwera.');
   if(k.wersja!==wersja||k.autoryzacja!=='odlaczone'||konfliktKlucza(klucz))return konflikt();
   const t=wczytajTokeny(db,klucz);
   if(!o.konfiguracjaEnv[klucz])return bladAllegro('walidacja','Brakuje konfiguracji kanału.');
   // Bez zachowanej pary wracamy do stanu przed zgodą — dalej prowadzi Device Flow.
   return zapiszZmiane(klucz,wersja,{autoryzacja:t?.access_token&&t?.refresh_token?'polaczone':'brak'},aktor);
  });
 }
 function zablokujZapisy(klucz:string,aktor:Aktor){
  db.prepare(`INSERT INTO kanaly_blokady_zapisu(kanal,zablokowane,aktor_id,aktor_login,zmieniono_at) VALUES (?,1,?,?,?)
   ON CONFLICT(kanal) DO UPDATE SET zablokowane=1,aktor_id=excluded.aktor_id,aktor_login=excluded.aktor_login,zmieniono_at=excluded.zmieniono_at`).run(klucz,aktor.id,aktor.login,teraz().toISOString());
 }
 const zapisyZablokowane=(klucz:string)=>Number(db.prepare('SELECT zablokowane FROM kanaly_blokady_zapisu WHERE kanal=?').get(klucz)?.zablokowane??0)===1;
 function zapiszNiejednoznaczne(klucz:string,operacje:{id:string;metoda:string;sciezka:string}[]){
  for(const p of operacje)db.prepare("INSERT OR IGNORE INTO kanaly_operacje_niejednoznaczne(id,kanal,metoda,sciezka,zmieniono_at) VALUES (?,?,?,?,?)").run(p.id,klucz,p.metoda,p.sciezka,teraz().toISOString());
 }
 const niejednoznaczne=(klucz:string)=>db.prepare("SELECT id,metoda,sciezka,stan FROM kanaly_operacje_niejednoznaczne WHERE kanal=? AND stan='do_sprawdzenia' ORDER BY id").all(klucz) as {id:string;metoda:string;sciezka:string;stan:string}[];
 const operacjaZablokowana=(klucz:string,metoda:string,sciezka:string)=>Boolean(db.prepare("SELECT 1 FROM kanaly_operacje_niejednoznaczne WHERE kanal=? AND metoda=? AND sciezka=? AND stan IN ('do_sprawdzenia','zablokowana') LIMIT 1").get(klucz,metoda,sciezka));
 return {lista,listaTypu,pobierz,typKanalu,utworzSzkic,utworzSzkicSklepu,zapiszSklep,zapiszZmiane,przywrocZKonfiguracji,transakcja,konfliktKlucza,zablokujZapisy,zapisyZablokowane,zapiszNiejednoznaczne,niejednoznaczne,operacjaZablokowana};
}
export type RepozytoriumKanalow=ReturnType<typeof createRepozytoriumKanalow>;
