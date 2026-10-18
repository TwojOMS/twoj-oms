// PRZ-093.10: Ustawienia → Integracje → inFakt. Wzór: wysylka/trasy/ustawienia-inpost.js (PRZ-093.09).
//
// Dostęp: strażnik po prefiksie `/ustawienia` wpuszcza tylko konto z uprawnieniem „ustawienia”, a gościa demo
// zatrzymuje na każdym POST-cie (core/bezpieczenstwo/podglad-demo.js) — tu tych blokad nie powtarzamy.
// ⚠️ Klucz API nie wraca na ekran nigdy — także po błędzie formularza (pole klucza zawsze puste). Komunikat testu
// połączenia buduje klient inFaktu (sprawdzPolaczenie zastępuje w nim klucz); błąd techniczny idzie tylko do logu.
import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { sprawdzFormularzInfakt, ADRES_INFAKT, EKRAN_INFAKTU } from '../../../domena/konfiguracja-infakt.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji, usunKonfiguracjeIntegracji, stanDlaEkranu }
  from '../../../oms/db/konfiguracja-integracji.js';
import { nawigacjaUstawien } from '../../ustawienia/nawigacja.js';

const KOMUNIKATY = { zapisano: 'Zapisano klucz API inFaktu.', odlaczono: 'inFakt został odłączony. Klucz API usunięty z OMS-u.' };

export function registerUstawieniaInfaktuRoutes(app, { db, konfiguracjaInfaktu }) {
  const k = konfiguracjaInfaktu;
  function widok(req, reply, { bledy = [], test = null } = {}) {
    const stan = stanDlaEkranu(wczytajKonfiguracjeIntegracji(db, 'infakt'));
    return reply.view('ustawienia-infakt.ejs', {
      nawigacja: nawigacjaUstawien(req, reply), title: 'inFakt',
      zEnv: k.zEnv, adresWPliku: k.adresWPliku, archiwumWPliku: k.archiwumWPliku, stan, adresApi: ADRES_INFAKT,
      bledy, test,
      zapisano: KOMUNIKATY[req.query?.zapisano] ?? null,
      wymagaRestartu: k.wymagaRestartu(), odlaczonyDoRestartu: k.odlaczonyDoRestartu(),
    });
  }
  const zEnv = (reply) => reply.code(409).type('text/plain; charset=utf-8')
    .send('inFakt jest ustawiony w pliku konfiguracji (oms.env, INFAKT_API_KEY) — tam go zmień. Formularz niczego nie zapisał.');

  app.get(EKRAN_INFAKTU, async (req, reply) => widok(req, reply));

  app.post(EKRAN_INFAKTU, async (req, reply) => {
    if (k.zEnv) return zEnv(reply);
    const { ustawienia, sekrety, bledy } = sprawdzFormularzInfakt(req.body ?? {}, wczytajKonfiguracjeIntegracji(db, 'infakt'));
    if (bledy.length) {
      reply.code(400);
      return widok(req, reply, { bledy });
    }
    const konto = req.konto ? { id: req.konto.id ?? null, login: req.konto.login ?? null } : null;
    zapiszKonfiguracjeIntegracji(db, 'infakt', { ustawienia, sekrety }, { konto });
    return reply.code(303).redirect(`${EKRAN_INFAKTU}?zapisano=zapisano`);
  });

  app.post(`${EKRAN_INFAKTU}/sprawdz`, async (req, reply) => {
    if (k.zEnv) return widok(req, reply);
    if (!wczytajKonfiguracjeIntegracji(db, 'infakt')) {
      return widok(req, reply, { test: { ok: false, tekst: 'Najpierw zapisz klucz API, potem sprawdź połączenie.' } });
    }
    try {
      await k.sprawdzPolaczenie();
      return widok(req, reply, { test: { ok: true, tekst: 'Połączenie z inFaktem działa — inFakt przyjął klucz i oddał listę faktur. Nic nie zostało wystawione ani wysłane do KSeF.' } });
    } catch (e) {
      req.log?.warn?.({ infakt: 'sprawdzenie połączenia', dlaOperatora: Boolean(e?.dlaOperatora), status: e?.status ?? null }, 'inFakt: sprawdzenie połączenia nieudane');
      return widok(req, reply, { test: { ok: false, tekst: komunikatDlaOperatora(e) } });
    }
  });

  // Odłączenie działa także przy inFakcie w .env: klucz zapisany z ekranu, zanim ktoś dopisał inFakt do pliku, musi dać się usunąć.
  app.post(`${EKRAN_INFAKTU}/odlacz`, async (_req, reply) => {
    usunKonfiguracjeIntegracji(db, 'infakt');
    return reply.code(303).redirect(`${EKRAN_INFAKTU}?zapisano=odlaczono`);
  });
}
