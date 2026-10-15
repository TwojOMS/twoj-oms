// PRZ-076 — złożenie OMS-u piaskownicy z atrapami integracji. Woła je deploy/proba/start.mjs i test
// tests/instalacja/atrapy-piaskownicy.test.js — jedna droga, więc test sprawdza dokładnie to, co wstaje w kontenerze.
//
// Wpięcie:
//   • inFakt i VIES — fabryki modułu faktur (createModulFaktury({ fabryki })), jedyny punkt w kodzie produkcji;
//   • Woo i Allegro — `nadpisania` usług kanaly.klienciSklepow / klienciKanalow / config (globalnie: decyzja właściciela
//     14.10 — widzą je wszystkie moduły). Pollery zamówień moduł kanałów buduje u siebie z pustej konfiguracji,
//     więc nie wstają i nie nadpisują zamówień demo.
// ⛔ Każdy krok odmawia poza OMS_TRYB=proba (tryb.mjs, modul faktur, sprawdzTrybProby w rdzeniu).
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { uruchomAplikacje } from '../../../src/core/uruchomienie.ts';
import { sprawdzKonfiguracjeModulow } from '../../../src/core/aplikacja.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { definicjeKanalow, konfiguracjaKanalow } from '../../../src/moduly/kanaly/konfiguracja.ts';
import { createModulZamowienia } from '../../../src/moduly/zamowienia/modul.ts';
import { createAtrapaInfaktu, createAtrapaVies } from './infakt.mjs';
import { createAtrapaGus } from './gus.mjs';
import { createAtrapaLacznosci } from './lacznosc.mjs';
import { zbudujAtrapyKanalow, stanyKanalowAtrapy } from './kanaly.mjs';
import { wymagajTrybuProby } from './tryb.mjs';
import { uruchomPulsPollerow } from './pollery.mjs';
import { ukryjEkranyDemo } from './ekrany.mjs';

export function modulyPiaskownicy(env) {
  wymagajTrybuProby(env, 'moduły piaskownicy');
  const fabryki = {
    createInfaktClient: ({ db, teraz }) => createAtrapaInfaktu({ db, teraz, env }),
    createVies: () => createAtrapaVies({ env }),
  };
  // PRZ-083: GUS — atrapa z komunikatem „nie działa w demo”; moduł zamówień składany z tą samą listą zależności.
  const gus = { createGusClient: () => createAtrapaGus({ env }) };
  return modulyDla(env).map((m) => {
    if (m.nazwa === 'faktury') return createModulFaktury({ fabryki });
    if (m.nazwa === 'zamowienia') return createModulZamowienia({ zWiadomosciami: m.wymaga.includes('wiadomosci'), fabryki: gus });
    return m;
  });
}

export function nadpisaniaPiaskownicy({ db, env, log }) {
  wymagajTrybuProby(env, 'nadpisania piaskownicy');
  const config = konfiguracjaKanalow(definicjeKanalow(env), env, true);
  const atrapy = zbudujAtrapyKanalow({ db, config, log, env });
  return { 'kanaly.klienciSklepow': atrapy.klienciSklepow, 'kanaly.klienciKanalow': atrapy.klienciKanalow, 'kanaly.config': atrapy.config,
    // PRZ-083: Diagnostyka bez połączeń (lacznosc.mjs).
    'ustawienia.lacznosc': createAtrapaLacznosci({ config: atrapy.config, env }),
    // PRZ-083: Integracje widzą kanały Allegro demo jako połączone (kanaly.mjs).
    'kanaly.stanyKanalow': stanyKanalowAtrapy({ config: atrapy.config }) };
}

/** OMS piaskownicy z atrapami. Zwraca to samo co uruchomAplikacje ({ aplikacja, zamknij }). */
export async function uruchomPiaskownice(env = process.env, { host = '0.0.0.0', log } = {}) {
  wymagajTrybuProby(env, 'piaskownica');
  const moduly = modulyPiaskownicy(env);
  sprawdzKonfiguracjeModulow(moduly, env);
  const db = openOmsDb(env.OMS_DB_PATH, { moduly });
  const nadpisania = nadpisaniaPiaskownicy({ db, env, log });
  ukryjEkranyDemo(db, env);
  // Źródła jak w zdrowiu (moduly/zdrowie/modul.ts): klucze sklepów i kanałów z konfiguracji, którą widzą moduły.
  const config = nadpisania['kanaly.config'];
  const zatrzymajPuls = uruchomPulsPollerow({ db, env, zrodla: [...Object.keys(config.sklepy ?? {}), ...Object.keys(config.kanaly ?? {})] });
  const wynik = await uruchomAplikacje({ moduly, env, db, host, port: Number(env.OMS_PORT || 3001), nadpisania, ...(log ? { log } : {}) });
  return { ...wynik, zamknij: async () => { zatrzymajPuls(); return wynik.zamknij(); } };
}
