import { randomUUID } from 'node:crypto';
import { wczytajUstawienia, zapiszUstawienia, ustawieniaZmienioneAt } from '../../../oms/db/ustawienia.js';
import { domyslnaPaczka, kwotyDostawy, sprawdzPaczke, sprawdzKoszty } from '../../../domena/ustawienia-panelu.js';
import { odczytajSzablony, zapiszSzablony, zmienSzablon, ustawDomyslnySzablon, usunSzablon } from '../../../domena/szablony-paczek.js';
import { DOSTAWY } from '../../../domena/nowe-zamowienie.js';
import { nawigacjaUstawien } from '../nawigacja.js';
const KOMUNIKATY_ZAPISU={paczka:'Zapisano domyślną paczkę.',szablon:'Zapisano szablony paczek.',dostawa:'Zapisano koszty dostawy.'};
export function registerUstawieniaWysylkiRoutes(app,{db}) {
  const wspolnyKontekst = (req, reply) => ({
    nawigacja: nawigacjaUstawien(req, reply),
    zapisano: KOMUNIKATY_ZAPISU[req.query?.zapisano] ?? null,
  });
  function widokWysylki(req, reply, {
    wpisanaPaczka = null, wpisanySzablon = null, bledyPaczki = [], wpisaneKoszty = null, bledyKosztow = [],
  } = {}) {
    const zapis = wczytajUstawienia(db);
    return reply.view('ustawienia-zamowienia.ejs', {
      ...wspolnyKontekst(req, reply), title: 'Zamówienia i wysyłka',
      paczka: wpisanaPaczka ?? domyslnaPaczka(zapis),
      szablonyPaczek: odczytajSzablony(zapis), wpisanySzablon,
      kwoty: wpisaneKoszty ?? kwotyDostawy(zapis), dostawy: DOSTAWY,
      bledyPaczki, bledyKosztow, ustawieniaZmienione: ustawieniaZmienioneAt(db),
    });
  }

  app.get('/ustawienia', async (_req, reply) => reply.redirect('/ustawienia/zamowienia-i-wysylka'));
  app.get('/ustawienia/zamowienia-i-wysylka', async (req, reply) => widokWysylki(req, reply));
  app.post('/ustawienia/paczka', async (req, reply) => {
    const { wartosci, bledy } = sprawdzPaczke(req.body ?? {});
    if (bledy.length) {
      reply.code(400);
      return widokWysylki(req, reply, { wpisanaPaczka: req.body ?? {}, bledyPaczki: bledy });
    }
    const stan = odczytajSzablony(wczytajUstawienia(db));
    const domyslny = stan.szablony.find((s) => s.id === stan.domyslnyId);
    const wynik = zmienSzablon(stan, { ...domyslny, id: domyslny.id,
      ...Object.fromEntries(Object.keys(domyslnaPaczka()).map((pole) => [pole, wartosci[`paczka.${pole}`]])) });
    zapiszUstawienia(db, zapiszSzablony(wynik.stan));
    return reply.redirect('/ustawienia/zamowienia-i-wysylka?zapisano=paczka');
  });

  app.post('/ustawienia/paczka/szablon', async (req, reply) => {
    const stan = odczytajSzablony(wczytajUstawienia(db));
    const dane = req.body ?? {};
    const wynik = zmienSzablon(stan, dane, randomUUID());
    if (wynik.bledy.length) {
      reply.code(400);
      return widokWysylki(req, reply, { wpisanySzablon: dane, bledyPaczki: wynik.bledy });
    }
    zapiszUstawienia(db, zapiszSzablony(wynik.stan));
    return reply.redirect('/ustawienia/zamowienia-i-wysylka?zapisano=szablon');
  });

  app.post('/ustawienia/paczka/szablon/:id/domyslny', async (req, reply) => {
    const wynik = ustawDomyslnySzablon(odczytajSzablony(wczytajUstawienia(db)), req.params.id);
    if (wynik.bledy.length) {
      reply.code(400);
      return widokWysylki(req, reply, { bledyPaczki: wynik.bledy });
    }
    zapiszUstawienia(db, zapiszSzablony(wynik.stan));
    return reply.redirect('/ustawienia/zamowienia-i-wysylka?zapisano=szablon');
  });

  app.post('/ustawienia/paczka/szablon/:id/usun', async (req, reply) => {
    const wynik = usunSzablon(odczytajSzablony(wczytajUstawienia(db)), req.params.id);
    if (wynik.bledy.length) {
      reply.code(400);
      return widokWysylki(req, reply, { bledyPaczki: wynik.bledy });
    }
    zapiszUstawienia(db, zapiszSzablony(wynik.stan));
    return reply.redirect('/ustawienia/zamowienia-i-wysylka?zapisano=szablon');
  });

  app.post('/ustawienia/dostawa', async (req, reply) => {
    const { wartosci, bledy } = sprawdzKoszty(req.body ?? {});
    if (bledy.length) {
      reply.code(400);
      return widokWysylki(req, reply, { wpisaneKoszty: req.body ?? {}, bledyKosztow: bledy });
    }
    zapiszUstawienia(db, wartosci);
    return reply.redirect('/ustawienia/zamowienia-i-wysylka?zapisano=dostawa');
  });

}
