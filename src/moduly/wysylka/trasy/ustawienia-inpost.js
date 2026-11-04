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
import { umowyPobraniaFirmy, zapiszUmowePobrania } from '../db/umowy-pobrania.js';

const ADRES = '/ustawienia/integracje/inpost';
const KURIER = 'inpost'; // jeden literał nazwy kuriera w pliku (scripts/straznik-kurierow.mjs)
const KOMUNIKATY = { zapisano: 'Zapisano dane kuriera InPost.', odlaczono: 'Kurier InPost został odłączony. Token usunięty z OMS-u, umowa na pobranie w InPoście wyłączona.',
  'pobranie-tak': 'Umowa na pobranie w InPoście: włączona.', 'pobranie-nie': 'Umowa na pobranie w InPoście: wyłączona.' };
const PUSTY = { nazwa: 'InPost', organizacja: '', paczkomatNadawczy: '' };
// PRZ-135.T2.03: data ostatniej zmiany przełącznika (stan liczy umowyPobraniaFirmy — ta sama reguła co nadanie).
const KLUCZ_POBRANIA = 'wysylka.umowa_pobrania.inpost';
function umowaPobrania(db) {
  let zmienionoAt = null;
  try { zmienionoAt = db.prepare('SELECT zmienione_at FROM ustawienia WHERE klucz = ?').get(KLUCZ_POBRANIA)?.zmienione_at ?? null; } catch { /* brak tabeli = brak daty */ }
  return { wlaczone: umowyPobraniaFirmy(db).includes(KURIER), zmienionoAt };
}

export function registerUstawieniaInpostRoutes(app, { db, kurierInpost }) {
  function widok(req, reply, { wpisane = null, bledy = [], test = null } = {}) {
    const stan = stanDlaEkranu(wczytajKonfiguracjeIntegracji(db, KURIER));
    return reply.view('ustawienia-inpost.ejs', {
      nawigacja: nawigacjaUstawien(req, reply), title: 'InPost',
      zEnv: kurierInpost.zEnv, adresFirmy: kurierInpost.adresFirmy(), ekranAdresu: EKRAN_ADRESU_FIRMY, stan,
      adresApi: ADRES_INPOST,
      pola: { ...PUSTY, ...(stan?.ustawienia ?? {}), ...(wpisane ?? {}) },
      bledy, test,
      zapisano: KOMUNIKATY[req.query?.zapisano] ?? null,
      wymagaRestartu: kurierInpost.wymagaRestartu(),
      pobranie: umowaPobrania(db),
    });
  }
  const zEnv = (reply) => reply.code(409).type('text/plain; charset=utf-8')
    .send('Kurier InPost jest ustawiony w pliku konfiguracji (oms.env) — tam go zmień. Formularz niczego nie zapisał.');

  app.get(ADRES, async (req, reply) => widok(req, reply));

  app.post(ADRES, async (req, reply) => {
    if (kurierInpost.zEnv) return zEnv(reply);
    const { ustawienia, sekrety, bledy } = sprawdzFormularzInpost(req.body ?? {}, wczytajKonfiguracjeIntegracji(db, KURIER));
    if (bledy.length) {
      reply.code(400);
      return widok(req, reply, { wpisane: ustawienia, bledy });
    }
    const konto = req.konto ? { id: req.konto.id ?? null, login: req.konto.login ?? null } : null;
    zapiszKonfiguracjeIntegracji(db, KURIER, { ustawienia, sekrety }, { konto });
    kurierInpost.odswiez();
    return reply.code(303).redirect(`${ADRES}?zapisano=zapisano`);
  });

  app.post(`${ADRES}/sprawdz`, async (req, reply) => {
    if (kurierInpost.zEnv) return widok(req, reply);
    if (!wczytajKonfiguracjeIntegracji(db, KURIER)) {
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

  // ⚠️ PIENIĄDZE (PRZ-135.T2): włącza WYŁĄCZNIE pole o wartości dokładnie „tak” (zaznaczony checkbox) — brak pola
  // i każda inna wartość zapisują „nie”. Działa też przy InPoście w .env: to ustawienie firmy, nie dane konta ShipX.
  app.post(`${ADRES}/pobranie`, async (req, reply) => {
    const wlaczone = req.body?.umowa === 'tak';
    zapiszUmowePobrania(db, KURIER, wlaczone);
    return reply.code(303).redirect(`${ADRES}?zapisano=${wlaczone ? 'pobranie-tak' : 'pobranie-nie'}`);
  });

  // Odłączenie działa także przy InPoście w .env: token zapisany z ekranu, zanim ktoś dopisał InPost do pliku, musi dać się usunąć.
  // PRZ-135.T2 (D1): odłączenie wyłącza też umowę na pobranie — nowe konto to może być nowa umowa.
  app.post(`${ADRES}/odlacz`, async (_req, reply) => {
    usunKonfiguracjeIntegracji(db, KURIER);
    zapiszUmowePobrania(db, KURIER, false);
    kurierInpost.odswiez();
    return reply.code(303).redirect(`${ADRES}?zapisano=odlaczono`);
  });
}
