import { wymagajZakresu } from '../zakres.js';
import {
  obslugaZamowieniaZKarty, obslugaZamowieniaPoNumerze, obslugaDostawy, obslugaStanuWysylki,
} from '../../api-panelu/trasy/api-zamowienia-z-karty.js';
import { obslugaSprzedazy } from '../../api-panelu/trasy/api-sprzedaz.js';

/** Te same odczyty co w panelu; dostęp według zakresów klucza API. */
export function trasyZamowieniaOdczyt(app, ctx) {
  const odczyt = { preHandler: wymagajZakresu('zamowienia:odczyt') };
  app.get('/zamowienia/z-karty/:kartaId', odczyt, obslugaZamowieniaZKarty(ctx));
  app.get('/zamowienia/po-numerze/:numer', odczyt, obslugaZamowieniaPoNumerze(ctx));
  app.get('/zamowienia/:id/dostawa', odczyt, obslugaDostawy(ctx));
  app.get('/zamowienia/:id/stan-wysylki', odczyt, obslugaStanuWysylki(ctx));
  app.get('/sprzedaz', { preHandler: wymagajZakresu('sprzedaz:odczyt') }, obslugaSprzedazy(ctx));
}
