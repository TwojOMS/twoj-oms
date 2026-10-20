import { statusyWKolejnosci, zapiszStatusy } from '../../../oms/db/statusy.js';
import { zamowieniaPoId } from '../../../oms/db/zamowienia.js';
import { wyliczStatus } from '../../../domena/status.js';
import { PALETA_STATUSOW, domyslneStatusy, kluczNowegoStatusu } from '../../../domena/statusy-konfiguracja.js';
import { nawigacjaUstawien } from '../nawigacja.js';

const LICZBA_ZAMOWIEN = new Intl.PluralRules('pl');

export function registerUstawieniaStatusowRoutes(app, { db }) {
  app.get('/ustawienia/statusy', async (req, reply) => reply.view('ustawienia-statusy.ejs', {
    title: 'Statusy zamówień', nawigacja: nawigacjaUstawien(req, reply),
    statusy: statusyWKolejnosci(db), paleta: PALETA_STATUSOW,
    komunikat: typeof req.query?.komunikat === 'string' ? req.query.komunikat : null,
    blad: req.query?.blad === '1',
  }));

  // Strażnik /ustawienia, blokada zapisu gościa demo i CSRF są wspólne z resztą ustawień.
  app.post('/ustawienia/statusy', async (req, reply) => {
    const { akcja, klucz, etykieta, kolor, jak, kolejnosc } = req.body ?? {};
    let komunikat = 'Zapisano statusy zamówień.';
    let blad = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      const statusy = statusyWKolejnosci(db).map(s => ({ ...s }));
      const indeks = statusy.findIndex(s => s.klucz === klucz);
      const status = statusy[indeks];
      if (akcja === 'kolejnosc') {
        if (!Array.isArray(kolejnosc) || kolejnosc.length !== statusy.length || new Set(kolejnosc).size !== statusy.length || kolejnosc.some(k => !statusy.some(s => s.klucz === k))) {
          throw new Error('Prześlij pełną kolejność istniejących statusów bez powtórzeń. Odśwież ekran.');
        }
        zapiszStatusy(db, kolejnosc.map(k => statusy.find(s => s.klucz === k)));
        db.exec('COMMIT');
        return reply.send({ komunikat: 'Zapisano kolejność' });
      } else if (akcja === 'dodaj') {
        statusy.push({ klucz: kluczNowegoStatusu(etykieta, statusy), etykieta, kolor, jak });
      } else if (akcja === 'domyslne') {
        // Własne zachowują swoje pozycje; systemowe odzyskują nazwy, kolory i wzajemną kolejność.
        const domyslne = domyslneStatusy();
        let n = 0;
        for (let i = 0; i < statusy.length; i++) if (!statusy[i].jak) statusy[i] = domyslne[n++];
      } else {
        if (!status) throw new Error('Nie znaleziono statusu. Odśwież ekran.');
        if (akcja === 'edytuj') {
          status.etykieta = etykieta;
          status.kolor = kolor;
        } else if (akcja === 'gora' || akcja === 'dol') {
          const cel = indeks + (akcja === 'gora' ? -1 : 1);
          if (cel >= 0 && cel < statusy.length) [statusy[indeks], statusy[cel]] = [statusy[cel], statusy[indeks]];
        } else if (akcja === 'usun') {
          if (!status.jak) throw new Error('Nie można usunąć statusu systemowego.');
          const ids = db.prepare('SELECT zamowienie_id FROM zamowienia_status_wlasny WHERE klucz = ?').all(klucz).map(w => w.zamowienie_id);
          const ile = zamowieniaPoId(db, ids).filter(z => wyliczStatus(z) === klucz).length;
          const slowo = { one: 'zamówienie', few: 'zamówienia', many: 'zamówień' }[LICZBA_ZAMOWIEN.select(ile)];
          if (ile) throw new Error(`Przenieś ${ile} ${slowo} na inny status, zanim usuniesz ten status.`);
          db.prepare('DELETE FROM zamowienia_status_wlasny WHERE klucz = ?').run(klucz);
          statusy.splice(indeks, 1);
        } else throw new Error('Nieznana czynność.');
      }
      zapiszStatusy(db, statusy);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      // Walidacja nie ujawnia SQL ani danych zamówień; inne błędy obsługuje wspólny handler.
      if (!(e instanceof Error) || e.code) throw e;
      komunikat = e.message;
      blad = true;
      if (akcja === 'kolejnosc') return reply.code(400).send({ komunikat });
    }
    return reply.code(303).redirect(`/ustawienia/statusy?komunikat=${encodeURIComponent(komunikat)}${blad ? '&blad=1' : ''}`);
  });
}
