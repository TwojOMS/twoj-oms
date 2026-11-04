import type { ModulOms, Srodowisko } from '../core/kontrakty.ts';
import { modulRdzen } from './rdzen/modul.ts';
import { modulWeb, createModulWeb } from '../core/web/modul.ts';
import { modulKanaly, createModulKanaly } from './kanaly/modul.ts';
import { definicjeKanalow, userAgentAllegro } from './kanaly/konfiguracja.ts';
import { createModulZamowienia } from './zamowienia/modul.ts';
import { modulFaktury, createModulFaktury } from './faktury/modul.ts';
import { szewTwojeFaktury } from './faktury/wczytaj-szew.ts';
import type { SzewTwojeFaktury } from './faktury/szew-kontrakt.ts';
import { zgodaTwojeFaktury } from '../domena/wybor-programu.js';
import { modulWysylka } from './wysylka/modul.ts';
import { modulMagazyn } from './magazyn/modul.ts';
import { modulZwroty } from './zwroty/modul.ts';
import { modulUstawienia } from './ustawienia/modul.ts';
import { modulKoszty } from './koszty/modul.ts';
import { modulZdrowie } from './zdrowie/modul.ts';
import { modulMarketing } from './marketing/modul.ts';
import { modulRaporty, createModulRaporty } from './raporty/modul.ts';
import { modulWiadomosci } from './wiadomosci/modul.ts';
import { modulApiPanelu } from './api-panelu/modul.ts';
import { modulAutomatyzacje } from './automatyzacje/modul.ts';

/** Jedyne miejsce włączenia modułów; kolejność wynika z wymaga.
 * PRZ-122.ZGODA-TFc: moduł `twojefaktury` (migracje schematu `tf_*`) rejestruje szew, zaraz po `faktury`; kopia bez
 * modułu TwojeFaktury go nie ma. */
export const MODULY: readonly ModulOms[] = [modulRdzen, modulWeb, modulKanaly, modulFaktury,
  ...(szewTwojeFaktury ? [szewTwojeFaktury.modul] : []), modulWiadomosci, createModulZamowienia({ zWiadomosciami: true }), modulWysylka,
  modulMagazyn, modulZwroty, modulUstawienia, modulAutomatyzacje, modulKoszty, modulRaporty, modulMarketing, modulApiPanelu, modulZdrowie] as readonly ModulOms[];

/** Zgoda instalacji bez rzucania: błędną wartość i tak odrzuca konfiguracja modułu `faktury` (to samo zdanie). */
function zgodaInstalacji(env: Srodowisko): boolean {
  try { return zgodaTwojeFaktury(env); } catch { return false; }
}

/** Jedyna zmienna część listy: jawne definicje kanałów danego uruchomienia.
 * `szewTwojeFaktury` — szew testów (`null` = lista kopii bez modułu TwojeFaktury); bez klucza — szew z drzewa.
 * PRZ-122.AS3: moduł `twojefaktury` (migracje `tf_*`, przedrostki serii próby) tylko przy zgodzie instalacji
 * (`OMS_TWOJEFAKTURY=tak`); bez niej baza nie dostaje tabel TF, a te, które już ma, zostają nietknięte. */
export function modulyDla(env: Srodowisko, o: { szewTwojeFaktury?: SzewTwojeFaktury | null } = {}): readonly ModulOms[] {
  const definicje = definicjeKanalow(env);
  const podmiana = Object.hasOwn(o, 'szewTwojeFaktury');
  const szewDrzewa = podmiana ? o.szewTwojeFaktury ?? null : szewTwojeFaktury;
  const szew = zgodaInstalacji(env) ? szewDrzewa : null;
  return MODULY.filter(modul => modul.nazwa !== 'twojefaktury').flatMap(modul => {
    if (modul.nazwa === 'kanaly') return [createModulKanaly(definicje, true, {userAgent:userAgentAllegro(env)}) as ModulOms];
    if (modul.nazwa === 'web') return [createModulWeb(definicje) as ModulOms];
    if (modul.nazwa === 'raporty') return [createModulRaporty(definicje) as ModulOms];
    if (modul.nazwa === 'faktury') {
      const faktury = podmiana ? createModulFaktury({ fabryki: { szewTwojeFaktury: szewDrzewa } }) as ModulOms : modul;
      return szew ? [faktury, szew.modul] : [faktury];
    }
    return [modul];
  });
}
