import type { Srodowisko } from '../../core/kontrakty.ts';
import type { DefinicjaKanalu } from './konfiguracja.ts';

/** Zamknięte rodziny wymaganych nazw. Nigdy nie zwraca wartości poświadczeń. */
export function brakujaceKluczeKanalu(d: DefinicjaKanalu, env: Srodowisko): string[] {
  const sufiksy = d.typ === 'woo' ? ['URL','CK','CS','MAPOWANIE'] : ['CLIENT_ID','CLIENT_SECRET','USER_AGENT','OD'];
  return sufiksy.map(s => `${d.prefiks}_${s}`).filter(n => !(env[n] ?? '').trim());
}
