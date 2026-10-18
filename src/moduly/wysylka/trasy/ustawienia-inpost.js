// PRZ-093.09: Ustawienia → Integracje → Kurier InPost. Wzór: trasy/ustawienia-dpd.js (PRZ-092).
//
// Dostęp: strażnik po prefiksie `/ustawienia` wpuszcza tylko konto z uprawnieniem „ustawienia”, a gościa demo
// zatrzymuje na każdym POST-cie (core/bezpieczenstwo/podglad-demo.js) — tu tych blokad nie powtarzamy.
// ⚠️ Token ShipX nie wraca na ekran nigdy — także po błędzie formularza (pole tokenu zawsze puste).
import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { sprawdzFormularzInpost, ADRES_INPOST } from '../../../domena/konfiguracja-inpost.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji, usunKonfiguracjeIntegracji, stanDlaEkranu }
  from '../../../oms/db/konfiguracja-integracji.js';
import { nawigacjaUstawien } from '../../ustawienia/nawigacja.js';
import { EKRAN_ADRESU_FIRMY } from '../../../domena/adres-firmy.js';

const ADRES = '/ustawienia/integracje/inpost';
const KOMUNIKATY = { zapisano: 'Zapisano dane kuriera InPost.', odlaczono: 'Kurier InPost został odłączony. Token usunięty z OMS-u.' };
const PUSTY = { nazwa: 'InPost', organizacja: '', paczkomatNadawczy: '' };

export function registerUstawieniaInpostRoutes(app, { db, kurierInpost }) {
  function widok(req, reply, { wpisane = null, bledy = [], test = null } = {}) {
    const stan = stanDlaEkranu(wczytajKonfiguracjeIntegracji(db, 'inpost'));
    return reply.view('ustawienia-inpost.ejs', {
      nawigacja: nawigacjaUstawien(req, reply), title: 'Kurier InPost',
      zEnv: kurierInpost.zEnv, adresFirmy: kurierInpost.adresFirmy(), ekranAdresu: EKRAN_ADRESU_FIRMY, stan,
      adresApi: ADRES_INPOST,
      pola: { ...PUSTY, ...(stan?.ustawienia ?? {}), ...(wpisane ?? {}) },
      bledy, test,
      zapisano: KOMUNIKATY[req.query?.zapisano] ?? null,
      wymagaRestartu: kurierInpost.wymagaRestartu(),
    });
  }
  const zEnv = (reply) => reply.code(409).type('text/plain; charset=utf-8')
    .send('Kurier InPost jest ustawiony w pliku konfiguracji (oms.env) — tam go zmień. Formularz niczego nie zapisał.');

  app.get(ADRES, async (req, reply) => widok(req, reply));

  app.post(ADRES, async (req, reply) => {
    if (kurierInpost.zEnv) return zEnv(reply);
    const { ustawienia, sekrety, bledy } = sprawdzFormularzInpost(req.body ?? {}, wczytajKonfiguracjeIntegracji(db, 'inpost'));
    if (bledy.length) {
      reply.code(400);
      return widok(req, reply, { wpisane: ustawienia, bledy });
    }
    const konto = req.konto ? { id: req.konto.id ?? null, login: req.konto.login ?? null } : null;
    zapiszKonfiguracjeIntegracji(db, 'inpost', { ustawienia, sekrety }, { konto });
    kurierInpost.odswiez();
    return reply.code(303).redirect(`${ADRES}?zapisano=zapisano`);
  });

  app.post(`${ADRES}/sprawdz`, async (req, reply) => {
    if (kurierInpost.zEnv) return widok(req, reply);
    if (!wczytajKonfiguracjeIntegracji(db, 'inpost')) {
      return widok(req, reply, { test: { ok: false, tekst: 'Najpierw zapisz token i numer organizacji, potem sprawdź połączenie.' } });
    }
    try {
      await kurierInpost.sprawdzPolaczenie();
      return widok(req, reply, { test: { ok: true, tekst: 'Połączenie z InPostem działa — InPost przyjął token i pokazał organizację. Nic nie zostało nadane.' } });
    } catch (e) {
      req.log?.warn?.({ inpost: 'sprawdzenie połączenia', dlaOperatora: Boolean(e?.dlaOperatora) }, 'InPost: sprawdzenie połączenia nieudane');
      return widok(req, reply, { test: { ok: false, tekst: komunikatDlaOperatora(e) } });
    }
  });

  // Odłączenie działa także przy InPoście w .env: token zapisany z ekranu, zanim ktoś dopisał InPost do pliku, musi dać się usunąć.
  app.post(`${ADRES}/odlacz`, async (_req, reply) => {
    usunKonfiguracjeIntegracji(db, 'inpost');
    kurierInpost.odswiez();
    return reply.code(303).redirect(`${ADRES}?zapisano=odlaczono`);
  });
}
