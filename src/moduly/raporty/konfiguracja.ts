import type { Srodowisko } from '../../core/kontrakty.ts';
import { definicjeKanalow, type DefinicjaKanalu } from '../kanaly/konfiguracja.ts';
import { wczytajKlasyfikacje } from '../kanaly/klasyfikacja.ts';
import { regulyHistorii } from '../kanaly/historia.ts';
import { kluczOkresu } from '../../domena/okres-rozliczeniowy.js';

/** Daty pokrycia opisują dane danej instalacji, nie daty wdrożenia firmy autora. */
function dzien(env: Srodowisko, klucz: string): string | null {
  const wartosc = env[klucz]?.trim();
  if (!wartosc) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(wartosc)) throw new Error(`${klucz}: oczekiwany dzień RRRR-MM-DD`);
  try { kluczOkresu(wartosc); }
  catch { throw new Error(`${klucz}: niepoprawna data kalendarzowa`); }
  return wartosc;
}

export function wczytajRaporty(env: Srodowisko) {
  return wczytajRaportyDlaKanalow(env, definicjeKanalow(env));
}

export function wczytajRaportyDlaKanalow(env: Srodowisko, definicje: readonly DefinicjaKanalu[]) {
  const klasyfikacja = wczytajKlasyfikacje(env, definicje);
  const konto = env.OMS_RAPORTY_KONTO_HISTORII?.trim();
  const kontoHistorii = konto ? Number(konto) : null;
  if (kontoHistorii !== null && (!/^\d+$/.test(konto!) || !Number.isSafeInteger(kontoHistorii) || kontoHistorii < 0)) {
    throw new Error('OMS_RAPORTY_KONTO_HISTORII: oczekiwany bezpieczny całkowity identyfikator konta >= 0');
  }
  if (kontoHistorii !== null && !klasyfikacja.konta.has(kontoHistorii)) throw new Error('OMS_RAPORTY_KONTO_HISTORII: nieznane konto historii');
  let nazwy: unknown;
  try {
    nazwy = JSON.parse(env.OMS_RAPORTY_NAZWY_KANALOW ?? '{}');
  } catch {
    throw new Error('OMS_RAPORTY_NAZWY_KANALOW: niepoprawny JSON');
  }
  if (!nazwy || typeof nazwy !== 'object' || Array.isArray(nazwy)
    || Object.values(nazwy).some(v => typeof v !== 'string' || !v.trim())) {
    throw new Error('OMS_RAPORTY_NAZWY_KANALOW: oczekiwany obiekt niepustych etykiet kanałów');
  }
  for (const kanal of Object.keys(nazwy)) if (!klasyfikacja.raporty.has(kanal)) throw new Error('OMS_RAPORTY_NAZWY_KANALOW: nieznany kanał raportowy');
  return {
    regulySprzedazy: { ...regulyHistorii(env), klasyfikacja },
    kontoHistorii,
    podlogaZwrotow: dzien(env, 'OMS_RAPORTY_PODLOGA_ZWROTOW'),
    pierwszyDzienOms: dzien(env, 'OMS_STATYSTYKI_PIERWSZY_DZIEN'),
    nazwyKanalow: nazwy as Record<string, string>,
    nazwaSklepuHistorii: env.OMS_RAPORTY_SKLEP_HISTORII?.trim() || null,
    dataImportuHistorii: dzien(env, 'OMS_RAPORTY_DATA_IMPORTU_HISTORII'),
    podlogaKosztow: (() => {
      const m = env.OMS_RAPORTY_PODLOGA_KOSZTOW?.trim();
      if (!m) return null;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new Error('OMS_RAPORTY_PODLOGA_KOSZTOW: oczekiwany miesiąc RRRR-MM');
      return m;
    })(),
  };
}

export type KonfiguracjaRaportow = ReturnType<typeof wczytajRaporty>;
