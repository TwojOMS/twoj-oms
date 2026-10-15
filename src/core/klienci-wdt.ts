import type { Srodowisko } from './kontrakty.ts';

/** Jedna lista dla specyfikacji i blokady importu historii. Alias nie wygrywa z pustą listą. */
export function wczytajKlientowWdt(env: Srodowisko): Set<string> {
  const lista = (v: string | undefined) => new Set((v ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const kanoniczna = lista(env.OMS_KLIENCI_WDT);
  const alias = lista(env.OMS_HISTORIA_MAILE_WDT);
  if (env.OMS_KLIENCI_WDT !== undefined && env.OMS_HISTORIA_MAILE_WDT !== undefined
    && (kanoniczna.size !== alias.size || [...kanoniczna].some(email => !alias.has(email)))) {
    throw new Error('Konflikt OMS_KLIENCI_WDT i OMS_HISTORIA_MAILE_WDT — ustaw jedną listę albo dwie równoważne.');
  }
  return env.OMS_KLIENCI_WDT !== undefined ? kanoniczna : alias;
}
