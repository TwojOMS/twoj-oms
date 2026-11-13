// PRZ-119.06: wzór ekranu inFaktu; wartości sekretów nigdy nie trafiają do widoku.
import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { stronaOdmowy } from '../../../core/web/odmowa.js';
import { sprawdzFormularzFakturowni, EKRAN_FAKTUROWNI } from '../../../domena/konfiguracja-fakturownia.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji, usunKonfiguracjeIntegracji, stanDlaEkranu }
  from '../../../oms/db/konfiguracja-integracji.js';
import { nawigacjaUstawien } from '../../ustawienia/nawigacja.js';
import { utworzAlarmAutoKsef } from '../db/alarm-auto-ksef.js';
import { fmtDataCzas } from '../../../domena/format-daty.js';
import { EKRAN_WYBORU_PROGRAMU } from '../../../domena/wybor-programu.js';
import { ADRES_RESTARTU } from './ustawienia-programu.js';
import { zapiszSprawdzenieFakturowni, wczytajSprawdzenieFakturowni, usunSprawdzenieFakturowni, stanZBledu }
  from '../db/sprawdzenie-fakturowni.js';

const KOMUNIKATY = {
  zapisano: 'Zapisano. Fakturownia przyjęła token — połączenie działa.',
  niesprawdzone: 'Zapisano, ale połączenia nie udało się sprawdzić — powód w stanie połączenia.',
  odlaczono: 'Fakturownia została odłączona. Token API usunięty z OMS-u.',
  sprawdzono: 'Potwierdzono wyłączenie automatycznej wysyłki w Fakturowni. Alarm został wygaszony.',
};

// PRZ-161: oficjalny skrót z pomocy Fakturowni do Integracje i dodatki → KSeF (przekierowuje na konto zalogowanego).
export const ADRES_KSEF_W_FAKTUROWNI = 'https://app.fakturownia.pl/goto?after_url=apps/ksef';
export const POMOC_KSEF_W_FAKTUROWNI = 'https://pomoc.fakturownia.pl/199488736-jak-wysylac-faktury-z-fakturowni-do-ksef';

/**
 * PRZ-161: ostatnie 4 znaki tokenu — żeby rozpoznać, KTÓRY token jest zapisany. Gdy token niesie `/domena` na końcu,
 * końcówka idzie sprzed ukośnika (sama domena nic by nie mówiła). Token krótszy niż 12 znaków — nic (formularz i tak
 * takiego nie przyjmie, a z krótkiego czwórka zdradzałaby za dużo).
 */
export function koncowkaTokenu(token) {
  const t = String(token ?? '').trim().split('/')[0];
  return t.length >= 12 ? t.slice(-4) : null;
}

export function registerUstawieniaFakturowniRoutes(app, { db, konfiguracjaFakturowni: k, teraz = () => new Date(),
  wyborProgramu = /** @type {any} */ (null), restart = /** @type {any} */ (null) }) {
  const alarm = utworzAlarmAutoKsef(db, { teraz });
  // PRZ-161: co jeszcze dzieli zapisaną Fakturownię od wystawiania — wybór w Module faktur albo restart.
  function uruchomienie(req) {
    if (!k.wymagaRestartu()) return null;
    const wybrana = wyborProgramu?.teraz?.()?.program === 'fakturownia';
    if (!wybrana) return { wybrana, adresModulu: EKRAN_WYBORU_PROGRAMU };
    const tryb = restart?.tryb ?? null;
    return { wybrana, adresModulu: EKRAN_WYBORU_PROGRAMU,
      przycisk: tryb && req.konto?.admin === true ? { adres: ADRES_RESTARTU, nieaktywny: tryb !== 'tak' } : null,
      recznie: !tryb };
  }
  // PRZ-161: jedno zapytanie do Fakturowni danymi `dane` (albo zapisanymi). Zwraca { stan, tekst }; nigdy nie rzuca.
  async function sprawdz(req, dane = null) {
    const zablokowane = k.sprawdzenieZablokowane?.() ?? null;
    if (zablokowane) return { stan: 'niesprawdzony', tekst: zablokowane, pominiete: true };
    try {
      await k.sprawdzPolaczenie(dane);
      return { stan: 'ok', tekst: null };
    } catch (e) {
      req.log?.warn?.({ fakturownia: 'sprawdzenie połączenia', status: e?.status ?? null }, 'Fakturownia: sprawdzenie połączenia nieudane');
      return { stan: stanZBledu(e), tekst: komunikatDlaOperatora(e) };
    }
  }
  const daneZapisu = (zapis) => zapis ? { domena: String(zapis.ustawienia?.domena ?? ''), token: String(zapis.sekrety?.token ?? '') } : null;
  function widok(req, reply, { bledy = [], test = null, domenaWpisana = null } = {}) {
    const zapis = wczytajKonfiguracjeIntegracji(db, 'fakturownia');
    const stan = stanDlaEkranu(zapis);
    const sprawdzenie = k.zEnv ? null : wczytajSprawdzenieFakturowni(db, daneZapisu(zapis));
    const potwierdzono = alarm.potwierdzono();
    return reply.view('ustawienia-fakturownia.ejs', {
      szerokosc: 'formularz', title: 'Fakturownia', nawigacja: nawigacjaUstawien(req, reply),
      stan, zEnv: k.zEnv, domenaProby: k.domenaProby ?? null, bledy, test, domenaWpisana,
      sprawdzenie: sprawdzenie ? { ...sprawdzenie, kiedy: sprawdzenie.kiedy ? fmtDataCzas(sprawdzenie.kiedy) : null } : null,
      // Tylko końcówka; pełny token nigdy nie trafia do widoku.
      koncowka: k.zEnv ? null : koncowkaTokenu(zapis?.sekrety?.token),
      // Znacznik alarmu to UTC (`toISOString`) — na ekranie czas polski, jak w reszcie panelu.
      alarm: alarm.wczytaj().map((w) => ({ ...w, kiedy: w.chwila ? fmtDataCzas(w.chwila) : null })),
      potwierdzono: potwierdzono ? fmtDataCzas(potwierdzono) : null,
      adresKsef: ADRES_KSEF_W_FAKTUROWNI, pomocKsef: POMOC_KSEF_W_FAKTUROWNI,
      uruchomienie: uruchomienie(req), zmien: req.query?.zmien === '1', zapisano: KOMUNIKATY[req.query?.zapisano] ?? null,
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
    // PRZ-161: najpierw Fakturownia, potem zapis. Odmowa (zły token, nieznane konto) = nic nie zapisane;
    // brak odpowiedzi = zapis ze stanem „niesprawdzony” (dane mogą być dobre, Fakturownia chwilowo niedostępna).
    const dane = { domena: ustawienia.domena, token: sekrety.token };
    const wynik = await sprawdz(req, dane);
    if (wynik.stan === 'odrzucony') {
      reply.code(400);
      return widok(req, reply, { domenaWpisana: ustawienia.domena,
        bledy: [`Fakturownia nie przyjęła tych danych — nic nie zapisano. ${wynik.tekst}`] });
    }
    const konto = req.konto ? { id: req.konto.id ?? null, login: req.konto.login ?? null } : null;
    zapiszKonfiguracjeIntegracji(db, 'fakturownia', { ustawienia, sekrety }, { konto });
    zapiszSprawdzenieFakturowni(db, wynik, dane, { teraz: teraz() });
    return reply.code(303).redirect(`${EKRAN_FAKTUROWNI}?zapisano=${wynik.stan === 'ok' ? 'zapisano' : 'niesprawdzone'}`);
  });
  app.post(`${EKRAN_FAKTUROWNI}/sprawdz`, async (req, reply) => {
    if (!k.zEnv && !wczytajKonfiguracjeIntegracji(db, 'fakturownia')) {
      return widok(req, reply, { test: { ok: false, tekst: 'Najpierw zapisz domenę konta i token API, potem sprawdź połączenie.' } });
    }
    const wynik = await sprawdz(req);
    // Wynik zapamiętany dla danych z Ustawień (plik konfiguracji nie ma stanu na ekranie); pominięte przy „Brak” — nie.
    const zapis = wczytajKonfiguracjeIntegracji(db, 'fakturownia');
    if (!k.zEnv && zapis && !wynik.pominiete) zapiszSprawdzenieFakturowni(db, wynik, daneZapisu(zapis), { teraz: teraz() });
    return widok(req, reply, { test: wynik.stan === 'ok'
      ? { ok: true, tekst: 'Połączenie z Fakturownią działa — przyjęła token i oddała listę faktur. Nic nie zostało wystawione ani wysłane do KSeF.' }
      : { ok: false, tekst: wynik.tekst } });
  });
  app.post(`${EKRAN_FAKTUROWNI}/sprawdzilem`, async (_req, reply) => {
    alarm.zgas();
    return reply.code(303).redirect(`${EKRAN_FAKTUROWNI}?zapisano=sprawdzono`);
  });
  app.post(`${EKRAN_FAKTUROWNI}/odlacz`, async (_req, reply) => {
    usunKonfiguracjeIntegracji(db, 'fakturownia');
    usunSprawdzenieFakturowni(db);
    return reply.code(303).redirect(`${EKRAN_FAKTUROWNI}?zapisano=odlaczono`);
  });
}
