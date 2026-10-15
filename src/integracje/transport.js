import { utworzHttp } from '../core/http.ts';

/**
 * Nowe moduły wstrzykują http. fetchImpl to przejściowy alias dla testów
 * przeszczepionych bez zmiany asercji; nie jest używany przez nowe moduły.
 * Zero automatycznych ponowień zachowuje dotychczasowe zachowanie klientów,
 * również dla PUT Allegro i jednorazowych tokenów OAuth.
 */
export function transport({ http, fetchImpl, limitCzasuMs = 30_000 } = {}) {
  return http ?? fetchImpl ?? utworzHttp({ ponowien: 0, limitCzasuMs });
}
