// PRZ-091 — ekrany stanów magazynowych w zakładce Magazyn: import stanu otwarcia i pozycje zamówień bez karty.
// Ruch ręczny z karty produktu obsługuje karta.js (potrzebuje jej ekranu do pokazania odmowy).
// Wszystko tutaj działa WYŁĄCZNIE przy włączonych stanach (Ustawienia → Magazyn); wyłączone = 409 z wyjaśnieniem.
import { przelacznikStanow, pozycjeBezKarty, podgladImportuOtwarcia, zapiszImportOtwarcia } from '../../oms/db/stany-magazynowe.js';
import { fmtDataCzas } from '../../domena/format-daty.js';

const WYLACZONE = {
  title: 'Magazyn — stany wyłączone',
  naglowek: 'Stany magazynowe są wyłączone',
  opis: 'Włącz je w Ustawieniach → Magazyn. Do tego czasu OMS nie liczy ilości na stanie.',
};

const tekstImportu = (body) => (typeof body?.tekst === 'string' ? body.tekst.slice(0, 200_000) : '');

export function registerStanyMagazynu(app, { db }) {
  const wylaczone = (reply) => reply.code(409).view('pusta-strona.ejs', WYLACZONE);

  app.get('/magazyn/stany/import', async (_req, reply) => {
    const { wlaczone, granica } = przelacznikStanow(db);
    if (!wlaczone) return wylaczone(reply);
    return reply.view('magazyn-stany-import.ejs', { title: 'Magazyn — import stanu otwarcia', od: fmtDataCzas(granica),
      tekst: '', plan: null, wynik: null });
  });

  // Podgląd: nic nie zapisuje. Ten sam tekst jedzie dalej ukrytym polem do „Zapisz”.
  app.post('/magazyn/stany/import', async (req, reply) => {
    const { wlaczone, granica } = przelacznikStanow(db);
    if (!wlaczone) return wylaczone(reply);
    const tekst = tekstImportu(req.body);
    return reply.view('magazyn-stany-import.ejs', { title: 'Magazyn — import stanu otwarcia', od: fmtDataCzas(granica),
      tekst, plan: podgladImportuOtwarcia(db, tekst), wynik: null });
  });

  app.post('/magazyn/stany/import/zapisz', async (req, reply) => {
    const { wlaczone, granica } = przelacznikStanow(db);
    if (!wlaczone) return wylaczone(reply);
    const tekst = tekstImportu(req.body);
    const wynik = zapiszImportOtwarcia(db, tekst, { konto: req.konto ?? null });
    return reply.view('magazyn-stany-import.ejs', { title: 'Magazyn — import stanu otwarcia', od: fmtDataCzas(granica),
      tekst: '', plan: null, wynik });
  });

  app.get('/magazyn/stany/bez-karty', async (_req, reply) => {
    const { wlaczone, granica } = przelacznikStanow(db);
    if (!wlaczone) return wylaczone(reply);
    return reply.view('magazyn-stany-bez-karty.ejs', { title: 'Magazyn — pozycje bez karty', od: fmtDataCzas(granica),
      pozycje: pozycjeBezKarty(db).map((p) => ({ ...p, adres: `/zamowienia/${p.zamowienie_id}` })) });
  });
}
