import type { ModulOms } from '../../core/kontrakty.ts';
import { konfiguracjaKanalow, type DefinicjaKanalu } from './konfiguracja.ts';
import { kluczeKanalu } from '../../integracje/klucze.js';
import { createWooClient } from '../../oms/woo/client.js';
import { createWooAdapter, createAllegroAdapter } from '../../integracje/fabryki.ts';
import { createAllegroClient } from '../../oms/allegro/client.js';
import { createTokeny } from '../../oms/allegro/tokeny.js';
import { createPoller } from './services/poller.js';
import { createWiazanieKanalow } from './services/wiazanie-kanalow.js';
import { createImportSklepu } from './services/import-sklep.js';
import { createZdjeciaAllegro, zPobieraniemZdjec } from './services/zdjecia-allegro.js';
import { stanyKanalowZKolizjami } from '../../domena/kanal-stan.js';
import { bladPolleraNaEkran } from '../../domena/zdrowie.js';
import * as zapytania from '../../oms/db/zamowienia.js';
import { registerWiazanieRoute } from './trasy.ts';

export function createModulKanaly(definicje: readonly DefinicjaKanalu[], niekompletneJakoAlarm = false,
  o: { fetchImpl?: typeof fetch } = {}): ModulOms<ReturnType<typeof konfiguracjaKanalow>> {
  return {
    nazwa: 'kanaly', wersja: '1.0.0', wymaga: ['rdzen'], migracje: [], menu: [], uprawnienia: [],
    kluczeIntegracji: definicje.flatMap(d => kluczeKanalu(d.typ, d.prefiks).kluczeIntegracji),
    konfiguracja: env => konfiguracjaKanalow(definicje, env, niekompletneJakoAlarm),
    zbuduj: ctx => {
      const { db, konfiguracja: config } = ctx;
      // Frozen startup: naprawiamy wyłącznie skonfigurowane Woo i wyłącznie ze źródłowego GMT.
      const daty = zapytania.znormalizujDatyWoo(db, Object.keys(config.sklepy));
      if (daty.naprawione || daty.pominiete) ctx.log(`daty zamowien: znormalizowano ${daty.naprawione} wierszy do UTC-Z`
        + `${daty.pominiete ? `, ${daty.pominiete} POMINIETYCH bez GMT w surowym JSON-ie (obejrzec recznie)` : ''}.`);
      const klienciSklepow = Object.fromEntries(Object.entries(config.sklepy).map(([k,u]) => [k, createWooClient({ ...u, fetchImpl: o.fetchImpl })]));
      const tokenyKanalow = Object.fromEntries(Object.entries(config.kanaly).map(([k,u]) => [k, createTokeny({ db, kanal: k, ustawienia: u, fetchImpl: o.fetchImpl })]));
      const klienciKanalow = Object.fromEntries(Object.entries(config.kanaly).map(([k,u]) => [k, createAllegroClient({ ustawienia: u, tokeny: tokenyKanalow[k], fetchImpl: o.fetchImpl })]));
      const pollery = [
        ...Object.entries(config.sklepy).map(([k,u]) => createPoller({ db, sklep:k, od:u.od, kanal:createWooAdapter({ woo:klienciSklepow[k] as unknown as Parameters<typeof createWooAdapter>[0]['woo'], mapowanie:u.mapowanie }) })),
        ...Object.entries(config.kanaly).map(([k,u]) => createPoller({ db, sklep:k, od:u.od, kanal:createAllegroAdapter({ klient:klienciKanalow[k] }) })),
      ];
      const zbiorczy = pollery.length ? {
        przebieg: async () => { const bledy:string[] = []; for (const p of pollery) { try { await p.przebieg(); } catch(e) { bledy.push((e as Error).message); } } if(bledy.length) throw new Error(bledy.join(' | ')); },
        stan: () => { const stany = pollery.map(p=>p.stan()); return stany.find(s=>bladPolleraNaEkran(s)) ?? stany.find(s=>s?.ostatni_blad) ?? stany[0]; },
        stany: () => pollery.map(p=>p.stan()),
      } : null;
      const zdjecia = Object.keys(klienciKanalow).length ? createZdjeciaAllegro({ db, klienci:klienciKanalow }) : null;
      const poller = zbiorczy && zdjecia ? zPobieraniemZdjec(zbiorczy, zdjecia) : zbiorczy;
      const stanyKanalow = () => stanyKanalowZKolizjami(Object.values(tokenyKanalow).map(t=>t.stanDlaEkranu()));
      const wiazanieKanalow = Object.keys(tokenyKanalow).length ? createWiazanieKanalow({ tokenyKanalow, log:ctx.log as (...args: any[]) => void }) : null;
      const importySklepow = Object.fromEntries(Object.entries(klienciSklepow).filter(([sklep])=>config.sklepy[sklep].historia).map(([sklep,klient]) => [sklep,createImportSklepu({ db, sklep, klient, konfiguracja:config.sklepy[sklep].historia, log:ctx.log as (...args: any[]) => void })]));
      return { uslugi: { config, db, zapytania, klienciSklepow, klienciKanalow, tokenyKanalow, poller, stanyKanalow, wiazanieKanalow, importySklepow },
        zegary: poller ? [{ nazwa:'poller', odstepMs:config.odstepMs, przebieg:async()=>{
          try { await poller.przebieg(); }
          catch(e) { ctx.log('poller:', e instanceof Error ? e.message : String(e)); }
        } }] : [],
        zdrowie: () => ({ alarmy: [], uwagi: pollery.map(p=>p.stan()).filter(s=>bladPolleraNaEkran(s)).map(s=>String(s.ostatni_blad)) }),
        trasy: app => registerWiazanieRoute(app, { wiazanieKanalow: ctx.usluga('kanaly', 'wiazanieKanalow'), widokIntegracji: (req, reply, dane) => {
          let renderer: Parameters<typeof registerWiazanieRoute>[1]['widokIntegracji'];
          try { renderer = ctx.usluga<typeof renderer>('ustawienia', 'widokIntegracji'); }
          catch { return reply.code(503).send({ blad: 'Widok ustawień integracji jest niedostępny.' }); }
          // PRZ-030 dostarcza rzeczywisty widok. Jego awarii nie maskujemy jako braku modułu.
          return renderer(req, reply, dane);
        } }),
      };
    },
  };
}
export const modulKanaly = createModulKanaly([]);
