import type { ModulOms, Srodowisko } from '../../core/kontrakty.ts';
import { wczytajSprzedawce } from '../../core/sprzedawca.ts';
import { integracje } from '../../integracje/klucze.js';
import { ODSTEP_OKNA_POBRANIA_MS } from '../../domena/pora-pobrania.js';
import { znormalizujNip } from '../../domena/gus.js';
import { createKsefClient } from '../../oms/ksef/client.js';
import { createSesjaKsef } from '../../oms/ksef/sesja.js';
import { stanKosztow } from '../../oms/db/koszty.js';
import { createCzuwaczKosztow, NAJDLUZSZY_PRZEBIEG_KOSZTOW_MS } from './services/czuwacz-kosztow.js';
import { createWizualizacjaKosztu } from './services/wizualizacja-kosztu.js';
import { createPaczkaDlaBiura } from './services/paczka-dla-biura.js';
import { zarejestrujTrasyKosztow } from './trasy/koszty.js';
import { zegarKosztow } from './zegary.ts';
import { skonfigurowanyUrl } from '../../core/konfiguracja-wartosci.ts';

export const ODSTEP_KOSZTOW_MS = 3600000;
export function wczytajKoszty(env: Srodowisko) {
  skonfigurowanyUrl(env.KSEF_API, 'KSEF_API');
  // Frozen porównuje kosztowy przebieg z dobą: 23 tyknięcia poza oknem i tak pomija.
  if (NAJDLUZSZY_PRZEBIEG_KOSZTOW_MS >= ODSTEP_OKNA_POBRANIA_MS) throw new Error('Budżet czuwacza kosztów nie mieści się przed następnym dobowym oknem pobrania.');
  const token = env.KSEF_TOKEN?.trim();
  if ((env.KSEF_TOKEN || env.KSEF_NIP || env.KSEF_API || env.KSEF_ARCHIWUM) && !token) throw new Error('Sekcja KSeF wymaga KSEF_TOKEN.');
  const nip = token ? wczytajSprzedawce(env).nip : null;
  if (token && env.KSEF_NIP?.trim() && znormalizujNip(env.KSEF_NIP) !== nip) throw new Error('KSEF_NIP musi być zgodny z OMS_SPRZEDAWCA_NIP.');
  return { ksef: token ? { token, nip: nip!, baseUrl: env.KSEF_API?.trim().replace(/\/+$/, '') || undefined } : null,
    katalogKosztow: env.KSEF_ARCHIWUM?.trim() || null, katalogSprzedazy: env.INFAKT_ARCHIWUM?.trim() || null,
    odstepMs: ODSTEP_KOSZTOW_MS };
}

export function createModulKoszty(o: { createKlient?: typeof createKsefClient; fabryki?: Record<string, (...args: any[]) => any> } = {}): ModulOms<ReturnType<typeof wczytajKoszty>> {
  return {
    nazwa: 'koszty', wersja: '1.0.0', wymaga: ['rdzen', 'web', 'faktury'],
    kluczeIntegracji: [...integracje.ksef.kluczeIntegracji], konfiguracja: wczytajKoszty, migracje: [],
    uprawnienia: [{ klucz: 'koszty', etykieta: 'Koszty', role: ['admin', 'operator'] }],
    menu: [{ dzial: 'analizy-cele', grupa: 'analizy-cele', etykieta: 'Koszty', adres: '/koszty', uprawnienie: 'koszty', kolejnosc: 40 }],
    zbuduj: ctx => {
      const { db, konfiguracja: k, teraz, log } = ctx;
      const infakt = ctx.usluga<any>('faktury', 'infakt');
      const ksefKlient = k.ksef ? (o.createKlient ?? createKsefClient)({ ...k.ksef, fetchImpl: undefined }) : null;
      const ksefSesja = ksefKlient ? createSesjaKsef({ db, klient: ksefKlient, teraz }) : null;
      const czuwaczKosztow = ksefKlient ? (o.fabryki?.createCzuwaczKosztow ?? createCzuwaczKosztow)({ db, klient: ksefKlient, sesja: ksefSesja, teraz, log, katalogArchiwum: k.katalogKosztow } as any) : null;
      const wizualizacjaKosztu = ksefKlient ? (o.fabryki?.createWizualizacjaKosztuFn ?? createWizualizacjaKosztu)({ db, klient: ksefKlient, sesja: ksefSesja } as any) : null;
      const paczkaDlaBiura = infakt ? (o.fabryki?.createPaczkaDlaBiuraFn ?? createPaczkaDlaBiura)({ db, infakt, wizualizacjaKosztu,
        katalogSprzedazy: k.katalogSprzedazy, katalogKosztow: k.katalogKosztow, teraz, log } as any) : null;
      return { uslugi: { config: k, ksefKlient, ksefSesja, czuwaczKosztow, wizualizacjaKosztu, paczkaDlaBiura,
        stanKosztow: () => stanKosztow(db), kosztyWlaczone: Boolean(czuwaczKosztow) },
        trasy: app => zarejestrujTrasyKosztow(app, { db,
          czuwaczKosztow: ctx.usluga<any>('koszty', 'czuwaczKosztow'),
          wizualizacjaKosztu: ctx.usluga<any>('koszty', 'wizualizacjaKosztu'),
          paczkaDlaBiura: ctx.usluga<any>('koszty', 'paczkaDlaBiura') } as any),
        zegary: czuwaczKosztow ? [zegarKosztow({ czuwacz: czuwaczKosztow, odstepMs: k.odstepMs, log })] : [],
      };
    },
  };
}
export const modulKoszty = createModulKoszty();
