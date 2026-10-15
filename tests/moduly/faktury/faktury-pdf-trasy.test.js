import { describe, it, expect } from 'vitest';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';

const PDF = Buffer.from('%PDF-1.4 test');
const AUTH = { authorization: `Basic ${Buffer.from('t:h').toString('base64')}` };

function serwer(infakt) {
  return buildOmsServer({
    db: openOmsDb(':memory:'), config: { auth: { user: 't', pass: 'h' } },
    infakt, fakturyWidok: { dokumenty: async () => [], nieoplacone: async () => [], proformy: () => [] },
  });
}

describe('GET /faktury/:uuid/pdf', () => {
  it('faktura VAT idzie po zasób /invoices/', async () => {
    let wolane = null;
    const app = serwer({ pobierzPdf: async (u) => { wolane = ['vat', u]; return PDF; }, pobierzPdfKorekty: async () => { throw new Error('nie ten zasób'); } });
    const r = await app.inject({ method: 'GET', url: '/faktury/u1/pdf?rodzaj=vat&numer=1%2F08%2F2026', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(wolane).toEqual(['vat', 'u1']);
  });

  // ⚠️ KOREKTA TO INNY ZASÓB — ten sam uuid pod /invoices/ oddaje 404 (sprawdzone 2026-08-01).
  // Rozstrzyga JAWNY parametr, nigdy zgadywanie po napisie „KOR" w numerze: numer generuje
  // ktoś inny i wolno mu zmienić format bez uprzedzenia.
  it('korekta idzie po zasób /corrective_invoices/', async () => {
    let wolane = null;
    const app = serwer({ pobierzPdf: async () => { throw new Error('nie ten zasób'); }, pobierzPdfKorekty: async (u) => { wolane = ['korekta', u]; return PDF; } });
    const r = await app.inject({ method: 'GET', url: '/faktury/k1/pdf?rodzaj=korekta&numer=1%2FKOR%2F08%2F2026', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(wolane).toEqual(['korekta', 'k1']);
  });

  // Numer faktury ma ukośniki, na Windowsie w nazwie pliku nielegalne — a stamtąd plik
  // jedzie prosto do drukarki.
  it('nazwa pliku nie ma ukośników', async () => {
    const app = serwer({ pobierzPdf: async () => PDF, pobierzPdfKorekty: async () => PDF });
    const r = await app.inject({ method: 'GET', url: '/faktury/u1/pdf?rodzaj=vat&numer=1%2F08%2F2026', headers: AUTH });
    expect(r.headers['content-disposition']).toContain('attachment');
    expect(r.headers['content-disposition']).not.toContain('/');
  });

  // ⚠️ BIALA LISTA, A NIE „wszystko, co nie jest korekta" (recenzja Zadania 8). Do tej pory
  // literowka w adresie (`?rodzaj=vt`) albo nowy, nieznany rodzaj dokumentu z inFaktu jechal
  // po zasob /invoices/ i konczyl sie surowym 404 z API — czyli komunikatem o cudzym systemie
  // zamiast zdaniem, ktore operator rozumie. Ta sama zasada, co przy `pole` w tym samym pliku
  // i przy `POLA_DATY` w services/faktury-widok.js: nazwa spoza listy ma ODMOWIC, nie zgadnac.
  it('nieznany rodzaj dokumentu odmawia czytelnie i NIE pyta inFaktu', async () => {
    let pytano = false;
    const app = serwer({
      pobierzPdf: async () => { pytano = true; return PDF; },
      pobierzPdfKorekty: async () => { pytano = true; return PDF; },
    });
    const r = await app.inject({ method: 'GET', url: '/faktury/u1/pdf?rodzaj=vt', headers: AUTH });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/rodzaj dokumentu/i);
    expect(pytano).toBe(false);
  });

  it('brak rodzaju w adresie też odmawia, zamiast zgadywać fakturę VAT', async () => {
    const app = serwer({ pobierzPdf: async () => PDF, pobierzPdfKorekty: async () => PDF });
    const r = await app.inject({ method: 'GET', url: '/faktury/u1/pdf', headers: AUTH });
    expect(r.statusCode).toBe(400);
  });

  it('awaria inFaktu daje 400 z komunikatem, nie 500', async () => {
    const app = serwer({ pobierzPdf: async () => { throw new Error('inFakt odrzucił pobranie PDF (404)'); }, pobierzPdfKorekty: async () => PDF });
    const r = await app.inject({ method: 'GET', url: '/faktury/u1/pdf?rodzaj=vat', headers: AUTH });
    expect(r.statusCode).toBe(400);
  });
});
