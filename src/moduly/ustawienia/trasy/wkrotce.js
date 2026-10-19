// PRZ-101.01: strony „wkrótce” w Ustawieniach — jedna trasa GET na pozycję, treść z domena/ustawienia-wkrotce.js.
// Uprawnienie „ustawienia” sprawdza strażnik po prefiksie `/ustawienia`, jak przy reszcie ekranów.
import { STRONY_WKROTCE } from '../../../domena/ustawienia-wkrotce.js';
import { nawigacjaUstawien } from '../nawigacja.js';

export function registerUstawieniaWkrotceRoutes(app) {
  for (const strona of STRONY_WKROTCE) {
    app.get(strona.href, async (req, reply) => reply.view('ustawienia-wkrotce.ejs', {
      nawigacja: nawigacjaUstawien(req, reply), title: strona.tytul, strona,
    }));
  }
}
