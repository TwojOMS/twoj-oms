// Fragment frozen ustawienia.js — właściciel wiadomości, rejestracja w module ustawień.
import { wczytajUstawienia, zapiszUstawienia } from '../../../oms/db/ustawienia.js';
import { ustawieniaFormulki, sprawdzFormularz } from '../../../domena/ustawienia-formulki.js';
import { nawigacjaUstawien } from '../../ustawienia/nawigacja.js';

function formulkaZFormularza(pola = {}) {
  const dni = Array.isArray(pola.dni) ? pola.dni : (pola.dni == null ? [] : [pola.dni]);
  return {
    wlaczona: pola.wlaczona === 'on' || pola.wlaczona === '1' || pola.wlaczona === true,
    tresc: String(pola.tresc ?? ''),
    odGodziny: String(pola.od ?? ''),
    doGodziny: String(pola.do ?? ''),
    dni: dni.map(Number).filter((dzien) => Number.isInteger(dzien) && dzien >= 0 && dzien <= 6),
    karencjaMin: String(pola.karencja ?? ''),
  };
}

export function registerUstawieniaFormulkiRoutes(app, { db }) {
  function widokAutomatyzacji(req, reply, { formulka = null, blad = null } = {}) {
    return reply.view('ustawienia-automatyzacje.ejs', {
      nawigacja: nawigacjaUstawien(req, reply),
      zapisano: req.query?.zapisano === 'formulka' ? 'Zapisano ustawienia autorespondera.' : null,
      title: 'Wiadomości i automatyzacje',
      formulka: formulka ?? ustawieniaFormulki(wczytajUstawienia(db)), blad,
    });
  }

  app.get('/ustawienia/wiadomosci-i-automatyzacje', async (req, reply) => widokAutomatyzacji(req, reply));

  app.post('/ustawienia/formulka', async (req, reply) => {
    const pola = req.body ?? {};
    const wynik = sprawdzFormularz(pola);
    if (!wynik.ok) {
      reply.code(400);
      return widokAutomatyzacji(req, reply, { formulka: formulkaZFormularza(pola), blad: wynik.blad });
    }
    zapiszUstawienia(db, wynik.wartosci);
    return reply.redirect('/ustawienia/wiadomosci-i-automatyzacje?zapisano=formulka');
  });
}
