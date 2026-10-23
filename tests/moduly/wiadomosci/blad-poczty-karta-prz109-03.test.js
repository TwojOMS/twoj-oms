import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszProforme } from '../../../src/moduly/faktury/db/proformy.js';
import { wiadomosciZamowienia } from '../../../src/oms/db/wiadomosci.js';
import { createWiadomosci } from '../../../src/moduly/wiadomosci/services/wiadomosci.js';
import { createPotwierdzenie } from '../../../src/moduly/wiadomosci/services/potwierdzenie.js';
import { createMailer } from '../../../src/core/poczta/smtp.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { nowyPanel, jako, post } from '../../pomoc/konta-prz068.js';

// PRZ-109.03 — obca firma ustawia własną pocztę w Ustawienia → Integracje → Poczta wychodząca i wysyła wiadomość
// z karty zamówienia. Gdy serwer SMTP odmówi, operator ma dostać zdanie z KODU nodemailera (komunikatBleduPoczty),
// a nie „błąd techniczny panelu”. Treść błędu (odpowiedź serwera z loginem) NIGDY na ekran ani do logu karty (07).
// ⛔ Żadnego prawdziwego SMTP: każdy mailer to atrapa rzucająca błąd o kształcie błędu nodemailera.

const config = {
  auth: { user: 'serwis', pass: 'x' },
  sprzedawca: { nazwa: 'Lampy Przykładowe sp. z o.o.' },
  proforma: { rachunek: '00 1111 2222 3333 4444 5555 6666' },
  nadawca: { nazwa: 'Lampy Przykładowe sp. z o.o.' },
};
const BASIC = { authorization: 'Basic ' + Buffer.from('serwis:x').toString('base64'), origin: 'http://localhost' };
const POLLER = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
const TERAZ = () => '2026-10-22T10:00:00.000Z';

const zamowienie = () => ({
  zrodlo_id: 9101, numer: 'LP-000101',
  klient: { first_name: 'Ewa', last_name: 'Testowa', email: 'klient@przyklad.invalid', company: '' },
  dostawa: { first_name: 'Ewa', last_name: 'Testowa', address_1: 'Lampowa 1', postcode: '00-001', city: 'Przykładowo' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '250.00', koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-20T09:15:00',
  termin_platnosci: '14',
  pozycje: [{
    zrodlo_id: 9201, nazwa: 'Lampa biurkowa', sku: 'LB-1', ilosc: 1,
    cena_brutto: '250.00', cena_netto: '203.25', brutto_linii: '250.00', netto_linii: '203.25', vat: null,
  }],
});

// Błąd o kształcie błędu nodemailera: `code` + treść z odpowiedzią serwera, w której stoi login skrzynki.
const LOGIN = 'sklep-login@przyklad.invalid';
const bladNodemailera = (code, message) => Object.assign(new Error(message), { code, response: message, command: 'AUTH PLAIN' });
const EAUTH = () => bladNodemailera('EAUTH', `Invalid login: 535 5.7.8 Authentication failed for ${LOGIN}`);
const ECONNECTION = () => bladNodemailera('ECONNECTION', 'getaddrinfo ENOTFOUND smtp.przyklad.invalid');
const rzucajacy = (fabrykaBledu) => ({ sendMail: vi.fn(async () => { throw fabrykaBledu(); }) });

const ZDANIE_EAUTH = 'Serwer poczty odrzucił login albo hasło. Sprawdź je w ustawieniach skrzynki u dostawcy poczty.';
const ZDANIE_POLACZENIA = 'Nie udało się połączyć z serwerem poczty. Sprawdź adres serwera i port';
const OGOLNE = 'błąd techniczny panelu — szczegóły w logu zamówienia.';
const WSKAZOWKA = 'Ustawienia → Integracje → Poczta wychodząca';

function panelKarty({ mailer, proforma = null, db = openOmsDb(':memory:'), zbuduj = (o) => buildOmsServer(o) } = {}) {
  const idZ = zapiszZamowienie(db, 'pro', zamowienie());
  const wiadomosci = createWiadomosci({
    db, mailer, proforma, config, teraz: TERAZ,
    potwierdzenie: createPotwierdzenie({ db, mailer, sprzedawca: config.sprzedawca, teraz: TERAZ }),
  });
  const app = zbuduj({ db, config, poller: POLLER, wiadomosci });
  const log = () => db.prepare('SELECT akcja, wynik FROM log WHERE zamowienie_id = ? ORDER BY id').all(idZ);
  return { db, app, idZ, log };
}
const wyslij = (app, idZ, temat, naglowki = BASIC) =>
  app.inject({ method: 'POST', url: `/zamowienia/${idZ}/wiadomosc/${temat}`, headers: naglowki });

describe('PRZ-109.03 — karta zamówienia: odmowa serwera poczty po polsku, bez treści błędu', () => {
  it('EAUTH: zdanie o loginie i haśle, wskazówka do Ustawień, bez loginu i odpowiedzi serwera na ekranie', async () => {
    const { db, app, idZ, log } = panelKarty({ mailer: rzucajacy(EAUTH) });
    const res = await wyslij(app, idZ, 'przypomnienie');
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Wiadomość NIE została wysłana');
    expect(res.body).toContain(ZDANIE_EAUTH);
    expect(res.body).toContain(WSKAZOWKA);
    expect(res.body).not.toContain(OGOLNE);
    expect(res.body).not.toContain(LOGIN);
    expect(res.body).not.toContain('535');
    // PRZ-109.07: jeden wpis z kodem i zdaniem, bez treści serwera; zero „wysłano”.
    expect(log().map((l) => l.akcja)).toEqual(['wiadomosc.blad']);
    expect(log()[0].wynik).toContain('(EAUTH) — ' + ZDANIE_EAUTH);
    expect(log()[0].wynik).not.toContain('535');
    expect(log()[0].wynik).not.toContain(LOGIN);
    expect(wiadomosciZamowienia(db, idZ)).toHaveLength(0);
  });

  it('ECONNECTION: zdanie o serwerze i porcie', async () => {
    const { app, idZ } = panelKarty({ mailer: rzucajacy(ECONNECTION) });
    const res = await wyslij(app, idZ, 'przypomnienie');
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(ZDANIE_POLACZENIA);
    expect(res.body).not.toContain('smtp.przyklad.invalid');
    expect(res.body).not.toContain(OGOLNE);
  });

  it('prawdziwy createMailer (kod przeniesiony z transportu): ta sama droga daje zdanie o haśle', async () => {
    const mailer = createMailer({
      smtp: { host: 'smtp.przyklad.invalid', port: 465, user: LOGIN, pass: 'zmyslone' }, mailFrom: LOGIN,
      transportFactory: () => ({ sendMail: async () => { throw EAUTH(); } }),
    });
    const { app, idZ } = panelKarty({ mailer });
    const res = await wyslij(app, idZ, 'przypomnienie');
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(ZDANIE_EAUTH);
    expect(res.body).not.toContain(LOGIN);
  });

  it('potwierdzenie (delegacja do starej usługi): to samo zdanie, log potwierdzenia ze szczegółami', async () => {
    const { db, app, idZ, log } = panelKarty({ mailer: rzucajacy(EAUTH) });
    const res = await wyslij(app, idZ, 'potwierdzenie');
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(ZDANIE_EAUTH);
    expect(res.body).not.toContain(LOGIN);
    expect(log().map((l) => l.akcja)).toEqual(['potwierdzenie.blad']);
    expect(log()[0].wynik).toContain('(EAUTH) — ' + ZDANIE_EAUTH);
    expect(log()[0].wynik).not.toContain('535');
    expect(log()[0].wynik).not.toContain(LOGIN);
    expect(wiadomosciZamowienia(db, idZ)).toHaveLength(0);
  });

  it('błąd przy wysyłce BEZ kodu nodemailera (TypeError) — dalej ogólne zdanie', async () => {
    const { app, idZ, log } = panelKarty({ mailer: { sendMail: async () => { throw new TypeError('x is not a function'); } } });
    const res = await wyslij(app, idZ, 'przypomnienie');
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(OGOLNE);
    expect(res.body).not.toContain('Serwer poczty');
    expect(res.body).not.toContain(WSKAZOWKA);
    expect(log().map((l) => l.akcja)).toEqual(['wiadomosc.blad']);
  });

  it('błąd z kodem, ale ZE ZŁOŻENIA (brak pliku proformy, ENOENT) — ogólne zdanie, nie „serwer poczty”', async () => {
    const proforma = { pdf: () => { throw Object.assign(new Error("ENOENT: no such file, open '/dane/proformy/x.pdf'"), { code: 'ENOENT' }); } };
    const mailer = rzucajacy(EAUTH);
    const db = openOmsDb(':memory:');
    const { app, idZ, log } = panelKarty({ mailer, proforma, db });
    zapiszProforme(db, idZ, { kwotaBrutto: '250.00', plikSciezka: '/dane/proformy/x.pdf', utworzonaAt: '2026-10-21T10:00:00.000Z' });
    const res = await wyslij(app, idZ, 'proforma');
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(OGOLNE);
    expect(res.body).not.toContain('Serwer poczty');
    expect(res.body).not.toContain('/dane/proformy');
    expect(mailer.sendMail).not.toHaveBeenCalled();
    expect(log().map((l) => l.akcja)).toEqual(['wiadomosc.nieudane-zlozenie']);
  });

  it('konto bez Ustawień (sprzedaż): zdanie o haśle, ale bez wskazówki do ekranu, którego nie otworzy', async () => {
    const { app, idZ, db } = panelKarty({ mailer: rzucajacy(EAUTH), zbuduj: (o) => nowyPanel(o).app });
    zalozKonto(db, { login: 'admin1', imie: 'Admin', haslo: 'h', rola: 'administrator', admin: true });
    zalozKonto(db, { login: 'ola', imie: 'Ola', haslo: 'h', rola: 'sprzedaz' });
    const res = await post(app, `/zamowienia/${idZ}/wiadomosc/przypomnienie`, jako(db, 'ola'));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(ZDANIE_EAUTH);
    expect(res.body).not.toContain(WSKAZOWKA);
    expect(res.body).not.toContain(LOGIN);
  });
});

describe('PRZ-109.03 — konta: zaproszenie mailem przy odmowie serwera poczty', () => {
  const ADRES = 'https://panel.przyklad.invalid';
  const NOWA = { imie: 'Nowa Osoba', login: 'nowa', email: 'nowa@przyklad.invalid', rola: 'produkcja', sposob: 'mail' };
  function panel(mailer) {
    const p = nowyPanel({ env: { OMS_ADRES_PANELU: ADRES }, nadpisania: { 'wiadomosci.mailer': mailer } });
    zalozKonto(p.db, { login: 'admin1', imie: 'Admin', haslo: 'h', rola: 'administrator', admin: true });
    return { ...p, admin: jako(p.db, 'admin1') };
  }

  it('EAUTH: zdanie o haśle i wskazówka do Ustawień, bez loginu; „Pokaż link” zostaje', async () => {
    const { app, admin } = panel(rzucajacy(EAUTH));
    const r = await post(app, '/ustawienia/konta/nowe', admin, NOWA);
    expect(r.statusCode).toBe(502);
    expect(r.body).toContain('Nie udało się wysłać maila');
    expect(r.body).toContain(ZDANIE_EAUTH);
    expect(r.body).toContain(WSKAZOWKA);
    expect(r.body).toContain('Pokaż link');
    expect(r.body).not.toContain(LOGIN);
    expect(r.body).not.toContain('535');
  });

  it('błąd bez kodu: dawne zdanie, bez „serwer poczty”', async () => {
    const { app, admin } = panel({ sendMail: async () => { throw new TypeError('x is not a function'); } });
    const r = await post(app, '/ustawienia/konta/nowe', admin, NOWA);
    expect(r.statusCode).toBe(502);
    expect(r.body).toContain('Nie udało się wysłać maila — użyj „Pokaż link”. Poprzedni link, jeśli był, nadal działa.');
    expect(r.body).not.toContain('Serwer poczty');
  });
});
