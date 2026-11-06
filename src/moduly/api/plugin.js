import { blad } from './odpowiedzi.js';
import { trasaJa } from './trasy/ja.js';
import { trasaZamowieniaLista } from './trasy/zamowienia-lista.js';
import { trasyZamowieniaOdczyt } from './trasy/zamowienia-odczyt.js';
import { trasyZamowieniaZapis } from './trasy/zamowienia-zapis.js';
import { trasyProduktyOdczyt } from './trasy/produkty-odczyt.js';
import { trasyProduktyZapis } from './trasy/produkty-zapis.js';
import { trasyStany } from './trasy/stany.js';
import { wpisDoDziennika } from '../../core/bezpieczenstwo/dziennik-api.js';

/** Obsługa błędów pozostaje w zasięgu tras /api/v1. */
export async function pluginApiV1(app, { ctx }) {
  // Druga warstwa za straznikiem: kazda trasa pluginu i jego 404 wymaga klucza rozpoznanego przez straznika.
  // Gdyby adres ominal czyAdresApiV1 (np. inne kodowanie sciezki), ciasteczko panelu ani Basic tu nie wejda.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.kluczApi) return blad(reply, 401, 'klucz', 'Brak, zły albo odwołany klucz API.');
  });
  app.addHook('onResponse', wpisDoDziennika(ctx));
  app.setNotFoundHandler(async (_req, reply) =>
    blad(reply, 404, 'brak', 'Nie ma takiego adresu w API.'));
  app.setErrorHandler((error, req, reply) => {
    if (error.statusCode === 400 && error.kod === 'stronicowanie') {
      return blad(reply, 400, 'stronicowanie', error.message);
    }
    if (error.validation || (error.statusCode === 400 && error.code?.startsWith('FST_ERR_CTP_'))) {
      return blad(reply, 400, 'zadanie', error.message);
    }
    if (error.statusCode === 413 || error.statusCode === 415) {
      return blad(reply, error.statusCode, error.statusCode === 413 ? 'plik' : 'typ', error.message);
    }
    req.log.error({ err: error }, 'Błąd API v1');
    return blad(reply, 500, 'blad', 'Błąd serwera.');
  });
  trasaJa(app, ctx);
  trasaZamowieniaLista(app, ctx);
  trasyZamowieniaOdczyt(app, ctx);
  trasyZamowieniaZapis(app, ctx);
  trasyProduktyOdczyt(app, ctx);
  trasyProduktyZapis(app, ctx);
  trasyStany(app, ctx);
}
