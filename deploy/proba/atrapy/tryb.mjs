// PRZ-076 — bezpiecznik atrap: każda atrapa odmawia powstania poza OMS_TRYB=proba. Trzecia bariera obok
// (1) obrazu produkcji, który nie kopiuje deploy/ (Dockerfile: tylko src i scripts), i (2) odmowy fabryk
// atrap w module faktur poza trybem próby.
import { efektywnyTryb } from '../../../src/core/tryb.ts';

export function wymagajTrybuProby(env, kto) {
  if (efektywnyTryb(env ?? {}) !== 'proba') throw new Error(`${kto}: atrapy działają wyłącznie z OMS_TRYB=proba`);
}
