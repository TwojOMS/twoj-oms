import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';

const env = { OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_SPRZEDAWCA_NIP: '1234563218',
  OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: tmpdir(),
  OMS_ETYKIETY_KATALOG: tmpdir(), INFAKT_API_KEY: 'fixture-key' };
const headers = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}` };
async function pdf(stron: number) {
  const d = await PDFDocument.create();
  for (let i=0; i<stron; i++) d.addPage([200,200]).drawText(`fixture-${i}`);
  return Buffer.from(await d.save());
}
const faktura = { uuid: 'u-faktura', id: 1, number: '1/08/2026', kind: 'vat',
  invoice_date: '2026-08-05', sale_date: '2026-08-05', net_price: 10000, tax_price: 2300,
  gross_price: 12300, currency: 'PLN', client_company_name: 'Fixture', client_tax_code: '1', ksef_number: 'KS-1' };
const korekta = { ...faktura, uuid: 'u-korekta', id: 2, number: 'KOR/08/2026', kind: 'correction',
  net_price: -1000, tax_price: -230, gross_price: -1230, ksef_number: 'KS-2' };

describe('PRZ-025 paczka kosztów przez przyjęte trasy faktur', () => {
  it('HTTP zbuduj scala zestawienie, fakturę i korektę prawdziwymi bajtami PDF', async () => {
    const infakt = { listaFaktur: vi.fn().mockResolvedValue([faktura]), listaKorekt: vi.fn().mockResolvedValue([korekta]),
      pobierzPdf: vi.fn().mockResolvedValue(await pdf(2)), pobierzPdfKorekty: vi.fn().mockResolvedValue(await pdf(1)) };
    const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
    const z = await zbudujOms({ env, nadpisania: { 'faktury.infakt': infakt } });
    try {
      const r = await z.app.inject({ method:'GET',url:'/faktury/paczka?miesiac=2026-08&czesc=sprzedaz',headers });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain('application/pdf');
      expect(r.headers['content-disposition']).toContain('paczka-dla-biura-2026-08-sprzedaz.pdf');
      expect((await PDFDocument.load(r.rawPayload)).getPageCount()).toBe(4);
      expect(infakt.listaFaktur).toHaveBeenCalledWith({od:'2026-08-01',do:'2026-08-31',pole:'sale_date'});
      expect(infakt.listaKorekt).toHaveBeenCalledWith({od:'2026-08-01',do:'2026-08-31',pole:'invoice_date'});
      expect(infakt.pobierzPdf).toHaveBeenCalledTimes(1);
      expect(infakt.pobierzPdf).toHaveBeenCalledWith('u-faktura');
      expect(infakt.pobierzPdfKorekty).toHaveBeenCalledTimes(1);
      expect(infakt.pobierzPdfKorekty).toHaveBeenCalledWith('u-korekta');
      expect(transport).not.toHaveBeenCalled();
    } finally { await z.app.close(); z.db.close(); transport.mockRestore(); }
  });
  it('HTTP zestawienie listuje dokumenty i nie pobiera ich PDF-ów', async () => {
    const infakt = { listaFaktur: vi.fn().mockResolvedValue([faktura]), listaKorekt: vi.fn().mockResolvedValue([korekta]),
      pobierzPdf: vi.fn(), pobierzPdfKorekty: vi.fn() };
    const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
    const z = await zbudujOms({ env, nadpisania: { 'faktury.infakt': infakt } });
    try {
      const r = await z.app.inject({method:'GET',url:'/faktury/zestawienie-przychodow?miesiac=2026-08',headers});
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-disposition']).toContain('zestawienie-przychodow-2026-08.pdf');
      const dokument = await PDFDocument.load(r.rawPayload);
      expect(dokument.getPageCount()).toBe(1);
      expect(dokument.getTitle()).toBe('Zestawienie przychodów — sierpień 2026');
      expect(infakt.listaFaktur).toHaveBeenCalledTimes(1);
      expect(infakt.listaKorekt).toHaveBeenCalledTimes(1);
      expect(infakt.pobierzPdf).not.toHaveBeenCalled();
      expect(infakt.pobierzPdfKorekty).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    } finally { await z.app.close(); z.db.close(); transport.mockRestore(); }
  });
});
