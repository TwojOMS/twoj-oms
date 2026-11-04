import type { ModulOms, OpisKuriera, Srodowisko, Zegar } from '../../core/kontrakty.ts';
import type { FastifyInstance } from 'fastify';
import { MODULY_KURIEROW, type RejestrKurierow } from '../../domena/moduly-kurierow.ts';
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
import { PACZKA_DOMYSLNA } from '../../domena/ustawienia-panelu.js';
import type { DaneSprzedawcy } from '../../core/sprzedawca.ts';
import { zrodloRachunkuFirmy } from '../../oms/db/rachunek-firmy.js';
import type { MapaKurierow } from './kurierzy.ts';
import { interwal } from '../../core/konfiguracja-wartosci.ts';
import { opcjeKlientaDpd } from '../../domena/konfiguracja-dpd.js';
import { opcjeKlientaInpost } from '../../domena/konfiguracja-inpost.js';
import { adresAkcji, stanKrokow } from '../../core/web/konfigurator/konfigurator.ts';
import { nawigacjaUstawien } from '../ustawienia/nawigacja.js';

type MapaKlientow = Record<string, any>;
type KonfiguracjaWysylki = {
  katalogEtykiet: string;
  odstepPrzesylekMs: number;
  odstepPodjazdowMs: number;
  adresPodjazdu: Record<string, string>;
  kurierzy: ReturnType<typeof wczytajKurierow>;
  proba: boolean;
};

type Odmowa = (...a: unknown[]) => Promise<never>;
/**
 * PRZ-092/093.09/135: piaskownica bez atrapy kuriera (opis.piaskownica.atrapa) — czytelna odmowa zamiast żądania do
 * kuriera: dane wpisane na :3005 nie mogą wyjść do DPD ani InPostu. Metody DOKŁADNIE jak u adaptera (R3) — wynikają
 * z umiejętności opisu; dodatkowe sprawdzPrzesylke u DPD przestawiłoby nadanie.js na drogę asynchroniczną.
 * Zgodność z adapterem pilnuje tests/moduly/wysylka/kurierzy-kontrakt-prz135.test.ts.
 */
export const odmowaWProbie = (opis: OpisKuriera) => (_opcjeKlienta?: unknown) => {
  const odmowa: Odmowa = async () => { throw bladOperatora(opis.piaskownica.komunikat, { status: 400 }); };
  const u = opis.umiejetnosci;
  return {
    nadaj: odmowa,
    ...(u.nadanieAsynchroniczne ? { sprawdzPrzesylke: odmowa } : {}),
    ...(opis.pobieranieEtykiety ? { pobierzEtykiete: odmowa } : {}),
    ...(u.sledzenie === 'wlasne' ? { statusPrzesylki: odmowa } : {}),
    ...(opis.umowa === 'wlasna' ? { sprawdzPolaczenie: odmowa } : {}),
  };
};

/**
 * PRZ-135.07b (D6): kurier z `konfigurator.kroki` dostaje wspólny widok kroków (src/core/web/konfigurator/) pod swoją
 * `konfigurator.sciezka`, z pierwszym krokiem jako bieżącym. Zapis kroków (trasy POST) dopisuje moduł kuriera.
 * Dziś żaden kurier nie ma kroków (DPD i InPost mają własne formularze), więc trasa nie powstaje.
 */
export function registerKrokiKurierowRoutes(app: FastifyInstance, rejestr: RejestrKurierow = MODULY_KURIEROW): void {
  for (const opis of Object.values(rejestr)) {
    const konfigurator = opis.konfigurator, krok = konfigurator.kroki?.[0];
    if (!konfigurator.kroki || !krok) continue;
    const kroki = stanKrokow({ kroki: konfigurator.kroki }, { biezacy: krok.id, zrobione: [] });
    app.get(konfigurator.sciezka, async (req, reply) => reply.view('core/web/konfigurator/konfigurator-krokow.ejs', {
      nawigacja: nawigacjaUstawien(req, reply), title: konfigurator.etykieta, etykieta: konfigurator.etykieta, kroki, krok,
      akcja: krok.formularz ? adresAkcji(konfigurator, krok, opis.klucz) : '',
    }));
  }
}

function odstep(env: Srodowisko, klucz: string, domyslny: number): number {
  return interwal(env[klucz], klucz, domyslny, 60000);
}

export function createModulWysylka({ fabryki = {} }: { fabryki?: FabrykiKurierow } = {}): ModulOms<KonfiguracjaWysylki> {
return {
  nazwa: 'wysylka', wersja: '1.0.0', wymaga: ['rdzen', 'web', 'kanaly', 'zamowienia', 'faktury'],
  // PRZ-135: klucze kurierów z opisów (bez powtórzeń, w kolejności rejestru) + inFakt (oznaczanie pobrań).
  kluczeIntegracji: [...new Set(Object.values(MODULY_KURIEROW).flatMap(opis => [...opis.kluczeEnv])),
    ...integracje.infakt.kluczeIntegracji],
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
    // PRZ-102.20: źródło bez stanu (czyta bazę przy każdym wywołaniu) nad rachunkiem z pliku z rdzenia.
    const rachunekFirmy = zrodloRachunkuFirmy({ db, zPliku: ctx.usluga<DaneSprzedawcy>('rdzen', 'sprzedawca') });
    const adresFirmy = zrodloAdresuFirmy({ db, zPliku: k.kurierzy.adresFirmyZPliku });
    // WzA czyta nazwę przy żądaniu, także bez DPD/ShipX z pliku i po zmianie Firmy w panelu. PRZ-102.20: rachunek też —
    // z bieżącej konfiguracji (plik → Ustawienia → Firma → brak); bez rachunku domena odmawia pobrania wymagającego konta.
    const pobranieNadawca = { get nazwa() { return adresFirmy.adres()?.nazwa ?? ''; },
      get rachunek() { return rachunekFirmy.biezacy().rachunek ?? undefined; } };
    const kurierzy = zbudujKurierow({ ...k.kurierzy,
      pobranieNadawca,
    }, klienciAllegro, fabryki);
    // PRZ-092: DPD z Ustawień tylko, gdy .env go nie ustawia (.env wygrywa). Piaskownica bez atrapy nie dostaje
    // prawdziwego klienta DPD: wpisane na :3005 dane nie mogą wyjść do DPD.
    const wczytajDpd = () => wczytajKonfiguracjeIntegracji(db, 'dpd');
    // PRZ-093.08: nadawca DPD z Ustawień = adres firmy (plik → Ustawienia → Firma), czytany przy każdej paczce.
    const dpdUstawien = k.kurierzy.dpd ? null : kurierDpdZUstawien({ wczytaj: wczytajDpd, nadawca: adresFirmy.adres,
      fabryka: fabryki.createDpd ?? (k.proba ? odmowaWProbie(MODULY_KURIEROW.dpd) : createDpdClient) });
    if (dpdUstawien && wczytajDpd()) kurierzy.dpd = dpdUstawien;
    // PRZ-093.09: InPost z Ustawień — ta sama zasada: tylko gdy plik nie ma INPOST_TOKEN (.env wygrywa), nadawca =
    // adres firmy czytany przy każdej paczce, piaskownica bez atrapy dostaje odmowę zamiast prawdziwego klienta.
    const wczytajInpost = () => wczytajKonfiguracjeIntegracji(db, 'inpost');
    const inpostUstawien = k.kurierzy.inpost ? null : kurierInpostZUstawien({ wczytaj: wczytajInpost, nadawca: adresFirmy.adres,
      fabryka: fabryki.createInpost ?? (k.proba ? odmowaWProbie(MODULY_KURIEROW.inpost) : createInpostClient) });
    if (inpostUstawien && wczytajInpost()) kurierzy.inpost = inpostUstawien;
    // Ten sam wybór źródła co nadanie; zapis i opcje klienta czytane przy każdym otwarciu Łączności.
    const celeLacznosci = () => {
      const dpd = dpdUstawien ? wczytajDpd() : null;
      const inpost = inpostUstawien ? wczytajInpost() : null;
      return {
        dpd: dpdUstawien ? (dpd ? { url: opcjeKlientaDpd(dpd, null).url } : null)
          : k.kurierzy.dpd ? { url: k.kurierzy.dpd.url } : null,
        inpost: inpostUstawien ? (inpost ? { url: opcjeKlientaInpost(inpost, null).url } : null)
          : k.kurierzy.inpost ? { url: k.kurierzy.inpost.url } : null,
      };
    };
    const dpdPrzyStarcie=Boolean(kurierzy.dpd),inpostPrzyStarcie=Boolean(kurierzy.inpost);
    const kurierzyDostepni=()=>Boolean((dpdPrzyStarcie&&kurierzy.dpd)||(inpostPrzyStarcie&&kurierzy.inpost)||Object.keys(klienciAllegro).length);
    const bezKurierowPrzyStarcie = !kurierzyDostepni();
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
    const nadanieGotowe=()=>kurierzyDostepni()&&(Object.keys(klienci).length>0||Object.keys(klienciAllegro).length>0);
    let implementacjaNadania:ReturnType<typeof createNadanie>|undefined;
    const nadanieBiezace=()=>{
      if(!nadanieGotowe())throw bladOperatora('Nadawanie nie jest skonfigurowane (brak sklepu lub konta Allegro i kuriera).',{status:503});
      return implementacjaNadania??=createNadanie({db,kurierzy,klienci,katalogEtykiet:k.katalogEtykiet});
    };
    if(nadanieGotowe())nadanieBiezace(); // Walidacja katalogu przed pierwszym kontaktem z kurierem.
    const nadanie={gotowe:nadanieGotowe,paczkaDomyslna:PACZKA_DOMYSLNA,
      nadaj:(...a:Parameters<ReturnType<typeof createNadanie>['nadaj']>)=>nadanieBiezace().nadaj(...a),
      sprawdzPonownie:(...a:Parameters<ReturnType<typeof createNadanie>['sprawdzPonownie']>)=>nadanieBiezace().sprawdzPonownie(...a),
      ponowNotatke:(...a:Parameters<ReturnType<typeof createNadanie>['ponowNotatke']>)=>nadanieBiezace().ponowNotatke(...a),
    };
    const podjazdy = createPodjazdy({ db, allegroDla: (kanal: string) => klienciAllegro[kanal] ?? null, teraz });
    const przesylkiAllegro = createPrzesylkiAllegro({ db, klienci: klienciAllegro });
    const czuwaczPrzesylek = createCzuwaczPrzesylek({ db, kurierzy, infakt, teraz, klienci });
    const czuwaczPodjazdow = podjazdy ? createCzuwaczPodjazdow({ db, podjazdy, kurierzy, teraz }) : null;
    const zegary: Zegar[] = czuwaczPrzesylek ? [zegarPrzesylek({ czuwacz: czuwaczPrzesylek,
      odstepMs: k.odstepPrzesylekMs, puls, log: ctx.log, program: infakt })] : [];
    if (czuwaczPodjazdow) zegary.push(zegarPodjazdow({ czuwacz: czuwaczPodjazdow,
      odstepMs: k.odstepPodjazdowMs, log: ctx.log }));
    return {
      uslugi: { nadanie, podjazdy, przesylkiAllegro, kurierzy, kurierDpd, kurierInpost, czuwaczPrzesylek, czuwaczPodjazdow, celeLacznosci,kurierzyDostepni,
        config: { ...config, ...k.kurierzy, pobranieNadawca, nadawca: k.kurierzy.dpd?.nadawca ?? null, katalogEtykiet: k.katalogEtykiet },
        przesylki: przesylki(db), zapytaniaPodjazdow: podjazdyDb(db), kolejkaDruku: kolejkaDruku(db) },
      trasy: (app) => {
        registerPrzesylkiRoutes(app, { db });
        registerPodjazdyRoutes(app, { db, podjazdy: ctx.usluga<any>('wysylka', 'podjazdy'), adresDomyslny: k.adresPodjazdu });
        const opcje = { db, nadanie: ctx.usluga<ReturnType<typeof createNadanie> | null>('wysylka', 'nadanie'), kurierzy: ctx.usluga<MapaKurierow>('wysylka', 'kurierzy'), config, programFaktur: infakt,
          syncSklep: { odeslijStatus: (...args: unknown[]) => ctx.usluga<any>('zamowienia', 'syncSklep')?.odeslijStatus(...args) },
          wczytajListe: (...a: unknown[]) => ctx.usluga<(...a: unknown[]) => unknown[]>('zamowienia', 'wczytajListe')(...a),
          miniaturyEkranu: (...args: unknown[]) => ctx.usluga<(...args: unknown[]) => unknown>('zamowienia', 'miniaturyEkranu')(...args),
        };
        registerNadanieRoutes(app, opcje);
        registerEtykietyRoutes(app, opcje);
        registerUstawieniaDpdRoutes(app, { db, kurierDpd });
        registerUstawieniaInpostRoutes(app, { db, kurierInpost });
        registerKrokiKurierowRoutes(app);
      },
      zegary,
      zdrowie: () => {
        const ocena = ocenZdrowie({ teraz: teraz(), startAt: puls.startAt,
          // PRZ-092: liczone z czuwacza zbudowanego przy starcie, nie z żywej mapy — kurier dodany w Ustawieniach do
          // panelu bez kurierów nie ma czuwacza do restartu, więc nie może dawać alarmu „brak przebiegu” ani gasić uwagi.
          przesylkiWlaczone: kurierzyDostepni(), pulsPrzesylek: puls.stan().czuwaczPrzesylek ?? null });
        if (!kurierzyDostepni()) ocena.uwagi.push('Nadawanie nie jest skonfigurowane.');
        return ocena;
      },
    };
  },
};
}
export const modulWysylka = createModulWysylka();
