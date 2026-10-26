import type { ModulOms } from '../../core/kontrakty.ts';
import { konfiguracjaZamowien } from './konfiguracja.ts';
import { ustawKanalIndywidualnyStatusow } from '../../oms/db/statusy.js';
import { createKontekstZamowien } from './kontekst.js';
import { registerListaRoutes } from './lista.js';
import { registerKartaRoutes } from './karta.js';
import { registerReczneRoutes } from './reczne.js'; import { registerScalanieRoutes } from './scalanie.js';
import { miniaturyEkranu } from './wspolne.js';
import * as zapytania from '../../oms/db/zamowienia.js';
import { createSyncSklep } from './services/sync-sklep.js';
import { zegarPonawianiaStatusow } from './zegary.ts';
import { createGusClient } from '../../oms/gus/client.js';
import { integracje } from '../../integracje/klucze.js';
import { migracjaStatusowWlasnych } from './migracje/0002-statusy-wlasne.ts';
import { migracjaIndeksuListy } from './migracje/0001-indeks-listy.ts';
import { migracjaScalen } from './migracje/0003-scalenia.ts';
import { efektywnyTryb } from '../../core/tryb.ts';
import { zrodloAdresuFirmy } from '../../oms/db/adres-firmy.js';
import { zrodloNipuIBdoFirmy } from '../../oms/db/nip-bdo-firmy.js';
import { wczytajKonfiguracjeIntegracji } from '../../oms/db/konfiguracja-integracji.js';
import { uslugaGus, odmowaGusWProbie } from './gus-ustawien.ts';
import { registerUstawieniaGusRoutes } from './ustawienia-gus.js';
// PRZ-083: `fabryki.createGusClient` — atrapa GUS piaskownicy i demo (deploy/proba/atrapy/gus.mjs), jak fabryki inFaktu
// i VIES w module faktur. Poza OMS_TRYB=proba odmowa już przy konfiguracji.
export function createModulZamowienia({ zWiadomosciami = false, fabryki = {} as { createGusClient?: (opcje?: { klucz: string; url: string }) => any } } = {}): ModulOms<ReturnType<typeof konfiguracjaZamowien>> { return {
  nazwa:'zamowienia',wersja:'1.0.0',wymaga:['rdzen','web','kanaly','faktury',...(zWiadomosciami?['wiadomosci']:[])],migracje:[migracjaIndeksuListy,migracjaStatusowWlasnych,migracjaScalen],
  uprawnienia:[{klucz:'zamowienia',etykieta:'Zamówienia',role:['admin','operator']}],
  menu:[{dzial:'sprzedaz',grupa:'obsluga',etykieta:'Zamówienia',adres:'/',uprawnienie:'zamowienia',kolejnosc:10}],
  konfiguracja:env=>{
    if(fabryki.createGusClient&&efektywnyTryb(env)!=='proba')throw new Error('Fabryka createGusClient (atrapa GUS piaskownicy) wolno podać tylko w trybie próby (OMS_TRYB=proba)');
    return konfiguracjaZamowien(env);
  },
  kluczeIntegracji: integracje.gus.kluczeIntegracji,
  zbuduj:ctx=>{
    ustawKanalIndywidualnyStatusow(ctx.db, ctx.konfiguracja.kanalIndywidualny);
    let kontekst:ReturnType<typeof createKontekstZamowien>|undefined;
    const klienci=ctx.usluga<Record<string,any>>('kanaly','klienciSklepow');
    const klienciKanalow=ctx.usluga<Record<string,any>>('kanaly','klienciKanalow');
    const syncSklep=Object.keys(klienci).length||Object.keys(klienciKanalow).length?createSyncSklep({db:ctx.db,klienci,klienciKanalow}):null;
    // PRZ-102.11: usługa GUS z bieżącej konfiguracji (plik → atrapa piaskownicy → Ustawienia → brak), pytana przy
    // każdym żądaniu — klucz zapisany w Ustawienia → Integracje → GUS działa bez restartu (gus-ustawien.ts).
    const gus=uslugaGus({
      zPliku:!fabryki.createGusClient&&ctx.konfiguracja.gus?createGusClient(ctx.konfiguracja.gus):null,
      atrapa:fabryki.createGusClient?fabryki.createGusClient():null,
      wczytaj:()=>wczytajKonfiguracjeIntegracji(ctx.db,'gus'),
      fabryka:fabryki.createGusClient??(ctx.konfiguracja.proba?odmowaGusWProbie:(o:{klucz:string;url:string})=>createGusClient(o)),
      adres:ctx.konfiguracja.gusAdres,
    });
    // PRZ-093.08: sprzedawca specyfikacji — plik albo Ustawienia → Firma (czytane przy każdym dokumencie).
    const adresFirmy=zrodloAdresuFirmy({db:ctx.db,zPliku:ctx.konfiguracja.nadawca});
    // PRZ-108.10: NIP i BDO specyfikacji — plik albo Ustawienia → Firma (każde pole osobno, czytane przy każdym dokumencie).
    const nipBdoFirmy=zrodloNipuIBdoFirmy({db:ctx.db,zPliku:ctx.konfiguracja.proforma});
    const opcje = {db:ctx.db,config:{...ctx.usluga<object>('kanaly','config'),...ctx.konfiguracja,adresFirmy:adresFirmy.adres,nipBdoFirmy:nipBdoFirmy.biezacy},
      poller:ctx.usluga('kanaly','poller'),stanyKanalow:ctx.usluga('kanaly','stanyKanalow'),
      // Pełny skład pobiera pocztę z jedynego modułu wiadomości podczas rejestracji tras.
      wiadomosci:null,gus,syncSklep,zdrowie:null,
    };
    // PRZ-117: status po chwilowej awarii kanału/sklepu wraca sam (zegary.ts).
    const zegary=syncSklep?[zegarPonawianiaStatusow({sync:syncSklep,teraz:ctx.teraz,log:ctx.log})]:[];
    return {zegary,uslugi:{config:opcje.config,zapytania,miniaturyEkranu,opcjeTras:opcje,syncSklep,gus,konfiguracjaGus:gus,
      wczytajListe:(...a:Parameters<ReturnType<typeof createKontekstZamowien>['wczytajListe']>)=>{if(!kontekst)throw new Error('Trasy zamówień nie zostały jeszcze złożone');return kontekst.wczytajListe(...a);}},
      trasy:app=>{
        kontekst=createKontekstZamowien({...ctx.usluga<object>('zamowienia','opcjeTras'),
          zdrowie:()=>{
            let odczyt:()=>unknown;
            try{odczyt=ctx.usluga<()=>unknown>('zdrowie','zdrowie');}
            catch(e){
              if(e instanceof Error&&e.message==='Usługa „zdrowie.zdrowie" nie istnieje albo moduł „zdrowie" nie jest zbudowany przed wołającym')return null;
              throw e;
            }
            return odczyt();
          },
          ...(zWiadomosciami?{wiadomosci:ctx.usluga('wiadomosci','wiadomosci')}:{}),
          nadanie:ctx.usluga('wysylka','nadanie'),kurierzy:ctx.usluga('wysylka','kurierzy'),przesylkiAllegro:ctx.usluga('wysylka','przesylkiAllegro'),
          // PRZ-102.11: GUS jak inne usługi — z rejestru (nadpisanie `zamowienia.gus` w testach), nie z kopii opcji.
          gus:ctx.usluga('zamowienia','gus'),
          faktura:ctx.usluga('faktury','faktura'),proforma:ctx.usluga('faktury','proforma'),
          fakturaAllegro:ctx.usluga('faktury','fakturaAllegro'),fakturaHurtem:ctx.usluga('faktury','fakturaHurtem'),doczytanieKsef:ctx.usluga('faktury','doczytanieKsef'),
          // PRZ-102.23: przycisk „Wyślij do KSeF” na karcie — tylko gdy jest usługa, do której prowadzi podgląd.
          wysylkaKsef:ctx.usluga('faktury','wysylkaKsef'),
        });
        registerListaRoutes(app,kontekst);registerKartaRoutes(app,kontekst);registerReczneRoutes(app,kontekst);registerScalanieRoutes(app,kontekst);
        // PRZ-102.11: Ustawienia → Integracje → GUS (wzór: ekrany kurierów i inFaktu). Usługa nie z nadpisań `gus`
        // (testy podmieniają tam samego klienta), tylko ta złożona wyżej.
        registerUstawieniaGusRoutes(app,{db:ctx.db,konfiguracjaGus:ctx.usluga('zamowienia','konfiguracjaGus')});
      },
    };
  },
}; }
export const modulZamowienia = createModulZamowienia();
