// PRZ-091: Ustawienia → Magazyn — przełącznik „Włącz stany magazynowe” (decyzje właściciela 17.10.2026).
// Reguły i zapis przełącznika siedzą w rdzeniu (oms/db/stany-magazynowe.js); ta trasa tylko pokazuje i przełącza.
//
// Kto może przełączyć: strażnik po prefiksie `/ustawienia` wpuszcza wyłącznie konto z uprawnieniem „ustawienia”,
// a gościa demo w podglądzie zatrzymuje na każdym POST-cie (core/bezpieczenstwo/podglad-demo.js) — tu nie
// powtarzamy żadnej z tych blokad.
import { przelacznikStanow, przelaczStany } from '../../../oms/db/stany-magazynowe.js';
import { nawigacjaUstawien } from '../nawigacja.js';

const KOMUNIKATY = {
  wlaczono: 'Stany magazynowe są włączone. Wpisz stan otwarcia kart w zakładce Magazyn.',
  wylaczono: 'Stany magazynowe są wyłączone.',
  bez_zmian: 'Nic się nie zmieniło — stany były już w tym położeniu.',
};

export function registerUstawieniaMagazynuRoutes(app, { db }) {
  app.get('/ustawienia/magazyn', async (req, reply) => {
    const przelacznik = przelacznikStanow(db);
    return reply.view('ustawienia-magazyn.ejs', {
      nawigacja: nawigacjaUstawien(req, reply),
      title: 'Magazyn',
      przelacznik,
      // Było już kiedyś włączone — ponowne włączenie zacznie liczyć od nowa (ostrzeżenie przy przycisku).
      bylWlaczony: przelacznik.historia.some((w) => w.wlaczone),
      zapisano: KOMUNIKATY[req.query?.zapisano] ?? null,
    });
  });

  app.post('/ustawienia/magazyn/stany', async (req, reply) => {
    const wartosc = String(req.body?.wlacz ?? '');
    if (wartosc !== '1' && wartosc !== '0') {
      return reply.code(400).type('text/plain; charset=utf-8').send('Pole „wlacz” musi mieć wartość 1 albo 0.');
    }
    const wlacz = wartosc === '1';
    const konto = req.konto ? { id: req.konto.id ?? null, login: req.konto.login ?? null } : null;
    const { zmieniono } = przelaczStany(db, { wlacz, konto });
    const zapisano = !zmieniono ? 'bez_zmian' : wlacz ? 'wlaczono' : 'wylaczono';
    return reply.code(303).redirect(`/ustawienia/magazyn?zapisano=${zapisano}`);
  });
}
