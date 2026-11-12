// PRZ-076 — złożenie OMS-u piaskownicy z atrapami integracji. Woła je deploy/proba/start.mjs i test
// tests/instalacja/atrapy-piaskownicy.test.js — jedna droga, więc test sprawdza dokładnie to, co wstaje w kontenerze.
//
// Wpięcie:
//   • poczta — moduł wiadomości z atrapą mailera (poczta.mjs, PRZ-087);
//   • KSeF kosztów — atrapa klienta dla tokenu z Ustawień (ksef.mjs, PRZ-102.22), fabryka modułu kosztów;
//   • inFakt i VIES — fabryki modułu faktur (createModulFaktury({ fabryki })), jedyny punkt w kodzie produkcji;
//   • Woo i Allegro — atrapy scalone z usługami modułu kanałów (widzą je wszystkie moduły).
//     Pollery zamówień moduł kanałów buduje u siebie z pustej konfiguracji,
//     więc nie wstają i nie nadpisują zamówień demo.
//   • ERLI z panelu — fetchImpl modułu kanałów: host atrapy z konfiguracji → stan atrapy w tej bazie;
//     oficjalny sandbox z własnym kluczem używa sieci, produkcja pozostaje zablokowana.
//     Zamówienia zapisuje zwykły poller z adapterem ERLI.
// ⛔ Każdy krok odmawia poza OMS_TRYB=proba (tryb.mjs, modul faktur, sprawdzTrybProby w rdzeniu).
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { uruchomAplikacje } from '../../../src/core/uruchomienie.ts';
import { sprawdzKonfiguracjeModulow } from '../../../src/core/aplikacja.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { definicjeKanalow, konfiguracjaKanalow } from '../../../src/moduly/kanaly/konfiguracja.ts';
import { createModulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { transportErliPiaskownicy } from './erli.mjs';
import { createModulZamowienia } from '../../../src/moduly/zamowienia/modul.ts';
import { createAtrapaInfaktu, createAtrapaVies } from './infakt.mjs';
import { createAtrapaGus } from './gus.mjs';
import { createAtrapaKsef } from './ksef.mjs';
import { createAtrapaKsefWysylki } from './ksef-wysylka.mjs';
import { createModulKoszty } from '../../../src/moduly/koszty/modul.ts';
import { MODULY_KURIEROW } from '../../../src/domena/moduly-kurierow.ts';
import { createModulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { createModulWiadomosciAtrapy } from './poczta.mjs';
import { createAtrapaLacznosci } from './lacznosc.mjs';
import { zbudujAtrapyKanalow, scalUslugiKanalow } from './kanaly.mjs';
import { wymagajTrybuProby } from './tryb.mjs';
import { uruchomPulsPollerow } from './pollery.mjs';
import { ukryjEkranyDemo } from './ekrany.mjs';

// Ścieżki w rejestrze są względem korzenia repozytorium; import wykonujemy raz, bez uruchamiania serwera.
const atrapyKurierow = await Promise.all(Object.values(MODULY_KURIEROW)
  .filter((opis) => opis.piaskownica.atrapa.trim())
  .map(async (opis) => ({ opis, modul: await import(new URL(`../../../${opis.piaskownica.atrapa}`, import.meta.url).href) })));

export function fabrykiKurierowPiaskownicy({ env, baza = () => null }) {
  wymagajTrybuProby(env, 'fabryki kurierów piaskownicy');
  return Object.fromEntries(atrapyKurierow.map(({ opis, modul }) => [
    `create${opis.klucz[0].toUpperCase()}${opis.klucz.slice(1)}`, modul.createAtrapa({ env, baza }),
  ]));
}

// PRZ-108.09: `baza` — funkcja oddająca bazę piaskownicy (otwiera się DOPIERO po złożeniu modułów, bo migracje biorą
// listę modułów). Atrapy kurierów czytają z niej `utworzona_at` paczki, żeby oddać realistyczny przebieg statusów.
/** @param {any} env @param {{baza?:()=>import('node:sqlite').DatabaseSync|null}} [opcje] */
export function modulyPiaskownicy(env, { baza = () => null } = {}) {
  wymagajTrybuProby(env, 'moduły piaskownicy');
  // Szew składa KSeF raz. Pamiętamy instancję także przy ponownym wywołaniu fabryki: numery i awaria zostają.
  let ksefWysylki;
  const fabryki = {
    atrapaKsefWysylki: () => (ksefWysylki ??= {
      ...createAtrapaKsefWysylki({ env }),
      fabryka: ({ token }) => createAtrapaKsef({ env, token }),
      spij: async () => {},
    }),
    createInfaktClient: ({ db, teraz }) => createAtrapaInfaktu({ db, teraz, env }),
    createVies: () => createAtrapaVies({ env }),
    // PRZ-121.06: „Uruchom OMS ponownie” — kontener piaskownicy startuje przez `node --watch-path`, który po wyjściu
    // dziecka czeka na zmianę pliku zamiast je podnieść. SIGTERM do rodzica (watch): zamyka dziecko i wychodzi,
    // kontener kończy się, a Docker (`restart: unless-stopped`) podnosi go od nowa. Rodzica tylko pod `--watch` (node
    // ustawia dziecku WATCH_REPORT_DEPENDENCIES) — inaczej rodzicem bywa systemd użytkownika; wtedy sygnał do siebie.
    // Bezpiecznik (recenzja): dziecko wychodzi po 20 s, gdyby zawieszony przebieg zegara trzymał je po zamknięciu.
    zakonczProces: () => {
      process.kill(process.env.WATCH_REPORT_DEPENDENCIES ? process.ppid : process.pid, 'SIGTERM');
      setTimeout(() => process.exit(0), 20_000).unref();
    },
  };
  // PRZ-083: GUS — atrapa z komunikatem „nie działa w demo”; moduł zamówień składany z tą samą listą zależności.
  // PRZ-102.11: z kluczem z Ustawień (opcje { klucz, url }) — dla „Sprawdź połączenie” na ekranie GUS.
  const gus = { createGusClient: (opcje) => createAtrapaGus({ env, klucz: opcje?.klucz ?? null }) };
  return modulyDla(env).map((m) => {
    if (m.nazwa === 'kanaly') {
      const modul = createModulKanaly(definicjeKanalow(env), true,
        { fetchImpl: transportErliPiaskownicy({ baza, env }) });
      return { ...modul, zbuduj: ctx => {
        const z = modul.zbuduj(ctx);
        scalUslugiKanalow(z.uslugi, zbudujAtrapyKanalow({ db: ctx.db, config: ctx.konfiguracja, log: ctx.log, env }), ctx.teraz);
        return z;
      } };
    }
    if (m.nazwa === 'faktury') return createModulFaktury({ fabryki });
    // PRZ-087: poczta — atrapa bez wysyłki, żeby karta zamówienia miała sekcję wiadomości (poczta.mjs).
    if (m.nazwa === 'wiadomosci') return createModulWiadomosciAtrapy(env);
    // PRZ-102.22: token KSeF z Ustawień (faktury kosztowe) — atrapa zamiast prawdziwego klienta (ksef.mjs).
    if (m.nazwa === 'koszty') return createModulKoszty({ atrapaKsef: ({ token }) => createAtrapaKsef({ env, token }) });
    if (m.nazwa === 'zamowienia') return createModulZamowienia({ zWiadomosciami: m.wymaga.includes('wiadomosci'), fabryki: gus });
    if (m.nazwa === 'wysylka') return createModulWysylka({ fabryki: fabrykiKurierowPiaskownicy({ env, baza }) });
    return m;
  });
}

export function nadpisaniaPiaskownicy({ db, env, log }) {
  wymagajTrybuProby(env, 'nadpisania piaskownicy');
  const config = konfiguracjaKanalow(definicjeKanalow(env), env, true);
  const atrapy = zbudujAtrapyKanalow({ db, config, log, env });
  return {
    // PRZ-083: Diagnostyka bez połączeń (lacznosc.mjs).
    'ustawienia.lacznosc': createAtrapaLacznosci({ config: atrapy.config, env }) };
}

/** OMS piaskownicy z atrapami. Zwraca to samo co uruchomAplikacje ({ aplikacja, zamknij }). */
export async function uruchomPiaskownice(env = process.env, { host = '0.0.0.0', log } = {}) {
  wymagajTrybuProby(env, 'piaskownica');
  let db = null;
  const moduly = modulyPiaskownicy(env, { baza: () => db });
  sprawdzKonfiguracjeModulow(moduly, env);
  db = openOmsDb(env.OMS_DB_PATH, { moduly });
  const nadpisania = nadpisaniaPiaskownicy({ db, env, log });
  ukryjEkranyDemo(db, env);
  // Źródła jak w zdrowiu (moduly/zdrowie/modul.ts): klucze sklepów i kanałów z konfiguracji, którą widzą moduły.
  const wynik = await uruchomAplikacje({ moduly, env, db, host, port: Number(env.OMS_PORT || 3001), nadpisania, ...(log ? { log } : {}) });
  const config = wynik.aplikacja.usluga('kanaly', 'config');
  const zatrzymajPuls = uruchomPulsPollerow({ db, env, zrodla: [...Object.keys(config.sklepy ?? {}), ...Object.keys(config.kanaly ?? {})] });
  return { ...wynik, zamknij: async () => { zatrzymajPuls(); return wynik.zamknij(); } };
}
