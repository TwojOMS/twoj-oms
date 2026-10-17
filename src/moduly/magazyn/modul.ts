import type { ModulOms } from '../../core/kontrakty.ts';
import { createMagazynPrzebieg } from './services/magazyn-przebieg.js';
import { registerKartaMagazynu, createKartaMagazynu } from './karta.js';
import { createPomocnikiMagazynu } from './pomocniki.js';
import { registerListaMagazynu } from './lista.js';
import { registerAkcjeMagazynu } from './akcje.js';
import { registerSynchronizacjaMagazynu } from './synchronizacja.js';
import { registerZapisMagazynu } from './zapis.js';
import { registerStanyMagazynu } from './stany.js';
import * as zapytania from '../../oms/db/magazyn.js';

type ConfigKanalow = { definicje: readonly {klucz:string;etykieta?:string}[]; sklepy: Record<string, unknown>; kanaly: Record<string, unknown> };
type KlienciSklepow = NonNullable<Parameters<typeof createMagazynPrzebieg>[0]>['sklepy'];
type KlienciAllegro = NonNullable<Parameters<typeof createMagazynPrzebieg>[0]>['allegro'];

/** Pełny magazyn: jawne kanały i wspólne instancje klientów modułu kanałów. */
export const modulMagazyn: ModulOms<null> = {
  nazwa: 'magazyn', wersja: '1.0.0', wymaga: ['rdzen', 'web', 'kanaly'],
  migracje: [], konfiguracja: () => null,
  uprawnienia: [{ klucz: 'magazyn', etykieta: 'Magazyn', role: ['administrator', 'sprzedaz'] }],
  menu: [{ dzial:'magazyn', grupa:'magazyn', etykieta:'Magazyn', adres:'/magazyn', uprawnienie:'magazyn', kolejnosc:10 }],
  zbuduj: ctx => {
    const config = ctx.usluga<ConfigKanalow>('kanaly', 'config');
    const sklepy = ctx.usluga<KlienciSklepow>('kanaly', 'klienciSklepow') ?? {};
    const allegro = ctx.usluga<KlienciAllegro>('kanaly', 'klienciKanalow') ?? {};
    const kanalySklepow = Object.keys(config.sklepy ?? {});
    const kanalyAllegro = Object.keys(config.kanaly ?? {});
    // Klienci są tymi samymi instancjami, które zbudował moduł kanałów.
    // Brak kanałów jest jawnym trybem bez konfiguracji, bez historycznych nazw.
    const magazyn = Object.keys(sklepy).length || Object.keys(allegro).length
      ? createMagazynPrzebieg({ db: ctx.db, sklepy, allegro, kanalySklepow, kanalyAllegro,
        log: (...czesci: unknown[]) => ctx.log(...czesci as string[]) })
      : null;
    return {
      uslugi: { magazyn, zapytania },
      trasy: app => {
        const opcje = { db: ctx.db, magazyn: ctx.usluga('magazyn', 'magazyn'), sklepy,
          pomoc: createPomocnikiMagazynu({ kanalySklepow, kanalyAllegro, definicje: config.definicje }),
          karta: createKartaMagazynu({ db: ctx.db, kanalyAllegro, definicje: config.definicje }) };
        registerListaMagazynu(app, opcje);
        registerSynchronizacjaMagazynu(app, opcje);
        registerAkcjeMagazynu(app, opcje);
        registerZapisMagazynu(app, opcje);
        registerStanyMagazynu(app, opcje);
        registerKartaMagazynu(app, { db: ctx.db, magazyn: opcje.magazyn, kanalyAllegro, definicje: config.definicje });
      },
    };
  },
};
