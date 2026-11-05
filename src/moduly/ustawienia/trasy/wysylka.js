import { tytulEkranuDlaAdresu } from '../../../domena/ekrany.js';
import { randomUUID } from 'node:crypto';
import { wczytajUstawienia, zapiszUstawienia, ustawieniaZmienioneAt } from '../../../oms/db/ustawienia.js';
import { domyslnaPaczka, kwotyDostawy, sprawdzPaczke, sprawdzKoszty } from '../../../domena/ustawienia-panelu.js';
import { odczytajSzablony, zapiszSzablony, zmienSzablon, ustawDomyslnySzablon, usunSzablon } from '../../../domena/szablony-paczek.js';
import { DOSTAWY } from '../../../domena/nowe-zamowienie.js';
import { GABARYTY_PACZKOMATU } from '../../../domena/paczka.js';
import { profilGabarytuAllegro } from '../../../domena/gabaryty-allegro.js';
import {
  USLUGI_AUTOMATOW, odczytajAutomaty, zapiszAutomaty, zmienAutomat, usunWyjatekAutomatu, domyslneAutomaty,
} from '../../../domena/gabaryty-automatow.js';
import { nawigacjaUstawien } from '../nawigacja.js';
const KOMUNIKATY_ZAPISU={paczka:'Zapisano domyślną paczkę.',szablon:'Zapisano szablony paczek.',dostawa:'Zapisano koszty dostawy.',automat:'Zapisano gabaryty paczkomatów i automatów.'};
export function registerUstawieniaWysylkiRoutes(app,{db}) {
  const wspolnyKontekst = (req, reply) => ({
    nawigacja: nawigacjaUstawien(req, reply),
    zapisano: KOMUNIKATY_ZAPISU[req.query?.zapisano] ?? null,
  });
  function widokWysylki(req, reply, {
    wpisanaPaczka = null, wpisanySzablon = null, bledyPaczki = [], wpisaneKoszty = null, bledyKosztow = [],
    wpisanyAutomat = null, bledyAutomatow = [],
  } = {}) {
    const zapis = wczytajUstawienia(db);
    const szablonyPaczek = odczytajSzablony(zapis);
    // PRZ-152.G11a: edycja w wierszu i nowy wiersz bez JS (?edytuj=<id>, ?dodaj=1); po odmowie
    // zapisu wiersz zostaje otwarty z wpisanymi wartościami.
    const edytujSzablon = wpisanySzablon
      ? (wpisanySzablon.id || null)
      : (wpisanaPaczka ? szablonyPaczek.domyslnyId : (typeof req.query?.edytuj === 'string' ? req.query.edytuj : null));
    const dodajSzablon = Boolean(wpisanySzablon && !wpisanySzablon.id) || (!edytujSzablon && req.query?.dodaj === '1');
    return reply.view('ustawienia-zamowienia.ejs', {
      ...wspolnyKontekst(req, reply), title: tytulEkranuDlaAdresu(req.url),
      paczka: wpisanaPaczka ?? domyslnaPaczka(zapis),
      szablonyPaczek, wpisanySzablon, wpisanaPaczka, edytujSzablon, dodajSzablon,
      automaty: odczytajAutomaty(zapis), automatyStart: domyslneAutomaty(zapis), uslugiAutomatow: USLUGI_AUTOMATOW,
      gabarytyPaczkomatu: GABARYTY_PACZKOMATU, wysokosciAllegro: profilGabarytuAllegro(USLUGI_AUTOMATOW[0].id).gabaryty,
      wpisanyAutomat, bledyAutomatow,
      kwoty: wpisaneKoszty ?? kwotyDostawy(zapis), dostawy: DOSTAWY,
      bledyPaczki, bledyKosztow, ustawieniaZmienione: ustawieniaZmienioneAt(db),
    });
  }

  app.get('/ustawienia', async (_req, reply) => reply.redirect('/ustawienia/firma'));
  app.get('/ustawienia/zamowienia-i-wysylka', async (req, reply) => widokWysylki(req, reply));
  app.get('/ustawienia/wysylka/dostawa', async (req, reply) => widokWysylki(req, reply));
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

  // PRZ-152.G11a: wartość startowa gabarytu i wagi dla paczkomatu InPost i automatów Allegro.
  app.post('/ustawienia/paczka/automat', async (req, reply) => {
    const dane = req.body ?? {};
    const wynik = zmienAutomat(odczytajAutomaty(wczytajUstawienia(db)), dane);
    if (wynik.bledy.length) {
      reply.code(400);
      return widokWysylki(req, reply, { wpisanyAutomat: dane, bledyAutomatow: wynik.bledy });
    }
    zapiszUstawienia(db, zapiszAutomaty(wynik.stan));
    return reply.redirect('/ustawienia/zamowienia-i-wysylka?zapisano=automat');
  });

  app.post('/ustawienia/paczka/automat/:id/jak-wszystkie', async (req, reply) => {
    const wynik = usunWyjatekAutomatu(odczytajAutomaty(wczytajUstawienia(db)), req.params.id);
    if (wynik.bledy.length) {
      reply.code(400);
      return widokWysylki(req, reply, { bledyAutomatow: wynik.bledy });
    }
    zapiszUstawienia(db, zapiszAutomaty(wynik.stan));
    return reply.redirect('/ustawienia/zamowienia-i-wysylka?zapisano=automat');
  });

  app.post('/ustawienia/dostawa', async (req, reply) => {
    const { wartosci, bledy } = sprawdzKoszty(req.body ?? {});
    if (bledy.length) {
      reply.code(400);
      return widokWysylki(req, reply, { wpisaneKoszty: req.body ?? {}, bledyKosztow: bledy });
    }
    zapiszUstawienia(db, wartosci);
    return reply.redirect('/ustawienia/wysylka/dostawa?zapisano=dostawa');
  });

}
