import { MODULY_OPCJONALNE } from '../../../domena/moduly-opcjonalne.js';
import { przelaczModul, wylaczoneModuly, zaleznosciModulow } from '../../../oms/db/moduly-opcjonalne.js';
import { nawigacjaUstawien } from '../nawigacja.js';

export function registerUstawieniaModulowRoutes(app, { db }) {
  const tylkoAdmin = (req, reply) => req.konto?.admin ? null
    : reply.code(403).view('brak-dostepu.ejs', { title: 'Brak dostępu', wlasnyUklad: true });
  const widok = (req, reply, blad = null) => reply.view('ustawienia-moduly.ejs', {
    title: 'Moduły', nawigacja: nawigacjaUstawien(req, reply), moduly: MODULY_OPCJONALNE,
    wylaczone: wylaczoneModuly(db), zaleznosci: zaleznosciModulow(db), blad,
    zapisano: req.query?.zapisano === '1' ? 'Zapisano ustawienia modułów.' : null,
  });
  app.get('/ustawienia/moduly', async (req, reply) => tylkoAdmin(req, reply) ?? widok(req, reply));
  app.post('/ustawienia/moduly', async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const { modul, wlacz } = req.body ?? {};
    if (wlacz !== '1' && wlacz !== '0') return widok(req, reply.code(400), 'Pole „wlacz” musi mieć wartość 1 albo 0.');
    const wynik = przelaczModul(db, { modul, wlacz: wlacz === '1' });
    if (wynik.blad) return widok(req, reply.code(wynik.kod), wynik.blad);
    return reply.code(303).redirect('/ustawienia/moduly?zapisano=1');
  });
}
