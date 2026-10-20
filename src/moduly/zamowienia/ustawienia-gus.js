// PRZ-102.11: Ustawienia → Integracje → GUS (dane firm po NIP). Wzór: faktury/trasy/ustawienia-infakt.js (PRZ-093.10).
//
// Dostęp: strażnik po prefiksie `/ustawienia` wpuszcza tylko konto z uprawnieniem „ustawienia”, a gościa demo
// zatrzymuje na każdym POST-cie (core/bezpieczenstwo/podglad-demo.js) — tu tych blokad nie powtarzamy.
// ⚠️ Klucz nie wraca na ekran nigdy — także po błędzie formularza (pole klucza zawsze puste). Komunikat testu
// połączenia buduje klient GUS (bez klucza); błąd techniczny idzie tylko do logu, też bez klucza.
import { komunikatDlaOperatora } from '../../domena/bledy.js';
import { sprawdzFormularzGus, EKRAN_GUS } from '../../domena/konfiguracja-gus.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji, usunKonfiguracjeIntegracji, stanDlaEkranu }
  from '../../oms/db/konfiguracja-integracji.js';
import { nawigacjaUstawien } from '../ustawienia/nawigacja.js';
import { tytulEkranuDlaAdresu } from '../../domena/ekrany.js';

const KOMUNIKATY = { zapisano: 'Zapisano klucz GUS. Przycisk „Pobierz z GUS” działa od teraz.', odlaczono: 'Klucz GUS usunięty z OMS-u.' };

export function registerUstawieniaGusRoutes(app, { db, konfiguracjaGus }) {
  const k = konfiguracjaGus;
  function widok(req, reply, { bledy = [], test = null } = {}) {
    const stan = stanDlaEkranu(wczytajKonfiguracjeIntegracji(db, 'gus'));
    return reply.view('ustawienia-gus.ejs', {
      nawigacja: nawigacjaUstawien(req, reply), title: tytulEkranuDlaAdresu(EKRAN_GUS),
      zEnv: k.zEnv, stan, bledy, test,
      zapisano: KOMUNIKATY[req.query?.zapisano] ?? null,
    });
  }
  const zEnv = (reply) => reply.code(409).type('text/plain; charset=utf-8')
    .send('Klucz GUS jest ustawiony w pliku konfiguracji (oms.env, GUS_KLUCZ) — tam go zmień. Formularz niczego nie zapisał.');

  app.get(EKRAN_GUS, async (req, reply) => widok(req, reply));

  app.post(EKRAN_GUS, async (req, reply) => {
    if (k.zEnv) return zEnv(reply);
    const { ustawienia, sekrety, bledy } = sprawdzFormularzGus(req.body ?? {}, wczytajKonfiguracjeIntegracji(db, 'gus'));
    if (bledy.length) {
      reply.code(400);
      return widok(req, reply, { bledy });
    }
    const konto = req.konto ? { id: req.konto.id ?? null, login: req.konto.login ?? null } : null;
    zapiszKonfiguracjeIntegracji(db, 'gus', { ustawienia, sekrety }, { konto });
    return reply.code(303).redirect(`${EKRAN_GUS}?zapisano=zapisano`);
  });

  app.post(`${EKRAN_GUS}/sprawdz`, async (req, reply) => {
    if (k.zEnv) return widok(req, reply);
    if (!k.zapisany()) {
      return widok(req, reply, { test: { ok: false, tekst: 'Najpierw zapisz klucz, potem sprawdź połączenie.' } });
    }
    try {
      await k.sprawdzZapisany();
      return widok(req, reply, { test: { ok: true, tekst: 'Połączenie z GUS działa — usługa BIR przyjęła klucz. Nic nie zostało pobrane ani zmienione.' } });
    } catch (e) {
      req.log?.warn?.({ gus: 'sprawdzenie połączenia', dlaOperatora: Boolean(e?.dlaOperatora), status: e?.status ?? null }, 'GUS: sprawdzenie połączenia nieudane');
      return widok(req, reply, { test: { ok: false, tekst: komunikatDlaOperatora(e) } });
    }
  });

  // Usunięcie działa także przy kluczu w .env: klucz zapisany z ekranu, zanim ktoś dopisał go do pliku, musi dać się usunąć.
  app.post(`${EKRAN_GUS}/odlacz`, async (_req, reply) => {
    usunKonfiguracjeIntegracji(db, 'gus');
    return reply.code(303).redirect(`${EKRAN_GUS}?zapisano=odlaczono`);
  });
}
