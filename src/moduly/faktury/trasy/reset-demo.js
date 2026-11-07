import { etykietaModulu } from '../../../domena/wybor-programu.js';
import { zlecResetDemo } from '../../../oms/db/reset-demo.js';
import { nawigacjaUstawien } from '../../ustawienia/nawigacja.js';

export const ADRES_DANYCH_DEMO = '/ustawienia/dane-demo';
const odmowa = reply => reply.code(403).view('brak-dostepu.ejs', { title: 'Brak dostępu', wlasnyUklad: true });

// PRZ-122.ZGODA-TFb: `numerDemo()` — następny numer serii FV TwojeFaktury (db/twojefaktury-numery.js), podaje modul.ts.
// Ten plik nie importuje kodu TwojeFaktury; bez funkcji (baza bez `tf_*`) ekran nie pokazuje numeru.
export function registerResetDemoRoutes(app, { db, wyborProgramu, nipTeraz, teraz, restart, numerDemo = null }) {
  function widok(req, reply, bledy = []) {
    const numer = numerDemo ? numerDemo() : null;
    return reply.view('ustawienia-dane-demo.ejs', { szerokosc: 'formularz', title: 'Dane demo', nawigacja: nawigacjaUstawien(req, reply), bledy,
      program: etykietaModulu(wyborProgramu.teraz().program), nip: nipTeraz(), numer, adres: ADRES_DANYCH_DEMO });
  }
  app.get(ADRES_DANYCH_DEMO, async (req, reply) => req.konto?.admin === true ? widok(req, reply) : odmowa(reply));
  app.post(`${ADRES_DANYCH_DEMO}/reset`, async (req, reply) => {
    if (req.konto?.admin !== true) return odmowa(reply);
    if (req.body?.potwierdzam !== 'tak') {
      reply.code(400);
      return widok(req, reply, ['Potwierdź, że dane demo zostaną zastąpione.']);
    }
    zlecResetDemo(db, { login: req.konto.login, teraz: teraz() });
    reply.raw.once('finish', () => setImmediate(() => restart.zakoncz()));
    return reply.view('brak-dostepu.ejs', { title: 'OMS uruchamia się ponownie', wlasnyUklad: true, restart: true,
      odswiez: { sekundy: 10, adres: ADRES_DANYCH_DEMO } });
  });
}
