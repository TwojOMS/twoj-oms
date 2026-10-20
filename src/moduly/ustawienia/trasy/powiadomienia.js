import { KOLEJNOSC, RODZAJE_OSTRZEZEN, sprawdzUkryteTypy } from '../../../domena/powiadomienia.js';
import { ukryteTypyKonta, zapiszUkryteTypy, rodzajeNiewidoczneDlaFirmy } from '../../../oms/db/powiadomienia.js';
import { nawigacjaUstawien } from '../nawigacja.js';

export function registerPowiadomieniaRoutes(app, { db }) {
  const zKontem = req => Number.isInteger(req.konto?.id) && req.konto.id > 0 && !req.konto.serwisowe;
  const widok = (req, reply, extra = {}) => reply.view('ustawienia-powiadomienia.ejs', {
    title: 'Powiadomienia', nawigacja: nawigacjaUstawien(req, reply),
    rodzaje: RODZAJE_OSTRZEZEN, ukryte: ukryteTypyKonta(db, req.konto?.id),
    moznaZapisac: zKontem(req), blad: null,
    zapisano: req.query?.zapisano === '1' ? 'Zapisano ustawienia powiadomień.' : null,
    niewidoczne: req.konto?.admin === true ? rodzajeNiewidoczneDlaFirmy(db) : [], ...extra,
  });
  app.get('/ustawienia/powiadomienia', async (req, reply) => widok(req, reply));
  app.post('/ustawienia/powiadomienia', async (req, reply) => {
    if (!zKontem(req)) return widok(req, reply.code(403), { blad: 'Konto serwisowe nie ma osobistych ustawień powiadomień.' });
    const wybor = req.body?.widoczne;
    let widoczne;
    try { widoczne = sprawdzUkryteTypy(wybor === undefined ? [] : typeof wybor === 'string' ? [wybor] : wybor); }
    catch (e) { return widok(req, reply.code(400), { blad: e.message }); }
    zapiszUkryteTypy(db, req.konto.id, KOLEJNOSC.filter(typ => !widoczne.includes(typ)));
    return reply.code(303).redirect('/ustawienia/powiadomienia?zapisano=1');
  });
}
