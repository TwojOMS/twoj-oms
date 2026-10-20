// PRZ-102.19 — etykiety przelewu i stałe teksty maili do edycji w Ustawieniach → Szablony wiadomości (ta sama sekcja
// co zdania o płatności z PRZ-102.17, jej druga część „Etykiety i stałe teksty"). właściciel 20.10: „szablony nie mają
// sensu, jeżeli część danych jest zapisana w kodzie".
//
// Prawdziwy serwer i trasy; poczta to atrapa (lista wysłanych w pamięci), PDF faktury to zmyślone bajty — nic nie
// wychodzi. Dane zmyślone. Edytowalne są tylko ETYKIETY — kwotę, rachunek, odbiorcę, tytuł i termin dalej liczy kod.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createWiadomosci } from '../../../src/moduly/wiadomosci/services/wiadomosci.js';
import { createPotwierdzenie } from '../../../src/moduly/wiadomosci/services/potwierdzenie.js';
import { mailWlasny, mailWyslane, tekstDoWatku, mailPotwierdzenia, mailPlatniczy } from '../../../src/moduly/wiadomosci/szablony.js';
import { modelWiadomosci } from '../../../src/domena/wiadomosc-platnicza.js';
import { podgladPodpisu } from '../../../src/moduly/wiadomosci/podpis-maili.js';
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
import { SCENARIUSZE, SCENARIUSZE_ZAMOWIENIA, WLASNY, OPRAWA } from '../../pomoc/zdania-platnosci-scenariusze.js';

const naglowek = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`, origin: 'http://localhost' };
const RACHUNEK = '00 1111 2222 3333 4444 5555 6666';
// Odbiorca przelewu z Ustawień → Firma (PRZ-102.18 — bez nazwy firmy wiersz „Odbiorca” nie pada).
const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [], proforma: { rachunek: RACHUNEK }, nadawca: { nazwa: 'Pracownia Przykładowa' } };
const ADRES = '/ustawienia/szablony-wiadomosci';
const ZAPIS = `${ADRES}/zdania-platnosci`;
const przywroc = (klucz) => `${ZAPIS}/${klucz}/przywroc`;

const zamowienie = (nad = {}) => ({
  zrodlo_id: 6019, numer: '1919',
  klient: { first_name: 'Anna', last_name: 'Testowa', email: 'anna@pracownia.example.test' },
  dostawa: { first_name: 'Anna', last_name: 'Testowa', address_1: 'Fikcyjna 1', postcode: '00-001', city: 'Testowo' },
  metoda_wysylki: 'dpd', metoda_platnosci: 'Przelew', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '476.00', koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-14T09:15:00', termin_platnosci: '14',
  pozycje: [{ zrodlo_id: 7019, nazwa: 'Lampa stołowa Grzybek', sku: 'LMP-1', ilosc: 2, cena_brutto: '238.00',
    cena_netto: '193.50', brutto_linii: '476.00', netto_linii: '387.00', vat: null }],
  ...nad,
});

let db; let app; let wyslane;
const get = (url) => app.inject({ method: 'GET', url, headers: naglowek });
const post = (url, payload = {}) => app.inject({ method: 'POST', url, headers: naglowek, payload });
const wierszZdan = () => db.prepare("SELECT wartosc FROM ustawienia WHERE klucz = 'wiadomosci.zdania_platnosci'").get()?.wartosc ?? null;
const sekcja = (html) => /<section class="ust-sekcja szw-sekcja" id="zdania-platnosci">[\s\S]*?<\/section>/u.exec(html)?.[0] ?? '';
const formularz = (zmiany = {}) => ({ ...DOMYSLNE_ZDANIA, ...zmiany });
/** Tekst błędu przy jednym polu ekranu ('' = pole bez błędu). */
const bladPola = (html, klucz) => {
  const i = html.indexOf(`id="zd-${klucz}"`);
  if (i < 0) return null;
  const koniec = html.indexOf('<div class="szw-zdanie', i);
  const blok = html.slice(i, koniec < 0 ? undefined : koniec);
  return /<p class="szw-zdanie-blad" role="alert">([^<]*)<\/p>/u.exec(blok)?.[1] ?? '';
};

let kolejny = 6019;
/** Zamówienie z wystawioną fakturą (PDF z atrapy), do zapłaty przelewem. */
function zamowienieZFaktura() {
  const zrodlo = kolejny++;
  const id = zapiszZamowienie(db, 'pro', zamowienie({ zrodlo_id: zrodlo, numer: String(zrodlo) }));
  // Termin uzgodniony przy zamówieniu (ustalenia handlowe na karcie) — zapis sklepowy go nie niesie.
  db.prepare("UPDATE zamowienia SET termin_platnosci = '14' WHERE id = ?").run(id);
  db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
    .run(id, `uuid-${zrodlo}`, `FV ${zrodlo}/10/2026`, '2026-10-15T09:00:00.000Z');
  return id;
}
async function wyslij(id, temat) {
  const przed = wyslane.length;
  const r = await post(`/zamowienia/${id}/wiadomosc/${temat}`);
  expect(r.statusCode, r.body).toBe(302);
  expect(wyslane.length).toBe(przed + 1);
  return wyslane.at(-1);
}
const wyslijFakture = (id) => wyslij(id, 'faktura');

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

const NOWE = ['etykieta_odbiorca', 'etykieta_rachunek', 'etykieta_tytul', 'etykieta_termin', 'dopisek_brutto',
  'naglowek_zamowienie', 'naglowek_platnosc', 'naglowek_wysylka', 'naglowek_faktura',
  'kolumna_pozycja', 'kolumna_ilosc', 'kolumna_cena', 'kolumna_wartosc', 'etykieta_razem', 'jednostka',
  'faktura_tak', 'faktura_bez_danych', 'faktura_nie', 'adres_do_uzgodnienia', 'platnosc_do_uzgodnienia', 'pozdrowienie'];

describe('część „Etykiety i stałe teksty" w sekcji Zdania o płatności', () => {
  it('każda etykieta: pole z tekstem domyślnym, opis, gdzie pada, znacznik „domyślne"', async () => {
    const s = sekcja((await get(ADRES)).body);
    expect(s).toContain('Etykiety i stałe teksty');
    for (const klucz of NOWE) {
      const z = ZDANIA.find((x) => x.klucz === klucz);
      expect(z, klucz).toBeTruthy();
      expect(s, klucz).toMatch(new RegExp(`<input id="zd-${klucz}" name="${klucz}" value="[^"]*" maxlength="30">`));
      expect(s, klucz).toContain(z.kiedy.replace(/"/g, '&#34;'));
    }
    expect(s).toContain('value="Rachunek"');
    expect(s).toContain('value="Pozdrawiamy,"');
    expect(s).not.toContain('/przywroc');
  });
});

describe('zmiana etykiety działa od następnego maila (ta sama instancja, bez restartu)', () => {
  it('„Rachunek" → „Konto": następna faktura ma „Konto:" w tekście i w HTML-u, numer rachunku bez zmian', async () => {
    const id = zamowienieZFaktura();
    const przed = await wyslijFakture(id);
    expect(przed.text).toContain(`\n  Rachunek: ${RACHUNEK}\n`);

    const zapis = await post(ZAPIS, formularz({ etykieta_rachunek: 'Konto' }));
    expect(zapis.statusCode, zapis.body).toBe(303);
    expect(JSON.parse(wierszZdan())).toEqual({ etykieta_rachunek: 'Konto' });

    const po = await wyslijFakture(id);
    expect(po.text).toContain(`\n  Konto: ${RACHUNEK}\n`);
    expect(po.text).not.toContain('Rachunek:');
    expect(po.html).toMatch(/>Konto<\/td><td style="[^"]*">00 1111 2222 3333 4444 5555 6666<\/td>/u);
    expect(po.html).not.toContain('>Rachunek</td>');
    // Podgląd na karcie — ta sama funkcja co wysyłka.
    expect((await get(`/zamowienia/${id}?wiadomosc=faktura`)).body).toContain('Konto');
  });

  it('pozostałe etykiety przelewu, dopisek przy kwocie i „Pozdrawiamy," w mailu z fakturą (tekst i HTML)', async () => {
    expect((await post(ZAPIS, formularz({
      etykieta_odbiorca: 'Na rzecz', etykieta_tytul: 'W tytule', etykieta_termin: 'Zapłać do', dopisek_brutto: 'z VAT', pozdrowienie: 'Z pozdrowieniami,',
    }))).statusCode).toBe(303);
    const m = await wyslijFakture(zamowienieZFaktura());
    expect(m.text).toContain('\n  476,00 zł z VAT\n');
    expect(m.text).toContain('\n  Na rzecz: Pracownia Przykładowa\n');
    expect(m.text).toMatch(/\n {2}W tytule: FV \d+\/10\/2026\n/u);
    expect(m.text).toContain('\n  Zapłać do: termin 14 dni — do 2026-10-28');
    expect(m.text).toContain('\n\nZ pozdrowieniami,\n');
    expect(m.text).not.toContain('Pozdrawiamy,');
    expect(m.html).toContain('<span style="font-size:14px;font-weight:normal;color:');
    expect(m.html).toContain('">z VAT</span>');
    expect(m.html).toContain('>Na rzecz</td>');
    expect(m.html).toContain('>W tytule</td>');
    expect(m.html).toContain('>Zapłać do</td>');
    expect(m.html).toContain('>Z pozdrowieniami,</p>');
    expect(m.html).not.toContain('brutto');
  });

  it('zapisany szablon faktury (nie domyślna droga) też bierze etykiety i „Pozdrawiamy," z panelu', async () => {
    const tresc = DOMYSLNE.faktura.tresc.replace('w załączeniu przesyłamy', 'przesyłamy w załączniku');
    expect((await post(`${ADRES}/faktura`, { temat: DOMYSLNE.faktura.temat, tresc })).statusCode).toBe(303);
    expect((await post(ZAPIS, formularz({ etykieta_rachunek: 'Konto', pozdrowienie: 'Do usłyszenia,' }))).statusCode).toBe(303);
    const m = await wyslijFakture(zamowienieZFaktura());
    expect(m.text).toContain('przesyłamy w załączniku');
    expect(m.text).toContain(`\n  Konto: ${RACHUNEK}`);
    expect(m.text).toContain('\n\nDo usłyszenia,\n');
    expect(m.html).toContain('>Konto</td>');
    expect(m.html).toContain('>Do usłyszenia,</p>');
  });

  it('potwierdzenie przyjęcia: nagłówki, kolumny, „Razem", jednostka, teksty faktury i podpis z panelu', async () => {
    // Najpierw mail z brzmieniem domyślnym — zapis niżej ma zadziałać na tej samej instancji, bez restartu.
    const przed = await wyslij(zapiszZamowienie(db, 'pro', zamowienie({ zrodlo_id: 6099, numer: '6099' })), 'potwierdzenie');
    expect(przed.text).toContain('\n\nZAMÓWIENIE\n');
    expect(przed.text).toContain('\n\nPozdrawiamy,\n');
    expect((await post(ZAPIS, formularz({
      naglowek_zamowienie: 'Twoje zamówienie', naglowek_platnosc: 'Zapłata', naglowek_wysylka: 'Dostawa', naglowek_faktura: 'Dokument',
      kolumna_pozycja: 'Produkt', kolumna_ilosc: 'Szt.', kolumna_cena: 'Cena jedn.', kolumna_wartosc: 'Suma',
      etykieta_razem: 'Łącznie', jednostka: 'kpl', dopisek_brutto: 'z VAT', faktura_nie: 'Bez faktury', pozdrowienie: 'Z pozdrowieniami,',
    }))).statusCode).toBe(303);
    const id = zapiszZamowienie(db, 'pro', zamowienie({ zrodlo_id: 6100, numer: '6100' }));
    db.prepare("UPDATE zamowienia SET termin_platnosci = '14' WHERE id = ?").run(id);
    const m = await wyslij(id, 'potwierdzenie');
    expect(m.text).toContain('\n\nTWOJE ZAMÓWIENIE\n  2 × Lampa stołowa Grzybek — 238,00 zł/kpl = 476,00 zł\n');
    expect(m.text).toContain('\n  ŁĄCZNIE: 476,00 zł z VAT\n');
    expect(m.text).toContain('\n\nZAPŁATA\n  Przelew, termin 14 dni\n');
    expect(m.text).toContain('\n\nDOSTAWA\n  Kurier DPD\n');
    expect(m.text).toContain('\n\nDOKUMENT\n  Bez faktury\n');
    expect(m.text).toContain('\n\nZ pozdrowieniami,\n');
    for (const t of ['Twoje zamówienie', 'Zapłata', 'Dostawa', 'Dokument']) expect(m.html).toContain(`>${t}</p>`);
    for (const t of ['Produkt', 'Szt.', 'Cena jedn.', 'Suma']) expect(m.html).toContain(`>${t}</td>`);
    expect(m.html).toContain('>Łącznie z VAT</td>');
    expect(m.html).toContain('>Bez faktury</p>');
    expect(m.html).toContain('>Z pozdrowieniami,</p>');
    for (const stare of ['Pozycja', 'Wartość', 'Razem brutto', 'Pozdrawiamy']) expect(m.html).not.toContain(stare);
  });

  it('potwierdzenie: „Tak — wystawimy na:", „dane do uzgodnienia", „adres do uzgodnienia", płatność „do uzgodnienia"', async () => {
    expect((await post(ZAPIS, formularz({
      faktura_tak: 'Fakturę wystawimy na:', faktura_bez_danych: 'dane ustalimy mailem', adres_do_uzgodnienia: 'adres ustalimy', platnosc_do_uzgodnienia: 'ustalimy',
    }))).statusCode).toBe(303);
    const id = zapiszZamowienie(db, 'pro', zamowienie({ zrodlo_id: 6101, numer: '6101', chce_fakture: 1, metoda_platnosci: '', termin_platnosci: '',
      klient: { email: 'anna@pracownia.example.test' }, dostawa: {} }));
    const m = await wyslij(id, 'potwierdzenie');
    expect(m.text).toContain('\n  Fakturę wystawimy na:\n  dane ustalimy mailem\n');
    expect(m.text).toContain('\n  (adres ustalimy)\n');
    expect(m.text).toContain('\n\nPŁATNOŚĆ\n  ustalimy\n');
    expect(m.html).toContain('>Fakturę wystawimy na:</p>');
    expect(m.html).toContain('>dane ustalimy mailem</p>');
    expect(m.html).toContain('>adres ustalimy</p>');
    expect(m.html).toContain('>ustalimy</p>');
  });

  it('podgląd szablonu w Ustawieniach pokazuje etykiety z panelu', async () => {
    expect((await post(ZAPIS, formularz({ etykieta_rachunek: 'Konto do wpłaty' }))).statusCode).toBe(303);
    const q = new URLSearchParams({ podglad: '1', temat: DOMYSLNE.faktura.temat, tresc: DOMYSLNE.faktura.tresc });
    const r = await get(`${ADRES}/faktura?${q}`);
    expect(r.body).toContain('Konto do wpłaty: 00 1111');
    expect(r.body).not.toContain('Rachunek: 00 1111');
  });
});

describe('„Pozdrawiamy," z panelu w pozostałych mailach z blokiem {podpis}', () => {
  const zdania = { pozdrowienie: 'Do usłyszenia,' };
  const z = SCENARIUSZE_ZAMOWIENIA[0][1];
  it('szablon własny, „Zamówienie wysłane", wątek Allegro (z zamówieniem i bez), podgląd podpisu w Poczcie', () => {
    for (const m of [mailWlasny(z, WLASNY, { oprawa: OPRAWA, zdania }), mailWyslane(z, DOMYSLNE.wyslane, { oprawa: OPRAWA, zdania })]) {
      expect(m.tekst).toContain('\n\nDo usłyszenia,\nPracownia Półcień');
      expect(m.html).toContain('>Do usłyszenia,</p>');
      expect(m.html).not.toContain('Pozdrawiamy');
    }
    expect(tekstDoWatku(z, WLASNY, { podpis: OPRAWA.podpis, zdania })).toContain('\n\nDo usłyszenia,\nPracownia Półcień');
    expect(tekstDoWatku(null, WLASNY, { podpis: OPRAWA.podpis, zdania })).toContain('\n\nDo usłyszenia,\nPracownia Półcień');
    const p = podgladPodpisu(OPRAWA, { zdania });
    expect(p.tekst).toContain('\nDo usłyszenia,\nPracownia Półcień');
    expect(p.html).toContain('>Do usłyszenia,</p>');
  });
});

describe('reguły etykiet', () => {
  it('pusta etykieta = domyślna (nic nie zapisane); także „brutto" — kwota zawsze ma dopisek', async () => {
    expect((await post(ZAPIS, formularz({ etykieta_rachunek: '', dopisek_brutto: '   ', pozdrowienie: '' }))).statusCode).toBe(303);
    expect(wierszZdan()).toBeNull();
    const m = await wyslijFakture(zamowienieZFaktura());
    expect(m.text).toContain(`\n  Rachunek: ${RACHUNEK}`);
    expect(m.text).toContain('\n  476,00 zł brutto\n');
    expect(m.text).toContain('\n\nPozdrawiamy,\n');
  });

  it('ponad 30 znaków, klamry, znaki sterujące → 400 z powodem przy polu, nic nie zapisane', async () => {
    const zle = [
      [{ etykieta_rachunek: 'K'.repeat(31) }, 'najwyżej 30 znaków'],
      [{ etykieta_tytul: 'Tytuł {numer}' }, 'Klamry'],
      [{ dopisek_brutto: 'z\tVAT' }, 'bez tabulatorów'],
      [{ pozdrowienie: 'Pozdrawiamy‮' }, 'bez tabulatorów'],
    ];
    for (const [pole, powod] of zle) {
      const r = await post(ZAPIS, formularz(pole));
      expect(r.statusCode, JSON.stringify(pole)).toBe(400);
      expect(sekcja(r.body), JSON.stringify(pole)).toContain(powod);
    }
    expect(wierszZdan()).toBeNull();
    // 30 znaków przechodzi.
    expect((await post(ZAPIS, formularz({ etykieta_rachunek: 'K'.repeat(30) }))).statusCode).toBe(303);
  });

  it('dwie etykiety przelewu o tym samym brzmieniu → 400 (klient nie odróżniłby rachunku od tytułu)', async () => {
    const r = await post(ZAPIS, formularz({ etykieta_termin: 'rachunek' }));
    expect(r.statusCode).toBe(400);
    expect(sekcja(r.body)).toContain('Etykiety danych do przelewu muszą się różnić');
    expect(wierszZdan()).toBeNull();
    // Recenzja 19 (W2): etykieta nie może też brzmieć jak DOMYŚLNA etykieta innego wiersza — „Termin" nazwany
    // „Rachunek" myli klienta, który zna maile sprzed zmiany, nawet gdy wiersz rachunku nazywa się już inaczej.
    const zamiana = await post(ZAPIS, formularz({ etykieta_rachunek: 'Numer konta', etykieta_termin: 'Rachunek' }));
    expect(zamiana.statusCode).toBe(400);
    expect(bladPola(zamiana.body, 'etykieta_termin')).toContain('Etykiety danych do przelewu muszą się różnić');
    expect(bladPola(zamiana.body, 'etykieta_rachunek')).toBe('');
    expect(wierszZdan()).toBeNull();
  });
});

describe('HTML w etykiecie', () => {
  // Recenzja 19 (W2): etykieta to litery łacińskie, cyfry, spacje i zwykła interpunkcja — `<` i `>` formularz odrzuca.
  // Escapowanie zostaje drugą linią obrony: `&` i `"` przechodzą reguły, a renderer musi je escapować.
  it('znaczniki w etykiecie → 400; `&` i cudzysłów escapowane w mailu, w podglądzie i w polu na ekranie', async () => {
    for (const pole of [{ etykieta_rachunek: '<b>Konto</b>' }, { pozdrowienie: '<img src=x>' }]) {
      expect((await post(ZAPIS, formularz(pole))).statusCode, JSON.stringify(pole)).toBe(400);
    }
    expect(wierszZdan()).toBeNull();
    const ZNAKI = 'Konto "firmowe" & co';
    expect((await post(ZAPIS, formularz({ etykieta_rachunek: ZNAKI }))).statusCode).toBe(303);
    const m = await wyslijFakture(zamowienieZFaktura());
    expect(m.text).toContain(`\n  ${ZNAKI}: ${RACHUNEK}`);
    expect(m.html).toContain('>Konto &quot;firmowe&quot; &amp; co</td>');
    const q = new URLSearchParams({ podglad: '1', temat: DOMYSLNE.faktura.temat, tresc: DOMYSLNE.faktura.tresc });
    expect((await get(`${ADRES}/faktura?${q}`)).body).toContain('Konto &amp;quot;firmowe&amp;quot; &amp;amp; co');
    expect(sekcja((await get(ADRES)).body)).toContain('value="Konto &#34;firmowe&#34; &amp; co"');
  });

  // Recenzja 19 (D1): renderer escapuje KAŻDĄ etykietę, nawet gdyby reguły ją przepuściły (zdania podane wprost).
  it('renderery escapują wszystkie etykiety bloków zamówienia, przelewu i podpisu', () => {
    const zdania = Object.fromEntries(ZDANIA.filter((z) => z.etykieta).map((z) => [z.klucz, `<b>${z.klucz}</b>`]));
    const z = SCENARIUSZE_ZAMOWIENIA[2][1]; // faktura bez danych nabywcy — pada „Tak — wystawimy na:" i „dane do uzgodnienia"
    const bezAdresu = SCENARIUSZE_ZAMOWIENIA[4][1];
    for (const zam of [z, bezAdresu, SCENARIUSZE_ZAMOWIENIA[0][1], SCENARIUSZE_ZAMOWIENIA[5][1]]) {
      for (const m of [mailPotwierdzenia(zam, { oprawa: OPRAWA, zdania }), mailPotwierdzenia(zam, { oprawa: OPRAWA, szablon: DOMYSLNE.potwierdzenie, zdania })]) {
        expect(m.html).not.toContain('<b>');
        expect(m.html).toContain('&lt;b&gt;kolumna_cena&lt;/b&gt;');
      }
    }
    const [, { z: zp, dokument, opcje }] = SCENARIUSZE[0];
    const model = modelWiadomosci(zp, { ...opcje, zdania });
    for (const m of [mailPlatniczy(zp, model, { temat_id: opcje.temat_id, dokument, oprawa: OPRAWA }),
      mailPlatniczy(zp, model, { temat_id: opcje.temat_id, dokument, oprawa: OPRAWA, szablon: DOMYSLNE[opcje.temat_id] })]) {
      expect(m.html).not.toContain('<b>');
      expect(m.html).toContain('&lt;b&gt;etykieta_rachunek&lt;/b&gt;');
      expect(m.html).toContain('&lt;b&gt;dopisek_brutto&lt;/b&gt;');
    }
  });
});

describe('„Przywróć domyślne" etykiety', () => {
  it('kasuje tylko tę etykietę — następny mail ma „Rachunek:", inne zmiany zostają', async () => {
    const id = zamowienieZFaktura();
    expect((await post(ZAPIS, formularz({ etykieta_rachunek: 'Konto', pozdrowienie: 'Z pozdrowieniami,' }))).statusCode).toBe(303);
    const ekran = sekcja((await get(ADRES)).body);
    expect(ekran).toContain(`formaction="${przywroc('etykieta_rachunek')}"`);
    expect(ekran).toContain('Domyślnie: „Rachunek”');

    const r = await post(przywroc('etykieta_rachunek'));
    expect(r.statusCode).toBe(303);
    expect(JSON.parse(wierszZdan())).toEqual({ pozdrowienie: 'Z pozdrowieniami,' });
    const m = await wyslijFakture(id);
    expect(m.text).toContain(`\n  Rachunek: ${RACHUNEK}`);
    expect(m.text).toContain('\n\nZ pozdrowieniami,\n');
  });
});

describe('zapisana etykieta, która nie przechodzi reguł (wpisana do bazy z pominięciem formularza)', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('za długa / z klamrą / zdublowana → w mailu domyślna, log bez treści, ekran ostrzega', async () => {
    db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('wiadomosci.zdania_platnosci', ?, '2026-10-20T09:00:00Z')")
      .run(JSON.stringify({ etykieta_rachunek: 'Konto {rachunek}', dopisek_brutto: 'x'.repeat(31), etykieta_tytul: 'Termin', pozdrowienie: 'Do usłyszenia,' }));
    const m = await wyslijFakture(zamowienieZFaktura());
    expect(m.text).toContain(`\n  Rachunek: ${RACHUNEK}`);
    expect(m.text).toContain('\n  476,00 zł brutto\n');
    expect(m.text).toMatch(/\n {2}Tytuł przelewu: FV/u);
    expect(m.text).not.toContain('{rachunek}');
    // Poprawna etykieta z tego samego wiersza działa.
    expect(m.text).toContain('\n\nDo usłyszenia,\n');

    const linie = console.error.mock.calls.map((a) => a.join(' ')).filter((l) => l.includes('nie przechodzi reguł'));
    expect(linie.join('\n')).toContain('„etykieta_rachunek”');
    expect(linie.join('\n')).toContain('„dopisek_brutto”');
    expect(linie.join('\n')).toContain('„etykieta_tytul”');
    expect(linie.join('\n')).not.toContain('{rachunek}');

    const ekran = sekcja((await get(ADRES)).body);
    expect(ekran.match(/Zapisane zdanie nie przechodzi reguł/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

// ——— Recenzja PRZ-102.19 (W1–W3, D2, D4, D5): każda reguła przy zapisie (400, nic nie zapisane) i przy odczycie
// wiersza wpisanego wprost do bazy (w mailu tekst domyślny). ————————————————————————————————————————————————
describe('recenzja 19: reguły przy zapisie i przy odczycie', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  const wpiszDoBazy = (stan) => db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('wiadomosci.zdania_platnosci', ?, '2026-10-20T09:00:00Z')
    ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc`).run(JSON.stringify(stan));
  const odmowy = async (lista) => {
    for (const pole of lista) {
      const r = await post(ZAPIS, formularz(pole));
      expect(r.statusCode, JSON.stringify(pole)).toBe(400);
    }
    expect(wierszZdan()).toBeNull();
  };
  const DOMYSLNY_PRZELEW = `\n  Rachunek: ${RACHUNEK}\n`;

  it('W1: niewidoczne znaki (\\p{Cf}) w zdaniach i etykietach → 400; z bazy → domyślne', async () => {
    await odmowy([
      { etykieta_rachunek: 'Ko​nto' }, { etykieta_tytul: 'Tytu­ł' }, { pozdrowienie: 'Pozdrawiamy⁠,' },
      { etykieta_termin: 'Termin؜' }, { pozostale: 'Jeśli coś‍ się nie zgadza, napisz.' }, { oplacone: 'Opłacone﻿ — dziękujemy.' },
    ]);
    wpiszDoBazy({ etykieta_rachunek: 'Ko​nto', pozostale: 'Dzięki‎ za zamówienie.' });
    const m = await wyslijFakture(zamowienieZFaktura());
    expect(m.text).toContain(DOMYSLNY_PRZELEW);
    expect(m.text).toContain(`\n\n${DOMYSLNE_ZDANIA.pozostale}\n\n`);
    expect(m.text).not.toMatch(/\p{Cf}/u);
  });

  it('W1: odstępy \\p{Zs} zwinięte do jednej spacji; końcowy dwukropek etykiety obcięty', async () => {
    expect((await post(ZAPIS, formularz({ etykieta_rachunek: 'Numer   konta :', etykieta_razem: 'Łącznie:', pozostale: 'Dzięki  za zamówienie.' }))).statusCode).toBe(303);
    expect(JSON.parse(wierszZdan())).toEqual({ etykieta_rachunek: 'Numer konta', etykieta_razem: 'Łącznie', pozostale: 'Dzięki za zamówienie.' });
    const m = await wyslijFakture(zamowienieZFaktura());
    expect(m.text).toContain(`\n  Numer konta: ${RACHUNEK}\n`);
    expect(m.text).not.toContain('::');
    // Z bazy (z pominięciem formularza) — ten sam wynik.
    wpiszDoBazy({ etykieta_rachunek: 'Konto:' });
    expect((await wyslijFakture(zamowienieZFaktura())).text).toContain(`\n  Konto: ${RACHUNEK}\n`);
  });

  it('W2: kolizja po normalizacji i z domyślną etykietą innego wiersza, także zamiana Rachunek↔Tytuł → 400; z bazy → domyślne', async () => {
    await odmowy([
      { etykieta_rachunek: 'Tytuł-przelewu' }, { etykieta_odbiorca: 'TYTUŁ PRZELEWU!' }, { etykieta_termin: 'Rachunek' },
      { etykieta_rachunek: 'Tytuł przelewu', etykieta_tytul: 'Rachunek' }, { etykieta_odbiorca: 'Konto', etykieta_termin: 'K o n t o' },
    ]);
    wpiszDoBazy({ etykieta_rachunek: 'Tytuł przelewu', etykieta_tytul: 'Rachunek' });
    const m = await wyslijFakture(zamowienieZFaktura());
    expect(m.text).toContain(DOMYSLNY_PRZELEW);
    expect(m.text).toMatch(/\n {2}Tytuł przelewu: FV/u);
  });

  it('W2: etykieta tylko z liter łacińskich — cyrylickie „а”/„о” (homoglify) → 400; z bazy → domyślne', async () => {
    await odmowy([{ etykieta_rachunek: 'Rаchunek' }, { etykieta_tytul: 'Kоnto' }, { kolumna_cena: 'Цена' }]);
    // Polskie litery to pismo łacińskie.
    expect((await post(ZAPIS, formularz({ etykieta_rachunek: 'Rachunek bankowy — źródło' }))).statusCode).toBe(303);
    wpiszDoBazy({ etykieta_rachunek: 'Rаchunek' });
    expect((await wyslijFakture(zamowienieZFaktura())).text).toContain(DOMYSLNY_PRZELEW);
  });

  it('W3a: ciąg 6+ cyfr w etykiecie (także ze spacjami i myślnikami) → 400; z bazy → domyślne', async () => {
    await odmowy([
      { etykieta_tytul: 'Konto 12 3456 7890' }, { etykieta_odbiorca: 'Wpłać 123-456' }, { pozdrowienie: 'Tel. 600 100 200' }, { kolumna_pozycja: '123456' },
    ]);
    expect((await post(ZAPIS, formularz({ etykieta_termin: 'Termin 14 dni' }))).statusCode).toBe(303);
    wpiszDoBazy({ etykieta_odbiorca: 'Konto 11 2222 3333' });
    const m = await wyslijFakture(zamowienieZFaktura());
    expect(m.text).toContain('\n  Odbiorca: Pracownia Przykładowa\n');
    expect(m.text).not.toContain('2222 3333\n  Rachunek');
  });

  it('W3b: „netto”, „bez VAT”, „net” przy kwocie, sumie, cenie i wartości → 400; z bazy → domyślne', async () => {
    await odmowy([
      { dopisek_brutto: 'netto' }, { dopisek_brutto: 'bez VAT' }, { dopisek_brutto: 'NET' }, { etykieta_razem: 'Razem netto' },
      { kolumna_cena: 'Cena bezVAT' }, { kolumna_wartosc: 'Wartość net' },
    ]);
    expect((await post(ZAPIS, formularz({ dopisek_brutto: 'z VAT', kolumna_cena: 'Cena' }))).statusCode).toBe(303);
    wpiszDoBazy({ dopisek_brutto: 'netto' });
    expect((await wyslijFakture(zamowienieZFaktura())).text).toContain('\n  476,00 zł brutto\n');
  });

  it('D2: „Tak — wystawimy na:” ≠ „Nie” po normalizacji, „Nie” nie zaczyna się od „tak” → 400; z bazy → domyślne', async () => {
    await odmowy([{ faktura_tak: 'nie!' }, { faktura_nie: 'Tak, ale później' }, { faktura_tak: 'Bez faktury', faktura_nie: 'bez-faktury' }]);
    wpiszDoBazy({ faktura_nie: 'Tak' });
    const id = zapiszZamowienie(db, 'pro', zamowienie({ zrodlo_id: 6200, numer: '6200' }));
    const m = await wyslij(id, 'potwierdzenie');
    expect(m.text).toContain('\n\nFAKTURA\n  Nie\n');
  });

  it('D4: odrzucone zdanie trafia do logu raz na zmianę zapisu, nie przy każdym mailu', async () => {
    const linie = () => console.error.mock.calls.map((a) => a.join(' ')).filter((l) => l.includes('nie przechodzi reguł'));
    wpiszDoBazy({ etykieta_rachunek: 'Konto {x}' });
    await wyslijFakture(zamowienieZFaktura());
    await wyslijFakture(zamowienieZFaktura());
    await get(`/zamowienia/${zamowienieZFaktura()}?wiadomosc=faktura`);
    expect(linie()).toHaveLength(1);
    wpiszDoBazy({ etykieta_rachunek: 'Konto {y}' });
    await wyslijFakture(zamowienieZFaktura());
    expect(linie()).toHaveLength(2);
  });

  it('D5: błąd kolizji tylko przy polach zmienionych w formularzu; obie zmienione — przy obu', async () => {
    const jedna = await post(ZAPIS, formularz({ etykieta_rachunek: 'Termin' }));
    expect(jedna.statusCode).toBe(400);
    expect(bladPola(jedna.body, 'etykieta_rachunek')).toContain('muszą się różnić');
    expect(bladPola(jedna.body, 'etykieta_termin')).toBe('');
    const obie = await post(ZAPIS, formularz({ etykieta_rachunek: 'Konto', etykieta_termin: 'konto' }));
    expect(obie.statusCode).toBe(400);
    expect(bladPola(obie.body, 'etykieta_rachunek')).toContain('muszą się różnić');
    expect(bladPola(obie.body, 'etykieta_termin')).toContain('muszą się różnić');
    expect(bladPola(obie.body, 'etykieta_tytul')).toBe('');
  });
});

describe('bez uprawnienia „ustawienia"', () => {
  beforeEach(() => { for (const m of ['log', 'error', 'warn', 'info']) vi.spyOn(console, m).mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('zapis etykiety i „Przywróć domyślne" = 403, nic nie zapisane; administrator może', async () => {
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

    expect((await postJako(p.app, ZAPIS, ewa, formularz({ etykieta_rachunek: 'Konto' }))).statusCode).toBe(403);
    expect(wiersz()).toBeNull();
    expect((await postJako(p.app, ZAPIS, admin, formularz({ etykieta_rachunek: 'Konto' }))).statusCode).toBe(303);
    expect((await postJako(p.app, przywroc('etykieta_rachunek'), ewa)).statusCode).toBe(403);
    expect(JSON.parse(wiersz())).toEqual({ etykieta_rachunek: 'Konto' });
  });
});
