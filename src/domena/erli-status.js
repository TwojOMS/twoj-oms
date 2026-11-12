import { statusBazowy } from './status.js';

export const STATUS_ERLI_DLA = {
  w_realizacji: 'inProgress',
  wyslane: 'sent',
};

// ERLI nie gwarantuje natychmiastowego odczytu po 202. Argument pochodzi wyłącznie
// z trwałego śladu udanego zapisu OMS, nigdy z sellerStatus/status_realizacji.
export function statusDlaErli(z, ostatniWyslany) {
  if (!z?.zrodlo_id) return null;
  if (['returned', 'cancelled'].includes(z.status_woo)) return null;
  let docelowy = STATUS_ERLI_DLA[statusBazowy(z)];
  if (!docelowy) return null;
  const odbiorOsobisty = z.metoda_wysylki === 'odbior_osobisty';
  if (docelowy === 'sent' && odbiorOsobisty) docelowy = 'readyToPickup';
  if (ostatniWyslany === docelowy) return null;
  // Oba stany końcowe są równorzędne: nie cofamy ich ani nie zamieniamy między sobą.
  if (['sent', 'readyToPickup'].includes(ostatniWyslany)) return null;
  // Odczyt ERLI służy tylko do blokowania cofnięcia, nie do pomijania duplikatów.
  if (docelowy === 'inProgress' && ['sent', 'readyToPickup', 'received', 'returned', 'returningToSender', 'canceled'].includes(z.status_realizacji)) return null;
  return docelowy;
}
