// PRZ-094.04 — Ustawienia → Integracje → Poczta wychodząca. Ten sam wzorzec co DPD / InPost / inFakt (PRZ-092,
// PRZ-093.09, PRZ-093.10): .env wygrywa (ekran tylko informuje, zapis tej części = 409), hasło SMTP nigdy nie wraca
// na ekran, do odpowiedzi ani do logu, puste pole hasła zostawia zapisane, zmiana działa od następnej wysyłki bez
// restartu. Prawdziwy serwer (buildOmsServer), prawdziwe moduły ustawień i wiadomości, prawdziwy createMailer —
// podmieniony jest wyłącznie transport nodemailera (nic nie wychodzi). Dane zmyślone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { createMailer } from '../../../src/core/poczta/smtp.js';
import { ustawEmail } from '../../../src/moduly/ustawienia/konta-dostep.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulWeb } from '../../../src/core/web/modul.ts';
import { modulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { createModulWiadomosci } from '../../../src/moduly/wiadomosci/modul.ts';
import { createModulZamowienia } from '../../../src/moduly/zamowienia/modul.ts';
import { createModulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import { modulUstawienia } from '../../../src/moduly/ustawienia/modul.ts';
import { modulMarketing } from '../../../src/moduly/marketing/modul.ts';
import { modulZdrowie } from '../../../src/moduly/zdrowie/modul.ts';
import { createModulWiadomosciAtrapy } from '../../../deploy/proba/atrapy/poczta.mjs';

const ADRES = '/ustawienia/integracje/poczta';
const HASLO = 'Zmyslone-Haslo-Smtp-094-A1';
const HASLO_2 = 'Zmyslone-Haslo-Smtp-094-B2';
const HASLO_PLIKU = 'Zmyslone-Haslo-Z-Pliku-094-C3';
const SMTP_A = { host: 'smtp.pracownia-a.example.test', port: '465', user: 'sklep@pracownia-a.example.test', nadawca: '' };
const SMTP_B = { host: 'poczta.pracownia-b.example.test', port: '587', user: 'biuro@pracownia-b.example.test',
  nadawca: 'Pracownia B <biuro@pracownia-b.example.test>' };
const ENV_SMTP = { SMTP_HOST: 'smtp.z-pliku.example.test', SMTP_PORT: '465', SMTP_USER: 'plik@z-pliku.example.test', SMTP_PASS: HASLO_PLIKU };
const PANEL = 'https://panel.pracownia.example.test';

let wyslane; let bladTransportu; let logi;
beforeEach(() => {
  wyslane = []; bladTransportu = null; logi = [];
  for (const m of ['log', 'error', 'warn', 'info']) vi.spyOn(console, m).mockImplementation((...t) => { logi.push(t.map(String).join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); });

// Fabryka mailera = prawdziwy createMailer z transportem, który tylko notuje (host, port, login, hasło, list).
const fabrykaMailera = (poczta) => createMailer({ ...poczta, transportFactory: () => ({
  async sendMail(list) {
    wyslane.push({ host: poczta.smtp.host, port: poczta.smtp.port, user: poczta.smtp.user, pass: poczta.smtp.pass, ...list });
    if (bladTransportu) throw bladTransportu;
    return { messageId: `<test-${wyslane.length}@example.test>` };
  },
}) });

async function panel({ env = {}, zapisPrzedStartem = null, wiadomosci = null } = {}) {
  const moduly = [modulRdzen, modulWeb, modulKanaly, createModulFaktury(),
    wiadomosci ?? createModulWiadomosci({ fabryki: { createMailer: fabrykaMailera } }),
    createModulZamowienia({ zWiadomosciami: true }), createModulWysylka(), modulMagazyn, modulUstawienia, modulMarketing, modulZdrowie];
  let db;
  if (zapisPrzedStartem) {
    const pierwszy = nowyPanel({ moduly, env });
    await pierwszy.app.ready();
    db = pierwszy.db;
    zapiszKonfiguracjeIntegracji(db, 'poczta', zapisPrzedStartem);
  }
  const p = nowyPanel({ moduly, env, ...(db ? { db } : {}) });
  await p.app.ready(); // migracja kont (kolumna email) biegnie przy składaniu modułów
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  ustawEmail(p.db, kontoPoLoginie(p.db, 'adam').id, 'wlasciciel@pracownia.example.test', () => new Date());
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia', 'wiadomosci']);
  return { ...p, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa') };
}
const smtpForm = (html) => /<form id="poczta-formularz"[\s\S]*?<\/form>/u.exec(html)?.[0] ?? '';
const adresForm = (html) => /<form id="adres-panelu-formularz"[\s\S]*?<\/form>/u.exec(html)?.[0] ?? '';
const probaForm = (html) => /<form id="poczta-proba"[\s\S]*?<\/form>/u.exec(html)?.[0] ?? '';
const bezHasel = (tekst, ...hasla) => hasla.every((h) => !String(tekst).includes(h));
const NOWA = { imie: 'Nowa Osoba', login: 'nowa', email: 'nowa@pracownia.example.test', rola: 'produkcja' };
const KLIENT = 'klient@kupujacy.example.test';
// Zamówienie do wysłania przypomnienia o płatności — dane zmyślone.
const zamowienieKlienta = () => ({
  zrodlo_id: 108201, numer: 'T-108-02',
  klient: { first_name: 'Ewa', last_name: 'Testowa', email: KLIENT },
  dostawa: { first_name: 'Ewa', last_name: 'Testowa', address_1: 'Zmyślona 1', postcode: '00-001', city: 'Testowo' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-20T09:00:00', termin_platnosci: '14',
  pozycje: [{ zrodlo_id: 108202, nazwa: 'Produkt testowy', sku: 'T-1', ilosc: 1,
    cena_brutto: '123.00', cena_netto: '100.00', brutto_linii: '123.00', netto_linii: '100.00', vat: null }],
});

describe('PRZ-094.04 Ustawienia → Integracje → Poczta wychodząca', () => {
  it('pusty ekran: formularz SMTP (hasło jako password, wymagane), adres panelu, „Nieustawiona”; Integracje mają wejście', async () => {
    const { app, admin } = await panel();
    const r = await get(app, ADRES, admin);
    expect(r.statusCode, r.body).toBe(200);
    const f = smtpForm(r.body);
    expect(f).toMatch(/<input id="poczta-host" name="host"/u);
    expect(f).toMatch(/<input id="poczta-port" name="port"[^>]* value="465"/u);
    expect(f).toMatch(/<input id="poczta-haslo" type="password" name="haslo" value=""[^>]* required>/u);
    expect(adresForm(r.body)).toMatch(/<input id="adres-panelu" name="adres"/u);
    expect(r.body).toContain('Nieustawiona');
    expect((await get(app, '/ustawienia/integracje', admin)).body).toContain(`href="${ADRES}"`);
  });

  it('zapis SMTP: 303, wiersz „poczta”, hasło jako sekret; hasło nie wraca na ekran; puste hasło nie kasuje zapisanego', async () => {
    const { app, admin, db } = await panel();
    const r = await post(app, ADRES, admin, { ...SMTP_A, haslo: HASLO });
    expect(r.statusCode, r.body).toBe(303);
    const zapis = wczytajKonfiguracjeIntegracji(db, 'poczta');
    expect(zapis.ustawienia).toEqual({ host: SMTP_A.host, port: 465, user: SMTP_A.user, nadawca: '' });
    expect(zapis.sekrety).toEqual({ haslo: HASLO });
    expect(zapis.kontoLogin).toBe('adam');
    const ekran = await get(app, r.headers.location, admin);
    expect(ekran.statusCode).toBe(200);
    expect(bezHasel(ekran.body, HASLO, 'Zmyslone-Haslo'), 'hasło na ekranie').toBe(true);
    expect(ekran.body).toContain('Ustawiona');
    expect(smtpForm(ekran.body)).toMatch(/<input id="poczta-haslo" type="password" name="haslo" value=""[^>]* placeholder="zapisane — zostaw puste, żeby nie zmieniać">/u);
    expect(smtpForm(ekran.body)).toContain(`value="${SMTP_A.host}"`);

    // Zmiana innego pola z pustym hasłem: hasło zostaje.
    expect((await post(app, ADRES, admin, { ...SMTP_B, haslo: '' })).statusCode).toBe(303);
    const po = wczytajKonfiguracjeIntegracji(db, 'poczta');
    expect(po.ustawienia).toEqual({ host: SMTP_B.host, port: 587, user: SMTP_B.user, nadawca: SMTP_B.nadawca });
    expect(po.sekrety).toEqual({ haslo: HASLO });
    expect(bezHasel(logi.join('\n'), HASLO), 'hasło w logu').toBe(true);
  });

  it('błędny formularz: 400, nic nie zapisane, wpisane hasło nie wraca w odpowiedzi', async () => {
    const { app, admin, db } = await panel();
    for (const zle of [{ ...SMTP_A, host: 'smtp z spacja.example.test' }, { ...SMTP_A, port: '70000' }, { ...SMTP_A, port: 'abc' },
      { ...SMTP_A, user: '' }, { ...SMTP_A, nadawca: 'Sklep <bez-malpy>' }, { ...SMTP_A, host: 'smtp://smtp.example.test' }]) {
      const r = await post(app, ADRES, admin, { ...zle, haslo: HASLO });
      expect(r.statusCode, JSON.stringify(zle)).toBe(400);
      expect(r.body).toContain('Nie zapisano');
      expect(bezHasel(r.body, HASLO), 'hasło w odpowiedzi 400').toBe(true);
    }
    expect((await post(app, ADRES, admin, { ...SMTP_A, haslo: '' })).statusCode).toBe(400); // pierwszy zapis bez hasła
    expect(wczytajKonfiguracjeIntegracji(db, 'poczta')).toBeNull();
  });

  it('adres panelu: ta sama walidacja co OMS_ADRES_PANELU — złe wartości 400, dobra zapisana jako origin i użyta w linku zaproszenia', async () => {
    const { app, admin, db } = await panel();
    for (const zly of ['ftp://panel.example.test', 'panel.example.test', `${PANEL}/panel`, `${PANEL}/?a=1`, `${PANEL}/#x`,
      'https://ktos:haslo@panel.example.test', ' https://panel.example.test']) {
      const r = await post(app, `${ADRES}/adres`, admin, { adres: zly });
      expect(r.statusCode, zly).toBe(400);
      expect(r.body).toContain('Nie zapisano');
    }
    expect(wczytajKonfiguracjeIntegracji(db, 'adres_panelu')).toBeNull();
    expect((await post(app, `${ADRES}/adres`, admin, { adres: `${PANEL}/` })).statusCode).toBe(303);
    expect(wczytajKonfiguracjeIntegracji(db, 'adres_panelu').ustawienia).toEqual({ adres: PANEL });
    expect((await get(app, ADRES, admin)).body).toContain(`value="${PANEL}"`);
  });

  it('bez restartu: zaproszenie mailem działa zaraz po zapisie w panelu, a zmiana SMTP działa od następnej wysyłki', async () => {
    const { app, admin } = await panel();
    // Przed zapisem: brak poczty — odmowa, nic nie wysłane (brak adresu od PRZ-094.10 nie blokuje: jest domyślny).
    const przed = await post(app, '/ustawienia/konta/nowe', admin, { ...NOWA, sposob: 'mail' });
    expect(przed.statusCode).toBe(400);
    await post(app, `${ADRES}/adres`, admin, { adres: PANEL });
    const bezSmtp = await post(app, '/ustawienia/konta/nowe', admin, { ...NOWA, sposob: 'mail' });
    expect(bezSmtp.statusCode).toBe(400);
    expect(bezSmtp.body).toContain('brak SMTP');
    expect(wyslane).toHaveLength(0);

    await post(app, ADRES, admin, { ...SMTP_A, haslo: HASLO });
    const zaproszenie = await post(app, '/ustawienia/konta/nowe', admin, { ...NOWA, sposob: 'mail' });
    expect(zaproszenie.statusCode, zaproszenie.body).toBe(302);
    expect(wyslane).toHaveLength(1);
    expect(wyslane[0]).toMatchObject({ host: SMTP_A.host, port: 465, user: SMTP_A.user, pass: HASLO, from: SMTP_A.user,
      to: NOWA.email, subject: 'Zaproszenie do panelu' });
    expect(wyslane[0].text).toContain(`${PANEL}/haslo/`);

    await post(app, ADRES, admin, { ...SMTP_B, haslo: HASLO_2 });
    const proba = await post(app, `${ADRES}/proba`, admin, { adres: 'odbiorca@pracownia.example.test' });
    expect(proba.statusCode, proba.body).toBe(200);
    expect(wyslane).toHaveLength(2);
    expect(wyslane[1]).toMatchObject({ host: SMTP_B.host, port: 587, user: SMTP_B.user, pass: HASLO_2, from: SMTP_B.nadawca,
      to: 'odbiorca@pracownia.example.test' });
    expect(bezHasel(proba.body, HASLO, HASLO_2), 'hasło w odpowiedzi').toBe(true);
  });

  it('zapis sprzed startu: mailer klientów (sekcja wiadomości) też czyta bieżący zapis — zmiana bez restartu', async () => {
    const { app, admin } = await panel({ zapisPrzedStartem: { ustawienia: { host: SMTP_A.host, port: 465, user: SMTP_A.user, nadawca: '' },
      sekrety: { haslo: HASLO } } });
    const ekran = await get(app, ADRES, admin);
    expect(ekran.body.includes('po ponownym uruchomieniu')).toBe(false);
    await post(app, `${ADRES}/proba`, admin, { adres: 'a@pracownia.example.test' });
    await post(app, ADRES, admin, { ...SMTP_B, haslo: HASLO_2 });
    await post(app, `${ADRES}/proba`, admin, { adres: 'b@pracownia.example.test' });
    expect(wyslane.map((w) => [w.host, w.pass === HASLO, w.pass === HASLO_2])).toEqual([[SMTP_A.host, true, false], [SMTP_B.host, false, true]]);
  });

  // PRZ-108.02: do tej pory wiadomości do klientów (karta zamówienia) powstawały przy starcie tylko wtedy, gdy poczta
  // już była — pierwszy zapis na ekranie wymagał restartu OMS-u. Teraz działają od razu, a bez poczty odmowa jak dawniej.
  it('pierwszy zapis bez poczty przy starcie: wiadomość do klienta z karty zamówienia działa od razu, bez restartu', async () => {
    const { app, admin, ewa, db } = await panel();
    const id = zapiszZamowienie(db, 'pro', zamowienieKlienta());
    const karta = () => get(app, `/zamowienia/${id}`, ewa);
    const wyslijKlientowi = () => post(app, `/zamowienia/${id}/wiadomosc/przypomnienie`, ewa, {});

    // Bez poczty: sekcji wiadomości nie ma, wysyłka = czytelna odmowa, nic nie poszło.
    expect((await karta()).body).not.toContain('Wyślij nową wiadomość');
    const przed = await wyslijKlientowi();
    expect(przed.statusCode).toBe(503);
    expect(przed.body).toContain('Poczta nie jest skonfigurowana');

    await post(app, ADRES, admin, { ...SMTP_A, haslo: HASLO });
    const ekran = (await get(app, ADRES, admin)).body;
    expect(ekran.includes('po ponownym uruchomieniu')).toBe(false);
    expect((await karta()).body).toContain('Wyślij nową wiadomość');
    const po = await wyslijKlientowi();
    expect(po.statusCode, po.body).toBe(302);
    expect(wyslane).toHaveLength(1);
    expect(wyslane[0]).toMatchObject({ host: SMTP_A.host, port: 465, user: SMTP_A.user, from: SMTP_A.user, to: KLIENT });
    expect(wyslane[0].pass === HASLO).toBe(true);
    expect(wyslane[0].subject).toContain('Przypomnienie o płatności');

    // Odłączenie poczty: znowu odmowa, jak przed zapisem — nic nie wychodzi.
    await post(app, `${ADRES}/odlacz`, admin, {});
    expect((await karta()).body).not.toContain('Wyślij nową wiadomość');
    expect((await wyslijKlientowi()).statusCode).toBe(503);
    expect(wyslane).toHaveLength(1);
    expect(bezHasel(logi.join('\n'), HASLO), 'hasło w logu').toBe(true);
  });

  it('SMTP w .env i zapis w bazie: wiadomość do klienta z karty idzie pocztą z pliku', async () => {
    const { app, ewa, db } = await panel({ env: ENV_SMTP, zapisPrzedStartem: { ustawienia: { host: SMTP_A.host, port: 465, user: SMTP_A.user, nadawca: '' }, sekrety: { haslo: HASLO } } });
    const id = zapiszZamowienie(db, 'pro', zamowienieKlienta());
    const r = await post(app, `/zamowienia/${id}/wiadomosc/przypomnienie`, ewa, {});
    expect(r.statusCode, r.body).toBe(302);
    expect(wyslane).toHaveLength(1);
    expect(wyslane[0]).toMatchObject({ host: ENV_SMTP.SMTP_HOST, user: ENV_SMTP.SMTP_USER, to: KLIENT });
  });

  it('wiadomość próbna: domyślnie adres zalogowanego admina; błąd serwera poczty = polski komunikat bez hasła i bez stack trace', async () => {
    const { app, admin } = await panel();
    expect(probaForm((await get(app, ADRES, admin)).body)).toBe(''); // bez poczty nie ma czego próbować
    await post(app, ADRES, admin, { ...SMTP_A, haslo: HASLO });
    const ekran = await get(app, ADRES, admin);
    expect(probaForm(ekran.body)).toContain('value="wlasciciel@pracownia.example.test"');
    expect(probaForm(ekran.body)).toContain('Wyślij wiadomość próbną');

    const ok = await post(app, `${ADRES}/proba`, admin, { adres: 'wlasciciel@pracownia.example.test' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('Wysłano wiadomość próbną');
    expect(wyslane[0]).toMatchObject({ to: 'wlasciciel@pracownia.example.test', subject: 'Wiadomość próbna z panelu' });

    bladTransportu = Object.assign(new Error(`Invalid login: 535 ${HASLO} rejected`), { code: 'EAUTH' });
    const zle = await post(app, `${ADRES}/proba`, admin, { adres: 'wlasciciel@pracownia.example.test' });
    expect(zle.statusCode).toBe(200);
    expect(zle.body).toContain('Nie wysłano.');
    expect(zle.body).toContain('odrzucił login albo hasło');
    expect(bezHasel(zle.body, HASLO, 'Invalid login', ' at '), 'hasło albo stack w odpowiedzi').toBe(true);
    expect(bezHasel(logi.join('\n'), HASLO, 'Invalid login'), 'hasło albo surowy błąd w logu').toBe(true);

    bladTransportu = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ESOCKET' });
    expect((await post(app, `${ADRES}/proba`, admin, { adres: 'wlasciciel@pracownia.example.test' })).body).toContain('Nie udało się połączyć z serwerem poczty');

    const zlyAdres = await post(app, `${ADRES}/proba`, admin, { adres: 'ktos@example.test\r\nBcc: obcy@example.test' });
    expect(zlyAdres.statusCode).toBe(400);
    expect(wyslane).toHaveLength(3);
  });

  it('SMTP w .env wygrywa: ekran tylko informuje, zapis = 409 bez zmian w bazie; próbna idzie pocztą z pliku', async () => {
    const { app, admin, db } = await panel({ env: ENV_SMTP });
    const r = await get(app, ADRES, admin);
    expect(r.body).toContain('w pliku konfiguracji');
    expect(smtpForm(r.body)).toBe('');
    expect(adresForm(r.body)).not.toBe(''); // adres panelu nie jest w pliku — ta część zostaje do ustawienia
    expect(bezHasel(r.body, HASLO_PLIKU), 'hasło z pliku na ekranie').toBe(true);
    const zapis = await post(app, ADRES, admin, { ...SMTP_A, haslo: HASLO });
    expect(zapis.statusCode).toBe(409);
    expect(bezHasel(zapis.body, HASLO)).toBe(true);
    expect(wczytajKonfiguracjeIntegracji(db, 'poczta')).toBeNull();
    const proba = await post(app, `${ADRES}/proba`, admin, { adres: 'wlasciciel@pracownia.example.test' });
    expect(proba.body).toContain('Wysłano wiadomość próbną');
    expect(wyslane[0]).toMatchObject({ host: ENV_SMTP.SMTP_HOST, user: ENV_SMTP.SMTP_USER });
    expect(bezHasel(proba.body, HASLO_PLIKU)).toBe(true);
  });

  it('SMTP w .env, a w bazie stary zapis z ekranu: plik wygrywa przy wysyłce, przycisk usunięcia działa', async () => {
    const { app, admin, db } = await panel({ env: ENV_SMTP, zapisPrzedStartem: { ustawienia: { host: SMTP_A.host, port: 465, user: SMTP_A.user, nadawca: '' }, sekrety: { haslo: HASLO } } });
    const ekran = await get(app, ADRES, admin);
    expect(ekran.body).toContain('Usuń zapisane ustawienia poczty');
    expect(bezHasel(ekran.body, HASLO)).toBe(true);
    await post(app, `${ADRES}/proba`, admin, { adres: 'wlasciciel@pracownia.example.test' });
    expect(wyslane[0].host).toBe(ENV_SMTP.SMTP_HOST);
    expect((await post(app, `${ADRES}/odlacz`, admin, {})).statusCode).toBe(303);
    expect(wczytajKonfiguracjeIntegracji(db, 'poczta')).toBeNull();
  });

  it('OMS_ADRES_PANELU w .env wygrywa: zapis adresu = 409, link w mailu z pliku, nie z bazy', async () => {
    const { app, admin, db } = await panel({ env: { OMS_ADRES_PANELU: 'https://z-pliku.example.test' } });
    const r = await get(app, ADRES, admin);
    expect(adresForm(r.body)).toBe('');
    expect(r.body).toContain('https://z-pliku.example.test');
    expect((await post(app, `${ADRES}/adres`, admin, { adres: PANEL })).statusCode).toBe(409);
    expect(wczytajKonfiguracjeIntegracji(db, 'adres_panelu')).toBeNull();
    zapiszKonfiguracjeIntegracji(db, 'adres_panelu', { ustawienia: { adres: PANEL }, sekrety: {} });
    await post(app, ADRES, admin, { ...SMTP_A, haslo: HASLO });
    expect((await post(app, '/ustawienia/konta/nowe', admin, { ...NOWA, sposob: 'mail' })).statusCode).toBe(302);
    expect(wyslane[0].text).toContain('https://z-pliku.example.test/haslo/');
    expect(wyslane[0].text.includes(PANEL)).toBe(false);
  });

  it('bez uprawnienia „ustawienia” — 403 na ekranie, zapisie, adresie, próbnej i odłączeniu; nic nie wysłane', async () => {
    const { app, ewa, admin, db } = await panel();
    expect((await get(app, ADRES, ewa)).statusCode).toBe(403);
    expect((await post(app, ADRES, ewa, { ...SMTP_A, haslo: HASLO })).statusCode).toBe(403);
    expect((await post(app, `${ADRES}/adres`, ewa, { adres: PANEL })).statusCode).toBe(403);
    expect(wczytajKonfiguracjeIntegracji(db, 'poczta')).toBeNull();
    await post(app, ADRES, admin, { ...SMTP_A, haslo: HASLO });
    expect((await post(app, `${ADRES}/proba`, ewa, { adres: 'a@pracownia.example.test' })).statusCode).toBe(403);
    expect((await post(app, `${ADRES}/odlacz`, ewa, {})).statusCode).toBe(403);
    expect(wczytajKonfiguracjeIntegracji(db, 'poczta')).not.toBeNull();
    expect(wyslane).toHaveLength(0);
  });

  it('POST bez nagłówka Origin (CSRF) — odmowa, nic nie zapisane', async () => {
    const { app, admin, db } = await panel();
    const r = await app.inject({ method: 'POST', url: ADRES, headers: { accept: 'text/html', ...admin }, payload: { ...SMTP_A, haslo: HASLO } });
    expect(r.statusCode).toBe(403);
    expect(wczytajKonfiguracjeIntegracji(db, 'poczta')).toBeNull();
  });

  it('piaskownica: wiadomość próbna przechodzi przez atrapę poczty, nawet z zapisanym SMTP — nic nie wychodzi', async () => {
    const { app, admin } = await panel({ wiadomosci: createModulWiadomosciAtrapy({ OMS_TRYB: 'proba' }) });
    const ekran = await get(app, ADRES, admin);
    expect(ekran.body).toContain('atrapa poczty');
    expect(smtpForm(ekran.body)).not.toBe(''); // piaskownica to nie .env — formularz zostaje do obejrzenia
    await post(app, ADRES, admin, { ...SMTP_A, haslo: HASLO });
    const r = await post(app, `${ADRES}/proba`, admin, { adres: 'wlasciciel@pracownia.example.test' });
    expect(r.body).toContain('Wysłano wiadomość próbną');
    expect(wyslane).toHaveLength(0); // fabryka prawdziwego SMTP (z zapisu) nie została użyta
    expect(logi.some((l) => l.includes('atrapa poczty') && l.includes('Wiadomość próbna z panelu') && l.includes('nic nie poszło'))).toBe(true);
  });

  it('piaskownica: wiadomość do klienta z karty idzie przez atrapę, nawet z zapisanym SMTP — nic nie wychodzi', async () => {
    const { app, admin, ewa, db } = await panel({ wiadomosci: createModulWiadomosciAtrapy({ OMS_TRYB: 'proba' }) });
    await post(app, ADRES, admin, { ...SMTP_A, haslo: HASLO });
    const id = zapiszZamowienie(db, 'pro', zamowienieKlienta());
    const r = await post(app, `/zamowienia/${id}/wiadomosc/przypomnienie`, ewa, {});
    expect(r.statusCode, r.body).toBe(302);
    expect(wyslane).toHaveLength(0);
    expect(logi.some((l) => l.includes('atrapa poczty') && l.includes(KLIENT) && l.includes('nic nie poszło'))).toBe(true);
  });
});
