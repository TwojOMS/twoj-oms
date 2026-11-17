import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Socket } from 'node:net';
import dns from 'node:dns/promises';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { zbudujOms } from '../../src/oms/bootstrap.ts';
import { zapiszZamowienie } from '../../src/oms/db/zamowienia.js';

// Mutant wracający do OMS_SPRZEDAWCA_* dla adresu ma zepsuć rzeczywiste PDF-y.
// D05 i frozen: dane prawne OMS pozostają oddzielne; wszystkie dokumenty
// korzystają z adresu DPD_NADAWCA_*, również gdy kurier nie jest aktywny.
const env = {
  OMS_TRYB: 'produkcja', OMS_SPRZEDAWCA_NIP: '1234563218',
  OMS_RACHUNEK: '34109010140000000000000000', OMS_USER: 'operator', OMS_PASS: 'fixture',
  OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir(),
  DPD_NADAWCA_NAZWA: 'Firma testowa Żółw', DPD_NADAWCA_ULICA: 'Testowa 1',
  DPD_NADAWCA_KOD: '00-001', DPD_NADAWCA_MIASTO: 'Miasto',
};
const auth = { authorization: 'Basic ' + Buffer.from('operator:fixture').toString('base64') };
let polaczenia: string[];
beforeEach(() => {
  polaczenia = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { polaczenia.push('fetch'); throw Error('Sieć zabroniona'); });
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => { polaczenia.push('socket'); throw Error('Sieć zabroniona'); });
  vi.spyOn(dns, 'lookup').mockImplementation(async () => { polaczenia.push('dns'); throw Error('DNS zabroniony'); });
});
afterEach(() => { vi.restoreAllMocks(); expect(polaczenia).toEqual([]); });

it.each([
  { wariant: 'brak dodatkowej rodziny', metoda: 'GET' as const },
  { wariant: 'brak dodatkowej rodziny', metoda: 'POST' as const },
  { wariant: 'konflikt dodatkowej rodziny', metoda: 'GET' as const },
  { wariant: 'konflikt dodatkowej rodziny', metoda: 'POST' as const },
])('$wariant / $metoda: PDF bierze ten sam adres co faktury', async ({ wariant, metoda }) => {
  const dodatkowe = wariant === 'konflikt dodatkowej rodziny' ? {
    OMS_SPRZEDAWCA_NAZWA: 'Niewłaściwa firma', OMS_SPRZEDAWCA_ULICA: 'Niewłaściwa 2',
    OMS_SPRZEDAWCA_KOD: '99-999', OMS_SPRZEDAWCA_MIASTO: 'Inne miasto', OMS_SPRZEDAWCA_KRAJ: 'DE',
  } : {};
  const a = await zbudujOms({ env: { ...env, ...dodatkowe } });
  try {
    const id = zapiszZamowienie(a.db, 'reczne', {
      zrodlo_id: 1, numer: 'ADRES-FIXTURE', klient: { email: 'klient@fixture.invalid' },
      dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
      kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00', oplacone_at: null, anulowane: 0,
      utworzone_at: '2026-01-01T12:00:00Z', status_woo: 'processing',
      pozycje: [{ nazwa: 'Towar', sku: 'FIXTURE', ilosc: 1, cena_brutto: '123.00', brutto_linii: '123.00', vat: null }],
    }, {});
    const request = metoda === 'GET'
      ? { method: metoda, url: `/zamowienia/${id}/specyfikacja.pdf`, headers: auth }
      : { method: metoda, url: '/zamowienia/specyfikacje.pdf', headers: { ...auth, origin: 'http://localhost' }, payload: { id: [String(id)] } };
      const r = await a.app.inject(request);
      expect(r.statusCode, r.statusCode === 200 ? request.url : r.body).toBe(200);
      expect(r.headers['content-type']).toContain('application/pdf');
      const pdf = await PDFDocument.load(r.rawPayload);
      expect(pdf.getAuthor()).toBe('Firma testowa Żółw');
      expect(pdf.getPageCount()).toBe(1);
    const faktury = a.usluga<any>('faktury', 'config');
    expect(faktury.nadawca).toMatchObject({ nazwa: 'Firma testowa Żółw', ulica: 'Testowa 1', kod: '00-001', miasto: 'Miasto', kraj: 'PL' });
    expect(a.usluga<any>('zamowienia', 'config').nadawca).toMatchObject({ nazwa: 'Firma testowa Żółw', ulica: 'Testowa 1', kod: '00-001', miasto: 'Miasto', kraj: 'PL' });
  } finally { await a.app.close(); a.db.close(); }
});
