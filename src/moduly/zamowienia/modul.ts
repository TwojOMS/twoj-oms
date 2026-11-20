import type { ModulOms } from '../../core/kontrakty.ts';
import { konfiguracjaZamowien } from './konfiguracja.ts';
import { ustawKanalIndywidualnyStatusow } from '../../oms/db/statusy.js';
import { createKontekstZamowien } from './kontekst.js';
import { registerListaRoutes } from './lista.js';
import { registerPowiadomieniaRoutes } from './powiadomienia.js';
import { registerKartaRoutes } from './karta.js';
import { registerReczneRoutes } from './reczne.js';
import { registerScalanieRoutes } from './scalanie.js';
import { miniaturyEkranu } from './wspolne.js';
import * as zapytania from '../../oms/db/zamowienia.js';
import { powiadomieniaKonta } from '../../oms/db/powiadomienia.js';
import { kluczDozwolony } from '../../domena/ostrzezenia.js';
import { createSyncSklep } from './services/sync-sklep.js';
import { MODULY_KANALOW } from '../../domena/moduly-kanalow.ts';
import { sprawdzZapisZwrotny, zwrotneAllegro, zwrotneSklepu } from '../../integracje/kanal-modul.ts';
import { zegarPonawianiaStatusow, zegarMigawkiPowiadomien } from './zegary.ts';
import { createMigawkaPowiadomien } from './services/migawka-powiadomien.js';
import { createGusClient } from '../../oms/gus/client.js';
import { integracje } from '../../integracje/klucze.js';
import { migracjaStatusowWlasnych } from './migracje/0002-statusy-wlasne.ts';
import { migracjaIndeksuListy } from './migracje/0001-indeks-listy.ts';
import { migracjaScalen } from './migracje/0003-scalenia.ts';
import { migracjaIndeksuListyFaktura } from './migracje/0004-indeks-listy-faktura.ts';
import { migracjaIndeksuPozycjiKarty } from './migracje/0005-indeks-pozycji-karty.ts';
import { efektywnyTryb } from '../../core/tryb.ts';
import { zrodloAdresuFirmy } from '../../oms/db/adres-firmy.js';
import { zrodloNipuIBdoFirmy } from '../../oms/db/nip-bdo-firmy.js';
import { wczytajKonfiguracjeIntegracji } from '../../oms/db/konfiguracja-integracji.js';
import { uslugaGus, odmowaGusWProbie } from './gus-ustawien.ts';
import { registerUstawieniaGusRoutes } from './ustawienia-gus.js';
// `fabryki.createGusClient` — atrapa GUS piaskownicy i demo (deploy/proba/atrapy/gus.mjs), jak fabryki inFaktu
// i VIES w module faktur. Poza OMS_TRYB=proba odmowa już przy konfiguracji.
export function createModulZamowienia({
  zWiadomosciami = false,
  fabryki = {} as { createGusClient?: (opcje?: { klucz: string; url: string }) => any },
} = {}): ModulOms<ReturnType<typeof konfiguracjaZamowien>> {
  return {
    nazwa: 'zamowienia',
    wersja: '1.0.0',
    wymaga: ['rdzen', 'web', 'kanaly', 'faktury', ...(zWiadomosciami ? ['wiadomosci'] : [])],
    migracje: [
      migracjaIndeksuListy,
      migracjaStatusowWlasnych,
      migracjaScalen,
      migracjaIndeksuListyFaktura,
      migracjaIndeksuPozycjiKarty,
    ],
    uprawnienia: [{ klucz: 'zamowienia', etykieta: 'Zamówienia', role: ['admin', 'operator'] }],
    menu: [
      {
        dzial: 'sprzedaz',
        grupa: 'obsluga',
        etykieta: 'Zamówienia',
        adres: '/',
        uprawnienie: 'zamowienia',
        kolejnosc: 10,
      },
    ],
    konfiguracja: (env) => {
      if (fabryki.createGusClient && efektywnyTryb(env) !== 'proba')
        throw new Error(
          'Fabryka createGusClient (atrapa GUS piaskownicy) wolno podać tylko w trybie próby (OMS_TRYB=proba)',
        );
      return konfiguracjaZamowien(env);
    },
    kluczeIntegracji: integracje.gus.kluczeIntegracji,
    zbuduj: (ctx) => {
      ustawKanalIndywidualnyStatusow(ctx.db, ctx.konfiguracja.kanalIndywidualny);
      let kontekst: ReturnType<typeof createKontekstZamowien> | undefined;
      const klienci = ctx.usluga<Record<string, any>>('kanaly', 'klienciSklepow');
      const klienciKanalow = ctx.usluga<Record<string, any>>('kanaly', 'klienciKanalow');
      // Adaptery sprawdzane raz na moduł, bez klientów: `klienciKanalow` to mapa na żądanie, a odczyt konta Allegro
      // bez skonfigurowanej aplikacji rzuca — przejście po mapie przy składaniu położyłoby start całego OMS-u.
      sprawdzZapisZwrotny(MODULY_KANALOW.woo, zwrotneSklepu({ ustawStatus: async () => undefined }));
      sprawdzZapisZwrotny(MODULY_KANALOW.allegro, zwrotneAllegro({ ustawStatusRealizacji: async () => undefined }));
      const syncSklep = createSyncSklep({
        db: ctx.db,
        klienci,
        klienciKanalow,
        czynny: () => Object.keys(klienci).length > 0 || Object.keys(klienciKanalow).length > 0,
      });
      // Usługa GUS z bieżącej konfiguracji (plik → atrapa piaskownicy → Ustawienia → brak), pytana przy
      // każdym żądaniu — klucz zapisany w Ustawienia → Integracje → GUS działa bez restartu (gus-ustawien.ts).
      const gus = uslugaGus({
        zPliku: !fabryki.createGusClient && ctx.konfiguracja.gus ? createGusClient(ctx.konfiguracja.gus) : null,
        atrapa: fabryki.createGusClient ? fabryki.createGusClient() : null,
        wczytaj: () => wczytajKonfiguracjeIntegracji(ctx.db, 'gus'),
        fabryka:
          fabryki.createGusClient ??
          (ctx.konfiguracja.proba ? odmowaGusWProbie : (o: { klucz: string; url: string }) => createGusClient(o)),
        adres: ctx.konfiguracja.gusAdres,
      });
      // Sprzedawca specyfikacji — plik albo Ustawienia → Firma (czytane przy każdym dokumencie).
      const adresFirmy = zrodloAdresuFirmy({ db: ctx.db, zPliku: ctx.konfiguracja.nadawca });
      // NIP i BDO specyfikacji — plik albo Ustawienia → Firma (każde pole osobno, czytane przy każdym dokumencie).
      const nipBdoFirmy = zrodloNipuIBdoFirmy({ db: ctx.db, zPliku: ctx.konfiguracja.proforma });
      const opcje = {
        db: ctx.db,
        config: {
          ...ctx.usluga<object>('kanaly', 'config'),
          ...ctx.konfiguracja,
          adresFirmy: adresFirmy.adres,
          nipBdoFirmy: nipBdoFirmy.biezacy,
        },
        poller: ctx.usluga('kanaly', 'poller'),
        stanyKanalow: ctx.usluga('kanaly', 'stanyKanalow'),
        // Pełny skład pobiera pocztę z jedynego modułu wiadomości podczas rejestracji tras.
        wiadomosci: null,
        gus,
        syncSklep,
        zdrowie: null,
      };
      // Reguły powiadomień korzystają z tych samych źródeł co lista zamówień (zdrowie, kopie, KSeF), a te
      // składa dopiero `trasy` — do tego czasu przebieg kończy się błędem w stanie migawki, nie pustą listą.
      const migawka = createMigawkaPowiadomien({
        db: ctx.db,
        teraz: ctx.teraz,
        log: ctx.log,
        zbierz: (teraz: Date) => {
          if (!kontekst) throw new Error('Trasy zamówień nie zostały jeszcze złożone');
          return kontekst.wierszeOstrzezenFirmy(teraz, {
            log: {
              error: (e: unknown, tekst: string) => ctx.log(`${tekst}:`, e instanceof Error ? e.message : String(e)),
            },
          });
        },
      });
      // Status po chwilowej awarii kanału/sklepu wraca sam (zegary.ts).
      const zegary = [
        ...(syncSklep ? [zegarPonawianiaStatusow({ sync: syncSklep, teraz: ctx.teraz, log: ctx.log })] : []),
        zegarMigawkiPowiadomien({ migawka }),
      ];
      return {
        zegary,
        uslugi: {
          // „Przelicz teraz" — po decyzji użytkownika (np. „Ignoruj"), bez czekania na zegar.
          przeliczPowiadomienia: migawka.przeliczTeraz,
          stanMigawkiPowiadomien: migawka.stan,
          dzwonek: (konto: Parameters<typeof powiadomieniaKonta>[1]) => {
            const teraz = ctx.teraz();
            const { aktualne, nieprzeczytane, pilne } = powiadomieniaKonta(ctx.db, konto, { teraz, archiwum: false });
            const stan = migawka.stan();
            return {
              nieprzeczytane,
              pilne: pilne > 0,
              wiersze: aktualne.filter((w) => kluczDozwolony(w.klucz)).slice(0, 5),
              nieaktualne: Boolean(
                stan?.blad_at || (stan?.odswiezone_at && +teraz - Date.parse(stan.odswiezone_at) > 5 * 60_000),
              ),
            };
          },
          config: opcje.config,
          zapytania,
          miniaturyEkranu,
          opcjeTras: opcje,
          syncSklep,
          gus,
          konfiguracjaGus: gus,
          wczytajListe: (...a: Parameters<ReturnType<typeof createKontekstZamowien>['wczytajListe']>) => {
            if (!kontekst) throw new Error('Trasy zamówień nie zostały jeszcze złożone');
            return kontekst.wczytajListe(...a);
          },
          // Flaga „zw” programu fakturowego z kontekstu karty — API panelu liczy tak samo jak karta.
          opcjeZw: () => {
            if (!kontekst) throw new Error('Trasy zamówień nie zostały jeszcze złożone');
            return kontekst.opcjeZw;
          },
          // Odmowa wystawienia faktury (moduł faktur) wraca jako karta z błędem przy polu.
          renderujKarte: (...a: Parameters<ReturnType<typeof createKontekstZamowien>['renderujKarte']>) => {
            if (!kontekst) throw new Error('Trasy zamówień nie zostały jeszcze złożone');
            return kontekst.renderujKarte(...a);
          },
        },
        trasy: (app) => {
          kontekst = createKontekstZamowien({
            ...ctx.usluga<object>('zamowienia', 'opcjeTras'),
            zdrowie: () => {
              let odczyt: () => unknown;
              try {
                odczyt = ctx.usluga<() => unknown>('zdrowie', 'zdrowie');
              } catch (e) {
                if (
                  e instanceof Error &&
                  e.message ===
                    'Usługa „zdrowie.zdrowie" nie istnieje albo moduł „zdrowie" nie jest zbudowany przed wołającym'
                )
                  return null;
                throw e;
              }
              return odczyt();
            },
            // Stan kopii bazy do tabelki ostrzeżeń; bez modułu zdrowie — brak wiersza, nie błąd.
            kopie: () => {
              let odczyt: () => unknown;
              try {
                odczyt = ctx.usluga<() => unknown>('zdrowie', 'kopie');
              } catch (e) {
                if (
                  e instanceof Error &&
                  e.message ===
                    'Usługa „zdrowie.kopie" nie istnieje albo moduł „zdrowie" nie jest zbudowany przed wołającym'
                )
                  return null;
                throw e;
              }
              return odczyt();
            },
            ...(zWiadomosciami ? { wiadomosci: ctx.usluga('wiadomosci', 'wiadomosci') } : {}),
            nadanie: ctx.usluga('wysylka', 'nadanie'),
            kurierzy: ctx.usluga('wysylka', 'kurierzy'),
            przesylkiAllegro: ctx.usluga('wysylka', 'przesylkiAllegro'),
            // GUS jak inne usługi — z rejestru (nadpisanie `zamowienia.gus` w testach), nie z kopii opcji.
            gus: ctx.usluga('zamowienia', 'gus'),
            faktura: ctx.usluga('faktury', 'faktura'),
            proforma: ctx.usluga('faktury', 'proforma'),
            fakturaAllegro: ctx.usluga('faktury', 'fakturaAllegro'),
            fakturaHurtem: ctx.usluga('faktury', 'fakturaHurtem'),
            doczytanieKsef: ctx.usluga('faktury', 'doczytanieKsef'),
            // Przycisk „Wyślij do KSeF” na karcie — tylko gdy jest usługa, do której prowadzi podgląd.
            wysylkaKsef: ctx.usluga('faktury', 'wysylkaKsef'),
            // Nazwa, ekran i reguła VAT programu fakturowego na karcie (klucz `infakt`, jak w 08).
            infakt: ctx.usluga('faktury', 'infakt'),
            // Wybór modułu faktur — zdanie „faktury wyłączone” zamiast „nie jest skonfigurowany”; bez modułu faktur `null`.
            wyborProgramu: (() => {
              try {
                return ctx.usluga('faktury', 'wyborProgramu');
              } catch {
                return null;
              }
            })(),
            // Stan komputerów z drukarką faktur; bez usługi albo przy błędzie `null` = „Drukuj” jak dziś.
            stanDrukuFaktur: () => {
              try {
                return ctx.usluga<() => unknown>('faktury', 'stanDrukuFaktur')() ?? null;
              } catch {
                return null;
              }
            },
            // Niepewne wysyłki KSeF programu wbudowanego (usługa modułu faktur); bez niej — bez ostrzeżenia.
            niepewneKsef: (teraz: Date) => {
              let odczyt: (t: Date) => unknown[];
              try {
                odczyt = ctx.usluga<(t: Date) => unknown[]>('faktury', 'niepewneKsefPonadDobe');
              } catch (e) {
                if (
                  e instanceof Error &&
                  e.message ===
                    'Usługa „faktury.niepewneKsefPonadDobe" nie istnieje albo moduł „faktury" nie jest zbudowany przed wołającym'
                )
                  return [];
                throw e;
              }
              return odczyt(teraz);
            },
          });
          registerListaRoutes(app, kontekst);
          registerPowiadomieniaRoutes(app, { db: ctx.db, przelicz: migawka.przeliczTeraz });
          registerKartaRoutes(app, kontekst);
          registerReczneRoutes(app, kontekst);
          registerScalanieRoutes(app, kontekst);
          // Ustawienia → Integracje → GUS (wzór: ekrany kurierów i inFaktu). Usługa nie z nadpisań `gus`
          // (testy podmieniają tam samego klienta), tylko ta złożona wyżej.
          registerUstawieniaGusRoutes(app, {
            db: ctx.db,
            konfiguracjaGus: ctx.usluga('zamowienia', 'konfiguracjaGus'),
          });
        },
      };
    },
  };
}
export const modulZamowienia = createModulZamowienia();
