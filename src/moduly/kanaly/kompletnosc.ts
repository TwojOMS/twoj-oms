import type { Srodowisko } from '../../core/kontrakty.ts';
import type { DefinicjaKanalu } from './konfiguracja.ts'; import { modulKanalu } from '../../domena/moduly-kanalow.ts';

/** Wymagane nazwy z rejestru. Nigdy nie zwraca wartości poświadczeń. */
export function brakujaceKluczeKanalu(d: DefinicjaKanalu, env: Srodowisko): string[] {
  const sufiksy = modulKanalu(d.typ).kluczeEnv.wymagane;
  return sufiksy.map(s => `${d.prefiks}_${s}`).filter(n => !(env[n] ?? '').trim());
}
