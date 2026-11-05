// PRZ-102.22: Ustawienia → Integracje → KSeF (faktury kosztowe). Wzór: zamowienia/ustawienia-gus.js (PRZ-102.11).
//
// Dostęp: strażnik po prefiksie `/ustawienia` wpuszcza tylko konto z uprawnieniem „ustawienia”, a gościa demo
// zatrzymuje na każdym POST-cie (core/bezpieczenstwo/podglad-demo.js) — tu tych blokad nie powtarzamy.
// ⚠️ Token nie wraca na ekran nigdy — także po błędzie formularza (pole tokenu zawsze puste). Komunikat testu
// połączenia buduje klient KSeF z odpowiedzi serwera (bez tokenu); błąd techniczny idzie tylko do logu, też bez tokenu.
import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { stronaOdmowy } from '../../../core/web/odmowa.js';
import { sprawdzFormularzKsef, EKRAN_KSEF, ZDANIE_UPRAWNIENIA_KSEF, ZDANIE_TOKENU_KOSZTOW_TWOJEFAKTURY, ODMOWA_KSEF_BRAK_NIP } from '../../../domena/konfiguracja-ksef-kosztow.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji, usunKonfiguracjeIntegracji, stanDlaEkranu }
  from '../../../oms/db/konfiguracja-integracji.js';
import { usunSesjeKsef } from '../../../oms/ksef/sesja.js';
import { wylaczoneModuly } from '../../../oms/db/moduly-opcjonalne.js';
import { nawigacjaUstawien } from '../../ustawienia/nawigacja.js';
import { tytulEkranuDlaAdresu } from '../../../domena/ekrany.js';
import { odmianaNazwyProgramu } from '../../../domena/nazwa-programu.js';

const KOMUNIKATY = {
  zapisano: 'Zapisano token KSeF. Czuwacz kosztów pobierze nim faktury zakupowe przy następnym przebiegu (o 3 w nocy albo „Odśwież teraz” na ekranie Koszty).',
  odlaczono: 'Token KSeF usunięty z OMS-u. Panel nie pobiera już faktur kosztowych; koszty zapisane wcześniej zostają.',
};

export function registerUstawieniaKsefRoutes(app, { db, zrodloKsef, nipSprzedawcy: nip, infakt = null }) {
  // PRZ-118.09: zdanie „Wysyłka faktur sprzedaży idzie przez …” — nazwa programu z usługi `infakt` modułu faktur.
  const program = infakt;
  const nazwaProgramu = odmianaNazwyProgramu(program);
  const wbudowany = program?.opis?.wbudowany === true;
  const k = zrodloKsef;
  // PRZ-108.10: NIP firmy funkcją (plik albo Ustawienia → Firma) — czytany przy każdym widoku i zapisie.
  const nipTeraz = () => (typeof nip === 'function' ? nip() : nip) ?? null;
  function widok(req, reply, { bledy = [], test = null } = {}) {
    const zapis = wczytajKonfiguracjeIntegracji(db, 'ksef');
    return reply.view('ustawienia-ksef.ejs', {
      nawigacja: nawigacjaUstawien(req, reply), title: tytulEkranuDlaAdresu(EKRAN_KSEF),
      zEnv: k.zEnv, stan: stanDlaEkranu(zapis), nipZapisu: zapis?.ustawienia?.nip ?? '', nipSprzedawcy: nipTeraz(),
      nipNiezgodny: k.nipNiezgodny(), modulWylaczony: wylaczoneModuly(db).includes('koszty'),
      zdanie: wbudowany ? ZDANIE_TOKENU_KOSZTOW_TWOJEFAKTURY : ZDANIE_UPRAWNIENIA_KSEF,
      wbudowany, bledy, test, odmowaBrakNip: ODMOWA_KSEF_BRAK_NIP,
      zapisano: KOMUNIKATY[req.query?.zapisano] ?? null, nazwaProgramu,
    });
  }
  // PRZ-152.G13k1: odmowa w układzie OMS (status i tekst bez zmian); tekst nie niesie tokenu.
  const zEnv = (reply) => stronaOdmowy(reply, 409,
    'Token KSeF jest ustawiony w pliku konfiguracji (oms.env, KSEF_TOKEN) — tam go zmień. Formularz niczego nie zapisał.',
    { tytul: 'Token KSeF jest w pliku konfiguracji', wroc: EKRAN_KSEF, napisWroc: 'Wróć do ustawień KSeF' });

  app.get(EKRAN_KSEF, async (req, reply) => widok(req, reply));

  app.post(EKRAN_KSEF, async (req, reply) => {
    if (k.zEnv) return zEnv(reply);
    const stary = wczytajKonfiguracjeIntegracji(db, 'ksef');
    const { ustawienia, sekrety, bledy } = sprawdzFormularzKsef(req.body ?? {}, stary, nipTeraz());
    if (bledy.length) {
      reply.code(400);
      return widok(req, reply, { bledy });
    }
    const konto = req.konto ? { id: req.konto.id ?? null, login: req.konto.login ?? null } : null;
    zapiszKonfiguracjeIntegracji(db, 'ksef', { ustawienia, sekrety }, { konto });
    // Nowy token = nowa sesja KSeF (oms/ksef/sesja.js); ten sam token zapisany ponownie zostawia sesję.
    if (stary?.sekrety?.token !== sekrety.token) usunSesjeKsef(db);
    return reply.code(303).redirect(`${EKRAN_KSEF}?zapisano=zapisano`);
  });

  app.post(`${EKRAN_KSEF}/sprawdz`, async (req, reply) => {
    if (k.zEnv) return widok(req, reply);
    if (!k.zapisany()) {
      return widok(req, reply, { test: { ok: false, tekst: 'Najpierw zapisz token, potem sprawdź połączenie.' } });
    }
    try {
      await k.sprawdzZapisany();
      return widok(req, reply, { test: { ok: true, tekst: 'Połączenie z KSeF działa — token przyjęty, lista faktur zakupowych z ostatniej doby odczytana. Nic nie zostało wysłane ani dopisane do kosztów.' } });
    } catch (e) {
      req.log?.warn?.({ ksef: 'sprawdzenie połączenia', dlaOperatora: Boolean(e?.dlaOperatora), status: e?.status ?? null }, 'KSeF: sprawdzenie połączenia nieudane');
      return widok(req, reply, { test: { ok: false, tekst: komunikatDlaOperatora(e) } });
    }
  });

  // Usunięcie działa także przy tokenie w .env: token zapisany z ekranu, zanim ktoś dopisał go do pliku, musi dać się
  // usunąć. Sesję KSeF kasujemy tylko wtedy, gdy była sesją tokenu z ekranu (przy pliku należy do tokenu z pliku).
  app.post(`${EKRAN_KSEF}/odlacz`, async (_req, reply) => {
    usunKonfiguracjeIntegracji(db, 'ksef');
    if (!k.zEnv) usunSesjeKsef(db);
    return reply.code(303).redirect(`${EKRAN_KSEF}?zapisano=odlaczono`);
  });
}
