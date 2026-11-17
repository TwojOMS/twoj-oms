// Cele ekranu Ustawienia → Łączność dla kanałów sprzedaży dodanych w konfiguratorze (i sklepów ERLI z pliku).
// Zasada: każdy połączony kanał z konfiguratora jest na liście — pod nazwą nadaną w panelu i adresem, z którym
// łączy się program. Adres bierzemy z bazy (adres sklepu, środowisko, ustawienia), NIGDY z ustawień klienta:
// te czytają klucze, a konto bez kluczy albo bez aplikacji rzucałoby wyjątek i zabierało cały ekran.
// Kanały z pliku (Woo, Allegro) ekran czyta jak dotąd z konfiguracji modułu (`config.sklepy`, `config.kanaly`).
import type {DatabaseSync} from 'node:sqlite';
import {TYPY_KANALOW,type TypKanaluZnany} from '../../domena/moduly-kanalow.ts';
import {HOSTY_ALLEGRO} from '../../oms/allegro/dcr.ts';
import {ADRES_API_ERLI} from './services/kanal-erli.ts';
import type {PolaczenieKanalu} from './kontrakty-allegro.ts';

export type CelKanalu={klucz:string;nazwa:string;url:string};
type Polaczenie=Pick<PolaczenieKanalu,'klucz'|'nazwa'|'srodowisko'|'zrodlo'|'autoryzacja'>;
type OpisLacznosci={
 /** Połączenia tego typu, które ekran ma sprawdzić (bez kanałów z pliku, które przychodzą z konfiguracji). */
 polaczenia:()=>readonly Polaczenie[];
 nazwa:(nazwa:string)=>string;
 /** Klucz celu — ten sam prefiks co dla kanałów z pliku, żeby wynik nie dublował się po przeniesieniu. */
 prefiks:string;
 adres:(k:Polaczenie)=>string;
};

/**
 * Opis dla KAŻDEGO typu z MODULY_KANALOW (Record po typie: nowy typ bez opisu = błąd `npm run typy`).
 * `lista(typ)` — połączenia z rejestru kanałów; `erli` — lista sklepów ERLI (plik + kreator, z ustawieniami).
 */
export function celeKanalowLacznosci(o:{
 db:DatabaseSync;
 lista:(typ:TypKanaluZnany)=>readonly PolaczenieKanalu[];
 erli:()=>readonly (Polaczenie&{ustawienia:Record<string,unknown>})[];
}):CelKanalu[] {
 const zPanelu=(typ:TypKanaluZnany)=>()=>o.lista(typ).filter(k=>k.zrodlo!=='env');
 const ustawieniaErli=new Map<string,Record<string,unknown>>();
 const OPISY:Record<TypKanaluZnany,OpisLacznosci>={
  woo:{polaczenia:zPanelu('woo'),prefiks:'sklep',nazwa:n=>`Sklep ${n}`,
   adres:k=>String((o.db.prepare('SELECT adres FROM kanaly_sklepy WHERE klucz=?').get(k.klucz) as {adres?:string}|undefined)?.adres??'')},
  allegro:{polaczenia:zPanelu('allegro'),prefiks:'allegro',nazwa:n=>`Allegro — ${n}`,
   adres:k=>HOSTY_ALLEGRO[k.srodowisko==='sandbox'?'sandbox':'produkcja'].api},
  // ERLI z pliku też tutaj — konfiguracja modułu nie ma dla nich osobnej mapy adresów.
  erli:{polaczenia:()=>o.erli().map(s=>{ustawieniaErli.set(s.klucz,s.ustawienia);return s;}),prefiks:'erli',nazwa:n=>`ERLI — ${n}`,
   adres:k=>{const a=ustawieniaErli.get(k.klucz)?.adresApi;return typeof a==='string'&&a?a:ADRES_API_ERLI;}},
 };
 const cele:CelKanalu[]=[];
 for(const typ of TYPY_KANALOW){
  const opis=OPISY[typ];
  for(const k of opis.polaczenia()){
   if(k.autoryzacja!=='polaczone')continue;
   cele.push({klucz:`${opis.prefiks}:${k.klucz}`,nazwa:opis.nazwa(k.nazwa),url:opis.adres(k)});
  }
 }
 return cele;
}
