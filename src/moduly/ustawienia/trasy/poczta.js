// PRZ-094.04: Ustawienia → Integracje → Poczta wychodząca. Wzór: wysylka/trasy/ustawienia-dpd.js (PRZ-092) i
// faktury/trasy/ustawienia-infakt.js (PRZ-093.10).
//
// Dwie niezależne części, każda z własnym „plik wygrywa”: serwer SMTP (SMTP_* w .env) i adres panelu do linków
// w mailach (OMS_ADRES_PANELU). Część ustawiona w pliku jest na ekranie tylko opisana, a jej zapis = 409.
// Dostęp: strażnik po prefiksie `/ustawienia` wpuszcza tylko konto z uprawnieniem „ustawienia”, a gościa demo
// zatrzymuje na każdym POST-cie (core/bezpieczenstwo/podglad-demo.js); Origin sprawdza wspólny potok — tu tych
// blokad nie powtarzamy.
// ⚠️ Hasło SMTP nie wraca na ekran nigdy — także po błędzie formularza (pole hasła zawsze puste) — i nie trafia do
// logu: przy nieudanej wiadomości próbnej log dostaje wyłącznie kod błędu nodemailera.
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji, usunKonfiguracjeIntegracji, stanDlaEkranu }
  from '../../../oms/db/konfiguracja-integracji.js';
import { EKRAN_POCZTY, PORT_DOMYSLNY, sprawdzFormularzPoczty, komunikatBleduPoczty } from '../../wiadomosci/poczta-ustawien.ts';
import { adresPaneluZZapisu, adresPaneluZZadania, sprawdzFormularzAdresuPanelu } from '../adres-panelu.ts';
import { emailKonta } from '../konta-dostep.js';
import { renderMailHtml } from '../../../core/poczta/mail-html.js';
import { nawigacjaUstawien } from '../nawigacja.js';

const KOMUNIKATY = {
  zapisano: 'Zapisano ustawienia poczty wychodzącej. Działają od następnego maila.',
  adres: 'Zapisano adres panelu. Linki w kolejnych mailach będą prowadzić pod ten adres.',
  'adres-usuniety': 'Usunięto zapisany adres panelu. Linki w kolejnych mailach prowadzą pod adres, z którego korzysta administrator wysyłający zaproszenie.',
  odlaczono: 'Ustawienia poczty usunięte z OMS-u (razem z hasłem).',
  podpis: 'Zapisano podpis maili. Następny mail do klienta pójdzie z tą marką i stopką.',
};
const PUSTY = { host: '', port: String(PORT_DOMYSLNY), user: '', nadawca: '' };
const ADRES_EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/u;
export const TEMAT_PROBNEJ = 'Wiadomość próbna z panelu';

/**
 * @param {any} app
 * PRZ-102.10: `podpis` — usługa wiadomosci.podpisMaili (marka i stopka maili do klientów) albo null bez modułu wiadomości.
 * @param {{ db: any, adresPaneluZEnv: string | null, poczta: () => any, mailer: () => any, podpis?: () => any, log?: (...t: string[]) => void }} opcje
 */
export function registerUstawieniaPocztyRoutes(app, { db, adresPaneluZEnv, poczta, mailer, podpis = () => null, log = () => {} }) {
  /** Sekcja „Podpis maili”: stan pól, wartości w formularzu i podgląd (bieżący albo z wpisanych, niezapisanych pól). */
  function ekranPodpisu({ wpisanyPodpis = null, bledyPodpisu = [], podgladWpisany = false, zapisano = false } = {}) {
    const usl = podpis();
    if (!usl) return null;
    const stan = usl.stan();
    const pola = { marka: stan.marka.wartosc, stopka: stan.stopka.wartosc, ...(wpisanyPodpis ?? {}) };
    return { stan, pola, bledy: bledyPodpisu, podgladWpisany, zapisano: zapisano ? KOMUNIKATY.podpis : null,
      podglad: usl.podglad(podgladWpisany && !bledyPodpisu.length ? wpisanyPodpis : null) };
  }
  function widok(req, reply, { wpisane = null, bledy = [], bledyAdresu = [], wpisanyAdres = null, proba = null, adresProby = null, podpisMaili = undefined } = {}) {
    const stanPoczty = poczta() ?? { zEnv: false, atrapa: false, ustawien: null };
    const stan = stanDlaEkranu(wczytajKonfiguracjeIntegracji(db, 'poczta'));
    const zapisAdresu = wczytajKonfiguracjeIntegracji(db, 'adres_panelu');
    const adresZapisany = adresPaneluZZapisu(zapisAdresu);
    const zapisane = stan?.ustawienia ?? {};
    return reply.view('ustawienia-poczta.ejs', {
      nawigacja: nawigacjaUstawien(req, reply), title: 'Poczta wychodząca',
      zEnv: stanPoczty.zEnv, atrapa: stanPoczty.atrapa, stan,
      pola: { ...PUSTY, ...Object.fromEntries(Object.entries(zapisane).map(([k, v]) => [k, String(v ?? '')])), ...(wpisane ?? {}) },
      moznaProbowac: Boolean(mailer()),
      adresProby: adresProby ?? emailKonta(db, req.konto?.id ?? -1) ?? '',
      // PRZ-094.10: tylko do podpowiedzi przy pustym polu — link z tokenem liczy wyłącznie trasa admina (konta.js).
      adresDomyslny: adresPaneluZZadania(req),
      adresZEnv: adresPaneluZEnv, adresZapisany, zapisAdresu: zapisAdresu ? { kontoLogin: zapisAdresu.kontoLogin, zmienionoAt: zapisAdresu.zmienionoAt } : null,
      wpisanyAdres: wpisanyAdres ?? adresZapisany ?? '',
      bledy, bledyAdresu, proba,
      podpisMaili: podpisMaili === undefined ? ekranPodpisu({ zapisano: req.query?.zapisano === 'podpis' }) : podpisMaili,
      // Potwierdzenie zapisu podpisu stoi w jego sekcji (adres kończy się #podpis-maili), nie na górze strony.
      zapisano: req.query?.zapisano === 'podpis' ? null : KOMUNIKATY[req.query?.zapisano] ?? null,
    });
  }
  const odmowaZPliku = (reply, co) => reply.code(409).type('text/plain; charset=utf-8')
    .send(`${co} jest ustawiony w pliku konfiguracji (oms.env) — tam go zmień. Formularz niczego nie zapisał.`);
  const kto = (req) => (req.konto ? { id: req.konto.id ?? null, login: req.konto.login ?? null } : null);

  app.get(EKRAN_POCZTY, async (req, reply) => {
    // PRZ-102.10: „Podgląd” podpisu to GET z wpisanymi polami — niczego nie zapisuje (jak podgląd szablonu wiadomości).
    const usl = podpis();
    if (req.query?.podglad === undefined || !usl) return widok(req, reply);
    const wpisane = {};
    for (const p of ['marka', 'stopka']) if (req.query[p] !== undefined) wpisane[p] = String(req.query[p]).slice(0, 2000);
    const { wartosci, bledy: bledyPodpisu } = usl.sprawdz(wpisane);
    return widok(req, reply, { podpisMaili: ekranPodpisu({ wpisanyPodpis: bledyPodpisu.length ? wpisane : wartosci, bledyPodpisu, podgladWpisany: true }) });
  });

  app.post(EKRAN_POCZTY, async (req, reply) => {
    if (poczta()?.zEnv) return odmowaZPliku(reply, 'Serwer poczty (SMTP_…)');
    const { ustawienia, sekrety, bledy } = sprawdzFormularzPoczty(req.body ?? {}, wczytajKonfiguracjeIntegracji(db, 'poczta'));
    if (bledy.length) {
      reply.code(400);
      return widok(req, reply, { wpisane: { host: ustawienia.host, port: String(ustawienia.port), user: ustawienia.user, nadawca: ustawienia.nadawca }, bledy });
    }
    zapiszKonfiguracjeIntegracji(db, 'poczta', { ustawienia, sekrety }, { konto: kto(req) });
    return reply.code(303).redirect(`${EKRAN_POCZTY}?zapisano=zapisano`);
  });

  app.post(`${EKRAN_POCZTY}/adres`, async (req, reply) => {
    if (adresPaneluZEnv) return odmowaZPliku(reply, 'Adres panelu (OMS_ADRES_PANELU)');
    const { adres, blad } = sprawdzFormularzAdresuPanelu(req.body ?? {});
    if (blad) {
      reply.code(400);
      // Wpisana wartość wraca do pola tylko wtedy, gdy da się ją bezpiecznie pokazać (EJS i tak ją escapuje).
      return widok(req, reply, { bledyAdresu: [blad], wpisanyAdres: String(req.body?.adres ?? '').slice(0, 200) });
    }
    // PRZ-094.10: puste pole = bez zapisu, linki prowadzą pod adres domyślny (ten, z którego korzysta admin).
    if (!adres) {
      const byl = Boolean(wczytajKonfiguracjeIntegracji(db, 'adres_panelu'));
      usunKonfiguracjeIntegracji(db, 'adres_panelu');
      return reply.code(303).redirect(byl ? `${EKRAN_POCZTY}?zapisano=adres-usuniety` : EKRAN_POCZTY);
    }
    zapiszKonfiguracjeIntegracji(db, 'adres_panelu', { ustawienia: { adres }, sekrety: {} }, { konto: kto(req) });
    return reply.code(303).redirect(`${EKRAN_POCZTY}?zapisano=adres`);
  });

  app.post(`${EKRAN_POCZTY}/proba`, async (req, reply) => {
    const adres = String(req.body?.adres ?? '').trim();
    if (!ADRES_EMAIL.test(adres) || adres.length > 254) {
      reply.code(400);
      return widok(req, reply, { proba: { ok: false, tekst: 'Podaj jeden poprawny adres e-mail odbiorcy wiadomości próbnej.' } });
    }
    const m = mailer();
    if (!m) return widok(req, reply, { adresProby: adres, proba: { ok: false, tekst: 'Najpierw zapisz serwer poczty, potem wyślij wiadomość próbną.' } });
    const text = ['Dzień dobry,', '', 'to wiadomość próbna z panelu obsługi zamówień.',
      'Skoro ją czytasz, poczta wychodząca działa: zaproszenia do kont i linki do ustawienia hasła dojdą tą samą drogą.', '',
      'Nie trzeba na nią odpowiadać.'].join('\n');
    try {
      await m.sendMail({ to: adres, subject: TEMAT_PROBNEJ, text, html: renderMailHtml({ text }) });
    } catch (e) {
      // Do logu tylko kod (EAUTH, ESOCKET…) — nigdy treść błędu: serwery SMTP odbijają w niej login, a bywa że i hasło.
      log(`poczta: wiadomość próbna nieudana (kod ${String(e?.code ?? (e?.dlaOperatora ? 'brak-ustawien' : 'nieznany')).replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 30)})`);
      return widok(req, reply, { adresProby: adres, proba: { ok: false, tekst: komunikatBleduPoczty(e) } });
    }
    const atrapa = Boolean(poczta()?.atrapa);
    return widok(req, reply, { adresProby: adres, proba: { ok: true, tekst: atrapa
      ? `Wysłano wiadomość próbną na ${adres} — w piaskownicy przejęła ją atrapa poczty, nic nie wyszło z serwera.`
      : `Wysłano wiadomość próbną na ${adres}. Sprawdź skrzynkę, także folder ze spamem.` } });
  });

  // PRZ-102.10: podpis maili do klientów. Pole ustawione w pliku (OMS_MAIL_MARKA / OMS_MAIL_STOPKA) = 409, jak reszta ekranu.
  app.post(`${EKRAN_POCZTY}/podpis`, async (req, reply) => {
    const usl = podpis();
    if (!usl) return reply.code(404).type('text/plain; charset=utf-8').send('Podpis maili wymaga modułu wiadomości.');
    const body = req.body ?? {};
    const pola = Object.fromEntries(['marka', 'stopka'].filter((p) => Object.hasOwn(body, p)).map((p) => [p, String(body[p] ?? '')]));
    const wynik = usl.zapisz(pola);
    if (wynik.kod === 409) {
      const nazwy = wynik.zablokowane.map((p) => (p === 'marka' ? 'Marka (OMS_MAIL_MARKA)' : 'Stopka (OMS_MAIL_STOPKA)')).join(' i ');
      return reply.code(409).type('text/plain; charset=utf-8')
        .send(`${nazwy}: ustawione w pliku konfiguracji (oms.env) — tam je zmień. Formularz niczego nie zapisał.`);
    }
    if (wynik.kod === 400) {
      reply.code(400);
      const wpisane = Object.fromEntries(Object.entries(pola).map(([k, v]) => [k, v.slice(0, 2000)]));
      return widok(req, reply, { podpisMaili: ekranPodpisu({ wpisanyPodpis: wpisane, bledyPodpisu: wynik.bledy }) });
    }
    return reply.code(303).redirect(`${EKRAN_POCZTY}?zapisano=podpis#podpis-maili`);
  });

  // Usunięcie działa także przy SMTP w .env: hasło zapisane z ekranu, zanim ktoś dopisał SMTP do pliku, musi dać się usunąć.
  app.post(`${EKRAN_POCZTY}/odlacz`, async (_req, reply) => {
    usunKonfiguracjeIntegracji(db, 'poczta');
    return reply.code(303).redirect(`${EKRAN_POCZTY}?zapisano=odlaczono`);
  });
}
