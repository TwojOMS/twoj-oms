import { describe, it, expect } from 'vitest';
import { buildOmsServer } from '../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { csvZaznaczonych } from '../../src/domena/eksport-faktur-csv.js';

const auth = { authorization: `Basic ${Buffer.from('t:h').toString('base64')}` };
const rows = [
  { uuid: 'a', number: '1/08', invoice_date: '2026-08-01', rodzaj: 'vat', client_company_name: 'Pracownia Półcień', client_tax_code: '1234563218', net_price: 3, tax_price: 0, gross_price: 3, kwotaZl: '0.03', stanZaplaty: 'zaplacona', stanKsef: 'jest', ksef_number: 'KS-1' },
  { uuid: 'b', number: '2/08', invoice_date: '2026-08-02', rodzaj: 'vat', client_company_name: '=Przykład', net_price: 100, tax_price: 23, gross_price: 123, kwotaZl: '1.23', stanZaplaty: 'nieznany', stanKsef: 'brak' },
];

describe('CSV zaznaczonych faktur', () => {
  it.each(['=', '+', '-', '@'])('zabezpiecza tekst nabywcy zaczynający się od %s', (znak) => {
    expect(csvZaznaczonych([{ ...rows[0], client_company_name: `${znak}nazwa;"x"` }]))
      .toContain(`"'${znak}nazwa;""x"""`);
  });
  it('przepisuje kwoty z listy i zabezpiecza komórki arkusza', async () => {
    const db = openOmsDb(':memory:');
    const app = buildOmsServer({ db, config: { auth: { user: 't', pass: 'h' } }, fakturyWidok: {
      dokumenty: async () => rows, nieoplacone: async () => [], proformy: () => [],
    } });
    try {
      const html = await app.inject({ method: 'GET', url: '/faktury?miesiac=2026-08&pole=invoice_date', headers: auth });
      const csv = await app.inject({ method: 'POST', url: '/faktury/lista-zaznaczonych.csv', headers: { ...auth, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' }, payload: 'miesiac=2026-08&pole=invoice_date&uuid=a&uuid=b' });
      expect(csv.statusCode).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv; charset=utf-8');
      expect(csv.headers['content-disposition']).toBe('attachment; filename="lista-faktur-2026-08-zaznaczone.csv"');
      expect(html.body).toContain('formaction="/faktury/lista-zaznaczonych.csv"');
      expect(csv.body.startsWith('\ufeff')).toBe(true);
      const lines = csv.body.slice(1).split('\r\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('Netto;VAT;Brutto');
      expect(lines[1]).toContain('0,03;0,00;0,03');
      expect(lines[2]).toContain('1,00;0,23;1,23');
      expect(lines[2]).toContain("'=Przykład");
      for (const row of rows) expect(html.body).toContain(`${row.kwotaZl.replace('.', ',')} zł`);
      expect(lines[1]).toContain('Pracownia Półcień');
    } finally { await app.close(); db.close(); }
  });

  it('zabezpiecza tabulator na początku tekstu, a kwot ujemnych korekty nie rusza', () => {
    const csv = csvZaznaczonych([{ ...rows[0], rodzaj: 'korekta', client_company_name: '\tTab', net_price: -100, tax_price: -23, gross_price: -123 }]);
    expect(csv).toContain("'\tTab");
    expect(csv).toContain(';-1,00;-0,23;-1,23;');
  });

  const serwer = (dokumenty) => buildOmsServer({ db: openOmsDb(':memory:'), config: { auth: { user: 't', pass: 'h' } }, fakturyWidok: { dokumenty, nieoplacone: async () => [], proformy: () => [] } });
  const post = (app, payload) => app.inject({ method: 'POST', url: '/faktury/lista-zaznaczonych.csv', headers: { ...auth, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' }, payload });

  it('eksportuje tylko zaznaczone dokumenty, nie cały miesiąc', async () => {
    const app = serwer(async () => rows);
    try {
      const r = await post(app, 'miesiac=2026-08&pole=invoice_date&uuid=b');
      expect(r.statusCode).toBe(200);
      const lines = r.body.slice(1).split('\r\n');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('2/08');
    } finally { await app.close(); }
  });

  it('odmawia ponad 100 dokumentów, nawet gdy wszystkie są na liście miesiąca', async () => {
    const duzo = Array.from({ length: 101 }, (_, i) => ({ ...rows[1], uuid: `u${i}`, number: `${i}/08` }));
    const app = serwer(async () => duzo);
    try {
      const r = await post(app, `miesiac=2026-08&pole=invoice_date&${duzo.map((d) => `uuid=${d.uuid}`).join('&')}`);
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain('najwyżej 100 dokumentów');
    } finally { await app.close(); }
  });

  it('błąd techniczny listy nie udaje odmowy operatora', async () => {
    const app = serwer(async () => { throw new Error('ECONNRESET program faktur'); });
    try {
      const r = await post(app, 'miesiac=2026-08&pole=invoice_date&uuid=a');
      expect(r.statusCode).toBe(500);
      expect(r.body).not.toContain('Nie udało się przygotować zestawienia faktur');
    } finally { await app.close(); }
  });

  it('odmawia dokumentu spoza listy i błędnego miesiąca w układzie panelu', async () => {
    const db = openOmsDb(':memory:');
    const app = buildOmsServer({ db, config: { auth: { user: 't', pass: 'h' } }, fakturyWidok: { dokumenty: async () => rows, nieoplacone: async () => [], proformy: () => [] } });
    try {
      for (const payload of ['miesiac=2026-08&pole=invoice_date&uuid=obcy', 'miesiac=zly&pole=invoice_date&uuid=a', `miesiac=2026-08&pole=invoice_date&${Array.from({ length: 101 }, (_, i) => `uuid=${i}`).join('&')}`]) {
        const r = await app.inject({ method: 'POST', url: '/faktury/lista-zaznaczonych.csv', headers: { ...auth, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' }, payload });
        expect(r.statusCode).toBe(400);
        expect(r.headers['content-type']).toContain('text/html');
        expect(r.body).toContain('<main');
        expect(r.body).toContain('Nie udało się przygotować zestawienia faktur');
      }
    } finally { await app.close(); db.close(); }
  });
});
