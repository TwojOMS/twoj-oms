import { bladKonfiguracji } from './blad-konfiguracji.ts';
import type { Srodowisko } from './kontrakty.ts';
import { integracje } from '../integracje/klucze.js';

export function efektywnyTryb(env: Srodowisko): 'produkcja' | 'proba' {
  const tryb = env.OMS_TRYB;
  if (tryb === undefined || tryb === '' || tryb === 'produkcja') return 'produkcja';
  if (tryb === 'proba') return 'proba';
  throw bladKonfiguracji('OMS_TRYB: dopuszczalne wartości produkcja lub proba');
}

export function sprawdzTrybProby(env: Srodowisko, kluczeIntegracji: readonly string[]): void {
  if (efektywnyTryb(env) !== 'proba') return;
  // SMTP is declared by modulWiadomosci outside the common integration registry.
  const wszystkie = [...new Set([...kluczeIntegracji, ...Object.values(integracje).flatMap(d => d.kluczeIntegracji),
    'SMTP_USER', 'SMTP_PASS'])];
  // Any nonempty raw credential can activate an integration: whitespace counts.
  const ustawione = wszystkie.filter((k) => env[k] !== undefined && env[k] !== '');
  if (ustawione.length) throw bladKonfiguracji(`OMS_TRYB=proba, a ustawione są klucze integracji: ${ustawione.join(', ')} — usuń je z .env próby`);
}
