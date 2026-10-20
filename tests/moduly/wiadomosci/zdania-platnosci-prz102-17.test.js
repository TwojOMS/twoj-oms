// PRZ-102.17 — zdania o płatności w mailach do edycji w Ustawieniach → Szablony wiadomości → „Zdania o płatności".
// Prawdziwy serwer i trasy; poczta to atrapa (lista wysłanych w pamięci), PDF faktury to zmyślone bajty — nic nie
// wychodzi. Dane zmyślone.
//
// Umowa: zapis z panelu działa od następnego maila na tej samej instancji (bez restartu), w mailu i w podglądach;
// zdanie przy pobraniu bez słowa o kurierze/doręczeniu = 400 i nic nie zapisane; „Przywróć domyślne" wraca do tekstu
// domyślnego; bez uprawnienia „ustawienia" = 403; HTML wpisany w pole jest escapowany w mailu, w podglądzie i na ekranie.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajWplateReczna } from '../../../src/oms/db/platnosci.js';
import { createWiadomosci } from '../../../src/moduly/wiadomosci/services/wiadomosci.js';
import { createPotwierdzenie } from '../../../src/moduly/wiadomosci/services/potwierdzenie.js';
import { DOMYSLNE } from '../../../src/domena/szablony-wiadomosci.js';
import { DOMYSLNE_ZDANIA, ZDANIA } from '../../../src/domena/zdania-platnosci.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get as getJako, post as postJako } from '../../pomoc/konta-prz068.js';
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

const naglowek = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`, origin: 'http://localhost' };
const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [], proforma: { rachunek: '00 1111 2222 3333 4444 5555 6666' } };
const ADRES = '/ustawienia/szablony-wiadomosci';
const ZAPIS = `${ADRES}/zdania-platnosci`;
const przywroc = (klucz) => `${ZAPIS}/${klucz}/przywroc`;

const NOWE_OPLACONE = 'Wpłata dotarła — dziękujemy i bierzemy się do pracy.';

const zamowienie = (nad = {}) => ({
  zrodlo_id: 6017, numer: '1717',
  klient: { first_name: 'Anna', last_name: 'Testowa', email: 'anna@pracownia.example.test' },
  dostawa: { first_name: 'Anna', last_name: 'Testowa', address_1: 'Fikcyjna 1', postcode: '00-001', city: 'Testowo' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '476.00', koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-14T09:15:00', termin_platnosci: '14',
  pozycje: [{ zrodlo_id: 7017, nazwa: 'Lampa stołowa Grzybek', sku: 'LMP-1', ilosc: 2, cena_brutto: '238.00',
    cena_netto: '193.50', brutto_linii: '476.00', netto_linii: '387.00', vat: null }],
  ...nad,
});

let db; let app; let wyslane;
const get = (url) => app.inject({ method: 'GET', url, headers: naglowek });
const post = (url, payload = {}) => app.inject({ method: 'POST', url, headers: naglowek, payload });
const wierszZdan = () => db.prepare("SELECT wartosc FROM ustawienia WHERE klucz = 'wiadomosci.zdania_platnosci'").get()?.wartosc ?? null;
const sekcja = (html) => /<section class="ust-sekcja szw-sekcja" id="zdania-platnosci">[\s\S]*?<\/section>/u.exec(html)?.[0] ?? '';
// Formularz z kompletem pól w bieżącym brzmieniu — tak wysyła go przeglądarka (wszystkie pola naraz).
const formularz = (zmiany = {}) => ({ ...DOMYSLNE_ZDANIA, ...zmiany });

/** Zamówienie z wystawioną fakturą (PDF z atrapy) — opcjonalnie opłacone wpłatą ręczną albo za pobraniem. */
function zamowienieZFaktura({ oplacone = false, pobranie = false, zrodlo = 6017 } = {}) {
  const id = zapiszZamowienie(db, 'pro', zamowienie({ zrodlo_id: zrodlo, numer: String(zrodlo), ...(pobranie ? { pobranie: 1, kwota_pobrania: '476.00', metoda_platnosci: 'Za pobraniem' } : {}) }));
  db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
    .run(id, `uuid-${zrodlo}`, `FV ${zrodlo}/10/2026`, '2026-10-15T09:00:00.000Z');
  if (oplacone) dodajWplateReczna(db, id, { kwota: '476.00', data: '2026-10-15' });
  return id;
}
async function wyslijFakture(id) {
  const przed = wyslane.length;
  const r = await post(`/zamowienia/${id}/wiadomosc/faktura`);
  expect(r.statusCode, r.body).toBe(302);
  expect(wyslane.length).toBe(przed + 1);
  return wyslane.at(-1);
}

beforeEach(async () => {
  db = openOmsDb(':memory:');
  wyslane = [];
  const mailer = { sendMail: async (m) => { wyslane.push(m); return { messageId: 't' }; } };
  const teraz = () => '2026-10-20T10:00:00.000Z';
  app = buildOmsServer({
    db, config, poller: { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) },
    wiadomosci: createWiadomosci({
      db, mailer, config, teraz, potwierdzenie: createPotwierdzenie({ db, mailer, teraz }),
      infakt: { pobierzPdf: async () => Buffer.from('%PDF-atrapa') },
    }),
  });
  await app.ready();
});

describe('sekcja „Zdania o płatności" na ekranie Szablonów wiadomości', () => {
  it('pokazuje każde zdanie z opisem, kiedy pada, w brzmieniu domyślnym', async () => {
    const r = await get(ADRES);
    expect(r.statusCode).toBe(200);
    const s = sekcja(r.body);
    expect(s).toContain('<h2>Zdania o płatności</h2>');
    expect(s).toContain('Gdy zamówienie jest za pobraniem');
    for (const z of ZDANIA) {
      expect(s, z.klucz).toContain(`name="${z.klucz}"`);
      expect(s, z.klucz).toContain(z.kiedy.replace(/"/g, '&#34;'));
    }
    expect(s).toContain('Należność pobierze kurier przy doręczeniu — nie trzeba nic przelewać.');
    // Nic nie zmienione — nie ma czego przywracać.
    expect(s).not.toContain('/przywroc');
  });

  it('opisy {zamkniecie} i {dane_platnosci} w edytorze odsyłają do sekcji', async () => {
    const r = await get(`${ADRES}/faktura`);
    expect(r.body.match(/Treść zdań zmienisz niżej w sekcji Zdania o płatności/g)).toHaveLength(2);
    expect(r.body).toContain(`href="${ADRES}#zdania-platnosci"`);
  });
});

describe('zapis zdania działa od następnego maila (ta sama instancja, bez restartu)', () => {
  it('„opłacone": następna faktura opłaconego zamówienia ma nowe zdanie w tekście i w HTML-u, także w podglądzie karty', async () => {
    const id = zamowienieZFaktura({ oplacone: true });
    const przed = await wyslijFakture(id);
    expect(przed.text).toContain(DOMYSLNE_ZDANIA.oplacone);

    const zapis = await post(ZAPIS, formularz({ oplacone: NOWE_OPLACONE }));
    expect(zapis.statusCode, zapis.body).toBe(303);
    expect(zapis.headers.location).toBe(`${ADRES}?zapisano=zdania#zdania-platnosci`);
    expect(JSON.parse(wierszZdan())).toEqual({ oplacone: NOWE_OPLACONE });

    const karta = await get(`/zamowienia/${id}?wiadomosc=faktura`);
    expect(karta.body).toContain(NOWE_OPLACONE);

    const po = await wyslijFakture(id);
    expect(po.text).toContain(`\n\n${NOWE_OPLACONE}\n\nPozdrawiamy,`);
    expect(po.text).not.toContain(DOMYSLNE_ZDANIA.oplacone);
    expect(po.html).toContain(NOWE_OPLACONE);
    expect(po.html).not.toContain(DOMYSLNE_ZDANIA.oplacone);

    // Ekran pokazuje zdanie jako zmienione i daje „Przywróć domyślne" tylko przy nim.
    const ekran = sekcja((await get(ADRES)).body);
    expect(ekran).toContain(`>${NOWE_OPLACONE}</textarea>`);
    expect(ekran.match(/\/przywroc"/g)).toHaveLength(1);
    expect(ekran).toContain(`formaction="${przywroc('oplacone')}"`);
  });

  it('zapisany szablon (nie domyślna droga) też bierze zdania z panelu: {zamkniecie} i nagłówki {dane_platnosci}', async () => {
    const tresc = DOMYSLNE.faktura.tresc.replace('w załączeniu przesyłamy', 'przesyłamy w załączniku');
    expect((await post(`${ADRES}/faktura`, { temat: DOMYSLNE.faktura.temat, tresc })).statusCode).toBe(303);
    expect((await post(ZAPIS, formularz({ pozostale: 'Dziękujemy za zamówienie.', naglowek_do_zaplaty: 'Kwota', naglowek_przelew: 'Dane do przelewu' }))).statusCode).toBe(303);
    const mail = await wyslijFakture(zamowienieZFaktura());
    expect(mail.text).toContain('przesyłamy w załączniku');
    // PRZ-102.18: bez nazwy firmy wiersz „Odbiorca:” w ogóle nie pada (wcześniej był pusty) — następny jest rachunek.
    expect(mail.text).toContain('\nKWOTA\n  476,00 zł brutto\n\nDANE DO PRZELEWU\n  Rachunek:');
    expect(mail.text).toContain('\n\nDziękujemy za zamówienie.\n\nPozdrawiamy,');
    expect(mail.html).toContain('>Kwota</p>');
    expect(mail.html).toContain('>Dane do przelewu</p>');
  });

  it('podgląd szablonu w Ustawieniach pokazuje zdania z panelu', async () => {
    expect((await post(ZAPIS, formularz({ pozostale: 'Zdanie z panelu do podglądu.', naglowek_przelew: 'Konto do wpłaty' }))).statusCode).toBe(303);
    const q = new URLSearchParams({ podglad: '1', temat: DOMYSLNE.faktura.temat, tresc: DOMYSLNE.faktura.tresc });
    const r = await get(`${ADRES}/faktura?${q}`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Zdanie z panelu do podglądu.');
    expect(r.body).toContain('KONTO DO WPŁATY');
    expect(r.body).not.toContain(DOMYSLNE_ZDANIA.pozostale);
  });

  it('zdanie o załączonej proformie z {numer_proformy} dostaje numer z koperty', async () => {
    expect((await post(ZAPIS, formularz({ zalacznik_proformy: 'Proforma {numer_proformy} jest w załączniku.' }))).statusCode).toBe(303);
    const q = new URLSearchParams({ podglad: '1', temat: DOMYSLNE.przypomnienie.temat, tresc: DOMYSLNE.przypomnienie.tresc });
    const r = await get(`${ADRES}/przypomnienie?${q}`);
    expect(r.body).toContain('Proforma PF 7/10/2026 jest w załączniku.');
  });
});

describe('bezpiecznik pobrania i reguły treści', () => {
  it('„pobranie" bez słowa o kurierze ani doręczeniu → 400 z wyjaśnieniem, wpisany tekst zostaje, nic nie zapisane', async () => {
    const r = await post(ZAPIS, formularz({ pobranie: 'Prosimy o wpłatę w ciągu 7 dni.', oplacone: NOWE_OPLACONE }));
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('zapłacić przelewem, a potem drugi raz kurierowi');
    expect(sekcja(r.body)).toContain('>Prosimy o wpłatę w ciągu 7 dni.</textarea>');
    // Zapis wszystkich albo żadnego — poprawne „opłacone" też nie weszło.
    expect(wierszZdan()).toBeNull();
    const mail = await wyslijFakture(zamowienieZFaktura({ pobranie: true }));
    expect(mail.text).toContain(DOMYSLNE_ZDANIA.pobranie);
  });

  it('„pobranie": słowo rozpoznane bez względu na wielkość liter i bez polskich znaków', async () => {
    for (const tekst of ['Zapłacisz KURIEROWI.', 'Płatność przy DORĘCZENIU paczki.', 'Platnosc przy doreczeniu paczki.']) {
      const r = await post(ZAPIS, formularz({ pobranie: tekst }));
      expect(r.statusCode, tekst).toBe(303);
      expect(JSON.parse(wierszZdan()).pobranie).toBe(tekst);
    }
    const mail = await wyslijFakture(zamowienieZFaktura({ pobranie: true }));
    expect(mail.text).toContain('Platnosc przy doreczeniu paczki.');
  });

  it('„opłacone" nie może prosić o zapłatę → 400; opis tego, co już się stało, przechodzi', async () => {
    for (const tekst of ['Prosimy przelać resztę.', 'Kwota do zapłaty jest w załączniku.', 'Zaplac do piatku.', 'Termin mija jutro.']) {
      const r = await post(ZAPIS, formularz({ oplacone: tekst }));
      expect(r.statusCode, tekst).toBe(400);
      expect(r.body).toContain('Zdanie przy opłaconym zamówieniu nie może prosić o zapłatę');
    }
    expect(wierszZdan()).toBeNull();
    expect((await post(ZAPIS, formularz({ oplacone: 'Zamówienie zapłacone, dziękujemy za przelew.' }))).statusCode).toBe(303);
  });

  it('znaki sterujące, za długi tekst, zbłąkane klamry, proforma bez numeru → 400, nic nie zapisane', async () => {
    const zle = [
      { pozostale: 'Zdanie\tz tabulatorem.' },
      { pozostale: 'x'.repeat(301) },
      { naglowek_przelew: 'N'.repeat(41) },
      { pozostale: 'Dzień dobry {imie}.' },
      { zalacznik_proformy: 'W załączeniu proforma.' },
      { zalacznik_proformy: 'Proforma {numer_proformy} i {numer}.' },
      { pozostale: 'Zdanie‮odwrócone.' },
    ];
    for (const pole of zle) {
      const r = await post(ZAPIS, formularz(pole));
      expect(r.statusCode, JSON.stringify(pole)).toBe(400);
    }
    expect(wierszZdan()).toBeNull();
  });

  it('puste pole i tekst równy domyślnemu = tekst domyślny (nic nie zapisane); Enter w polu = odstęp', async () => {
    expect((await post(ZAPIS, formularz({ pozostale: '   ' }))).statusCode).toBe(303);
    expect(wierszZdan()).toBeNull();
    expect((await post(ZAPIS, formularz({ pozostale: 'Pierwsza linia\r\ndruga linia.' }))).statusCode).toBe(303);
    expect(JSON.parse(wierszZdan())).toEqual({ pozostale: 'Pierwsza linia druga linia.' });
  });
});

describe('„Przywróć domyślne"', () => {
  it('kasuje tylko to zdanie — następny mail ma tekst domyślny, inne zmiany zostają', async () => {
    const id = zamowienieZFaktura({ oplacone: true });
    expect((await post(ZAPIS, formularz({ oplacone: NOWE_OPLACONE, naglowek_przelew: 'Konto' }))).statusCode).toBe(303);
    expect((await wyslijFakture(id)).text).toContain(NOWE_OPLACONE);

    const r = await post(przywroc('oplacone'), formularz({ oplacone: 'to, co akurat stało w polu, jest pomijane' }));
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`${ADRES}?zapisano=zdanie-przywrocone#zdania-platnosci`);
    expect(JSON.parse(wierszZdan())).toEqual({ naglowek_przelew: 'Konto' });

    const po = await wyslijFakture(id);
    expect(po.text).toContain(`\n\n${DOMYSLNE_ZDANIA.oplacone}\n\nPozdrawiamy,`);
    expect(sekcja((await get(`${ADRES}?zapisano=zdanie-przywrocone`)).body)).toContain(`>${DOMYSLNE_ZDANIA.oplacone}</textarea>`);

    expect((await post(przywroc('naglowek_przelew'))).statusCode).toBe(303);
    expect(wierszZdan()).toBeNull();
  });

  it('nieznane zdanie → 404', async () => {
    expect((await post(przywroc('nie-ma-takiego'))).statusCode).toBe(404);
  });
});

describe('HTML wpisany w pole jest escapowany', () => {
  const ZLY = 'Uwaga <b>pogrubienie</b> & <img src=x onerror=alert(1)> — dziękujemy.';
  it('w mailu (HTML i tekst), w podglądzie szablonu i w polu na ekranie', async () => {
    expect((await post(ZAPIS, formularz({ pozostale: ZLY, naglowek_do_zaplaty: '<i>Kwota</i>' }))).statusCode).toBe(303);

    const mail = await wyslijFakture(zamowienieZFaktura());
    expect(mail.text).toContain(ZLY);
    expect(mail.html).not.toContain('<b>pogrubienie</b>');
    expect(mail.html).not.toContain('<img src=x');
    expect(mail.html).toContain('Uwaga &lt;b&gt;pogrubienie&lt;/b&gt; &amp; &lt;img src=x onerror=alert(1)&gt; — dziękujemy.');
    expect(mail.html).toContain('&lt;i&gt;Kwota&lt;/i&gt;');

    const q = new URLSearchParams({ podglad: '1', temat: DOMYSLNE.faktura.temat, tresc: DOMYSLNE.faktura.tresc });
    const podglad = await get(`${ADRES}/faktura?${q}`);
    // srcdoc jest escapowany drugi raz przez widok: wewnątrz ramki `&lt;b&gt;` to tekst, nie znacznik.
    expect(podglad.body).toContain('Uwaga &amp;lt;b&amp;gt;pogrubienie');
    expect(podglad.body).not.toContain('<b>pogrubienie</b>');

    const ekran = sekcja((await get(ADRES)).body);
    expect(ekran).not.toContain('<b>pogrubienie</b>');
    expect(ekran).toContain('Uwaga &lt;b&gt;pogrubienie&lt;/b&gt;');
  });
});

describe('bez uprawnienia „ustawienia"', () => {
  beforeEach(() => { for (const m of ['log', 'error', 'warn', 'info']) vi.spyOn(console, m).mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('ekran, zapis i „Przywróć domyślne" = 403, nic nie zapisane', async () => {
    const moduly = [modulRdzen, modulWeb, modulKanaly, createModulFaktury(), createModulWiadomosci(),
      createModulZamowienia({ zWiadomosciami: true }), createModulWysylka(), modulMagazyn, modulUstawienia, modulMarketing, modulZdrowie];
    const p = nowyPanel({ moduly });
    await p.app.ready();
    zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
    ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia', 'wiadomosci']);
    const ewa = jako(p.db, 'ewa');
    const admin = jako(p.db, 'adam');
    const wiersz = () => p.db.prepare("SELECT wartosc FROM ustawienia WHERE klucz = 'wiadomosci.zdania_platnosci'").get()?.wartosc ?? null;

    expect((await getJako(p.app, ADRES, ewa)).statusCode).toBe(403);
    expect((await postJako(p.app, ZAPIS, ewa, formularz({ oplacone: NOWE_OPLACONE }))).statusCode).toBe(403);
    expect(wiersz()).toBeNull();

    // Admin w tym samym składzie może — 403 wyżej to uprawnienie, nie brak trasy.
    expect((await postJako(p.app, ZAPIS, admin, formularz({ oplacone: NOWE_OPLACONE }))).statusCode).toBe(303);
    expect((await postJako(p.app, przywroc('oplacone'), ewa)).statusCode).toBe(403);
    expect(JSON.parse(wiersz())).toEqual({ oplacone: NOWE_OPLACONE });
  });
});

// Recenzja PRZ-102.17 (WAŻNE 2): odczyt przy mailu sprawdza reguły. Zdanie zapisane przed zaostrzeniem filtra albo
// wpisane do bazy z pominięciem formularza nie wychodzi do klienta — mail dostaje tekst domyślny, log jedną linię bez
// treści zdania, a ekran mówi to przy polu.
describe('zapisane zdanie, które nie przechodzi reguł', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('„Prosimy o zapłatę" wpisane wprost do bazy dla „opłacone" → mail ma zdanie domyślne, log bez treści, ekran ostrzega', async () => {
    const ZLE = 'Prosimy o zapłatę 476 zł.';
    db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('wiadomosci.zdania_platnosci', ?, '2026-10-20T09:00:00Z')")
      .run(JSON.stringify({ oplacone: ZLE, naglowek_przelew: 'Konto do wpłaty' }));
    const id = zamowienieZFaktura({ oplacone: true });

    const mail = await wyslijFakture(id);
    expect(mail.text).toContain(`\n\n${DOMYSLNE_ZDANIA.oplacone}\n\nPozdrawiamy,`);
    expect(mail.text).not.toContain(ZLE);
    expect(mail.html).not.toContain(ZLE);
    const karta = await get(`/zamowienia/${id}?wiadomosc=faktura`);
    expect(karta.body).not.toContain(ZLE);

    const linie = console.error.mock.calls.map((a) => a.join(' ')).filter((l) => l.includes('zdanie o płatności'));
    expect(linie.length).toBeGreaterThan(0);
    expect(linie[0]).toContain('„oplacone”');
    expect(linie[0]).toContain('w mailu idzie tekst domyślny');
    expect(linie.join('\n')).not.toContain('Prosimy');

    const ekran = sekcja((await get(ADRES)).body);
    expect(ekran).toContain(`>${ZLE}</textarea>`);
    expect(ekran).toContain('Zapisane zdanie nie przechodzi reguł — w mailu idzie domyślne.');
    expect(ekran).toContain(`formaction="${przywroc('oplacone')}"`);
    // Zdanie poprawne z tego samego wiersza dalej działa.
    expect((await get(`${ADRES}/faktura?${new URLSearchParams({ podglad: '1', temat: DOMYSLNE.faktura.temat, tresc: DOMYSLNE.faktura.tresc })}`)).body)
      .toContain('KONTO DO WPŁATY');
  });

  it('formularz odrzuca prośby o zapłatę przy „opłacone" i przelew przy „pobranie" (400, nic nie zapisane)', async () => {
    for (const pole of [
      { oplacone: 'Prosimy o zapłatę 476 zł.' }, { oplacone: 'Czekamy na wpłatę.' }, { oplacone: 'Prosimy o płatność.' },
      { pobranie: 'Należność pobierze kurier, ale prosimy też o przelew.' }, { pobranie: 'Nie płać kurierowi, zapłać przelewem.' },
    ]) {
      expect((await post(ZAPIS, formularz(pole))).statusCode, JSON.stringify(pole)).toBe(400);
    }
    expect(wierszZdan()).toBeNull();
    expect((await post(ZAPIS, formularz({ oplacone: 'Płatność zaksięgowana — dziękujemy.' }))).statusCode).toBe(303);
  });
});
