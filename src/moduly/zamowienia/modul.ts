import type { ModulOms } from '../../core/kontrakty.ts';
import { konfiguracjaZamowien } from './konfiguracja.ts';
import { createKontekstZamowien } from './kontekst.js';
import { registerListaRoutes } from './lista.js';
import { registerKartaRoutes } from './karta.js';
import { registerReczneRoutes } from './reczne.js';
import { miniaturyEkranu } from './wspolne.js';
import * as zapytania from '../../oms/db/zamowienia.js';
import { createSyncSklep } from './services/sync-sklep.js';
import { createGusClient } from '../../oms/gus/client.js';
import { integracje } from '../../integracje/klucze.js';
import { migracjaIndeksuListy } from './migracje/0001-indeks-listy.ts';
import { efektywnyTryb } from '../../core/tryb.ts';
import { zrodloAdresuFirmy } from '../../oms/db/adres-firmy.js';
// PRZ-083: `fabryki.createGusClient` — atrapa GUS piaskownicy i demo (deploy/proba/atrapy/gus.mjs), jak fabryki inFaktu
// i VIES w module faktur. Poza OMS_TRYB=proba odmowa już przy konfiguracji.
export function createModulZamowienia({ zWiadomosciami = false, fabryki = {} as { createGusClient?: () => any } } = {}): ModulOms<ReturnType<typeof konfiguracjaZamowien>> { return {
  nazwa:'zamowienia',wersja:'1.0.0',wymaga:['rdzen','web','kanaly','faktury',...(zWiadomosciami?['wiadomosci']:[])],migracje:[migracjaIndeksuListy],
  uprawnienia:[{klucz:'zamowienia',etykieta:'Zamówienia',role:['admin','operator']}],
  menu:[{dzial:'sprzedaz',grupa:'obsluga',etykieta:'Zamówienia',adres:'/',uprawnienie:'zamowienia',kolejnosc:10}],
  konfiguracja:env=>{
    if(fabryki.createGusClient&&efektywnyTryb(env)!=='proba')throw new Error('Fabryka createGusClient (atrapa GUS piaskownicy) wolno podać tylko w trybie próby (OMS_TRYB=proba)');
    return konfiguracjaZamowien(env);
  },
  kluczeIntegracji: integracje.gus.kluczeIntegracji,
  zbuduj:ctx=>{
    let kontekst:ReturnType<typeof createKontekstZamowien>|undefined;
    const klienci=ctx.usluga<Record<string,any>>('kanaly','klienciSklepow');
    const klienciKanalow=ctx.usluga<Record<string,any>>('kanaly','klienciKanalow');
    const syncSklep=Object.keys(klienci).length||Object.keys(klienciKanalow).length?createSyncSklep({db:ctx.db,klienci,klienciKanalow}):null;
    const gus=fabryki.createGusClient?fabryki.createGusClient():ctx.konfiguracja.gus?createGusClient(ctx.konfiguracja.gus):null;
    // PRZ-093.08: sprzedawca specyfikacji — plik albo Ustawienia → Firma (czytane przy każdym dokumencie).
    const adresFirmy=zrodloAdresuFirmy({db:ctx.db,zPliku:ctx.konfiguracja.nadawca});
    const opcje = {db:ctx.db,config:{...ctx.usluga<object>('kanaly','config'),...ctx.konfiguracja,adresFirmy:adresFirmy.adres},
      poller:ctx.usluga('kanaly','poller'),stanyKanalow:ctx.usluga('kanaly','stanyKanalow'),
      // Pełny skład pobiera pocztę z jedynego modułu wiadomości podczas rejestracji tras.
      wiadomosci:null,gus,syncSklep,zdrowie:null,
    };
    return {uslugi:{config:opcje.config,zapytania,miniaturyEkranu,opcjeTras:opcje,syncSklep,gus,
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
          faktura:ctx.usluga('faktury','faktura'),proforma:ctx.usluga('faktury','proforma'),
          fakturaAllegro:ctx.usluga('faktury','fakturaAllegro'),fakturaHurtem:ctx.usluga('faktury','fakturaHurtem'),doczytanieKsef:ctx.usluga('faktury','doczytanieKsef'),
        });
        registerListaRoutes(app,kontekst);registerKartaRoutes(app,kontekst);registerReczneRoutes(app,kontekst);
      },
    };
  },
}; }
export const modulZamowienia = createModulZamowienia();
