// PRZ-092: Ustawienia → Integracje → Kurier DPD (wzór: „Nowy kurier — DPD Polska” w Apilo).
//
// Dostęp: strażnik po prefiksie `/ustawienia` wpuszcza tylko konto z uprawnieniem „ustawienia”, a gościa demo
// zatrzymuje na każdym POST-cie (core/bezpieczenstwo/podglad-demo.js) — tu tych blokad nie powtarzamy.
// ⚠️ Hasło i kanał DPD Info nie wracają na ekran nigdy — także po błędzie formularza (pole hasła zawsze puste).
import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { sprawdzFormularzDpd, TYPY_ETYKIET_DPD } from '../../../domena/konfiguracja-dpd.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji, usunKonfiguracjeIntegracji, stanDlaEkranu }
  from '../../../oms/db/konfiguracja-integracji.js';
import { nawigacjaUstawien } from '../../ustawienia/nawigacja.js';
import { EKRAN_ADRESU_FIRMY } from '../../../domena/adres-firmy.js';

const ADRES = '/ustawienia/integracje/dpd';
const KOMUNIKATY = { zapisano: 'Zapisano dane kuriera DPD.', odlaczono: 'Kurier DPD został odłączony. Dane logowania usunięte z OMS-u.' };
const PUSTY = { nazwa: 'DPD', login: '', fid: '', typEtykiety: 'LBL_PRINTER' };

export function registerUstawieniaDpdRoutes(app, { db, kurierDpd }) {
  function widok(req, reply, { wpisane = null, bledy = [], test = null } = {}) {
    const stan = stanDlaEkranu(wczytajKonfiguracjeIntegracji(db, 'dpd'));
    return reply.view('ustawienia-dpd.ejs', {
      nawigacja: nawigacjaUstawien(req, reply), title: 'Kurier DPD',
      // PRZ-093.08: adres nadawcy = adres firmy (plik albo Ustawienia → Firma), czytany przy każdym widoku.
      zEnv: kurierDpd.zEnv, adresFirmy: kurierDpd.adresFirmy(), ekranAdresu: EKRAN_ADRESU_FIRMY, stan,
      pola: { ...PUSTY, ...(stan?.ustawienia ?? {}), ...(wpisane ?? {}) },
      typy: TYPY_ETYKIET_DPD, bledy, test,
      zapisano: KOMUNIKATY[req.query?.zapisano] ?? null,
      wymagaRestartu: kurierDpd.wymagaRestartu(),
    });
  }
  const zEnv = (reply) => reply.code(409).type('text/plain; charset=utf-8')
    .send('Kurier DPD jest ustawiony w pliku konfiguracji (oms.env) — tam go zmień. Formularz niczego nie zapisał.');

  app.get(ADRES, async (req, reply) => widok(req, reply));

  app.post(ADRES, async (req, reply) => {
    if (kurierDpd.zEnv) return zEnv(reply);
    const { ustawienia, sekrety, bledy } = sprawdzFormularzDpd(req.body ?? {}, wczytajKonfiguracjeIntegracji(db, 'dpd'));
    if (bledy.length) {
      reply.code(400);
      return widok(req, reply, { wpisane: ustawienia, bledy });
    }
    const konto = req.konto ? { id: req.konto.id ?? null, login: req.konto.login ?? null } : null;
    zapiszKonfiguracjeIntegracji(db, 'dpd', { ustawienia, sekrety }, { konto });
    kurierDpd.odswiez();
    return reply.code(303).redirect(`${ADRES}?zapisano=zapisano`);
  });

  app.post(`${ADRES}/sprawdz`, async (req, reply) => {
    if (kurierDpd.zEnv) return widok(req, reply);
    if (!wczytajKonfiguracjeIntegracji(db, 'dpd')) {
      return widok(req, reply, { test: { ok: false, tekst: 'Najpierw zapisz dane od DPD, potem sprawdź połączenie.' } });
    }
    try {
      await kurierDpd.sprawdzPolaczenie();
      return widok(req, reply, { test: { ok: true, tekst: 'Połączenie z DPD działa — DPD przyjęło login, hasło i numer klienta. Nic nie zostało nadane.' } });
    } catch (e) {
      req.log?.warn?.({ dpd: 'sprawdzenie połączenia', dlaOperatora: Boolean(e?.dlaOperatora) }, 'DPD: sprawdzenie połączenia nieudane');
      return widok(req, reply, { test: { ok: false, tekst: komunikatDlaOperatora(e) } });
    }
  });

  // Odłączenie działa także przy DPD w .env: hasło zapisane z ekranu, zanim ktoś dopisał DPD do pliku, musi dać się usunąć.
  app.post(`${ADRES}/odlacz`, async (_req, reply) => {
    usunKonfiguracjeIntegracji(db, 'dpd');
    kurierDpd.odswiez();
    return reply.code(303).redirect(`${ADRES}?zapisano=odlaczono`);
  });
}
