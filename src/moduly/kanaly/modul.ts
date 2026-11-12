import type {ModulOms} from '../../core/kontrakty.ts';
import {konfiguracjaKanalow,type DefinicjaKanalu} from './konfiguracja.ts';
import {kluczeKanalu} from '../../integracje/klucze.js';
import {bladPolleraNaEkran} from '../../domena/zdrowie.js';
import {nieznaneKanalyZamowien} from '../../domena/moduly-kanalow.ts';
import {efektywnyTryb} from '../../core/tryb.ts';
import {registerTrasyAllegro} from './trasy-allegro.ts';
import {registerTrasyWoo} from './trasy-woo.ts';
import {registerTrasyErli} from './trasy-erli.ts';
import {createSklepyErli} from './services/sklepy-erli.ts';
import {createSklepyWoo} from './services/sklepy-woo.ts';
import {createWooClient} from '../../oms/woo/client.js';
import {klientSklepuPrzykladowego} from './services/atrapa-sklepu-przykladowego.ts';
import {migracjaKanalowSprzedazy} from './migracje/0001-kanaly-sprzedazy.ts';
import {migracjaDiagnostykiAllegro} from './migracje/0002-diagnostyka-allegro.ts';
import {migracjaTypuKanaluISklepow} from './migracje/0003-kanaly-typ-sklepy.ts';
import {zbudujUslugiKanalow,type OpcjeKompozycji} from './services/kompozycja-kanalow.ts';import {uwagaToruErli} from './services/kanal-erli.ts';
import {profilAllegroProby,type ProfilAllegroProby} from './straz-allegro-proby.ts';
export function createModulKanaly(definicje:readonly DefinicjaKanalu[],niekompletneJakoAlarm=false,o:OpcjeKompozycji={}):ModulOms<ReturnType<typeof konfiguracjaKanalow>>{
 let tryb:'produkcja'|'proba'='produkcja',profilAllegro:ProfilAllegroProby='bez-allegro';
 return {
  nazwa:'kanaly',wersja:'1.0.0',wymaga:['rdzen'],migracje:[migracjaKanalowSprzedazy,migracjaDiagnostykiAllegro,migracjaTypuKanaluISklepow],menu:[],uprawnienia:[],
  kluczeIntegracji:definicje.flatMap(d=>kluczeKanalu(d.typ,d.prefiks).kluczeIntegracji),
  konfiguracja:env=>{
   tryb=efektywnyTryb(env);profilAllegro=profilAllegroProby(env);
   if(o.autoryzacjaAtrapy&&efektywnyTryb(env)!=='proba')throw new Error('Atrapa autoryzacji Allegro jest dostępna wyłącznie w trybie próby.');
   return konfiguracjaKanalow(definicje,env,niekompletneJakoAlarm);
  },
  zbuduj:ctx=>{
   // PRZ-148.07: w trybie próby transport Allegro odmawia hosta poza jawnym profilem Sandbox. Wyjątek: atrapa
   // autoryzacji razem z wstrzykniętym transportem (cały ruch Allegro idzie do atrapy, nie do sieci).
   const atrapaAllegro=Boolean(o.autoryzacjaAtrapy&&o.fetchImpl);
   const przykladowySklep=(adres:string)=>Object.values(ctx.usluga<any>('kanaly','config').sklepy??{}).some((s:any)=>s?.atrapa===true&&s.baseUrl===adres);
   const opcje:OpcjeKompozycji={...o,...(tryb==='proba'?{
    // Rejestr tworzy klienta dopiero po zbudowaniu usług: regułę adresu sprawdzamy leniwie.
    klientWooZastepczy:d=>przykladowySklep(d.baseUrl)?klientSklepuPrzykladowego(d):null,
    ...(!atrapaAllegro?{strazAllegro:profilAllegro}:{}),
   }:{})};
   const uslugi=zbudujUslugiKanalow(ctx,definicje,opcje);
   const envSklepy=definicje.filter(d=>d.typ==='woo').map(d=>({klucz:d.klucz,nazwa:d.etykieta??d.klucz,adres:uslugi.config.sklepy[d.klucz]?.baseUrl??'',od:uslugi.config.sklepy[d.klucz]?.od??'',mapowanie:uslugi.config.sklepy[d.klucz]?.mapowanie??{instancje:{}}}));
   const sklepyWoo=createSklepyWoo({db:ctx.db,repozytorium:uslugi.repozytoriumKanalow,envSklepy,teraz:ctx.teraz,tryb,przykladowySklep,
    // PRZ-150.01: adres atrapy nie istnieje w sieci — w próbie kreator rozmawia ze sklepem przykładowym bez sieci.
    klient:d=>tryb==='proba'&&przykladowySklep(d.baseUrl)?klientSklepuPrzykladowego(d):createWooClient({...d,fetchImpl:o.fetchImpl,tylkoTenSamOrigin:true}),poAktywacji:k=>{
     let odbiorca:((kanal:typeof k)=>void)|undefined;
     try{odbiorca=ctx.usluga('raporty','poAktywacjiKanalu');}catch(e){if(!(e instanceof Error)||!e.message.includes('raporty.poAktywacjiKanalu')||!e.message.includes('nie istnieje'))throw e;}
     odbiorca?.(k);
    }});
   const sklepyErli=createSklepyErli({db:ctx.db,teraz:ctx.teraz,ustawieniaEnv:uslugi.config.erli??{},definicje:definicje.filter(d=>d.typ==='erli'),fetchImpl:o.fetchImpl});
   return {uslugi:{...uslugi,sklepyWoo,sklepyErli},
    zegary:[{nazwa:'poller',odstepMs:uslugi.config.odstepMs,przebieg:async()=>{try{await uslugi.poller.przebieg();}catch(e){ctx.log('poller:',e instanceof Error?e.message:String(e));}}}],
    zdrowie:()=>{
     const nieznane=nieznaneKanalyZamowien();
     // PRZ-157.00: zamówienie z kluczem spoza rejestru kanałów — obsłużone po staremu, ale widoczne w diagnostyce (sam klucz).
     const uwagaKanalow=nieznane.length?[`Zamówienia z kanałów spoza rejestru kanałów (${nieznane.slice(0,10).join(', ')}${nieznane.length>10?', …':''}) — obsługiwane jak dotąd: Allegro po kluczu, pozostałe jak sklep.`]:[];
     const stany=uslugi.poller.stany();
     const uwagiErli=stany.flatMap((s:any)=>{
      const tor=uwagaToruErli(s);
      // Stan uzgodnienia zawiera też odpowiedź API — pokazujemy wyłącznie chwilę przerwania.
      const chwila=typeof s?.uzgodnienie_blad==='string'?s.uzgodnienie_blad.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z(?=\s|$)/)?.[0]:null;
      return [...(tor?[tor]:[]),...(s?.uzgodnienie_blad?[`ERLI ${s.sklep}: uzgodnienie przerwane — ${chwila??'chwila nieznana'}`]:[])];
     });
     return {alarmy:[],uwagi:[...stany.filter((s:any)=>bladPolleraNaEkran(s)).map((s:any)=>String(s.ostatni_blad)),...uwagaKanalow,...uwagiErli]};
    },
    trasy:app=>{registerTrasyErli(app,sklepyErli,ctx.teraz);registerTrasyAllegro(app,uslugi,ctx.teraz,ctx.usluga);registerTrasyWoo(app,{db:ctx.db,repozytorium:uslugi.repozytoriumKanalow,sklepyWoo,envSklepy,teraz:ctx.teraz,tryb,config:()=>ctx.usluga<any>('kanaly','config')});},
   };
  },
 };
}
export const modulKanaly=createModulKanaly([]);
