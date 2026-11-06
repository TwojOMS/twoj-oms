import { wymagajZakresu } from '../zakres.js';
import {
  obslugaZalozeniaZKarty, obslugaWRealizacji, obslugaProformy, obslugaPdfProformy,
} from '../../api-panelu/trasy/api-zamowienia-z-karty.js';

/** Te same zapisy i usługi co w panelu; dostęp według zakresów klucza API. */
export function trasyZamowieniaZapis(app, ctx) {
  const zapis = { preHandler: wymagajZakresu('zamowienia:zapis') };
  const proformy = { preHandler: wymagajZakresu('proformy:zapis') };
  app.post('/zamowienia/z-karty', zapis, obslugaZalozeniaZKarty(ctx));
  app.post('/zamowienia/:id/w-realizacji', zapis, obslugaWRealizacji(ctx));
  app.post('/zamowienia/:id/proforma', proformy, obslugaProformy({ ...ctx, adresProform: '/api/v1/proformy' }));
  app.get('/proformy/:id/pdf', proformy, obslugaPdfProformy(ctx));
}
