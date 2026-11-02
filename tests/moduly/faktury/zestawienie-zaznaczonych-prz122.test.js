// PRZ-122.B13d1: POST /faktury/zestawienie-zaznaczonych — trasa cienka jak GET /faktury/paczka: parsuje body, woła
// usługę, oddaje bajty. Prawdziwy serwer, usługa na atrapie inFaktu (zero żądań sieciowych), dane zmyślone.
import { describe, it, expect, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { jako } from '../../pomoc/konta-prz068.js';
import { createPaczkaDlaBiura } from '../../../src/moduly/koszty/services/paczka-dla-biura.js';

const AUTH = { authorization: `Basic ${Buffer.from('t:h').toString('base64')}` };
const POST = { origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' };
const URL = '/faktury/zestawienie-zaznaczonych';

function serwer(opcje = {}) {
  const db = openOmsDb(':memory:');
  const app = buildOmsServer({
    db,
    config: { auth: { user: 't', pass: 'h' } },
    fakturyWidok: { dokumenty: async () => [], nieoplacone: async () => [], proformy: () => [] },
    ...opcje,
  });
  return { app, db };
}
const wyslij = (app, body, naglowki = AUTH) => app.inject({ method: 'POST', url: URL, headers: { ...naglowki, ...POST }, payload: body });

async function pdfZ(stron) {
  const d = await PDFDocument.create();
  for (let i = 0; i < stron; i += 1) d.addPage([200, 200]);
  return Buffer.from(await d.save());
}
const f = (uuid, nr) => ({ uuid, id: nr, number: `${nr}/08/2026`, kind: 'vat', invoice_date: '2026-08-05', sale_date: '2026-08-05',
  net_price: 10000, tax_price: 2300, gross_price: 12300, currency: 'PLN', client_company_name: 'Pracownia Półcień',
  client_tax_code: '4534240685', ksef_number: 'KS' });

describe('POST /faktury/zestawienie-zaznaczonych (PRZ-122.B13d1)', () => {
  it('200: jeden PDF z zaznaczonymi dokumentami, nazwa pliku z miesiącem', async () => {
    const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('sieć zabroniona'));
    const db = openOmsDb(':memory:');
    const infakt = { listaFaktur: vi.fn(async () => [f('u1', 1), f('u2', 2), f('u3', 3)]), listaKorekt: vi.fn(async () => []),
      pobierzPdf: vi.fn(async () => pdfZ(2)), pobierzPdfKorekty: vi.fn() };
    const paczkaDlaBiura = createPaczkaDlaBiura({ db, infakt, teraz: () => new Date('2026-09-02T10:00:00Z') });
    const { app } = serwer({ db, paczkaDlaBiura });
    try {
      const r = await wyslij(app, 'uuid=u1&uuid=u3&miesiac=2026-08&pole=invoice_date');
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain('application/pdf');
      expect(r.headers['content-disposition']).toBe('attachment; filename="zestawienie-faktur-2026-08-zaznaczone.pdf"');
      expect((await PDFDocument.load(r.rawPayload)).getTitle()).toBe('Zestawienie zaznaczonych faktur — 2026-08');
      expect(infakt.pobierzPdf.mock.calls.map(([u]) => u)).toEqual(['u1', 'u3']);
      expect(infakt.listaFaktur).toHaveBeenCalledWith({ od: '2026-08-01', do: '2026-08-31', pole: 'invoice_date' });
      expect(transport).not.toHaveBeenCalled();
    } finally { transport.mockRestore(); await app.close(); }
  });

  it('400: nic nie zaznaczone, zły pole, zły miesiąc — usługa nie wołana', async () => {
    const zbudujZaznaczone = vi.fn();
    const { app } = serwer({ paczkaDlaBiura: { zbuduj: vi.fn(), zbudujZaznaczone } });
    const pusto = await wyslij(app, 'miesiac=2026-08&pole=invoice_date');
    expect(pusto.statusCode).toBe(400);
    expect(pusto.body).toContain('Zaznacz co najmniej jedną fakturę.');
    expect((await wyslij(app, 'uuid=u1&miesiac=2026-08&pole=payment_date')).statusCode).toBe(400);
    expect((await wyslij(app, 'uuid=u1&miesiac=2026-08')).statusCode).toBe(400);
    expect((await wyslij(app, 'uuid=u1&miesiac=sierpien&pole=invoice_date')).statusCode).toBe(400);
    expect(zbudujZaznaczone).not.toHaveBeenCalled();
  });

  it.each([
    'miesiac=2026-08&pole=invoice_date',
    'uuid=u1&miesiac=2026-08&pole=%3Cscript%3Ezle%3C%2Fscript%3E',
    'uuid=u1&miesiac=%3Cscript%3Ezle%3C%2Fscript%3E&pole=invoice_date',
  ])('C07a: odmowa przed usługą ma układ panelu i escapowany opis: %s', async (body) => {
    const zbudujZaznaczone = vi.fn();
    const { app } = serwer({ paczkaDlaBiura: { zbudujZaznaczone } });
    const r = await wyslij(app, body);
    expect(r.statusCode).toBe(400);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('<main');
    expect(r.body).toContain('Nie udało się przygotować zestawienia faktur');
    expect(r.body).toContain('← Wróć do listy faktur');
    expect(r.body).not.toContain('<script>zle</script>');
    if (body.includes('%3Cscript')) expect(r.body).toContain('&lt;script&gt;zle&lt;/script&gt;');
    expect(zbudujZaznaczone).not.toHaveBeenCalled();
    await app.close();
  });

  it('odmowa usługi: dlaOperatora → 400, czekaNaKsef → 409', async () => {
    const odmowa = Object.assign(new Error('Zaznaczonych dokumentów nie ma na liście: x'), { dlaOperatora: true });
    const czeka = Object.assign(new Error('czeka na numer KSeF'), { dlaOperatora: true, status: 409, czekaNaKsef: true });
    const zbudujZaznaczone = vi.fn().mockRejectedValueOnce(odmowa).mockRejectedValueOnce(czeka);
    const { app } = serwer({ paczkaDlaBiura: { zbuduj: vi.fn(), zbudujZaznaczone } });
    const a = await wyslij(app, 'uuid=x&miesiac=2026-08&pole=invoice_date');
    expect(a.statusCode).toBe(400);
    expect(a.body).toContain('x');
    // Odmowa zwalnia zatrzask: drugie 409 to „czeka na KSeF” z usługi, nie „właśnie składane”.
    const b = await wyslij(app, 'uuid=x&miesiac=2026-08&pole=invoice_date');
    expect(b.statusCode).toBe(409);
    expect(b.body).not.toContain('właśnie składane');
    expect(zbudujZaznaczone).toHaveBeenCalledWith({ uuids: ['x'], miesiac: '2026-08', pole: 'invoice_date' });
  });

  it('503 bez usługi zestawienia', async () => {
    const { app } = serwer();
    expect((await wyslij(app, 'uuid=u1&miesiac=2026-08&pole=invoice_date')).statusCode).toBe(503);
  });

  it('409: drugie żądanie w trakcie składania (ten sam zatrzask co zestawienie za okres)', async () => {
    let odblokuj; let wystartowala;
    const wTrakcie = new Promise((res) => { odblokuj = res; });
    const wStarcie = new Promise((res) => { wystartowala = res; });
    const zbudujZaznaczone = vi.fn(async () => { wystartowala(); await wTrakcie; return { bajty: Buffer.from('%PDF-1.4 z'), nazwa: 'z.pdf' }; });
    const zbuduj = vi.fn(async () => ({ bajty: Buffer.from('%PDF-1.4 p'), nazwa: 'p.pdf' }));
    const { app } = serwer({ paczkaDlaBiura: { zbuduj, zbudujZaznaczone } });
    const pierwsze = wyslij(app, 'uuid=u1&miesiac=2026-08&pole=invoice_date');
    await wStarcie;
    const drugie = await wyslij(app, 'uuid=u2&miesiac=2026-08&pole=invoice_date');
    expect(drugie.statusCode).toBe(409);
    expect(drugie.body).toContain('Zestawienie faktur jest właśnie składane');
    expect((await app.inject({ method: 'GET', url: '/faktury/paczka?miesiac=2026-08&czesc=sprzedaz', headers: AUTH })).statusCode).toBe(409);
    odblokuj();
    expect((await pierwsze).statusCode).toBe(200);
    expect(zbudujZaznaczone).toHaveBeenCalledTimes(1);
    expect(zbuduj).not.toHaveBeenCalled();
    expect((await wyslij(app, 'uuid=u1&miesiac=2026-08&pole=invoice_date')).statusCode).toBe(200);
  });

  it('403: konto bez prawa do FAKTUR (strażnik), usługa nie wołana', async () => {
    const zbudujZaznaczone = vi.fn();
    const { app, db } = serwer({ paczkaDlaBiura: { zbuduj: vi.fn(), zbudujZaznaczone } });
    zalozKonto(db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
    ustawUprawnienia(db, kontoPoLoginie(db, 'ewa').id, ['zamowienia']);
    const r = await wyslij(app, 'uuid=u1&miesiac=2026-08&pole=invoice_date', jako(db, 'ewa'));
    expect(r.statusCode).toBe(403);
    expect(zbudujZaznaczone).not.toHaveBeenCalled();
  });
});
