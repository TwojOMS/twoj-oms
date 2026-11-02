// PRZ-122.TFe: przypadki wspólne przeniesione z tests/moduly/koszty/paczka-twojefaktury-prz122.test.js; asercje bez zmian.
import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFRawStream, PDFString, PDFHexString, decodePDFRawStream } from 'pdf-lib';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createModulKoszty } from '../../../src/moduly/koszty/modul.ts';
import { createPaczkaDlaBiura } from '../../../src/moduly/koszty/services/paczka-dla-biura.js';
const teraz = () => new Date('2026-10-28T02:10:00Z');
function zalaczniki(pdf) {
  const wynik = {};
  const names = pdf.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const ef = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  const tablica = ef?.lookupMaybe(PDFName.of('Names'), PDFArray);
  if (!tablica) return wynik;
  for (let i = 0; i < tablica.size(); i += 2) {
    const nazwa = tablica.lookup(i, PDFString, PDFHexString).decodeText();
    const spec = tablica.lookup(i + 1, PDFDict);
    const strumien = spec.lookup(PDFName.of('EF'), PDFDict).lookup(PDFName.of('F'), PDFRawStream);
    wynik[nazwa] = Buffer.from(decodePDFRawStream(strumien).decode());
  }
  return wynik;
}

describe('paczka dla biura — inFakt', () => {
  it('inFakt: paczka bez załączników, także gdy baza ma wysyłki TwojeFaktury', async () => {
    const pdf = async () => { const d = await PDFDocument.create(); d.addPage([200, 200]); return Buffer.from(await d.save()); };
    const f = { uuid: 'u1', id: 1, number: '5/10/2026', kind: 'vat', invoice_date: '2026-10-05', sale_date: '2026-10-05',
      net_price: 10000, tax_price: 2300, gross_price: 12300, currency: 'PLN', client_company_name: 'Lampy Kowalczyk sp. z o.o.',
      client_tax_code: '1234500011', ksef_number: 'KS' };
    const infakt = { listaFaktur: async () => [f], listaKorekt: async () => [], pobierzPdf: pdf, pobierzPdfKorekty: pdf };
    const w = await createPaczkaDlaBiura({ db: openOmsDb(), infakt, teraz }).zbuduj('2026-10', 'sprzedaz');
    expect(zalaczniki(await PDFDocument.load(w.bajty))).toEqual({});
  });
});

describe('katalog archiwum sprzedaży paczki (moduł kosztów)', () => {
  const katalog = (e, wbudowany) => {
    let dostal = null;
    const modul = createModulKoszty({ fabryki: { createPaczkaDlaBiuraFn: (a) => { dostal = a; return {}; } } });
    const program = { opis: wbudowany ? { wbudowany: true } : {}, listaFaktur: async () => [] };
    const db = openOmsDb();
    try {
      modul.zbuduj({ db, konfiguracja: modul.konfiguracja({ OMS_SPRZEDAWCA_NIP: '1234563218', ...e }), teraz, log: () => {},
        usluga: (m, n) => ({ 'faktury.infakt': program, 'faktury.programFakturowy': program })[`${m}.${n}`] });
    } finally { db.close(); }
    return dostal.katalogSprzedazy;
  };
  it.each([
    ['wbudowany wybiera OMS_ARCHIWUM_SPRZEDAZY', { OMS_ARCHIWUM_SPRZEDAZY: '/oms', INFAKT_ARCHIWUM: '/infakt' }, true, '/oms'],
    ['wbudowany bez niej — INFAKT_ARCHIWUM', { INFAKT_ARCHIWUM: '/infakt' }, true, '/infakt'],
    ['wbudowany bez obu — null', {}, true, null],
    ['inFakt zachowuje INFAKT_ARCHIWUM', { OMS_ARCHIWUM_SPRZEDAZY: '/oms', INFAKT_ARCHIWUM: '/infakt' }, false, '/infakt'],
    ['inFakt bez INFAKT_ARCHIWUM — null', { OMS_ARCHIWUM_SPRZEDAZY: '/oms' }, false, null],
  ])('%s', (_opis, e, wbudowany, oczekiwany) => {
    expect(katalog(e, wbudowany)).toBe(oczekiwany);
  });
});
