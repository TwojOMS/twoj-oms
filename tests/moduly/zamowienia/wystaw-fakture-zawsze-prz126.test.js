import { afterEach, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';
import { zapiszFakturaDlaKazdego } from '../../../src/moduly/faktury/db/faktury-dla-kazdego.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { jako } from '../../pomoc/konta-prz068.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const headers = { authorization: 'Basic ' + Buffer.from('operator:fixture').toString('base64'), origin: 'http://localhost' };
const panele = [];
afterEach(async () => { for (const p of panele.splice(0)) { await p.app.close(); p.db.close(); } });
const powody = {
  anulowane: 'Zamówienie jest anulowane — aby wystawić fakturę, najpierw wyjaśnij anulowanie zamówienia.',
  okres: 'Zamówienie rozlicza się fakturą zbiorczą — otwórz <a href="/okresy/1">okres październik 2026</a>, aby wystawić fakturę za cały okres.',
  program: 'inFakt nie jest skonfigurowany — administrator może skonfigurować program w <a href="/ustawienia/integracje/infakt">Ustawienia → Integracje → inFakt</a>.',
  rola: 'Twoje konto nie ma prawa wystawiać faktur — poproś administratora o dostęp do wystawiania faktur.',
  // PRZ-152.G10e: „Ustawienia → Faktury” jest odnośnikiem dla konta z prawem do ekranu ustawień (tekst bez zmian).
  prosba: 'Klient nie prosił o fakturę. Administrator może to włączyć w <a href="/ustawienia/faktury/zasady">Ustawienia → Faktury</a> („faktura także bez prośby klienta”).',
};
const PROSBA_BEZ_LINKU = 'Klient nie prosił o fakturę. Administrator może to włączyć w Ustawienia → Faktury („faktura także bez prośby klienta”).';
async function panel(o = {}) {
  const db = openOmsDb(':memory:');
  if (o.rola) zalozKonto(db, { login: 'pakowacz-test', imie: 'Pakowacz', haslo: 'fixture', rola: 'produkcja', ekrany: ['zamowienia'] });
  if (o.sprzedaz) zalozKonto(db, { login: 'sprzedawca-test', imie: 'Sprzedawca', haslo: 'fixture', rola: 'sprzedaz' });
  const infakt = { znajdzKlientaPoNip: vi.fn().mockResolvedValue(null), zalozKlienta: vi.fn().mockResolvedValue(555),
    wystaw: vi.fn().mockResolvedValue({ uuid: 'fixture-p1', numer: 'FV/P1', ksefStatus: null }) };
  const app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'fixture' } },
    poller: { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) },
    faktura: o.program === false ? null : createFaktura({ db, infakt }), ...(o.programOpis ? { infakt: o.programOpis } : {}) });
  panele.push({ app, db });
  await app.ready();
  const id = zapiszZamowienie(db, 'reczne', { zrodlo_id: 12601, numer: 'P1-12601',
    klient: { first_name: 'Anna', last_name: 'Przykładowa', address_1: 'Fikcyjna 1', postcode: '00-001', city: 'Miasto Testowe', ...o.klient },
    dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, nip: null, status_woo: 'processing', oplacone_at: null,
    kwota_brutto: '129.00', koszt_dostawy_brutto: '0.00',
    chce_fakture: o.prosba === false ? 0 : 1, anulowane: o.anulowane ? 1 : 0, utworzone_at: '2026-10-28T10:00:00',
    pozycje: [{ nazwa: 'Produkt testowy', sku: 'P1', ilosc: 1, cena_brutto: '129.00', vat: null }] }, {});
  if (o.dlaKazdego) zapiszFakturaDlaKazdego(db, true);
  if (o.okres) {
    db.prepare("INSERT INTO okresy_rozliczeniowe (klient_klucz,rok,miesiac,stan,utworzony_at) VALUES ('test-p1',2026,10,'otwarty','2026-10-01')").run();
    db.prepare('UPDATE zamowienia SET okres_rozliczeniowy_id=1 WHERE id=?').run(id);
    if (o.fakturaOkresu) db.prepare("UPDATE okresy_rozliczeniowe SET infakt_uuid='fixture-okres', numer='FZ/P1', stan='zafakturowany' WHERE id=1").run();
  }
  if (o.faktura) db.prepare("INSERT INTO faktury (zamowienie_id,infakt_uuid,numer,utworzona_at) VALUES (?,'fixture-p1','FV/P1','2026-10-29')").run(id);
  let h = headers;
  if (o.rola) {
    h = { ...jako(db, 'pakowacz-test'), origin: headers.origin };
  }
  if (o.sprzedaz) h = { ...jako(db, 'sprzedawca-test'), origin: headers.origin };
  const get = () => app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: h });
  const post = () => app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura`, headers: h });
  return { db, app, id, infakt, get, post };
}
const przycisk = (html) => html.match(/<button\b[^>]*>Wystaw fakturę<\/button>/)?.[0];
const tekst = (html) => html.replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

it.each([
  ['anulowane', { anulowane: true, okres: true, program: false, prosba: false }],
  ['okres', { okres: true, program: false, prosba: false }],
  ['program', { program: false, rola: true, prosba: false }],
  ['rola', { rola: true, prosba: false }],
  ['prosba', { prosba: false, klient: { first_name: '', last_name: '' } }],
])('%s: przycisk disabled z jednym widocznym powodem i bez pól', async (powod, opcje) => {
  const p = await panel(opcje);
  const r = await p.get();
  expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
  expect(przycisk(r.body)).toContain('disabled');
  // PRZ-152.G10e: wygląd nieaktywnego przycisku z `.btn:disabled` (layout-oms.ejs), bez stylu w linii.
  expect(przycisk(r.body)).not.toContain('style=');
  expect(przycisk(r.body)).toContain('aria-describedby="powod-wystawienia-faktury"');
  expect(tekst(r.body)).toContain(`<p class="wyjasnienie" id="powod-wystawienia-faktury">${powody[powod]}</p>`);
  expect(tekst(r.body).split(powody[powod])).toHaveLength(2);
  expect(r.body).not.toContain('id="wystaw-fakture"');
});
// PRZ-126.PT5: do 03.11 ten test sprawdzał, że brak adresu NIE blokuje (aktywny przycisk, faktura
// wystawiona). Od PT5 adres nabywcy jest wymagany (art. 106e ust. 1 pkt 3) — test sprawdza odmowę.
// Pełny zestaw przypadków: tests/moduly/zamowienia/adres-nabywcy-wymagany-pt.test.js.
it('bez adresu: prośba klienta daje szary przycisk z powodem, a POST odmawia bez faktury i bez programu', async () => {
  const p = await panel({ klient: { address_1: '', postcode: '', city: '' } });
  const r = await p.get();
  expect(r.statusCode).toBe(200);
  expect(przycisk(r.body)).toContain('disabled');
  expect(r.body).toContain('<p class="wyjasnienie" id="powod-wystawienia-faktury">Brak adresu nabywcy (ulica, kod pocztowy, miasto) — '
    + '<a href="#dane-faktury">uzupełnij dane do faktury</a>.</p>');
  const post = await p.post();
  expect(post.statusCode).toBe(400);
  expect(post.body).toContain('Brak adresu nabywcy (ulica, kod pocztowy, miasto).');
  expect(p.db.prepare('SELECT count(*) AS n FROM faktury WHERE zamowienie_id=?').get(p.id).n).toBe(0);
  expect(p.infakt.wystaw).not.toHaveBeenCalled();
});
it.each([false, true])('okres z fakturą: dokładnie jedno zdanie, link do Faktur zależy od uprawnień (ograniczona rola=%s)', async (rola) => {
  const p = await panel({ okres: true, fakturaOkresu: true, rola });
  const r = await p.get();
  expect(r.statusCode).toBe(200);
  expect(przycisk(r.body)).toContain('disabled');
  const zdanie = 'Faktura za okres jest już wystawiona — do KSeF wysyłasz ją z zakładki '
    + (rola ? 'Faktury.' : '<a href="/faktury">Faktury</a>.');
  expect(r.body).toContain(`<p class="wyjasnienie" id="powod-wystawienia-faktury">${zdanie}</p>`);
  expect(r.body.match(/(?:Faktura okresu|Faktura za okres)/g)).toHaveLength(1);
  expect(r.body).not.toContain('<p class="pasek-uwaga">Faktura');
  expect(r.body).not.toContain('aby wystawić fakturę za cały okres');
});
it.each([{ }, { prosba: false, dlaKazdego: true }])('można: aktywny przycisk, formularz i brak zdania %j', async (opcje) => {
  const r = await (await panel(opcje)).get();
  expect(r.statusCode).toBe(200);
  expect(przycisk(r.body)).toBeDefined();
  expect(przycisk(r.body)).not.toContain('disabled');
  expect(r.body).toContain('id="wystaw-fakture"');
  expect(r.body).not.toContain('id="powod-wystawienia-faktury"');
});
it('istniejąca faktura: brak przycisku i zdania', async () => {
  const r = await (await panel({ faktura: true })).get();
  expect(r.statusCode).toBe(200);
  expect(przycisk(r.body)).toBeUndefined();
  expect(r.body).not.toContain('id="powod-wystawienia-faktury"');
});
it('PRZ-152.G10e: konto bez prawa do Ustawień widzi ten sam tekst powodu, bez odnośnika', async () => {
  const r = await (await panel({ prosba: false, sprzedaz: true, klient: { first_name: '', last_name: '' } })).get();
  expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
  expect(przycisk(r.body)).toContain('disabled');
  expect(tekst(r.body)).toContain(`<p class="wyjasnienie" id="powod-wystawienia-faktury">${PROSBA_BEZ_LINKU}</p>`);
  expect(r.body).not.toContain('href="/ustawienia/faktury/zasady"');
});
it('TwojeFaktury: brak prośby wyjaśnia kolejność ustawień KSeF', async () => {
  const r = await (await panel({ prosba: false, programOpis: { opis: { id: 'twojefaktury', wbudowany: true,
    nazwa: { mianownik: 'TwojeFaktury', miejscownik: 'TwojeFaktury' } } } })).get();
  expect(r.statusCode).toBe(200);
  expect(przycisk(r.body)).toContain('disabled');
  expect(tekst(r.body)).toContain('przy TwojeFaktury najpierw „Faktury konsumenckie w KSeF”');
});
it('POST nadal odmawia bez prośby i opcji: 400, brak faktury w bazie, brak wywołania programu', async () => {
  const p = await panel({ prosba: false });
  const r = await p.post();
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('Klient nie prosił o fakturę.');
  expect(p.db.prepare('SELECT count(*) AS n FROM faktury WHERE zamowienie_id=?').get(p.id).n).toBe(0);
  expect(p.infakt.wystaw).not.toHaveBeenCalled();
});
