import type { KanalSprzedazy, Kurier } from '../core/kontrakty.ts';
import { createWooAdapter as woo } from '../oms/woo/adapter.js';
import { createAllegroAdapter as allegro } from '../oms/allegro/adapter.js';
import { createDpdClient as dpd } from '../oms/kurierzy/dpd.js';
import { createInpostClient as inpost } from '../oms/kurierzy/inpost.js';
import { createAllegroWzaClient as wza } from '../oms/kurierzy/allegro-wza.js';

// Sprawdzane przez tsc na rzeczywistym wyniku fabryki, bez rzutowania wyniku.
// Moduły mogą importować te same nazwane fabryki z tego pliku.
export function createWooAdapter(o: Parameters<typeof woo>[0]) {
  return woo(o) satisfies KanalSprzedazy;
}
export function createAllegroAdapter(o: Parameters<typeof allegro>[0]) {
  return allegro(o) satisfies KanalSprzedazy;
}
export function createDpdClient(o: Parameters<typeof dpd>[0]) {
  return dpd(o) satisfies Kurier;
}
export function createInpostClient(o: Parameters<typeof inpost>[0]) {
  return inpost(o) satisfies Kurier;
}
export function createAllegroWzaClient(o: Parameters<typeof wza>[0]) {
  return wza(o) satisfies Kurier;
}
