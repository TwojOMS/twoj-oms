import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeXML } from 'ejs';
import { CONFIG, BASIC, post, get } from '../../pomoc/konta-prz068.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { bladOperatora } from '../../../src/domena/bledy.js';
import { GDZIE_KLUCZ_INFAKTU } from '../../../src/domena/konfiguracja-infakt.js';
import { zapewnijOkres, zamknijOkres } from '../../../src/oms/db/okresy.js';
import { dopiszKlientaZbiorczego } from './_klient-zbiorczy-pomocniki.js';

const katalog = mkdtempSync(join(tmpdir(), 'oms-g13f1-'));
const POWOD = 'Pracownia Półcień: <odmowa> & "sprawdź".';
let p;
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Sieć zabroniona'); }); });
afterEach(async () => { await p?.app.close(); p?.db.close(); p = null; vi.restoreAllMocks(); });
afterAll(() => rmSync(katalog, { recursive: true, force: true }));

function panel(opcje = {}) {
  p = { db: openOmsDb(':memory:') };
  p.app = buildOmsServer({ db: p.db, config: { auth: CONFIG.auth,
    nadawca: { nazwa: 'Pracownia Półcień', ulica: 'Testowa 1', kod: '00-001', miasto: 'Warszawa', kraj: 'PL' },
    proforma: { nip: '1234563218' } },
    env: { OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog },
    faktura: null, fakturaHurtem: null, proforma: null, fakturaAllegro: null, infakt: null, ...opcje });
  p.db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, nip, kwota_brutto, klient_json, utworzone_at) VALUES ('reczne', 'g13f1', 'TEST/1', '1234500011', '100.00', ?, '2026-07-10T10:00:00.000Z')")
    .run(JSON.stringify({ company: 'Pracownia Półcień' }));
  return Number(p.db.prepare("SELECT id FROM zamowienia WHERE zrodlo_id = 'g13f1'").get().id);
}
const rzuc = () => { throw bladOperatora(POWOD); };

async function odmowa(url, status, tekst, wroc, metoda = 'POST') {
  const r = await (metoda === 'GET' ? get(p.app, url, BASIC) : post(p.app, url, BASIC));
  expect(r.statusCode).toBe(status);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toContain('<html');
  expect(r.body).toContain(`>${escapeXML(tekst)}</p>`);
  // Przycisk powrotu, nie link z menu (`/` i `/faktury` są w menu każdej strony).
  const href = escapeXML(wroc).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  expect(r.body).toMatch(new RegExp(`href="${href}"[^>]*>\\s*Wróć do `));
  expect(globalThis.fetch).not.toHaveBeenCalled();
  return r;
}

it('27 hurt: brak usługi, stały powrót na listę mimo obcego powrotu', async () => {
  panel();
  await odmowa('/zamowienia/faktury-hurtem?powrot=//obcy.test', 503,
    `Wystawianie faktur nie jest skonfigurowane (brak danych inFaktu). ${GDZIE_KLUCZ_INFAKTU}`, '/');
});

for (const [nr, koncowka, metoda] of [
  [28, 'potwierdzenie-wywozu.pdf', 'GET'], [30, 'okres', 'POST'], [33, 'proforma', 'POST'],
  [38, 'faktura', 'POST'], [40, 'faktura/odblokuj', 'POST'], [42, 'faktura/skasowana', 'POST'],
  [45, 'faktura-allegro', 'POST'],
]) {
  it(`${nr} ${koncowka}: brak zamówienia, powrót na listę`, async () => {
    panel();
    await odmowa(`/zamowienia/999999/${koncowka}`, 404, 'Nie ma takiego zamówienia', '/', metoda);
  });
}

it('29 PDF wywozu: odmowa modelu', async () => {
  const id = panel();
  await odmowa(`/zamowienia/${id}/potwierdzenie-wywozu.pdf`, 400,
    'Nie udało się przygotować potwierdzenia wywozu: Potwierdzenie wywozu dotyczy wyłącznie dostawy wewnątrzwspólnotowej (WDT) — nabywca tego zamówienia nie ma numeru VAT-UE innego państwa członkowskiego.', `/zamowienia/${id}`, 'GET');
});
it('31 okres: odmowa reguły', async () => {
  const id = panel();
  await odmowa(`/zamowienia/${id}/okres`, 400, 'NIP z tego zamówienia nie należy do żadnego klienta rozliczanego zbiorczo.', `/zamowienia/${id}`);
});
it('32 okres: odmowa usługi dla zamkniętego miesiąca', async () => {
  const id = panel();
  dopiszKlientaZbiorczego(p.db, { nazwa: 'Pracownia Półcień' });
  const okres = zapewnijOkres(p.db, { klientKlucz: 'przykladowa', rok: 2026, miesiac: 7 });
  zamknijOkres(p.db, okres.id);
  await odmowa(`/zamowienia/${id}/okres`, 400, 'Okres lipiec 2026 jest już rozliczony — zamówienie z tą datą złożenia wymaga Twojej decyzji (korekta faktury albo zmiana daty).', `/zamowienia/${id}`);
});

for (const [nr, koncowka, tekst] of [
  [34, 'proforma', 'Proformy nie są skonfigurowane.'],
  [39, 'faktura', `inFakt nie jest skonfigurowany. ${GDZIE_KLUCZ_INFAKTU}`],
  [46, 'faktura-allegro', 'Kanał Allegro nie jest skonfigurowany — faktury stąd nie wyślesz.'],
]) {
  it(`${nr} ${koncowka}: brak usługi`, async () => {
    const id = panel();
    await odmowa(`/zamowienia/${id}/${koncowka}`, 503, tekst, `/zamowienia/${id}`);
  });
}
it('35 proforma: komunikat operatora z ucieczką HTML', async () => {
  const id = panel({ proforma: { wystaw: rzuc } });
  await odmowa(`/zamowienia/${id}/proforma`, 400, `Nie udało się wystawić proformy: ${POWOD}`, `/zamowienia/${id}`);
});
it('36 PDF proformy: brak usługi, id dokumentu nie jest id zamówienia', async () => {
  panel();
  await odmowa('/proformy/777/pdf?powrot=//obcy.test', 503, 'Proformy nie są skonfigurowane.', '/faktury', 'GET');
});
it('37 PDF proformy: brak dokumentu, komunikat operatora', async () => {
  panel({ proforma: { pdf: rzuc } });
  await odmowa('/proformy/777/pdf', 404, POWOD, '/faktury', 'GET');
});
it('41 odblokowanie: brak faktury', async () => {
  const id = panel();
  await odmowa(`/zamowienia/${id}/faktura/odblokuj`, 400, 'Nie udało się odblokować faktury: To zamówienie nie ma zablokowanej faktury — nie ma czego odblokowywać.', `/zamowienia/${id}`);
});
it('43 skasowanie: odmowa programu wbudowanego', async () => {
  const id = panel({ infakt: { opis: { wbudowany: true, nazwa: { dopelniacz: 'TwojeFaktury' } } } });
  await odmowa(`/zamowienia/${id}/faktura/skasowana`, 400, 'Faktury TwojeFaktury nie da się skasować — są w bazie panelu. Błędny dokument popraw korektą.', `/zamowienia/${id}`);
});
it('44 skasowanie: brak faktury', async () => {
  const id = panel();
  await odmowa(`/zamowienia/${id}/faktura/skasowana`, 400, 'Nie udało się odnotować skasowania faktury: To zamówienie nie ma zablokowanej faktury — nie ma czego kasować.', `/zamowienia/${id}`);
});
it('47 Allegro: komunikat operatora z ucieczką HTML', async () => {
  const id = panel({ fakturaAllegro: { wyslij: rzuc } });
  await odmowa(`/zamowienia/${id}/faktura-allegro`, 400, `Nie udało się wysłać faktury do Allegro: ${POWOD}`, `/zamowienia/${id}`);
});

it('udany PDF proformy zachowuje bajty i nagłówki', async () => {
  const bajty = Buffer.from('%PDF-test');
  panel({ proforma: { pdf: () => ({ numer: 'PF/7', bajty }) } });
  const r = await get(p.app, '/proformy/777/pdf', BASIC);
  expect(r.statusCode).toBe(200);
  expect(r.headers['content-type']).toBe('application/pdf');
  expect(r.headers['content-disposition']).toBe('attachment; filename="proforma-PF_7.pdf"');
  expect(r.rawPayload).toEqual(bajty);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
