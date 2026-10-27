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
import { jawnyBrak } from '../../../domena/wybor-programu.js';
import { nawigacjaUstawien } from '../../ustawienia/nawigacja.js';
import { czyWysylacKonsumenckie, zapiszKonsumenckie } from '../db/ksef-konsumenckie.js';
import { stanAutomatuKsef, obsluzZapisAutomatuKsef } from './automat-ksef-ekran.js';

const KOMUNIKATY = { zapisano: 'Zapisano klucz API inFaktu.', odlaczono: 'inFakt został odłączony. Klucz API usunięty z OMS-u.' };

export function registerUstawieniaInfaktuRoutes(app, { db, konfiguracjaInfaktu, automatKsef = null, teraz = () => new Date(), infakt = null }) {
  const k = konfiguracjaInfaktu;
  function widok(req, reply, { bledy = [], test = null } = {}) {
    const stan = stanDlaEkranu(wczytajKonfiguracjeIntegracji(db, 'infakt'));
    return reply.view('ustawienia-infakt.ejs', {
      nawigacja: nawigacjaUstawien(req, reply), title: 'inFakt',
      zEnv: k.zEnv, adresWPliku: k.adresWPliku, archiwumWPliku: k.archiwumWPliku, stan, adresApi: ADRES_INFAKT,
      bledy, test,
      konsumenckie: czyWysylacKonsumenckie(db),
      zapisano: KOMUNIKATY[req.query?.zapisano] ?? null,
      wymagaRestartu: k.wymagaRestartu(), odlaczonyDoRestartu: k.odlaczonyDoRestartu(),
      // PRZ-121.02: wybrany „Brak” (plik albo Ustawienia, także zapisany po starcie) — klucz zostaje, OMS go nie używa.
      wybranyBrak: jawnyBrak(k.wyborProgramu?.teraz?.()),
      // PRZ-108.06: formularz automatu KSeF jest na ekranie Ustawienia → Automatyzacje; tu zostaje stan i odnośnik
      // (odnośnik tylko dla admina — tylko admin ten automat ustawia).
      automatStan: stanAutomatuKsef(db, teraz),
      admin: req.konto?.admin === true || req.konto?.podgladDemo === true,
    });
  }

  // PRZ-102.12 → PRZ-108.06: stary adres zapisu automatu KSeF. Ta sama obsługa co na ekranie Automatyzacji
  // (automat-ksef-ekran.js): tylko admin, 303 na nowy ekran, błąd formularza = 400 z ekranem Automatyzacji.
  // PRZ-118.10: `infakt` (usługa modułu faktur: klient albo program) — nazwa programu w sekcji automatu przy 400.
  app.post(`${EKRAN_INFAKTU}/ksef-automat`, obsluzZapisAutomatuKsef({ db, konfiguracjaInfaktu, automatKsef, teraz, infakt }));
  const zEnv = (reply) => reply.code(409).type('text/plain; charset=utf-8')
    .send('inFakt jest ustawiony w pliku konfiguracji (oms.env, INFAKT_API_KEY) — tam go zmień. Formularz niczego nie zapisał.');

  // Prefiks /ustawienia: zapis tylko z prawem do Ustawień, również gdy klucz API pochodzi z pliku.
  app.post(`${EKRAN_INFAKTU}/ksef-konsumenckie`, async (req, reply) => {
    const wartosci = [].concat(req.body?.wlaczony ?? '0');
    if (wartosci.some((w) => w !== '0' && w !== '1')) {
      return reply.code(400).send('Nieprawidłowa wartość przełącznika faktur konsumenckich.');
    }
    zapiszKonsumenckie(db, wartosci.includes('1'));
    return reply.code(303).redirect(`${EKRAN_INFAKTU}#ksef-konsumenckie`);
  });

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
