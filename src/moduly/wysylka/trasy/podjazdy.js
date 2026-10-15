import { dzienWarszawa } from '../../../domena/format-daty.js';
import { ktoKlikal } from '../../zamowienia/lista.js';

const lista = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const polaAdresu = ['name', 'street', 'postalCode', 'city', 'countryCode', 'email', 'phone'];
const adresZ = (source) => Object.fromEntries(polaAdresu.map((k) => [k, source?.[k] ?? '']));

function wybrane(db, ids) {
  return lista(ids).map(Number).filter(Number.isSafeInteger).map((id) => db.prepare(`
    SELECT p.id, p.numer_listu, z.numer AS numer_zamowienia, z.sklep
    FROM przesylki p JOIN zamowienia z ON z.id=p.zamowienie_id WHERE p.id=?`).get(id))
    .filter(Boolean);
}

export function registerPodjazdyRoutes(app, { db, podjazdy, adresDomyslny }) {
  app.get('/przesylki/podjazdy/historia', async (_req, reply) => {
    const wiersze = db.prepare(`SELECT p.*, GROUP_CONCAT(pp.numer_listu, ', ') AS numery_listow,
      MAX(NULLIF(z.metoda_wysylki_nazwa, '')) AS nazwa_uslugi
      FROM podjazdy p LEFT JOIN podjazdy_przesylki pp ON pp.podjazd_id = p.id
      LEFT JOIN przesylki s ON s.id = pp.przesylka_id
      LEFT JOIN zamowienia z ON z.id = s.zamowienie_id
      GROUP BY p.id ORDER BY p.utworzony_at DESC, p.id DESC`).all();
    return reply.view('podjazdy-historia.ejs', { title: 'Historia podjazdów Allegro', wiersze });
  });

  app.get('/przesylki/podjazdy', async (req, reply) => {
    const paczki = wybrane(db, req.query?.ids);
    if (!paczki.length) return reply.redirect('/przesylki?pokaz=utworzone');
    return reply.view('podjazdy.ejs', { title: 'Podjazdy Allegro', faza: 'wybor', paczki,
      data: dzienWarszawa(new Date().toISOString()), adres: adresDomyslny,
      grupy: [], blad: null });
  });

  app.post('/przesylki/podjazdy/podglad', async (req, reply) => {
    const paczki = wybrane(db, req.body?.ids);
    const adres = adresZ(req.body);
    const data = req.body?.data;
    try {
      if (!podjazdy) throw new Error('Konta Allegro są niedostępne.');
      const podglad = await podjazdy.przygotuj({ ids: lista(req.body?.ids).map(Number),
        data, adres, kto: ktoKlikal(req) });
      return reply.view('podjazdy.ejs', { title: 'Podjazdy Allegro', faza: 'podglad',
        paczki, ...podglad, blad: null });
    } catch (error) {
      return reply.code(400).view('podjazdy.ejs', { title: 'Podjazdy Allegro', faza: 'wybor',
        paczki, data, adres, grupy: [], blad: error.message });
    }
  });

  app.post('/przesylki/podjazdy/zlec', async (req, reply) => {
    if (!podjazdy) return reply.code(503).send('Konta Allegro są niedostępne.');
    try {
      const termin = JSON.parse(req.body?.termin ?? 'null');
      const wynik = await podjazdy.zlec({ podgladId: req.body?.podgladId,
        grupaId: req.body?.grupaId, termin, kto: ktoKlikal(req) });
      return reply.redirect(`/przesylki/podjazdy/podglad/${encodeURIComponent(wynik.podglad_id)}`);
    } catch (error) {
      try {
        const podglad = podjazdy.pobierzPodglad({ id: req.body?.podgladId });
        return reply.code(400).view('podjazdy.ejs', { title: 'Podjazdy Allegro', faza: 'podglad',
          paczki: [], ...podglad, blad: `Nie zamówiono podjazdu: ${error.message}` });
      } catch {
        return reply.code(400).send(`Nie zamówiono podjazdu: ${error.message}`);
      }
    }
  });

  app.get('/przesylki/podjazdy/podglad/:id', async (req, reply) => {
    if (!podjazdy) return reply.code(503).send('Konta Allegro są niedostępne.');
    try {
      const podglad = podjazdy.pobierzPodglad({ id: req.params.id });
      return reply.view('podjazdy.ejs', { title: 'Podjazdy Allegro', faza: 'podglad',
        paczki: [], ...podglad, blad: null });
    } catch (error) {
      return reply.code(404).send(error.message);
    }
  });

  app.get('/przesylki/podjazdy/:id', async (req, reply) => {
    if (!podjazdy) return reply.code(503).send('Konta Allegro są niedostępne.');
    try {
      const wynik = await podjazdy.sprawdz({ id: Number(req.params.id) });
      return reply.view('podjazdy.ejs', { title: 'Podjazdy Allegro', faza: 'wynik', wynik,
        grupy: [], paczki: [], blad: null });
    } catch (error) {
      return reply.code(400).send(`Nie można sprawdzić podjazdu: ${error.message}`);
    }
  });
}
