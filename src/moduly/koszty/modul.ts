import type { ModulOms, Srodowisko } from '../../core/kontrakty.ts';
import { wczytajSprzedawce } from '../../core/sprzedawca.ts';
import { integracje } from '../../integracje/klucze.js';
import { ODSTEP_OKNA_POBRANIA_MS } from '../../domena/pora-pobrania.js';
import { znormalizujNip } from '../../domena/gus.js';
import { createKsefClient } from '../../oms/ksef/client.js';
import { createSesjaKsef, odciskTokenuKsef } from '../../oms/ksef/sesja.js';
import { stanKosztow } from '../../oms/db/koszty.js';
import { createCzuwaczKosztow, NAJDLUZSZY_PRZEBIEG_KOSZTOW_MS } from './services/czuwacz-kosztow.js';
import { createWizualizacjaKosztu } from './services/wizualizacja-kosztu.js';
import { createPaczkaDlaBiura } from './services/paczka-dla-biura.js';
import { zarejestrujTrasyKosztow } from './trasy/koszty.js';
import { zegarKosztow } from './zegary.ts';
import { skonfigurowanyUrl } from '../../core/konfiguracja-wartosci.ts';
import { efektywnyTryb } from '../../core/tryb.ts';
import { wczytajKonfiguracjeIntegracji } from '../../oms/db/konfiguracja-integracji.js';
import { wylaczoneModuly, kosztyWlaczoneOd } from '../../oms/db/moduly-opcjonalne.js';
import { zrodloKsefKosztow, czuwaczZeZrodla, wizualizacjaZeZrodla, odmowaKsefWProbie, type KlientKsef, type ZestawKsef } from './ksef-ustawien.ts';
import { registerUstawieniaKsefRoutes } from './trasy/ustawienia-ksef.js';
import { zrodloNipuIBdoFirmy } from '../../oms/db/nip-bdo-firmy.js';

export const ODSTEP_KOSZTOW_MS = 3600000;
export function wczytajKoszty(env: Srodowisko) {
  skonfigurowanyUrl(env.KSEF_API, 'KSEF_API');
  // Frozen porównuje kosztowy przebieg z dobą: 23 tyknięcia poza oknem i tak pomija.
  if (NAJDLUZSZY_PRZEBIEG_KOSZTOW_MS >= ODSTEP_OKNA_POBRANIA_MS) throw new Error('Budżet czuwacza kosztów nie mieści się przed następnym dobowym oknem pobrania.');
  const token = env.KSEF_TOKEN?.trim();
  if ((env.KSEF_TOKEN || env.KSEF_NIP || env.KSEF_API || env.KSEF_ARCHIWUM) && !token) throw new Error('Sekcja KSeF wymaga KSEF_TOKEN.');
  // PRZ-102.22: NIP sprzedawcy także bez tokenu w pliku — to kontekst logowania tokenem z Ustawień → Integracje → KSeF.
  const nip = nipSprzedawcy(env, Boolean(token));
  if (token && env.KSEF_NIP?.trim() && znormalizujNip(env.KSEF_NIP) !== nip) throw new Error('KSEF_NIP musi być zgodny z OMS_SPRZEDAWCA_NIP.');
  // Adres API tylko z pliku — ten sam dla tokenu z pliku i z ekranu.
  const baseUrl = env.KSEF_API?.trim().replace(/\/+$/, '') || undefined;
  return { ksef: token ? { token, nip: nip!, baseUrl } : null, nipSprzedawcy: nip, adresKsef: baseUrl,
    // Piaskownica: token z ekranu nie wychodzi do KSeF (atrapa albo odmowa).
    proba: efektywnyTryb(env) === 'proba',
    katalogKosztow: env.KSEF_ARCHIWUM?.trim() || null, katalogSprzedazy: env.INFAKT_ARCHIWUM?.trim() || null,
    odstepMs: ODSTEP_KOSZTOW_MS };
}
// Z tokenem w pliku brak NIP-u sprzedawcy W PLIKU zatrzymuje start jak dotąd (token z pliku = kontekst z pliku; KSEF_NIP
// porównujemy przy starcie). Bez tokenu w pliku NIP z pliku jest tylko pierwszym źródłem — PRZ-108.10: zbuduj czyta
// bieżący NIP (plik → Ustawienia → Firma) przy każdym użyciu tokenu z ekranu.
function nipSprzedawcy(env: Srodowisko, wymagany: boolean): string | null {
  let nip: string | null = null;
  try { nip = wczytajSprzedawce(env).nip; } catch (e) { if (wymagany) throw e; return null; }
  if (wymagany && !nip) throw new Error(BRAK_NIP_PRZY_TOKENIE);
  return nip;
}
const BRAK_NIP_PRZY_TOKENIE = 'KSEF_TOKEN w pliku konfiguracji wymaga OMS_SPRZEDAWCA_NIP w tym samym pliku (10 cyfr) — token loguje do KSeF w kontekście tej firmy. Dopisz NIP do pliku albo usuń KSEF_TOKEN i dodaj token w Ustawienia → Integracje → KSeF.';

const najpozniejsza = (daty: (string | null)[]): string | null =>
  daty.filter((d): d is string => Boolean(d)).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;

type FabrykaKsef = (o: { token: string; nip: string; baseUrl?: string }) => KlientKsef;
// PRZ-102.22: `atrapaKsef` — atrapa klienta KSeF piaskownicy i demo (deploy/proba/atrapy/ksef.mjs) dla tokenu z Ustawień,
// jak `fabryki.createGusClient` w module zamówień. Poza OMS_TRYB=proba odmowa już przy konfiguracji.
export function createModulKoszty(o: { createKlient?: typeof createKsefClient; atrapaKsef?: FabrykaKsef; fabryki?: Record<string, (...args: any[]) => any> } = {}): ModulOms<ReturnType<typeof wczytajKoszty>> {
  return {
    nazwa: 'koszty', wersja: '1.0.0', wymaga: ['rdzen', 'web', 'faktury'],
    kluczeIntegracji: [...integracje.ksef.kluczeIntegracji],
    konfiguracja: env => {
      const k = wczytajKoszty(env);
      if (o.atrapaKsef && !k.proba) throw new Error('Fabryka atrapaKsef (atrapa KSeF piaskownicy) wolno podać tylko w trybie próby (OMS_TRYB=proba)');
      return k;
    },
    migracje: [],
    uprawnienia: [{ klucz: 'koszty', etykieta: 'Koszty', role: ['admin', 'operator'] }],
    menu: [{ dzial: 'analizy-cele', grupa: 'analizy-cele', etykieta: 'Koszty', adres: '/koszty', uprawnienie: 'koszty', kolejnosc: 40 }],
    zbuduj: ctx => {
      const { db, konfiguracja: k, teraz, log } = ctx;
      const infakt = ctx.usluga<any>('faktury', 'infakt');
      // Jeden zestaw = jeden klient, JEDNA trwała sesja (tokeny_ksef) i czuwacz/wizualizacja na tej samej sesji —
      // druga sesja na tym samym kliencie to drugie odświeżanie jednorazowego refresh tokenu.
      // PRZ-102.22 (recenzja): sesja zna odcisk tokenu, którym ją wydano — para innego tokenu to dla niej brak pary.
      const zestaw = (klient: KlientKsef, t: { token: string; nip: string }): ZestawKsef => {
        const sesja = createSesjaKsef({ db, klient, teraz, odcisk: odciskTokenuKsef(t) });
        return { klient, sesja,
          czuwacz: (o.fabryki?.createCzuwaczKosztow ?? createCzuwaczKosztow)({ db, klient, sesja, teraz, log, katalogArchiwum: k.katalogKosztow } as any),
          wizualizacja: (o.fabryki?.createWizualizacjaKosztuFn ?? createWizualizacjaKosztu)({ db, klient, sesja } as any) };
      };
      const zPliku = k.ksef ? zestaw((o.createKlient ?? createKsefClient)({ ...k.ksef, fetchImpl: undefined }) as KlientKsef, k.ksef) : null;
      // PRZ-102.22: plik → panel → brak, przy każdym użyciu (ksef-ustawien.ts). Piaskownica: atrapa albo odmowa.
      const fabryka: FabrykaKsef = o.atrapaKsef ?? (k.proba ? odmowaKsefWProbie
        : (opcje) => (o.createKlient ?? createKsefClient)({ ...opcje, fetchImpl: undefined }) as KlientKsef);
      // PRZ-108.10: kontekst tokenu z ekranu = bieżący NIP firmy (plik → Ustawienia → Firma), czytany przy każdym użyciu.
      const nipFirmy = zrodloNipuIBdoFirmy({ db, zPliku: { nip: k.nipSprzedawcy } });
      const nipTeraz = () => nipFirmy.biezacy().nip;
      const zrodloKsef = zrodloKsefKosztow({ zPliku, wczytaj: () => wczytajKonfiguracjeIntegracji(db, 'ksef'),
        nipSprzedawcy: nipTeraz, baseUrl: k.adresKsef, fabryka, zestaw, teraz,
        // Ustawienia → Moduły: sprawdzane przy każdym przebiegu i każdym PDF-ie, bez restartu.
        wylaczony: () => wylaczoneModuly(db).includes('koszty') });
      const czuwaczKosztow = czuwaczZeZrodla(zrodloKsef);
      const wizualizacjaKosztu = wizualizacjaZeZrodla(zrodloKsef);
      const paczkaDlaBiura = infakt ? (o.fabryki?.createPaczkaDlaBiuraFn ?? createPaczkaDlaBiura)({ db, infakt, wizualizacjaKosztu,
        katalogSprzedazy: k.katalogSprzedazy, katalogKosztow: k.katalogKosztow, teraz, log } as any) : null;
      // `ksefKlient`/`ksefSesja` — zestaw z PLIKU (null bez KSEF_TOKEN); bieżący zestaw (także z panelu) daje `zrodloKsef`.
      return { uslugi: { config: k, ksefKlient: zPliku?.klient ?? null, ksefSesja: zPliku?.sesja ?? null, zrodloKsef,
        czuwaczKosztow, wizualizacjaKosztu, paczkaDlaBiura,
        stanKosztow: () => stanKosztow(db),
        // PRZ-102.22: funkcje, nie wartości z chwili startu — token z panelu i przełącznik modułu działają bez restartu.
        kosztyWlaczone: () => czuwaczKosztow.dostepny(), modulWylaczony: () => zrodloKsef.wylaczony(),
        // Od kiedy pobieranie jest włączone (próg /health liczy się od tej chwili, jeśli jest późniejsza niż ostatnie
        // udane pobranie): zapis tokenu z ekranu (gdy to on jest w użyciu) albo włączenie modułu w Ustawienia → Moduły.
        wlaczoneOd: () => najpozniejsza([zrodloKsef.zEnv ? null : wczytajKonfiguracjeIntegracji(db, 'ksef')?.zmienionoAt ?? null,
          kosztyWlaczoneOd(db)]) },
        trasy: app => {
          zarejestrujTrasyKosztow(app, { db,
            czuwaczKosztow: ctx.usluga<any>('koszty', 'czuwaczKosztow'),
            wizualizacjaKosztu: ctx.usluga<any>('koszty', 'wizualizacjaKosztu'),
            paczkaDlaBiura: ctx.usluga<any>('koszty', 'paczkaDlaBiura') } as any);
          registerUstawieniaKsefRoutes(app, { db, zrodloKsef, nipSprzedawcy: nipTeraz });
        },
        // Zegar stoi zawsze: token zapisany w panelu ma pobierać od następnego tyknięcia. Bez tokenu albo przy
        // wyłączonym module przebieg wraca od razu jako pominięty (zegar loguje tylko „jeszcze trwa”).
        zegary: [zegarKosztow({ czuwacz: czuwaczKosztow, odstepMs: k.odstepMs, log })],
      };
    },
  };
}
export const modulKoszty = createModulKoszty();
