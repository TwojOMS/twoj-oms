// PRZ-148.03 — zwrot z kosztem dostawy przy fakturze bez pozycji „Dostawa”: karta zamówienia i ekran zwrotu pokazują
// przycisk „Wystaw korektę” WYŁĄCZONY ze zdaniem z domeny (powodOdmowyKorektyBezDostawy), zamiast przycisku, który
// prowadził na goły tekst odmowy z POST korekty. Pełna aplikacja, atrapa programu w nadpisaniach, zero sieci. Dane zmyślone.
import { describe, it, expect, vi } from 'vitest';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajZwrot } from '../../../src/oms/db/zwroty.js';

const env = { OMS_DB_PATH: ':memory:', OMS_SPRZEDAWCA_NIP: '1234563218',
  OMS_RACHUNEK: '34109010140000000000000000', OMS_USER: 'operator', OMS_PASS: 'test',
  OMS_PROFORMY_KATALOG: '.', OMS_ETYKIETY_KATALOG: '.' };
const headers = { authorization: 'Basic ' + Buffer.from('operator:test').toString('base64'), origin: 'http://localhost' };

const ZDANIE = 'Zwrot obejmuje 19.00 zł dostawy, a faktura FV 8/11/2026 nie ma pozycji „Dostawa&#34;'
  + ' — korekty nie da się złożyć. Wystaw ją ręcznie w inFakcie.';

const atrapa = (nazwaDostawy) => ({
  pobierzFakture: vi.fn().mockResolvedValue({ uuid: 'polcien-fv8', number: 'FV 8/11/2026', invoice_date: '2026-11-02',
    services: [{ name: 'Lampa Półcień', quantity: 2, gross_price: 25800, tax_symbol: '23' },
      { name: nazwaDostawy, quantity: 1, gross_price: 1900, tax_symbol: '23' }] }),
  wystawKorekte: vi.fn().mockResolvedValue({ referencja: 'REF-POLCIEN-8', uuid: null, numer: null }),
  listaKorekt: vi.fn().mockResolvedValue([]),
});

function zamowienieZeZwrotem(db, { kwotaDostawy = '19.00' } = {}) {
  const id = zapiszZamowienie(db, 'reczne', { zrodlo_id: 8001, numer: '8001', klient: null,
    dostawa: null, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1,
    nip: null, kwota_brutto: '277.00', koszt_dostawy_brutto: '19.00', status_woo: 'processing',
    oplacone_at: null, anulowane: 0, utworzone_at: '2026-11-01T12:00:00',
    pozycje: [{ zrodlo_id: 81, nazwa: 'Lampa Półcień', sku: 'LAMPA-P8', ilosc: 2,
      cena_brutto: '129.00', brutto_linii: '258.00', vat: null }] }, {});
  db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
    .run(id, 'polcien-fv8', 'FV 8/11/2026', '2026-11-02T12:00:00Z');
  const zwrotId = dodajZwrot(db, id, { data: '2026-11-03', kwota: '129.00', kwotaDostawy,
    pozycje: [{ klucz_pozycji: 's81', nazwa: 'Lampa Półcień', ilosc: 1, kwota: '129.00' }] }).id;
  return { id, zwrotId };
}

async function zAplikacja(program, dzialanie) {
  const siec = vi.fn(() => { throw new Error('Sieć zabroniona w PRZ-148.03'); });
  vi.stubGlobal('fetch', siec);
  let a;
  try {
    a = await zbudujOms({ env, nadpisania: { 'faktury.infakt': program } });
    await dzialanie(a);
    expect(siec).not.toHaveBeenCalled();
  } finally { if (a) { await a.app.close(); a.db.close(); } vi.unstubAllGlobals(); }
}
const pobierz = async (a, url) => {
  const r = await a.app.inject({ method: 'GET', url, headers });
  expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
  return r.body;
};
const formularz = (id, zwrotId) => `action="/zamowienia/${id}/zwroty/${zwrotId}/korekta"`;
const WYLACZONY = /<button type="button" class="btn btn--maly" disabled[^>]*>Wystaw korektę<\/button>/u;

describe('PRZ-148.03 karta zamówienia: zwrot z dostawą, faktura bez pozycji „Dostawa”', () => {
  it('przycisk wyłączony ze zdaniem z domeny, bez formularza POST', async () => {
    const program = atrapa('Wysyłka');
    await zAplikacja(program, async (a) => {
      const { id, zwrotId } = zamowienieZeZwrotem(a.db);
      const html = await pobierz(a, `/zamowienia/${id}`);
      expect(html).not.toContain(formularz(id, zwrotId));
      expect(html).toMatch(WYLACZONY);
      expect(html).toContain(ZDANIE);
      expect(program.pobierzFakture).toHaveBeenCalledWith('polcien-fv8');
    });
  });

  it('faktura z pozycją „Dostawa” — przycisk działa jak dotąd', async () => {
    await zAplikacja(atrapa('Dostawa'), async (a) => {
      const { id, zwrotId } = zamowienieZeZwrotem(a.db);
      const html = await pobierz(a, `/zamowienia/${id}`);
      expect(html).toContain(formularz(id, zwrotId));
      expect(html).not.toMatch(WYLACZONY);
    });
  });

  it('zwrot bez dostawy — karta nie pyta programu o fakturę', async () => {
    const program = atrapa('Wysyłka');
    await zAplikacja(program, async (a) => {
      const { id, zwrotId } = zamowienieZeZwrotem(a.db, { kwotaDostawy: null });
      expect(await pobierz(a, `/zamowienia/${id}`)).toContain(formularz(id, zwrotId));
      expect(program.pobierzFakture).not.toHaveBeenCalled();
    });
  });

  it('błąd odczytu faktury nie kładzie karty — przycisk zostaje (odmowę da dopiero usługa)', async () => {
    const program = atrapa('Wysyłka');
    program.pobierzFakture.mockRejectedValue(new Error('program nieosiągalny'));
    await zAplikacja(program, async (a) => {
      const { id, zwrotId } = zamowienieZeZwrotem(a.db);
      expect(await pobierz(a, `/zamowienia/${id}`)).toContain(formularz(id, zwrotId));
    });
  });
});

describe('PRZ-148.03 ekran zwrotu: zwrot z dostawą, faktura bez pozycji „Dostawa”', () => {
  it('przycisk wyłączony ze zdaniem z domeny, bez formularza POST', async () => {
    await zAplikacja(atrapa('Wysyłka'), async (a) => {
      const { id, zwrotId } = zamowienieZeZwrotem(a.db);
      const html = await pobierz(a, `/zamowienia/${id}/zwrot`);
      expect(html).not.toContain(formularz(id, zwrotId));
      expect(html).toMatch(WYLACZONY);
      expect(html).toContain(ZDANIE);
    });
  });

  it('faktura z pozycją „Dostawa” — przycisk działa jak dotąd', async () => {
    await zAplikacja(atrapa('Dostawa'), async (a) => {
      const { id, zwrotId } = zamowienieZeZwrotem(a.db);
      const html = await pobierz(a, `/zamowienia/${id}/zwrot`);
      expect(html).toContain(formularz(id, zwrotId));
      expect(html).not.toMatch(WYLACZONY);
    });
  });
});
