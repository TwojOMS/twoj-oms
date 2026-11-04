import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {RepozytoriumKanalow} from '../repozytorium-kanalow.ts';
import type {RejestrKanalow} from './rejestr-kanalow.ts';
import {bladAllegro,type Aktor,type PolaczenieAllegro,type Wynik} from '../kontrakty-allegro.ts';

/** Lokalni kandydaci do sprawdzenia, bez HTTP i treści wiadomości. Nie dowodzą
 * niewykonania operacji w Allegro ani nie są obietnicą automatycznego wznowienia. */
function kandydaci(db:DatabaseSync,klucz:string){
 const ma=(t:string)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
 return {
  statusy:db.prepare('SELECT id,status_woo,status_realizacji,utworzone_at FROM zamowienia WHERE sklep=? AND sync_woo_blad IS NOT NULL ORDER BY id').all(klucz),
  faktury:ma('faktury')?db.prepare(`SELECT f.id,f.zamowienie_id,f.ksef_numer,f.allegro_invoice_id,f.allegro_weryfikacja
   FROM faktury f JOIN zamowienia z ON z.id=f.zamowienie_id WHERE z.sklep=? AND z.chce_fakture=1 AND f.numer IS NOT NULL AND f.allegro_wyslana_at IS NULL ORDER BY f.id`).all(klucz):[],
  przesylki:ma('przesylki')?db.prepare(`SELECT p.id,p.zamowienie_id,p.status,p.kolejnosc,p.id_przesylki_kuriera,p.numer_listu
   FROM przesylki p JOIN zamowienia z ON z.id=p.zamowienie_id WHERE z.sklep=? AND p.kurier='allegro_wza' AND p.status IN ('w_trakcie','do_wyjasnienia','blad') ORDER BY p.id`).all(klucz):[],
  podjazdy:ma('podjazdy')?db.prepare("SELECT id,stan,command_id,pickup_id FROM podjazdy WHERE kanal=? AND stan IN ('zarezerwowany','oczekuje','nieznany') ORDER BY id").all(klucz):[],
  wiadomosci:ma('allegro_watki')?db.prepare(`SELECT w.thread_id,w.last_message_date_time,w.ostatnia_od_kupujacego,w.typ,z.zamkniete_do
   FROM allegro_watki w LEFT JOIN allegro_zamkniecia z ON z.kanal=w.kanal AND z.thread_id=w.thread_id WHERE w.kanal=? ORDER BY w.thread_id`).all(klucz):[],
  odpowiedziNiepotwierdzone:ma('allegro_odpowiedzi')?db.prepare('SELECT id,thread_id,rodzaj,zapisany_at FROM allegro_odpowiedzi WHERE kanal=? AND wyslany_at IS NULL ORDER BY id').all(klucz):[],
 };
}
export function createPrzegladZapisowAllegro(o:{db:DatabaseSync;repozytorium:RepozytoriumKanalow;rejestr:RejestrKanalow;teraz?:()=>Date}){
 const teraz=o.teraz??(()=>new Date());
 type Proba={klucz:string;wersja:number;generacja:number;aktorId:number;sesjaId:string;skrot:string;wygasa:number};
 const proby=new Map<string,Proba>();
 const konflikt=()=>bladAllegro('konflikt','Lista operacji lub połączenie zostały zmienione. Otwórz przegląd ponownie.');
 const sprzataj=()=>{for(const [id,p]of proby)if(p.wygasa<=teraz().getTime())proby.delete(id);};
 const lista=(klucz:string)=>({kandydaci:kandydaci(o.db,klucz),niejednoznaczne:o.db.prepare("SELECT id,metoda,sciezka,stan FROM kanaly_operacje_niejednoznaczne WHERE kanal=? AND stan IN ('do_sprawdzenia','zablokowana') ORDER BY id").all(klucz)});
 const skrot=(l:ReturnType<typeof lista>)=>createHash('sha256').update(JSON.stringify(l)).digest('hex');
 function przygotuj(klucz:string,wersja:number,aktor:Aktor,sesjaId:string){
  sprzataj();const k=o.repozytorium.pobierz(klucz);
  if(!k||k.wersja!==wersja||k.autoryzacja!=='polaczone'||!sesjaId||o.repozytorium.konfliktKlucza(klucz))return konflikt();
  if(proby.size>=1000)return bladAllegro('tymczasowy','Zbyt wiele otwartych przeglądów. Spróbuj później.');
  const l=lista(klucz),id=randomUUID();
  proby.set(id,{klucz,wersja,generacja:k.generacja,aktorId:aktor.id,sesjaId,skrot:skrot(l),wygasa:teraz().getTime()+600000});
  return {ok:true as const,dane:{przegladId:id,wersja,klucz,...l}};
 }
 /** Operator wybiera blokady do zachowania. Zwolnienie nie wykonuje HTTP. */
 function zatwierdz(id:string,pozostawZablokowane:string[],aktor:Aktor,sesjaId:string):Wynik<PolaczenieAllegro>{
  sprzataj();const p=proby.get(id);
  if(!p||p.aktorId!==aktor.id||p.sesjaId!==sesjaId||!Array.isArray(pozostawZablokowane)||pozostawZablokowane.some(x=>typeof x!=='string'))return konflikt();
  return o.repozytorium.transakcja(()=>{
   const k=o.repozytorium.pobierz(p.klucz),l=lista(p.klucz);
   if(!k||k.wersja!==p.wersja||k.generacja!==p.generacja||k.autoryzacja!=='polaczone'||o.repozytorium.konfliktKlucza(p.klucz)||skrot(l)!==p.skrot||o.rejestr.czyTrwa(p.klucz,'calosc'))return konflikt();
   const ids=l.niejednoznaczne.map(x=>String(x.id)).sort();
   if(pozostawZablokowane.some(id=>!ids.includes(id)))return bladAllegro('walidacja','Wybrano operację spoza przeglądu.');
   const bezWiersza=k.zrodlo==='env'&&!o.db.prepare('SELECT 1 FROM kanaly_sprzedazy WHERE klucz=?').get(k.klucz);
   const z=bezWiersza?{ok:true as const,dane:k}:o.repozytorium.zapiszZmiane(p.klucz,p.wersja,{},aktor);if(!z.ok)return z;
   const pozostaw=new Set(pozostawZablokowane);
   for(const id of ids)o.db.prepare('UPDATE kanaly_operacje_niejednoznaczne SET stan=?,zmieniono_at=? WHERE kanal=? AND id=?').run(pozostaw.has(id)?'zablokowana':'zwolniona',teraz().toISOString(),p.klucz,id);
   o.db.prepare('UPDATE kanaly_blokady_zapisu SET zablokowane=0,aktor_id=?,aktor_login=?,zmieniono_at=? WHERE kanal=?').run(aktor.id,aktor.login,teraz().toISOString(),p.klucz);
   proby.delete(id);return z;
  });
 }
 return {przygotuj,zatwierdz};
}
