// PRZ-122.TFe: przypadki wspólne przeniesione z tests/moduly/koszty/paczka-zaznaczone-prz122.test.js; asercje bez zmian.
// PRZ-122.B13d1: zestawienie ZAZNACZONYCH faktur — z listy uuid (lista FAKTURY, jeden miesiąc) jeden PDF zbudowany jak
// zestawienie faktur za okres: strona zestawienia, potem PDF-y dokumentów, przy TwojeFaktury XML i UPO jako załączniki.
// Dane zmyślone; inFakt na atrapie, TwojeFaktury w trybie próby — żadne żądanie nie wychodzi do sieci.
import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFString, PDFHexString } from 'pdf-lib';
import PDFKit from 'pdfkit';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { createPaczkaDlaBiura, MAX_ZAZNACZONYCH } from '../../../src/moduly/koszty/services/paczka-dla-biura.js';
import { zbudujZestawieniePdf } from '../../../src/moduly/koszty/pdf/zestawienie-dla-biura-pdf.js';

async function pdfZ(stron, tekst = 'x') {
  const d = await PDFDocument.create();
  for (let i = 0; i < stron; i += 1) d.addPage([200, 200]).drawText(`${tekst} ${i}`, { x: 10, y: 100, size: 12 });
  return Buffer.from(await d.save());
}
const f = (n = {}) => ({
  uuid: 'u1', id: 1, number: '1/08/2026', kind: 'vat', invoice_date: '2026-08-05', sale_date: '2026-08-05',
  net_price: 10000, tax_price: 2300, gross_price: 12300, currency: 'PLN', client_company_name: 'Pracownia Półcień',
  client_tax_code: '4534240685', ksef_number: 'KS', ...n,
});
const TRZY = [f(), f({ uuid: 'u2', id: 2, number: '2/08/2026' }), f({ uuid: 'u3', id: 3, number: '3/08/2026' })];
const infaktAtrapa = (n = {}) => ({
  pobrane: [],
  zakresy: [],
  async listaFaktur(z) { this.zakresy.push(['f', z]); return TRZY; },
  async listaKorekt(z) { this.zakresy.push(['k', z]); return []; },
  async pobierzPdf(uuid) { this.pobrane.push(uuid); return pdfZ(2, `faktura ${uuid}`); },
  async pobierzPdfKorekty(uuid) { this.pobrane.push(uuid); return pdfZ(1, 'korekta'); },
  ...n,
});
const teraz = () => new Date('2026-09-02T10:00:00Z');

describe('zestawienie zaznaczonych faktur — inFakt (PRZ-122.B13d1)', () => {
  it('2 z 3 faktur miesiąca: zestawienie z 2 wierszami, potem 2 dokumenty, stopka = liczba stron pliku, tytuł', async () => {
    const inf = infaktAtrapa();
    const wolania = [];
    const zbudujZestawienie = (a) => { wolania.push(a); return zbudujZestawieniePdf(a); };
    const rysowanie = vi.spyOn(PDFKit.prototype, 'text');
    let w; let napisy;
    try {
      w = await createPaczkaDlaBiura({ db: openOmsDb(), infakt: inf, teraz, zbudujZestawienie })
        .zbudujZaznaczone({ uuids: ['u3', 'u1'], miesiac: '2026-08', pole: 'sale_date' });
      napisy = rysowanie.mock.calls.map(([t]) => t).filter((t) => typeof t === 'string');
    } finally { rysowanie.mockRestore(); }

    expect(w.nazwa).toBe('zestawienie-faktur-2026-08-zaznaczone.pdf');
    expect(w.dokumentow).toBe(2);
    expect(inf.pobrane).toEqual(['u1', 'u3']);
    const ostatnie = wolania.at(-1);
    expect(ostatnie.paczka.sprzedaz.map((r) => r.numer)).toEqual(['1/08/2026', '3/08/2026']);
    expect(ostatnie.tytul).toBe('Zestawienie zaznaczonych faktur');
    expect(ostatnie.kryterium).toBe('faktury zaznaczone na liście FAKTURY');
    const doc = await PDFDocument.load(w.bajty);
    const stronZestawienia = (await PDFDocument.load(await zbudujZestawieniePdf(ostatnie))).getPageCount();
    expect(doc.getPageCount()).toBe(stronZestawienia + 2 * 2);
    expect(w.stron).toBe(doc.getPageCount());
    expect(ostatnie.liczbaStron).toBe(doc.getPageCount());
    expect(doc.getTitle()).toBe('Zestawienie zaznaczonych faktur — 2026-08');
    expect(napisy.some((t) => t.startsWith('Zestawienie zaznaczonych faktur — sierpień 2026'))).toBe(true);
    expect(napisy.some((t) => t.startsWith('Kryterium: faktury zaznaczone na liście FAKTURY.'))).toBe(true);
    // Listy z tym samym polem daty, co lista FAKTURY, z której przyszło zaznaczenie.
    expect(inf.zakresy).toEqual([
      ['f', { od: '2026-08-01', do: '2026-08-31', pole: 'sale_date' }],
      ['k', { od: '2026-08-01', do: '2026-08-31', pole: 'sale_date' }],
    ]);
  });

  it('uuid podany kilka razy (także z odstępami) = jeden dokument', async () => {
    const inf = infaktAtrapa();
    const w = await createPaczkaDlaBiura({ db: openOmsDb(), infakt: inf, teraz })
      .zbudujZaznaczone({ uuids: ['u2', 'u2', ' u2 '], miesiac: '2026-08', pole: 'invoice_date' });
    expect(w.dokumentow).toBe(1);
    expect(inf.pobrane).toEqual(['u2']);
  });

  it('pojedynczy uuid jako napis (jedno pole wyboru) działa jak lista', async () => {
    const inf = infaktAtrapa();
    const w = await createPaczkaDlaBiura({ db: openOmsDb(), infakt: inf, teraz })
      .zbudujZaznaczone({ uuids: 'u1', miesiac: '2026-08', pole: 'invoice_date' });
    expect(w.dokumentow).toBe(1);
  });

  it('uuid spoza miesiąca = odmowa z identyfikatorem, żaden PDF nie pobrany', async () => {
    const inf = infaktAtrapa();
    const e = await createPaczkaDlaBiura({ db: openOmsDb(), infakt: inf, teraz })
      .zbudujZaznaczone({ uuids: ['u1', 'obcy-7c1e'], miesiac: '2026-08', pole: 'invoice_date' })
      .then(() => null, (b) => b);
    expect(e).toMatchObject({ dlaOperatora: true });
    expect(e.message).toContain('obcy-7c1e');
    expect(e.message).not.toContain('1/08/2026');
    expect(inf.pobrane).toEqual([]);
  });

  it(`${MAX_ZAZNACZONYCH + 1} uuid = odmowa przed jakimkolwiek pytaniem do programu`, async () => {
    expect(MAX_ZAZNACZONYCH).toBe(100);
    const duzo = Array.from({ length: MAX_ZAZNACZONYCH + 1 }, (_, i) => `u${i + 1}`);
    const inf = infaktAtrapa({ listaFaktur: async () => duzo.map((uuid, i) => f({ uuid, id: i + 1, number: `${i + 1}/08/2026` })) });
    await expect(createPaczkaDlaBiura({ db: openOmsDb(), infakt: inf, teraz })
      .zbudujZaznaczone({ uuids: duzo, miesiac: '2026-08', pole: 'invoice_date' }))
      .rejects.toMatchObject({ dlaOperatora: true, message: expect.stringContaining(String(MAX_ZAZNACZONYCH)) });
    expect(inf.pobrane).toEqual([]);
  });

  it('nic nie zaznaczone, zły miesiąc, złe pole = odmowa bez pytania programu', async () => {
    const inf = infaktAtrapa();
    const p = createPaczkaDlaBiura({ db: openOmsDb(), infakt: inf, teraz });
    await expect(p.zbudujZaznaczone({ uuids: [], miesiac: '2026-08', pole: 'invoice_date' }))
      .rejects.toMatchObject({ dlaOperatora: true, message: 'Zaznacz co najmniej jedną fakturę.' });
    await expect(p.zbudujZaznaczone({ uuids: ['  '], miesiac: '2026-08', pole: 'invoice_date' }))
      .rejects.toMatchObject({ dlaOperatora: true });
    await expect(p.zbudujZaznaczone({ uuids: ['u1'], miesiac: 'sierpien', pole: 'invoice_date' }))
      .rejects.toMatchObject({ dlaOperatora: true });
    await expect(p.zbudujZaznaczone({ uuids: ['u1'], miesiac: '2026-08', pole: 'payment_date' }))
      .rejects.toMatchObject({ dlaOperatora: true });
    expect(inf.zakresy).toEqual([]);
  });
});

