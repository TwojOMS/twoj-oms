import { celeLacznosci, podsumowanie } from '../../../domena/lacznosc.js';
import { kanalyZOtwartymBezpiecznikiem } from '../../../oms/db/stan-weryfikacji.js';
import { sprawdzLacznosc } from '../../../oms/services/lacznosc.js';
import { nawigacjaUstawien } from '../nawigacja.js';

// Wydzielona zachowana trasa frozen routes/ustawienia.js.
export function registerDiagnostykaRoutes(app, { db, config = {}, lacznosc = null }) {
  app.get('/ustawienia/lacznosc', async (req, reply) => {
    let wyniki = [];
    let blad = null;
    try {
      wyniki = lacznosc ? await lacznosc.sprawdz() : await sprawdzLacznosc({ cele: celeLacznosci(config) });
    } catch (error) {
      blad = error?.message || 'nieznany błąd';
    }
    return reply.view('lacznosc.ejs', {
      nawigacja: nawigacjaUstawien(req, reply),
      zapisano: null, title: 'Diagnostyka', wyniki, blad,
      podsumowanie: podsumowanie(wyniki), sprawdzoneAt: new Date().toISOString(),
      bezpieczniki: kanalyZOtwartymBezpiecznikiem(db),
    });
  });
}
