import { KOLEJNOSC, sprawdzUkryteTypy, rodzajeDlaKonta } from '../../../domena/powiadomienia.js';
import { ukryteTypyKonta, zapiszUkryteTypy, rodzajeNiewidoczneDlaFirmy } from '../../../oms/db/powiadomienia.js';
import { nawigacjaUstawien } from '../nawigacja.js';

/** @param {any} app @param {{db:any,loginDemo?:string|null}} opcje */
export function registerPowiadomieniaRoutes(app, { db, loginDemo = null }) {
  const zKontem = req => Number.isInteger(req.konto?.id) && req.konto.id > 0 && !req.konto.serwisowe;
  const widok = (req, reply, extra = {}) => reply.view('ustawienia-powiadomienia.ejs', { szerokosc: 'formularz',
    title: 'Powiadomienia', nawigacja: req.url.startsWith('/konto/') ? reply.locals?.nawigacja : nawigacjaUstawien(req, reply),
    // PRZ-108.08: rodzaj „tylko administrator” (automatyzacje) nie stoi na liście konta, które go i tak nie zobaczy.
    rodzaje: rodzajeDlaKonta(req.konto), ukryte: ukryteTypyKonta(db, req.konto?.id),
    moznaZapisac: zKontem(req), blad: null,
    zapisano: req.query?.zapisano === '1' ? 'Zapisano ustawienia powiadomień.' : null,
    niewidoczne: req.konto?.admin === true ? rodzajeNiewidoczneDlaFirmy(db) : [], ...extra,
  });
  app.get('/ustawienia/powiadomienia', async (req, reply) => widok(req, reply));
  app.get('/konto/powiadomienia', async (req, reply) => widok(req, reply));
  const zapisz = async (req, reply) => {
    if (loginDemo && req.konto?.login === loginDemo) return widok(req, reply.code(403), { blad: 'W demonstracji zmiany są wyłączone.' });
    if (!zKontem(req)) return widok(req, reply.code(403), { blad: 'Konto serwisowe nie ma osobistych ustawień powiadomień.' });
    const wybor = req.body?.widoczne;
    let widoczne;
    try { widoczne = sprawdzUkryteTypy(wybor === undefined ? [] : typeof wybor === 'string' ? [wybor] : wybor); }
    catch (e) { return widok(req, reply.code(400), { blad: e.message }); }
    // Ukryte = rodzaje z listy TEGO konta, których nie zaznaczyło (rodzaj spoza jego listy nie jest „wyłączony”).
    const naLiscie = rodzajeDlaKonta(req.konto).map(r => r.typ);
    zapiszUkryteTypy(db, req.konto.id, KOLEJNOSC.filter(typ => naLiscie.includes(typ) && !widoczne.includes(typ)));
    return reply.code(303).redirect('/konto/powiadomienia?zapisano=1');
  };
  app.post('/ustawienia/powiadomienia', zapisz);
  app.post('/konto/powiadomienia', zapisz);
}
