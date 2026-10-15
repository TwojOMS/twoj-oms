import type { ModulOms, Srodowisko } from '../core/kontrakty.ts';
import { modulRdzen } from './rdzen/modul.ts';
import { modulWeb, createModulWeb } from '../core/web/modul.ts';
import { modulKanaly, createModulKanaly } from './kanaly/modul.ts';
import { definicjeKanalow } from './kanaly/konfiguracja.ts';
import { createModulZamowienia } from './zamowienia/modul.ts';
import { modulFaktury } from './faktury/modul.ts';
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

/** Jedyne miejsce włączenia modułów; kolejność wynika z wymaga. */
export const MODULY: readonly ModulOms[] = [modulRdzen, modulWeb, modulKanaly, modulFaktury,
  modulWiadomosci, createModulZamowienia({ zWiadomosciami: true }), modulWysylka,
  modulMagazyn, modulZwroty, modulUstawienia, modulKoszty, modulRaporty, modulMarketing, modulApiPanelu, modulZdrowie] as readonly ModulOms[];

/** Jedyna zmienna część listy: jawne definicje kanałów danego uruchomienia. */
export function modulyDla(env: Srodowisko): readonly ModulOms[] {
  const definicje = definicjeKanalow(env);
  return MODULY.map(modul => {
    if (modul.nazwa === 'kanaly') return createModulKanaly(definicje, true) as ModulOms;
    if (modul.nazwa === 'web') return createModulWeb(definicje) as ModulOms;
    if (modul.nazwa === 'raporty') return createModulRaporty(definicje) as ModulOms;
    return modul;
  });
}
