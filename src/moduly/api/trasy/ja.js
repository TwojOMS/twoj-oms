import { blad } from '../odpowiedzi.js';
import { ZAKRESY_API } from '../../../domena/klucze-api.js';

/** Tożsamość klucza rozpoznanego przez strażnika wejścia; zakresy w stałej kolejności ZAKRESY_API. */
export function trasaJa(app) {
  app.get('/ja', async (req, reply) => {
    if (!req.kluczApi) {
      return blad(reply, 401, 'klucz', 'Brak, zły albo odwołany klucz API.');
    }
    const { nazwa, prefiks, zakresy } = req.kluczApi;
    return { nazwa, prefiks, zakresy: ZAKRESY_API.filter((zakres) => zakresy.has(zakres)) };
  });
}
