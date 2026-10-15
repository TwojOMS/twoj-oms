import type { ModulOms, Srodowisko, Zegar } from '../../core/kontrakty.ts';
import { integracje } from '../../integracje/klucze.js';
import { createNadanie } from './services/nadanie.js';
import { createPodjazdy } from './services/podjazdy.js';
import { createPrzesylkiAllegro } from './services/przesylki-allegro.js';
import { createCzuwaczPrzesylek } from './services/czuwacz-przesylek.js';
import { createCzuwaczPodjazdow } from './services/czuwacz-podjazdow.js';
import { createZapytania as przesylki } from './db/przesylki.js';
import { createZapytania as podjazdyDb } from './db/podjazdy.js';
import { createZapytania as kolejkaDruku } from './db/kolejka-druku.js';
import { registerPrzesylkiRoutes } from './trasy/przesylki.js';
import { registerPodjazdyRoutes } from './trasy/podjazdy.js';
import { registerNadanieRoutes } from './trasy/nadanie.js';
import { registerEtykietyRoutes } from './trasy/etykiety.js';
import { wczytajKurierow, zbudujKurierow, type FabrykiKurierow } from './kurierzy.ts';
import { zegarPrzesylek, zegarPodjazdow } from './zegary.ts';
import { sprzatnijOsadStatusu } from './sprzatanie.js';
import { ocenZdrowie } from '../../domena/zdrowie.js';
import type { DaneSprzedawcy } from '../../core/sprzedawca.ts';
import type { MapaKurierow } from './kurierzy.ts';
import { interwal } from '../../core/konfiguracja-wartosci.ts';

type MapaKlientow = Record<string, any>;
type KonfiguracjaWysylki = {
  katalogEtykiet: string;
  odstepPrzesylekMs: number;
  odstepPodjazdowMs: number;
  adresPodjazdu: Record<string, string>;
  kurierzy: ReturnType<typeof wczytajKurierow>;
};

function odstep(env: Srodowisko, klucz: string, domyslny: number): number {
  return interwal(env[klucz], klucz, domyslny, 60000);
}

export function createModulWysylka({ fabryki = {} }: { fabryki?: FabrykiKurierow } = {}): ModulOms<KonfiguracjaWysylki> {
return {
  nazwa: 'wysylka', wersja: '1.0.0', wymaga: ['rdzen', 'web', 'kanaly', 'zamowienia', 'faktury'],
  kluczeIntegracji: [...integracje.dpd.kluczeIntegracji, ...integracje.inpost.kluczeIntegracji,
    ...integracje.allegro.kluczeIntegracji, ...integracje.infakt.kluczeIntegracji],
  konfiguracja: (env) => {
    // Dawna nazwa ma pierwszeństwo: istniejące listy wskazują ten sam wolumen.
    const katalogEtykiet = env.OMS_ETYKIETY_DIR?.trim() || env.OMS_ETYKIETY_KATALOG?.trim() || '/var/lib/panel/etykiety';
    const kurierzy = wczytajKurierow(env);
    const nadawca = kurierzy.dpd?.nadawca;
    return {
      katalogEtykiet,
      kurierzy,
      odstepPrzesylekMs: odstep(env, 'OMS_PRZESYLKI_ODSTEP_MS', 3600000),
      odstepPodjazdowMs: odstep(env, 'OMS_PODJAZDY_ODSTEP_MS', 600000),
      adresPodjazdu: {
        name: nadawca?.nazwa ?? '', street: nadawca?.ulica ?? '',
        postalCode: nadawca?.kod ?? '', city: nadawca?.miasto ?? '',
        countryCode: nadawca?.kraj ?? 'PL', email: nadawca?.email ?? '', phone: nadawca?.phone ?? '',
      },
    };
  },
  migracje: [],
  uprawnienia: [{ klucz: 'przesylki', etykieta: 'Przesyłki', role: ['admin', 'operator'] }],
  menu: [{ dzial: 'sprzedaz', grupa: 'obsluga', etykieta: 'Przesyłki', adres: '/przesylki', uprawnienie: 'przesylki', kolejnosc: 20 }],
  zbuduj: (ctx) => {
    const { db, konfiguracja: k, teraz } = ctx;
    const klienci = ctx.usluga<MapaKlientow>('kanaly', 'klienciSklepow');
    const klienciAllegro = ctx.usluga<MapaKlientow>('kanaly', 'klienciKanalow');
    const config = ctx.usluga<any>('kanaly', 'config');
    const sprzedawca = ctx.usluga<DaneSprzedawcy>('rdzen', 'sprzedawca');
    const kurierzy = zbudujKurierow({ ...k.kurierzy,
      pobranieNadawca: { ...k.kurierzy.pobranieNadawca, rachunek: sprzedawca.rachunek },
    }, klienciAllegro, fabryki);
    sprzatnijOsadStatusu(db, kurierzy, ctx.log);
    const infakt = ctx.usluga<any>('faktury', 'infakt');
    const puls = ctx.usluga<any>('faktury', 'puls');
    const jestSklep = Object.keys(klienci).length > 0;
    const nadanie = Object.keys(kurierzy).length && jestSklep
      ? createNadanie({ db, kurierzy, klienci, katalogEtykiet: k.katalogEtykiet }) : null;
    const podjazdy = Object.keys(klienciAllegro).length
      ? createPodjazdy({ db, allegroDla: (kanal: string) => klienciAllegro[kanal] ?? null, teraz }) : null;
    const przesylkiAllegro = Object.keys(klienciAllegro).length ? createPrzesylkiAllegro({ db, klienci: klienciAllegro }) : null;
    const czuwaczPrzesylek = Object.keys(kurierzy).length ? createCzuwaczPrzesylek({ db, kurierzy, infakt, teraz }) : null;
    const czuwaczPodjazdow = podjazdy ? createCzuwaczPodjazdow({ db, podjazdy, kurierzy, teraz }) : null;
    const zegary: Zegar[] = czuwaczPrzesylek ? [zegarPrzesylek({ czuwacz: czuwaczPrzesylek,
      odstepMs: k.odstepPrzesylekMs, puls, log: ctx.log })] : [];
    if (czuwaczPodjazdow) zegary.push(zegarPodjazdow({ czuwacz: czuwaczPodjazdow,
      odstepMs: k.odstepPodjazdowMs, log: ctx.log }));
    return {
      uslugi: { nadanie, podjazdy, przesylkiAllegro, kurierzy, czuwaczPrzesylek, czuwaczPodjazdow,
        config: { ...config, ...k.kurierzy, nadawca: k.kurierzy.dpd?.nadawca ?? null, katalogEtykiet: k.katalogEtykiet },
        przesylki: przesylki(db), zapytaniaPodjazdow: podjazdyDb(db), kolejkaDruku: kolejkaDruku(db) },
      trasy: (app) => {
        registerPrzesylkiRoutes(app, { db });
        registerPodjazdyRoutes(app, { db, podjazdy: ctx.usluga<any>('wysylka', 'podjazdy'), adresDomyslny: k.adresPodjazdu });
        const opcje = { db, nadanie: ctx.usluga<ReturnType<typeof createNadanie> | null>('wysylka', 'nadanie'), kurierzy: ctx.usluga<MapaKurierow>('wysylka', 'kurierzy'), config,
          syncSklep: { odeslijStatus: (...args: unknown[]) => ctx.usluga<any>('zamowienia', 'syncSklep')?.odeslijStatus(...args) },
          wczytajListe: (...a: unknown[]) => ctx.usluga<(...a: unknown[]) => unknown[]>('zamowienia', 'wczytajListe')(...a),
          miniaturyEkranu: (...args: unknown[]) => ctx.usluga<(...args: unknown[]) => unknown>('zamowienia', 'miniaturyEkranu')(...args),
        };
        registerNadanieRoutes(app, opcje);
        registerEtykietyRoutes(app, opcje);
      },
      zegary,
      zdrowie: () => {
        const ocena = ocenZdrowie({ teraz: teraz(), startAt: puls.startAt,
          przesylkiWlaczone: Boolean(Object.keys(kurierzy).length), pulsPrzesylek: puls.stan().czuwaczPrzesylek ?? null });
        if (!Object.keys(kurierzy).length) ocena.uwagi.push('Nadawanie nie jest skonfigurowane.');
        return ocena;
      },
    };
  },
};
}
export const modulWysylka = createModulWysylka();
