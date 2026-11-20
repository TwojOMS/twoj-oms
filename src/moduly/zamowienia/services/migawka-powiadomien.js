// src/moduly/zamowienia/services/migawka-powiadomien.js
//
// Przebieg migawki powiadomień: zbiera sprawy firmy regułami z `domena/ostrzezenia.js`, scala z poprzednim
// przebiegiem i zapisuje w jednej transakcji. Liczy się w tle (zegar modułu), żeby dzwonek i lista nie
// odpalały kilkunastu zapytań przy każdym wejściu na stronę.

import { performance } from 'node:perf_hooks';
import { scalMigawke } from '../../../domena/migawka-powiadomien.js';
import {
  wczytajMigawke,
  zapiszMigawke,
  zapiszBladMigawki,
  stanMigawki,
} from '../../../oms/db/powiadomienia-migawka.js';
import { odrzucenia } from '../../../oms/db/ostrzezenia.js';

// Co minutę: sprawy z reguł (stan magazynu, terminy, awarie) mają się pojawić w dzwonku szybko, a jeden
// przebieg na bazie demo trwa milisekundy (pomiar: `scripts/pomiar-migawki-powiadomien.mjs`).
export const ODSTEP_MIGAWKI_POWIADOMIEN_MS = 60 * 1000;

export const POWOD_TRWA = 'poprzedni przebieg jeszcze trwa';

/**
 * @typedef {{ wiersze: object[], nieudane?: { zrodlo: string, prefiks: string }[] }} Zebrane
 * @param {{ db: import('node:sqlite').DatabaseSync,
 *   zbierz: (teraz: Date) => object[] | Zebrane | Promise<object[] | Zebrane>,
 *   teraz?: () => Date, mierz?: () => number, log?: (...t: string[]) => void }} o
 *   `zbierz` — wiersze reguł dla całej firmy (bez filtrów konta) albo `{ wiersze, nieudane }`, gdy część
 *   źródeł zawiodła; rzuca, gdy zebrać się nie da wcale.
 */
export function createMigawkaPowiadomien({
  db,
  zbierz,
  teraz = () => new Date(),
  mierz = () => performance.now(),
  log = () => {},
}) {
  // Jeden przebieg naraz: zegar i „przelicz teraz" po „Ignoruj" mogą przyjść jednocześnie, a dwa scalenia
  // z tym samym `poprzednie` zapisałyby tę samą sprawę dwa razy jako nową.
  let trwa = null;
  let ponow = false;

  async function jedenPrzebieg() {
    const chwila = teraz();
    const start = mierz();
    try {
      const zebrane = await zbierz(chwila);
      const nowe = Array.isArray(zebrane) ? zebrane : zebrane.wiersze;
      const nieudane = Array.isArray(zebrane) ? [] : (zebrane.nieudane ?? []);
      const zmiany = scalMigawke({
        poprzednie: wczytajMigawke(db),
        nowe,
        teraz: chwila,
        odrzucone: odrzucenia(db),
        nieudane: nieudane.map((n) => n.prefiks),
      });
      const czasMs = mierz() - start;
      // Źródło, które nie odpowiedziało, zostawia swoje sprawy jak były (`scalMigawke`), a ślad idzie do stanu
      // (`/health`); przebieg bez awarii źródeł błąd czyści.
      const blad = nieudane.length ? nieudane.map((n) => `źródło ${n.zrodlo} nie odpowiedziało`).join('; ') : null;
      zapiszMigawke(db, zmiany, { teraz: chwila, czasMs, blad });
      if (blad) log('migawka powiadomień:', blad);
      return {
        czasMs,
        nowych: zmiany.wstaw.length + zmiany.wroc.length,
        rozwiazanych: zmiany.rozwiaz.length,
        usunietych: zmiany.usun.length,
      };
    } catch (e) {
      // Zebrać się nie dało wcale (np. baza nie odpowiada): migawka zostaje z ostatniego udanego przebiegu, bo
      // awaria zbierania nie może wyglądać jak „wszystko rozwiązane". Błąd idzie do stanu (`/health`) i logu.
      // Awarię pojedynczego źródła obsługuje gałąź wyżej — reszta spraw się odświeża.
      const blad = e instanceof Error ? e.message : String(e);
      try {
        zapiszBladMigawki(db, blad, { teraz: chwila });
      } catch (e2) {
        log('migawka powiadomień: nie zapisałem błędu:', e2 instanceof Error ? e2.message : String(e2));
      }
      log('migawka powiadomień:', blad);
      return { blad };
    }
  }

  /** Przebieg zegara. Gdy poprzedni trwa — pomija (zegar i tak tyka co minutę). */
  async function przebieg() {
    if (trwa) return { pominiety: true, powod: POWOD_TRWA };
    trwa = (async () => {
      try {
        let wynik = await jedenPrzebieg();
        while (ponow) {
          ponow = false;
          wynik = await jedenPrzebieg();
        }
        return wynik;
      } finally {
        trwa = null;
      }
    })();
    return trwa;
  }

  /**
   * „Przelicz teraz" — po decyzji użytkownika (np. „Ignoruj"). Gdy przebieg trwa, po nim idzie jeszcze jeden,
   * bo trwający mógł przeczytać ignorowania sprzed decyzji.
   */
  async function przeliczTeraz() {
    if (trwa) {
      ponow = true;
      return trwa;
    }
    return przebieg();
  }

  return { przebieg, przeliczTeraz, stan: () => stanMigawki(db) };
}
