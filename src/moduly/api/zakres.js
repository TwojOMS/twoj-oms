import { blad } from './odpowiedzi.js';

/** Zakres klucza jest niezależny od uprawnień kont panelu. */
export function wymagajZakresu(zakres) {
  return async function (req, reply) {
    if (!req.kluczApi?.zakresy.has(zakres)) {
      return blad(reply, 403, 'brak_zakresu', `Klucz nie ma zakresu ${zakres}.`);
    }
  };
}
