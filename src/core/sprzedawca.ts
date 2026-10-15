import type { Srodowisko } from './kontrakty.ts';
import { poprawnyNip, poprawnyRachunek } from './walidatory.ts';

export type DaneSprzedawcy = { nip: string; rachunek: string; bdo: string | null; bank: string | null };

const oczysc = (v: string) => v.replace(/^PL/i, '').replace(/[\s-]/g, '');

/** Dane sprzedawcy wyłącznie z konfiguracji; brak blokuje start. */
export function wczytajSprzedawce(env: Srodowisko): DaneSprzedawcy {
  const bledy: string[] = [];
  const nipSurowy = env.OMS_SPRZEDAWCA_NIP?.trim() ?? '';
  const rachSurowy = env.OMS_RACHUNEK?.trim() ?? '';
  const nip = oczysc(nipSurowy);
  const rachunek = oczysc(rachSurowy);
  if (!nipSurowy) bledy.push('Brak wymaganej zmiennej: OMS_SPRZEDAWCA_NIP');
  else if (!poprawnyNip(nip)) bledy.push('OMS_SPRZEDAWCA_NIP: niepoprawny NIP (10 cyfr, suma kontrolna)');
  if (!rachSurowy) bledy.push('Brak wymaganej zmiennej: OMS_RACHUNEK');
  else if (!poprawnyRachunek(rachunek)) bledy.push('OMS_RACHUNEK: niepoprawny numer rachunku (NRB, 26 cyfr, suma kontrolna)');
  const bdo = env.OMS_SPRZEDAWCA_BDO?.trim() || null;
  if (bdo && !/^\d{9}$/.test(bdo)) bledy.push('OMS_SPRZEDAWCA_BDO: oczekiwano 9 cyfr');
  if (bledy.length) throw new Error(bledy.join('\n'));
  return { nip, rachunek, bdo, bank: env.OMS_BANK?.trim() || null };
}
