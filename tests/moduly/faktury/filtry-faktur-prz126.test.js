import { it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createFakturyWidok } from '../../../src/moduly/faktury/services/faktury-widok.js';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { jako } from '../../pomoc/konta-prz068.js';
import { createPaczkaDlaBiura } from '../../../src/moduly/koszty/services/paczka-dla-biura.js';
import { sumaListy } from '../../../src/domena/lista-faktur.js';

it('zbudujZestawieniePrzychodow i lista mają tę samą sumę brutto miesiąca bez zamian', async () => {
  const dokumenty = [
    { rodzaj: 'vat', gross_price: 13400, net_price: 10895, tax_price: 2505 },
    { rodzaj: 'vat', gross_price: 17700, net_price: 14391, tax_price: 3309 },
    { rodzaj: 'korekta', gross_price: -8400, net_price: -6830, tax_price: -1570 },
  ];
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const bajty = await pdf.save();
  const sumy = [];
  const usluga = createPaczkaDlaBiura({ db: null, infakt: {
    listaFaktur: async () => dokumenty.slice(0, 2), listaKorekt: async () => dokumenty.slice(2),
  }, zbudujZestawienie: ({ paczka }) => { sumy.push(paczka.sumy.sprzedaz.PLN.bruttoGr); return bajty; } });
  await usluga.zbudujZestawieniePrzychodow('2026-10');
  expect(sumy).toEqual([22700, 22700]);
  expect(sumaListy(dokumenty).PLN.bruttoGr).toBe(sumy[0]);
});

it('GET filtruje widoczne dokumenty i sumę, zachowuje filtry w zaznaczeniu i POST', async () => {
  const db = openOmsDb(':memory:');
  const dokument = (uuid, rodzaj, gross_price, net_price, reszta = {}) => ({
    uuid, number: uuid, rodzaj, gross_price, net_price, tax_price: gross_price - net_price,
    invoice_date: '2026-10-12', ...reszta,
  });
  const fakturyWidok = createFakturyWidok({ db, infakt: {
    listaFaktur: async () => [dokument('VAT-DLUG', 'vat', 13400, 10895, { left_to_pay: 100 }),
      dokument('VAT-PAID', 'vat', 17700, 14391, { status: 'paid' }),
      dokument('VAT-STARA', 'vat', 10000, 8130, { zastapiona_przez: 'nowa' })],
    listaKorekt: async () => [dokument('KOR-MINUS', 'korekta', -8400, -6830)],
    listaNieoplaconych: async () => [],
  } });
  const app = buildOmsServer({ db, config: { auth: { user: 'test', pass: 'fikcyjne' } },
    fakturyWidok, czuwaczArchiwumSprzedazy: { przebieg: async () => ({ pominiety: true, powod: 'test' }) } });
  try {
    await app.ready();
    zalozKonto(db, { login: 'test', imie: 'Test', haslo: 'fikcyjne', rola: 'sprzedaz', admin: true });
    ustawUprawnienia(db, kontoPoLoginie(db, 'test').id, ['faktury']);
    const headers = { ...jako(db, 'test'), origin: 'http://localhost' };
    const get = async (query) => {
      const r = await app.inject({ url: `/faktury?miesiac=2026-10&${query}`, headers });
      expect(r.statusCode).toBe(200);
      return r.body;
    };
    const korekty = await get('typ=korekta');
    expect(korekty).toContain('KOR-MINUS');
    expect(korekty).not.toContain('VAT-DLUG');
    expect(korekty).toContain('netto -68,30 zł · brutto -84,00 zł');
    const dlug = await get('platnosc=niezaplacona');
    expect(dlug).toContain('VAT-DLUG');
    expect(dlug).not.toContain('VAT-PAID');
    expect(dlug).not.toContain('VAT-STARA');
    expect(dlug).not.toContain('KOR-MINUS');
    const html = await get('typ=korekta&platnosc=niezaplacona');
    expect(html).toMatch(/name="typ"[\s\S]*value="korekta" selected/);
    expect(html).toMatch(/name="platnosc"[\s\S]*value="niezaplacona" selected/);
    expect(html).toContain('typ=korekta&amp;platnosc=niezaplacona&amp;zaznacz=1');
    expect(html).toContain('name="typ" value="korekta"');
    expect(html).toContain('name="platnosc" value="niezaplacona"');
    expect(html).toContain('Razem 0 dokumentów');
    const zazn = await get('typ=vat&platnosc=niezaplacona&zaznacz=1');
    expect(zazn).toMatch(/value="VAT-DLUG"[^>]*checked/);
    expect(zazn).toContain('typ=vat&amp;platnosc=niezaplacona');
    const wszystkie = await get('typ=xyz&platnosc=xyz');
    expect(wszystkie).toContain('VAT-DLUG');
    expect(wszystkie).toContain('KOR-MINUS');
    const post = await app.inject({ method: 'POST', url: '/faktury/archiwum/uruchom', headers,
      payload: { miesiac: '2026-10', pole: 'invoice_date', typ: 'korekta', platnosc: 'niezaplacona' } });
    expect(post.statusCode).toBe(303);
    expect(post.headers.location).toContain('typ=korekta&platnosc=niezaplacona');
    console.info('Dowód /faktury?typ=korekta&platnosc=niezaplacona:\n'
      + [...html.matchAll(/<select name="(?:typ|platnosc)">[\s\S]*?<\/select>|<tfoot>[\s\S]*?<\/tfoot>/g)]
        .map(([fragment]) => fragment).join('\n'));
  } finally { await app.close(); db.close(); }
});
