// PRZ-119.06: wzór ekranu inFaktu; wartości sekretów nigdy nie trafiają do widoku.
import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { stronaOdmowy } from '../../../core/web/odmowa.js';
import { sprawdzFormularzFakturowni, EKRAN_FAKTUROWNI } from '../../../domena/konfiguracja-fakturownia.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji, usunKonfiguracjeIntegracji, stanDlaEkranu }
  from '../../../oms/db/konfiguracja-integracji.js';
import { nawigacjaUstawien } from '../../ustawienia/nawigacja.js';
import { utworzAlarmAutoKsef } from '../db/alarm-auto-ksef.js';
import { fmtDataCzas } from '../../../domena/format-daty.js';

const KOMUNIKATY = {
  zapisano: 'Zapisano domenę konta i token API Fakturowni.',
  odlaczono: 'Fakturownia została odłączona. Token API usunięty z OMS-u.',
  sprawdzono: 'Potwierdzono wyłączenie automatycznej wysyłki w Fakturowni. Alarm został wygaszony.',
};

export function registerUstawieniaFakturowniRoutes(app, { db, konfiguracjaFakturowni: k, teraz = () => new Date() }) {
  const alarm = utworzAlarmAutoKsef(db, { teraz });
  function widok(req, reply, { bledy = [], test = null } = {}) {
    const stan = stanDlaEkranu(wczytajKonfiguracjeIntegracji(db, 'fakturownia'));
    return reply.view('ustawienia-fakturownia.ejs', {
      szerokosc: 'formularz', title: 'Fakturownia', nawigacja: nawigacjaUstawien(req, reply),
      stan, zEnv: k.zEnv, domenaProby: k.domenaProby ?? null, bledy, test,
      // Znacznik alarmu to UTC (`toISOString`) — na ekranie czas polski, jak w reszcie panelu.
      alarm: alarm.wczytaj().map((w) => ({ ...w, kiedy: w.chwila ? fmtDataCzas(w.chwila) : null })),
      wymagaRestartu: k.wymagaRestartu(), zapisano: KOMUNIKATY[req.query?.zapisano] ?? null,
    });
  }
  app.get(EKRAN_FAKTUROWNI, async (req, reply) => widok(req, reply));
  app.post(EKRAN_FAKTUROWNI, async (req, reply) => {
    if (k.zEnv) return stronaOdmowy(reply, 409,
      'Fakturownia jest ustawiona w pliku konfiguracji (oms.env, FAKTUROWNIA_API_TOKEN i FAKTUROWNIA_DOMENA) — tam ją zmień. Formularz niczego nie zapisał.',
      { tytul: 'Nie zapisano ustawień Fakturowni', wroc: EKRAN_FAKTUROWNI, napisWroc: 'Wróć do ustawień Fakturowni' });
    // PRZ-119.11b: pole domeny jest tylko do odczytu, ale jedyną ochroną jest to sprawdzenie (nic nie zapisane).
    if (k.domenaProby && String(req.body?.domena ?? '').trim() !== k.domenaProby) {
      reply.code(400);
      return widok(req, reply, { bledy: [k.zdanieKontaProby(k.domenaProby)] });
    }
    const { ustawienia, sekrety, bledy } = sprawdzFormularzFakturowni(req.body ?? {}, wczytajKonfiguracjeIntegracji(db, 'fakturownia'));
    if (bledy.length) {
      reply.code(400);
      return widok(req, reply, { bledy });
    }
    const konto = req.konto ? { id: req.konto.id ?? null, login: req.konto.login ?? null } : null;
    zapiszKonfiguracjeIntegracji(db, 'fakturownia', { ustawienia, sekrety }, { konto });
    return reply.code(303).redirect(`${EKRAN_FAKTUROWNI}?zapisano=zapisano`);
  });
  app.post(`${EKRAN_FAKTUROWNI}/sprawdz`, async (req, reply) => {
    if (!k.zEnv && !wczytajKonfiguracjeIntegracji(db, 'fakturownia')) {
      return widok(req, reply, { test: { ok: false, tekst: 'Najpierw zapisz domenę konta i token API, potem sprawdź połączenie.' } });
    }
    try {
      await k.sprawdzPolaczenie();
      return widok(req, reply, { test: { ok: true, tekst: 'Połączenie z Fakturownią działa — przyjęła token i oddała listę faktur. Nic nie zostało wystawione ani wysłane do KSeF.' } });
    } catch (e) {
      req.log?.warn?.({ fakturownia: 'sprawdzenie połączenia', status: e?.status ?? null }, 'Fakturownia: sprawdzenie połączenia nieudane');
      return widok(req, reply, { test: { ok: false, tekst: komunikatDlaOperatora(e) } });
    }
  });
  app.post(`${EKRAN_FAKTUROWNI}/sprawdzilem`, async (_req, reply) => {
    alarm.zgas();
    return reply.code(303).redirect(`${EKRAN_FAKTUROWNI}?zapisano=sprawdzono`);
  });
  app.post(`${EKRAN_FAKTUROWNI}/odlacz`, async (_req, reply) => {
    usunKonfiguracjeIntegracji(db, 'fakturownia');
    return reply.code(303).redirect(`${EKRAN_FAKTUROWNI}?zapisano=odlaczono`);
  });
}
