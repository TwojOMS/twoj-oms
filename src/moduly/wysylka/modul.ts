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
import { wczytajKurierow, zbudujKurierow, kurierDpdZUstawien, kurierInpostZUstawien, type FabrykiKurierow } from './kurierzy.ts';
import { registerUstawieniaDpdRoutes } from './trasy/ustawienia-dpd.js';
import { registerUstawieniaInpostRoutes } from './trasy/ustawienia-inpost.js';
import { wczytajKonfiguracjeIntegracji } from '../../oms/db/konfiguracja-integracji.js';
import { zrodloAdresuFirmy } from '../../oms/db/adres-firmy.js';
import { createDpdClient, createInpostClient } from '../../integracje/fabryki.ts';
import { efektywnyTryb } from '../../core/tryb.ts';
import { bladOperatora } from '../../domena/bledy.js';
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
  proba: boolean;
};

// PRZ-092: piaskownica bez atrapy DPD (deploy/proba/atrapy/dpd.mjs) — czytelna odmowa zamiast żądania do DPD.
const odmowaDpdWProbie = () => {
  const odmowa = async () => { throw bladOperatora('Piaskownica: prawdziwe DPD jest tu wyłączone — nic nie poszło do DPD.', { status: 400 }); };
  return { nadaj: odmowa, statusPrzesylki: odmowa, sprawdzPolaczenie: odmowa };
};
// PRZ-093.09: to samo dla InPostu z Ustawień (atrapa: deploy/proba/atrapy/inpost.mjs) — token z :3005 nie wychodzi.
const odmowaInpostWProbie = () => {
  const odmowa = async () => { throw bladOperatora('Piaskownica: prawdziwy InPost jest tu wyłączony — nic nie poszło do InPostu.', { status: 400 }); };
  return { nadaj: odmowa, sprawdzPrzesylke: odmowa, pobierzEtykiete: odmowa, statusPrzesylki: odmowa, sprawdzPolaczenie: odmowa };
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
      proba: efektywnyTryb(env) === 'proba',
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
    // PRZ-092: DPD z Ustawień tylko, gdy .env go nie ustawia (.env wygrywa). Piaskownica bez atrapy nie dostaje
    // prawdziwego klienta DPD: wpisane na :3005 dane nie mogą wyjść do DPD.
    const wczytajDpd = () => wczytajKonfiguracjeIntegracji(db, 'dpd');
    // PRZ-093.08: nadawca DPD z Ustawień = adres firmy (plik → Ustawienia → Firma), czytany przy każdej paczce.
    const adresFirmy = zrodloAdresuFirmy({ db, zPliku: k.kurierzy.adresFirmyZPliku });
    const dpdUstawien = k.kurierzy.dpd ? null : kurierDpdZUstawien({ wczytaj: wczytajDpd, nadawca: adresFirmy.adres,
      fabryka: fabryki.createDpd ?? (k.proba ? odmowaDpdWProbie : createDpdClient) });
    if (dpdUstawien && wczytajDpd()) kurierzy.dpd = dpdUstawien;
    // PRZ-093.09: InPost z Ustawień — ta sama zasada: tylko gdy plik nie ma INPOST_TOKEN (.env wygrywa), nadawca =
    // adres firmy czytany przy każdej paczce, piaskownica bez atrapy dostaje odmowę zamiast prawdziwego klienta.
    const wczytajInpost = () => wczytajKonfiguracjeIntegracji(db, 'inpost');
    const inpostUstawien = k.kurierzy.inpost ? null : kurierInpostZUstawien({ wczytaj: wczytajInpost, nadawca: adresFirmy.adres,
      fabryka: fabryki.createInpost ?? (k.proba ? odmowaInpostWProbie : createInpostClient) });
    if (inpostUstawien && wczytajInpost()) kurierzy.inpost = inpostUstawien;
    const bezKurierowPrzyStarcie = !Object.keys(kurierzy).length;
    const kurierDpd = {
      zEnv: Boolean(k.kurierzy.dpd), adresFirmy: adresFirmy.biezacy,
      // Mapa `kurierzy` jest wspólna (nadanie, czuwacz, trasy) — podmiana wpisu działa od następnego żądania.
      odswiez: () => { if (!dpdUstawien) return; if (wczytajDpd()) kurierzy.dpd = dpdUstawien; else delete kurierzy.dpd; },
      // Wprost przez adapter z Ustawień, nie przez mapę: brak wpisu w mapie nie może dać „Połączenie działa”.
      sprawdzPolaczenie: () => { if (!dpdUstawien) throw bladOperatora('Kurier DPD jest ustawiony w pliku konfiguracji.'); return dpdUstawien.sprawdzPolaczenie(); },
      // Nadanie i czuwacz powstają przy starcie tylko z co najmniej jednym kurierem — pierwszy kurier wymaga restartu.
      wymagaRestartu: () => bezKurierowPrzyStarcie && Boolean(kurierzy.dpd),
    };
    const kurierInpost = {
      zEnv: Boolean(k.kurierzy.inpost), adresFirmy: adresFirmy.biezacy,
      odswiez: () => { if (!inpostUstawien) return; if (wczytajInpost()) kurierzy.inpost = inpostUstawien; else delete kurierzy.inpost; },
      sprawdzPolaczenie: () => { if (!inpostUstawien) throw bladOperatora('Kurier InPost jest ustawiony w pliku konfiguracji.'); return inpostUstawien.sprawdzPolaczenie(); },
      wymagaRestartu: () => bezKurierowPrzyStarcie && Boolean(kurierzy.inpost),
    };
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
      uslugi: { nadanie, podjazdy, przesylkiAllegro, kurierzy, kurierDpd, kurierInpost, czuwaczPrzesylek, czuwaczPodjazdow,
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
        registerUstawieniaDpdRoutes(app, { db, kurierDpd });
        registerUstawieniaInpostRoutes(app, { db, kurierInpost });
      },
      zegary,
      zdrowie: () => {
        const ocena = ocenZdrowie({ teraz: teraz(), startAt: puls.startAt,
          // PRZ-092: liczone z czuwacza zbudowanego przy starcie, nie z żywej mapy — kurier dodany w Ustawieniach do
          // panelu bez kurierów nie ma czuwacza do restartu, więc nie może dawać alarmu „brak przebiegu” ani gasić uwagi.
          przesylkiWlaczone: Boolean(czuwaczPrzesylek), pulsPrzesylek: puls.stan().czuwaczPrzesylek ?? null });
        if (!czuwaczPrzesylek) ocena.uwagi.push('Nadawanie nie jest skonfigurowane.');
        return ocena;
      },
    };
  },
};
}
export const modulWysylka = createModulWysylka();
