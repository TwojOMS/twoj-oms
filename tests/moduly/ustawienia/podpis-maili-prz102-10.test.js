// PRZ-102.10 — podpis maili do klientów (marka i stopka) w Ustawieniach → Integracje → Poczta wychodząca.
// Prawdziwy serwer i prawdziwe moduły (ustawienia, wiadomości, zamówienia); podmieniony jest wyłącznie transport
// nodemailera — list trafia do tablicy, nic nie wychodzi. Dane zmyślone.
//
// Umowa: bez OMS_MAIL_MARKA/OMS_MAIL_STOPKA w pliku zapis z panelu działa od następnego maila na tej samej instancji
// (bez restartu); pole ustawione w pliku pokazuje wartość z pliku, jego zapis = 409, a mail ma wartość z pliku —
// także wtedy, gdy w bazie leży wcześniejszy zapis z panelu. Zapis tylko z uprawnieniem „ustawienia” (inaczej 403).
// HTML wpisany w pole jest w mailu i w podglądzie escapowany.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { createMailer } from '../../../src/core/poczta/smtp.js';
import { utworzZamowienieReczne, przeliczKwoteRecznego } from '../../../src/oms/db/zamowienia-reczne.js';
import { dodajPozycjeReczna } from '../../../src/oms/db/zamowienia.js';
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

const EKRAN = '/ustawienia/integracje/poczta';
const ZAPIS = `${EKRAN}/podpis`;
const ENV_SMTP = { SMTP_HOST: 'smtp.pracownia.example.test', SMTP_USER: 'sklep@pracownia.example.test', SMTP_PASS: 'zmyslone-102-10' };
const MARKA = 'Pracownia Półcień';
const STOPKA = 'ul. Lipowa 7, 00-001 Warszawa\nhttps://pracownia.example.test';
const MARKA_PLIKU = 'Lampy z Pliku';
const STOPKA_PLIKU = 'Stopka z pliku konfiguracji';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let wyslane;
beforeEach(() => {
  wyslane = [];
  for (const m of ['log', 'error', 'warn', 'info']) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

const fabrykaMailera = (poczta) => createMailer({ ...poczta, transportFactory: () => ({
  async sendMail(list) { wyslane.push(list); return { messageId: `<test-${wyslane.length}@example.test>` }; },
}) });

async function panel({ env = {}, przedStartem = null } = {}) {
  const moduly = [modulRdzen, modulWeb, modulKanaly, createModulFaktury(),
    createModulWiadomosci({ fabryki: { createMailer: fabrykaMailera } }),
    createModulZamowienia({ zWiadomosciami: true }), createModulWysylka(), modulMagazyn, modulUstawienia, modulMarketing, modulZdrowie];
  let db;
  if (przedStartem) {
    const pierwszy = nowyPanel({ moduly, env: { ...ENV_SMTP, ...env } });
    await pierwszy.app.ready();
    db = pierwszy.db;
    przedStartem(db);
  }
  const p = nowyPanel({ moduly, env: { ...ENV_SMTP, ...env }, ...(db ? { db } : {}) });
  await p.app.ready();
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia', 'wiadomosci']);
  return { ...p, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa') };
}

function zamowienie(db) {
  const id = utworzZamowienieReczne(db, { klient: { email: 'klient@pracownia.example.test' },
    dostawa: { first_name: 'Anna', last_name: 'Testowa', address_1: 'Fikcyjna 1', postcode: '00-001', city: 'Testowo' },
    metoda_wysylki: 'dpd', metoda_platnosci: 'Przelew', utworzone_at: '2026-10-01T09:00:00.000Z' });
  dodajPozycjeReczna(db, id, { nazwa: 'Lampa fikcyjna', sku: 'LMP-1', ilosc: 1, cena_brutto: '10.00', brutto_linii: '10.00' });
  przeliczKwoteRecznego(db, id);
  return id;
}
// Potwierdzenie prawdziwą trasą karty (wiadomości → delegacja do usługi potwierdzenia) — i list z atrapy transportu.
async function wyslijPotwierdzenie(p) {
  const id = zamowienie(p.db);
  const przed = wyslane.length;
  const r = await post(p.app, `/zamowienia/${id}/wiadomosc/potwierdzenie`, p.admin);
  expect(r.statusCode, r.body).toBe(302);
  expect(wyslane.length).toBe(przed + 1);
  return wyslane.at(-1);
}
const sekcja = (html) => /<section class="ust-sekcja" id="podpis-maili">[\s\S]*?<\/section>/u.exec(html)?.[0] ?? '';
const wierszeUstawien = (db) => db.prepare("SELECT klucz, wartosc FROM ustawienia WHERE klucz LIKE 'poczta.podpis.%' ORDER BY klucz").all()
  .map((w) => ({ ...w }));

describe('PRZ-102.10 podpis maili w Ustawieniach → Poczta', () => {
  it('bez pliku: zapis w panelu zmienia następny mail na tej samej instancji, bez restartu (tekst, HTML, podgląd)', async () => {
    const p = await panel();
    const przed = await wyslijPotwierdzenie(p);
    expect(przed.text.trimEnd().split('\n').at(-1)).toBe('Obsługa sklepu');

    const ekran = await get(p.app, EKRAN, p.admin);
    expect(ekran.statusCode, ekran.body).toBe(200);
    expect(sekcja(ekran.body)).toContain('Podpis maili');
    expect(sekcja(ekran.body)).toMatch(/<input id="podpis-marka" name="marka" value=""/u);
    expect(sekcja(ekran.body)).toMatch(/<textarea id="podpis-stopka" name="stopka"[^>]*><\/textarea>/u);

    const r = await post(p.app, ZAPIS, p.admin, { marka: `  ${MARKA}  `, stopka: `${STOPKA}\n\n` });
    expect(r.statusCode, r.body).toBe(303);
    expect(wierszeUstawien(p.db)).toEqual([{ klucz: 'poczta.podpis.marka', wartosc: MARKA }, { klucz: 'poczta.podpis.stopka', wartosc: STOPKA }]);

    const po = await wyslijPotwierdzenie(p);
    expect(po.text).toContain(`Pozdrawiamy,\n${MARKA}`);
    expect(po.text.endsWith(`\n\n${STOPKA}`)).toBe(true);
    expect(po.html).toContain(MARKA);
    expect(po.html).toContain('ul. Lipowa 7, 00-001 Warszawa');

    // Podgląd na karcie i ekran szablonu też widzą nowy podpis (zmienna {nazwa_firmy} = marka).
    const id = zamowienie(p.db);
    expect((await p.app.inject({ method: 'GET', url: `/zamowienia/${id}?wiadomosc=potwierdzenie`, headers: { ...p.admin, accept: 'text/html' } })).body)
      .toContain(MARKA);
    const szablon = await get(p.app, `/ustawienia/szablony-wiadomosci/potwierdzenie?podglad=1&temat=${encodeURIComponent('Zamówienie {numer_zamowienia}')}&tresc=${encodeURIComponent('Firma: {nazwa_firmy}\n\n{podpis}')}`, p.admin);
    expect(szablon.body).toContain(`Firma: ${MARKA}`);

    expect(r.headers.location).toBe(`${EKRAN}?zapisano=podpis#podpis-maili`);
    const potwierdzenie = (await get(p.app, `${EKRAN}?zapisano=podpis`, p.admin)).body;
    expect(sekcja(potwierdzenie)).toContain('Zapisano podpis maili');
    const ekranPo = await get(p.app, EKRAN, p.admin);
    expect(sekcja(ekranPo.body)).toContain(`value="${MARKA}"`);
    expect(sekcja(ekranPo.body)).toMatch(/<iframe[^>]*srcdoc="[^"]*Pracownia Półcień/u);

    // Puste pola = powrót do domyślnego podpisu i maila bez stopki.
    expect((await post(p.app, ZAPIS, p.admin, { marka: '', stopka: '' })).statusCode).toBe(303);
    expect(wierszeUstawien(p.db)).toEqual([]);
    const znowu = await wyslijPotwierdzenie(p);
    expect(znowu.text.trimEnd().split('\n').at(-1)).toBe('Obsługa sklepu');
    expect(znowu.text).not.toContain('Lipowa');
  });

  it('plik wygrywa: pole z pliku pokazane z dopiskiem, zapis = 409, mail bajt w bajt jak bez zapisu w panelu', async () => {
    const env = { OMS_MAIL_MARKA: MARKA_PLIKU, OMS_MAIL_STOPKA: STOPKA_PLIKU };
    const czysty = await panel({ env });
    const wzor = await wyslijPotwierdzenie(czysty);
    expect(wzor.text).toContain(`Pozdrawiamy,\n${MARKA_PLIKU}`);

    // W bazie leży zapis z panelu sprzed dopisania zmiennych do pliku — nie może wygrać z plikiem.
    const p = await panel({ env, przedStartem: (db) => {
      db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('poczta.podpis.marka', 'Marka z panelu', '2026-10-19T10:00:00Z'), ('poczta.podpis.stopka', 'Stopka z panelu', '2026-10-19T10:00:00Z')").run();
    } });
    const ekran = await get(p.app, EKRAN, p.admin);
    expect(sekcja(ekran.body)).toContain(MARKA_PLIKU);
    expect(sekcja(ekran.body)).toContain(STOPKA_PLIKU);
    expect(sekcja(ekran.body)).toContain('ustawione w pliku konfiguracji');
    expect(sekcja(ekran.body)).not.toMatch(/<input id="podpis-marka"/u);

    for (const pole of [{ marka: 'Inna marka' }, { stopka: 'Inna stopka' }]) {
      const r = await post(p.app, ZAPIS, p.admin, pole);
      expect(r.statusCode, JSON.stringify(pole)).toBe(409);
    }
    expect(wierszeUstawien(p.db).map((w) => w.wartosc)).toEqual(['Marka z panelu', 'Stopka z panelu']);

    const mail = await wyslijPotwierdzenie(p);
    expect({ text: mail.text, html: mail.html, subject: mail.subject }).toEqual({ text: wzor.text, html: wzor.html, subject: wzor.subject });
  });

  it('plik ustawia samą markę: stopkę można zapisać w panelu, markę nie', async () => {
    const p = await panel({ env: { OMS_MAIL_MARKA: MARKA_PLIKU } });
    expect((await post(p.app, ZAPIS, p.admin, { marka: 'X' })).statusCode).toBe(409);
    expect((await post(p.app, ZAPIS, p.admin, { stopka: STOPKA })).statusCode).toBe(303);
    const mail = await wyslijPotwierdzenie(p);
    expect(mail.text).toContain(`Pozdrawiamy,\n${MARKA_PLIKU}`);
    expect(mail.text.endsWith(`\n\n${STOPKA}`)).toBe(true);
  });

  it('bez uprawnienia „ustawienia”: ekran i zapis = 403, nic nie zapisane', async () => {
    const p = await panel();
    expect((await get(p.app, EKRAN, p.ewa)).statusCode).toBe(403);
    expect((await post(p.app, ZAPIS, p.ewa, { marka: MARKA, stopka: STOPKA })).statusCode).toBe(403);
    expect(wierszeUstawien(p.db)).toEqual([]);
  });

  it('walidacja: znaki sterujące i długość — 400, nic nie zapisane; nowa linia w stopce dozwolona', async () => {
    const p = await panel();
    for (const zle of [{ marka: 'Dwie\nlinie' }, { marka: 'Tab\tulator' }, { marka: 'x'.repeat(121) },
      { stopka: 'Linia\u0007dzwonek' }, { stopka: 'Tab\tw stopce' }, { stopka: 'y'.repeat(601) },
      { stopka: Array.from({ length: 9 }, (_, i) => `linia ${i}`).join('\n') }, { marka: 'Odwrócony \u202Etekst' }]) {
      const r = await post(p.app, ZAPIS, p.admin, zle);
      expect(r.statusCode, JSON.stringify(zle)).toBe(400);
      expect(r.body).toContain('Nie zapisano');
    }
    expect(wierszeUstawien(p.db)).toEqual([]);
    expect((await post(p.app, ZAPIS, p.admin, { marka: MARKA, stopka: 'a\r\nb' })).statusCode).toBe(303);
    expect(wierszeUstawien(p.db).map((w) => w.wartosc)).toEqual([MARKA, 'a\nb']);
  });

  it('HTML w polach jest escapowany w mailu i w podglądzie na ekranie', async () => {
    const p = await panel();
    const marka = 'Sklep <img src=x onerror=alert(1)> & Syn';
    const stopka = '<b>Gruby</b>\n<script>alert(2)</script>';
    expect((await post(p.app, ZAPIS, p.admin, { marka, stopka })).statusCode).toBe(303);

    const mail = await wyslijPotwierdzenie(p);
    expect(mail.html).toContain(esc(marka));
    expect(mail.html).toContain(esc('<b>Gruby</b>'));
    expect(mail.html).not.toContain('<img src=x');
    expect(mail.html).not.toContain('<script>alert(2)');
    expect(mail.html).not.toContain('<b>Gruby</b>');

    const ekran = (await get(p.app, EKRAN, p.admin)).body;
    expect(ekran).not.toContain('<img src=x');
    expect(ekran).not.toContain('<script>alert(2)');
    expect(ekran).not.toContain('<b>Gruby</b>');
    // W srcdoc HTML maila jest escapowany drugi raz (atrybut), więc przeglądarka zobaczy w ramce tekst, nie znacznik.
    expect(sekcja(ekran)).toContain(esc(esc('<img src=x onerror=alert(1)>')));
    expect(sekcja(ekran)).toMatch(/<iframe[^>]* sandbox /u);
  });

  it('podgląd niezapisanych wartości: GET niczego nie zapisuje, pokazuje wpisaną markę w ramce', async () => {
    const p = await panel();
    const r = await get(p.app, `${EKRAN}?podglad=1&marka=${encodeURIComponent('Nowa Marka')}&stopka=${encodeURIComponent('Stopka podglądu')}#podpis-maili`, p.admin);
    expect(r.statusCode).toBe(200);
    expect(sekcja(r.body)).toMatch(/srcdoc="[^"]*Nowa Marka/u);
    expect(sekcja(r.body)).toContain('value="Nowa Marka"');
    expect(wierszeUstawien(p.db)).toEqual([]);
  });
});
