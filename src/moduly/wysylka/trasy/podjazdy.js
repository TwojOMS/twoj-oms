import { dzienWarszawa } from '../../../domena/format-daty.js';
import { ktoKlikal } from '../../zamowienia/lista.js';
import { stronaOdmowy } from '../../../core/web/odmowa.js';

// PRZ-152.G13: odmowy tras podjazdów w układzie OMS (status i tekst bez zmian).
const LISTA = { wroc: '/przesylki', napisWroc: 'Wróć do listy przesyłek' };
const bezKont = (reply) => stronaOdmowy(reply, 503, 'Konta Allegro są niedostępne.', { tytul: 'Podjazdy Allegro są niedostępne', ...LISTA });

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
    return reply.view('podjazdy-historia.ejs', { szerokosc: 'tabela', title: 'Historia podjazdów Allegro', wiersze });
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
    if (!podjazdy) return bezKont(reply);
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
        return stronaOdmowy(reply, 400, `Nie zamówiono podjazdu: ${error.message}`, { tytul: 'Nie zamówiono podjazdu', ...LISTA });
      }
    }
  });

  app.get('/przesylki/podjazdy/podglad/:id', async (req, reply) => {
    if (!podjazdy) return bezKont(reply);
    try {
      const podglad = podjazdy.pobierzPodglad({ id: req.params.id });
      return reply.view('podjazdy.ejs', { title: 'Podjazdy Allegro', faza: 'podglad',
        paczki: [], ...podglad, blad: null });
    } catch (error) {
      return stronaOdmowy(reply, 404, error.message, { tytul: 'Nie ma takiego podglądu podjazdu', ...LISTA });
    }
  });

  app.get('/przesylki/podjazdy/:id', async (req, reply) => {
    if (!podjazdy) return bezKont(reply);
    try {
      const wynik = await podjazdy.sprawdz({ id: Number(req.params.id) });
      return reply.view('podjazdy.ejs', { title: 'Podjazdy Allegro', faza: 'wynik', wynik,
        okruszki: [{ tekst: 'Przesyłki', href: '/przesylki' }, { tekst: `Podjazd ${req.params.id}` }],
        grupy: [], paczki: [], blad: null });
    } catch (error) {
      return stronaOdmowy(reply, 400, `Nie można sprawdzić podjazdu: ${error.message}`,
        { tytul: 'Nie można sprawdzić podjazdu', wroc: '/przesylki/podjazdy/historia', napisWroc: 'Wróć do historii podjazdów' });
    }
  });
}
