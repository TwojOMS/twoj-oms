import type { ModulOms } from '../../core/kontrakty.ts';
import { createMagazynPrzebieg } from './services/magazyn-przebieg.js';
import { registerKartaMagazynu, createKartaMagazynu } from './karta.js';
import { createPomocnikiMagazynu } from './pomocniki.js';
import { registerListaMagazynu } from './lista.js';
import { registerNowaKartaMagazynu } from './nowa-karta.js';
import { registerAkcjeMagazynu } from './akcje.js';
import { registerSzybkaCenaMagazynu } from './szybka-cena.js';
import { registerCenyKanalow } from './ceny-kanalow.js';
import { registerSynchronizacjaMagazynu } from './synchronizacja.js';
import { registerImportMagazynu } from './import.js';
import { registerZapisMagazynu } from './zapis.js';
import { registerOfertyMagazynu } from './oferty.js';
import { registerProblemyOfert } from './problemy-ofert.js';
import { registerStanyMagazynu } from './stany.js';
import { registerOpisMagazynu } from './opis.js';
import { registerSlownikiMagazynu } from './slowniki.js';
import { registerProducenciMagazynu } from './producenci.js';
import { registerUstawieniaMagazynuRoutes } from './ustawienia-magazynu.js';
import { registerCennikowOmsRoutes } from './cenniki-oms-ustawienia.js';
import { registerKategorieAllegro } from './kategorie-allegro-trasy.js';
import { registerProgStanu } from './prog-stanu.js';
import * as zapytania from '../../oms/db/magazyn.js';
import { listaNaZadanie, mapaNaZadanie } from '../kanaly/kolekcje-na-zadanie.ts';
import { kanalKlientaUmie } from '../../domena/moduly-kanalow.ts';
import { katalogZdjec, adresPublicznyZdjec, registerZdjeciaMagazynu } from './services/zdjecia-pliki.js';
import { createTrescAllegroPrzebieg } from './services/allegro-tresc-kart.js';
import { skonfigurujZrodla } from './services/kolejnosc-zrodel.js';
import { registerGaleriaMagazynu } from './galeria.js';
import { migracjaOfertKanalow } from './migracje/0001-oferty-kanalow.ts';
import { migracjaOfertAllegro } from './migracje/0002-oferty-allegro.ts';
import { migracjaCennikowDostaw } from './migracje/0003-cenniki-dostaw.ts';
import { migracjaStanowKanalow } from './migracje/0004-stany-kanalow.ts';
import { migracjaCenStatusowKanalow } from './migracje/0005-ceny-statusy-kanalow.ts';
import { migracjaCennikowOms } from './migracje/0006-cenniki-oms.ts';
import { migracjaCennikowKanalowKart } from './migracje/0007-cenniki-kanalow-kart.ts';
import { createPetlaOfert, ODSTEP_PETLI_OFERT_MS } from './services/petla-ofert.js';
import {
  katalogErli,
  katalogAllegro,
  wezlyAllegro,
  type KlientKataloguErli,
  type KlientKataloguAllegro,
} from '../../integracje/kanal-modul.ts';
import { maZgodeNaOferty } from '../../domena/uprawnienia-kanalu.js';
import { wczytajTokeny } from '../../oms/db/tokeny.js';
import { createPetlaOfertAllegro } from './services/petla-ofert-allegro.js';
import { createPetlaStanowWoo } from './services/petla-stanow-woo.js';
import { createStraznikStanow, ODSTEP_STRAZNIKA_MS } from './services/straznik-stanow.js';
import { pobierzZdjecie, LIMIT as LIMIT_ZDJECIA } from './services/zdjecia-pliki.js';
import { constants as stalePlikow } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

const ROZSZERZENIE_ZDJECIA: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
type ZdjecieDoWgrania = { sha256?: string | null; typ?: string | null; adres_zrodlowy?: string | null };

/**
 * Bajty zdjęcia do wgrania na Allegro. Najpierw plik z magazynu OMS (`<sha256>.<ext>`,
 * bez podążania za dowiązaniem — jak trasa zdjęć), a gdy pliku nie ma — pobieracz zdjęć z adresu źródłowego
 * (tylko https, limity, bez adresów prywatnych).
 */
function czytnikZdjecAllegro(katalog: string) {
  return async (z: ZdjecieDoWgrania): Promise<Uint8Array> => {
    const rozszerzenie = z.typ ? ROZSZERZENIE_ZDJECIA[z.typ] : undefined;
    if (z.sha256 && /^[0-9a-f]{64}$/.test(z.sha256) && rozszerzenie) {
      let plik;
      try {
        plik = await open(
          join(katalog, `${z.sha256}.${rozszerzenie}`),
          stalePlikow.O_RDONLY | stalePlikow.O_NOFOLLOW | stalePlikow.O_NONBLOCK,
        );
        const s = await plik.stat();
        if (!s.isFile() || s.size > LIMIT_ZDJECIA)
          throw new Error('Zdjęcie w magazynie OMS nie jest zwykłym plikiem albo przekracza limit.');
        return await plik.readFile();
      } catch (e) {
        if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      } finally {
        await plik?.close();
      }
    }
    if (z.adres_zrodlowy) return pobierzZdjecie(z.adres_zrodlowy);
    throw new Error('Zdjęcie nie ma pliku w magazynie OMS ani adresu źródłowego.');
  };
}

type ConfigKanalow = {
  definicje: readonly { klucz: string; etykieta?: string }[];
  sklepy: Record<string, unknown>;
  kanaly: Record<string, unknown>;
  odstepMs?: number;
};
type KlienciSklepow = NonNullable<Parameters<typeof createMagazynPrzebieg>[0]>['sklepy'];
type KlienciAllegro = NonNullable<Parameters<typeof createMagazynPrzebieg>[0]>['allegro'];
type KontoKanalu = {
  klucz: string;
  nazwa?: string;
  zrodlo?: string;
  autoryzacja?: string;
  srodowisko?: 'produkcja' | 'sandbox';
};
type RepozytoriumKanalowErli = {
  listaTypu: (typ: 'erli' | 'allegro') => readonly KontoKanalu[];
  zapisyZablokowane: (klucz: string) => boolean;
  konfliktKlucza?: (klucz: string) => boolean;
  zwolnijOperacje?: (klucz: string, metoda: string, zasob: string) => number;
};

type KonfiguracjaMagazynu = { katalog: string; adresPublicznyZdjec: string };

/** Pełny magazyn: jawne kanały i wspólne instancje klientów modułu kanałów. */
export const modulMagazyn: ModulOms<KonfiguracjaMagazynu> = {
  nazwa: 'magazyn',
  wersja: '1.0.0',
  wymaga: ['rdzen', 'web', 'kanaly'],
  migracje: [
    migracjaOfertKanalow,
    migracjaOfertAllegro,
    migracjaCennikowDostaw,
    migracjaStanowKanalow,
    migracjaCenStatusowKanalow,
    migracjaCennikowOms,
    migracjaCennikowKanalowKart,
  ],
  konfiguracja: (env) => ({ katalog: katalogZdjec(env), adresPublicznyZdjec: adresPublicznyZdjec(env) }),
  uprawnienia: [{ klucz: 'magazyn', etykieta: 'Magazyn', role: ['administrator', 'sprzedaz'] }],
  menu: [
    {
      dzial: 'magazyn',
      grupa: 'magazyn',
      etykieta: 'Magazyn',
      adres: '/magazyn',
      uprawnienie: 'magazyn',
      kolejnosc: 10,
    },
  ],
  zbuduj: (ctx) => {
    const config = ctx.usluga<ConfigKanalow>('kanaly', 'config');
    skonfigurujZrodla(ctx.db, () => ctx.usluga<ConfigKanalow>('kanaly', 'config'));
    const sklepy = ctx.usluga<KlienciSklepow>('kanaly', 'klienciSklepow') ?? {};
    const wszyscyKlienci = ctx.usluga<KlienciAllegro>('kanaly', 'klienciKanalow') ?? {};
    const obslugujeOferty = (sklep: string) => kanalKlientaUmie(sklep, (u) => u.stany === 'oferty');
    const allegro = mapaNaZadanie(
      () => Object.keys(wszyscyKlienci).filter(obslugujeOferty),
      (sklep) => wszyscyKlienci[sklep],
    );
    const kanalySklepow = listaNaZadanie(() => Object.keys(config.sklepy ?? {}));
    const kanalyAllegro = listaNaZadanie(() => Object.keys(config.kanaly ?? {}).filter(obslugujeOferty));
    // Klienci są tymi samymi instancjami, które zbudował moduł kanałów.
    // Brak kanałów jest jawnym trybem bez konfiguracji, bez historycznych nazw.
    const magazyn = createMagazynPrzebieg({
      db: ctx.db,
      sklepy,
      allegro,
      kanalySklepow,
      kanalyAllegro,
      log: (...czesci: unknown[]) => ctx.log(...(czesci as string[])),
    });
    // Osobny przebieg „Pobierz treść i zdjęcia ofert" — ci sami klienci Allegro, tylko odczyt.
    const trescAllegro = createTrescAllegroPrzebieg({
      db: ctx.db,
      allegro,
      kanalyAllegro,
      katalog: ctx.konfiguracja.katalog,
      log: (...czesci: unknown[]) => ctx.log(...(czesci as string[])),
    });
    // Pętla ofert ERLI — tylko bieżące konta ERLI z klientem w module kanałów (decyzja 3);
    // blokada zapisów konta (tryb „tylko odczyt”) z repozytorium kanałów trafia do jednej bramki zapisu.
    const repozytorium = (): RepozytoriumKanalowErli | null => {
      try {
        return ctx.usluga<RepozytoriumKanalowErli>('kanaly', 'repozytoriumKanalow') ?? null;
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Usługa „')) return null;
        throw e;
      }
    };
    // Nazwy cenników ERLI pobrane przez konfigurator konta (krok 3). Czytamy tylko jawne ustawienia, bez sekretów;
    // `null` = konto bez pobranej listy (wtedy cennik na karcie wpisuje się tekstem).
    const cennikiDostawErli = (klucz: string): string[] | null => {
      try {
        const w = ctx.db
          .prepare('SELECT ustawienia_json FROM konfiguracja_integracji WHERE integracja = ?')
          .get(`erli:${klucz}`) as { ustawienia_json?: string } | undefined;
        const lista = (JSON.parse(w?.ustawienia_json ?? '{}') as { cennikiDostaw?: unknown })?.cennikiDostaw;
        return Array.isArray(lista) ? lista.filter((n): n is string => typeof n === 'string') : null;
      } catch {
        return null;
      }
    };
    const kontaErli = () => {
      const repo = repozytorium();
      if (!repo) return [];
      return repo
        .listaTypu('erli')
        .filter((k) => wszyscyKlienci[k.klucz])
        .map((k) => ({
          klucz: k.klucz,
          nazwa: k.nazwa,
          klient: wszyscyKlienci[k.klucz],
          katalog: katalogErli(wszyscyKlienci[k.klucz] as unknown as KlientKataloguErli),
          tylkoOdczyt: () => repo.zapisyZablokowane(k.klucz),
          cennikiDostaw: cennikiDostawErli(k.klucz),
        }));
    };
    // Jedna lista kont Allegro dla ekranów i pętli. Klient to ta sama instancja
    // co w module kanałów; konto rozłączone albo z konfliktem klucza nie wchodzi, nawet gdy klient by się znalazł
    // (te same warunki co dostęp w kompozycji kanałów). Pola katalog i allegro dokładane są niżej.
    const kontaAllegro = () => {
      const repo = repozytorium();
      if (!repo) return [];
      return repo
        .listaTypu('allegro')
        .filter(
          (k) =>
            (k.autoryzacja === 'polaczone' || (k.zrodlo === 'env' && k.autoryzacja === 'brak')) &&
            !repo.konfliktKlucza?.(k.klucz) &&
            wszyscyKlienci[k.klucz],
        )
        .map((k) => ({
          klucz: k.klucz,
          nazwa: k.nazwa,
          klient: wszyscyKlienci[k.klucz],
          srodowisko: k.srodowisko ?? 'produkcja',
          zgoda: maZgodeNaOferty(wczytajTokeny(ctx.db, k.klucz)?.access_token),
          tylkoOdczyt: () => repo.zapisyZablokowane(k.klucz),
          // Katalog i węzły na tym samym kliencie konta (bariera i odświeżanie tokenu są w kliencie).
          katalog: katalogAllegro(wszyscyKlienci[k.klucz] as unknown as KlientKataloguAllegro),
          allegro: wezlyAllegro(wszyscyKlienci[k.klucz] as unknown as KlientKataloguAllegro),
        }));
    };
    const petlaOfert = createPetlaOfert({
      db: ctx.db,
      konta: kontaErli,
      adresPublicznyZdjec: ctx.konfiguracja.adresPublicznyZdjec,
      // N1: D64 zakłada przebieg pollera krótszy niż pollerMs — krótszy odstęp z env nie skraca karencji poniżej 120 s.
      pollerMs: Math.max(config?.odstepMs ?? 0, 120_000),
      log: (...czesci: unknown[]) => ctx.log(...(czesci as string[])),
    });
    // Osobna pętla ofert Allegro — te same konta co ekrany; konto bez zgody na oferty
    // (brak tokenu z zakresem ofert, np. demo) pętla pomija bez żadnego wywołania.
    const petlaOfertAllegro = createPetlaOfertAllegro({
      db: ctx.db,
      konta: kontaAllegro,
      zwolnijOperacje: (klucz: string, metoda: string, zasob: string) =>
        repozytorium()?.zwolnijOperacje?.(klucz, metoda, zasob) ?? 0,
      czytajZdjecie: czytnikZdjecAllegro(ctx.konfiguracja.katalog),
      log: (...czesci: unknown[]) => ctx.log(...(czesci as string[])),
    });
    // Pętla stanów Woo — sklepy z konfiguracji kanałów z klientem z modułu kanałów (ta sama
    // instancja; tryb „Odczyt” niesie klient jako `tylkoOdczyt`). Sklep bez klienta nie wchodzi.
    const kontaWoo = () =>
      kanalySklepow
        .filter((k) => (sklepy as Record<string, unknown>)[k])
        .map((k) => ({ klucz: k, klient: (sklepy as Record<string, unknown>)[k] }));
    const petlaStanowWoo = createPetlaStanowWoo({
      db: ctx.db,
      konta: kontaWoo,
      pollerMs: Math.max(config?.odstepMs ?? 0, 120_000),
      log: (...czesci: unknown[]) => ctx.log(...(czesci as string[])),
    });
    // Strażnik co 30 s — zmiana odcisku stanów przyspiesza trzy pętle (odstęp 60 s pilnuje każda pętla).
    const straznik = createStraznikStanow({
      db: ctx.db,
      petle: { erli: petlaOfert, allegro: petlaOfertAllegro, woo: petlaStanowWoo },
      log: (...czesci: unknown[]) => ctx.log(...(czesci as string[])),
    });
    return {
      zegary: [
        {
          nazwa: 'petlaOfert',
          odstepMs: ODSTEP_PETLI_OFERT_MS,
          przebieg: async () => {
            try {
              await petlaOfert.przebieg();
            } catch (e) {
              ctx.log(`oferty-erli: przebieg: ${e instanceof Error ? e.message : String(e)}`);
            }
          },
        },
        {
          nazwa: 'petlaOfertAllegro',
          odstepMs: ODSTEP_PETLI_OFERT_MS,
          przebieg: async () => {
            try {
              await petlaOfertAllegro.przebieg();
            } catch (e) {
              ctx.log(`oferty-allegro: przebieg: ${e instanceof Error ? e.message : String(e)}`);
            }
          },
        },
        {
          nazwa: 'petlaStanowWoo',
          odstepMs: ODSTEP_PETLI_OFERT_MS,
          przebieg: async () => {
            try {
              await petlaStanowWoo.przebieg();
            } catch (e) {
              ctx.log(`stany-woo: przebieg: ${e instanceof Error ? e.message : String(e)}`);
            }
          },
        },
        {
          nazwa: 'straznikStanow',
          odstepMs: ODSTEP_STRAZNIKA_MS,
          przebieg: async () => {
            try {
              straznik.przebieg();
            } catch (e) {
              ctx.log(`straznik-stanow: przebieg: ${e instanceof Error ? e.message : String(e)}`);
            }
          },
        },
      ],
      uslugi: { magazyn, zapytania, trescAllegro },
      trasy: (app) => {
        const komunikatyNowychKart = new Map<number, string>();
        registerZdjeciaMagazynu(app, { katalog: ctx.konfiguracja.katalog });
        registerGaleriaMagazynu(app, { db: ctx.db, katalog: ctx.konfiguracja.katalog });
        const opcje = {
          db: ctx.db,
          magazyn: ctx.usluga('magazyn', 'magazyn'),
          sklepy,
          kanalySklepow,
          kontaErli,
          kontaAllegro,
          definicje: config.definicje,
          trescAllegro: ctx.usluga('magazyn', 'trescAllegro'),
          pomoc: createPomocnikiMagazynu({
            kanalySklepow,
            kanalyAllegro,
            // Same klucze kont ERLI — bez budowania katalogu i klienta, bo lista czyta je przy każdym żądaniu.
            kanalyErli: listaNaZadanie(() => {
              const repo = repozytorium();
              return repo
                ? repo
                    .listaTypu('erli')
                    .filter((k) => wszyscyKlienci[k.klucz])
                    .map((k) => k.klucz)
                : [];
            }),
            definicje: config.definicje,
          }),
          karta: createKartaMagazynu({
            db: ctx.db,
            kanalyAllegro,
            definicje: config.definicje,
            kontaErli,
            kontaAllegro,
            sklepy,
          }),
        };
        registerListaMagazynu(app, opcje);
        registerNowaKartaMagazynu(app, { ...opcje, katalog: ctx.konfiguracja.katalog, komunikatyNowychKart });
        registerSynchronizacjaMagazynu(app, opcje);
        registerImportMagazynu(app, { ...opcje, definicje: config.definicje });
        registerAkcjeMagazynu(app, opcje);
        registerSzybkaCenaMagazynu(app, opcje);
        registerCenyKanalow(app, opcje);
        registerZapisMagazynu(app, opcje);
        registerOfertyMagazynu(app, { ...opcje, adresPublicznyZdjec: ctx.konfiguracja.adresPublicznyZdjec });
        registerProblemyOfert(app, opcje);
        registerStanyMagazynu(app, opcje);
        registerProgStanu(app, opcje);
        app.register(async (app) => (await import('./stany-otwarcie.js')).registerStanyOtwarcie(app, opcje));
        registerOpisMagazynu(app, opcje);
        // Magazyn → Kategorie; połączenia WooCommerce czytane z konfiguracji na żądanie.
        registerSlownikiMagazynu(app, {
          db: ctx.db,
          sklepy,
          kontaAllegro,
          definicje: () =>
            ctx.usluga<ConfigKanalow>('kanaly', 'config').definicje as readonly {
              klucz: string;
              typ?: string;
              etykieta?: string;
            }[],
        });
        // Magazyn → Producenci (GPSR) razem z markami kart; konta Allegro dla kolumny Allegro w tabeli marek.
        registerProducenciMagazynu(app, { db: ctx.db, kontaAllegro });
        // Magazyn → Ustawienia (stany, kolejność źródeł treści, parametry kart); dawne adresy w Ustawieniach → 301.
        registerUstawieniaMagazynuRoutes(app, { db: ctx.db });
        // Magazyn → Cenniki: cenniki dostaw OMS z powiązaniami kont i pobieranie list cenników z Allegro i ERLI.
        registerCennikowOmsRoutes(app, {
          db: ctx.db,
          kontaAllegro,
          kontaErli,
          definicje: () => ctx.usluga<ConfigKanalow>('kanaly', 'config').definicje,
          sklepyErli: () => {
            try {
              return ctx.usluga('kanaly', 'sklepyErli') ?? null;
            } catch (e) {
              if (e instanceof Error && e.message.startsWith('Usługa „')) return null;
              throw e;
            }
          },
          teraz: ctx.teraz,
        });
        // Mapowanie kategorii i marek na Allegro (na środowisko).
        registerKategorieAllegro(app, { db: ctx.db, kontaAllegro });
        registerKartaMagazynu(app, {
          db: ctx.db,
          komunikatyNowychKart,
          magazyn: opcje.magazyn,
          kanalyAllegro,
          definicje: config.definicje,
          kontaErli,
          kontaAllegro,
          sklepy,
          zmianyZFormularza: opcje.pomoc.zmianyZFormularza,
        });
      },
    };
  },
};
