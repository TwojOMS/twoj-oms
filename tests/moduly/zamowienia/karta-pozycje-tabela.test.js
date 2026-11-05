import { it, expect, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { programTestowy } from '../../pomoc/program-testowy.js';
import { nettoWiersza } from '../../../src/domena/tabela-pozycji.js';

let app, db;
const headers = { authorization: 'Basic ' + Buffer.from('operator:x').toString('base64'), origin: 'http://localhost' };
const pozycja = { zrodlo_id: 41, nazwa: 'Lampa Półcień', sku: 'LP-41', ilosc: 2, cena_brutto: '61.50', cena_netto: '49.99', brutto_linii: '123.00', netto_linii: '99.98', vat: '23' };
async function panel({ kanal = 'pro', nip = null, zw = false } = {}) {
  db = openOmsDb(':memory:');
  const program = programTestowy({ id: 'twojefaktury' });
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'x' } },
    poller: { stan: () => ({}) }, ...(zw ? { infakt: { ...program, opis: { ...program.opis, wbudowany: true } } } : {}) });
  await app.ready();
  return zapiszZamowienie(db, kanal, { zrodlo_id: 123, numer: '123', klient: { first_name: 'Ewa', email: 'ewa@example.test' },
    dostawa: { city: 'Warszawa' }, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, kwota_brutto: '151.29', koszt_dostawy_brutto: '28.29', koszt_dostawy_netto: '23.00',
    status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-11-05T10:00:00', nip, pozycje: [pozycja, { ...pozycja, zrodlo_id: 42, nazwa: 'Klosz' }] }, {});
}
async function karta(id, edycja = true) {
  const r = await app.inject({ url: `/zamowienia/${id}${edycja ? '?edytuj=pozycje' : ''}`, headers });
  expect(r.statusCode).toBe(200);
  return r.body.slice(r.body.indexOf('id="pozycje"'), r.body.indexOf('id="przesylka"'));
}
const tabela = (html) => html.match(/<table[\s\S]*?<\/table>/u)?.[0];
const wiersze = (html) => [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gu)].map(m => m[0]);
afterEach(async () => { await app?.close(); db?.close(); });

it('odczyt bez usuniętych zachowuje HTML tabeli sprzed przebudowy', async () => {
  const id = await panel();
  expect(tabela(await karta(id, false))).toMatchSnapshot();
});

it.each(['pro', 'allegro'])('%s: osiem kolumn, równoległe pola i oddzielny wzór nowego wiersza', async (kanal) => {
  const id = await panel({ kanal });
  const html = await karta(id);
  const tab = tabela(html);
  expect([...tab.matchAll(/<th\b[^>]*>(.*?)<\/th>/gu)].map(m => m[1])).toEqual(['Ilość', 'Nazwa', 'SKU', 'Cena netto', 'Stawka VAT', 'Cena brutto', 'Suma', '×']);
  const rows = wiersze(tab).filter(r => r.includes('name="klucz"'));
  expect(rows).toHaveLength(4);
  for (const row of rows) {
    for (const pole of ['klucz', 'nazwa', 'sku', 'ilosc', 'cena_netto', 'vat', 'cena_brutto']) expect(row.match(new RegExp(`name="${pole}"`, 'g'))).toHaveLength(1);
  }
  const sklep = rows.find(r => r.includes('value="s41"'));
  expect(sklep).toMatch(/<tr data-pozycja[^>]*data-stawka="23"/u);
  expect(sklep).not.toContain('data-wiersz-pozycji');
  expect(sklep).not.toMatch(/<select[^>]*name="vat"/u);
  expect(sklep).toContain('name="usun" value="s41"');
  expect(sklep).toContain(`name="cena_netto" value="${nettoWiersza(pozycja, '23')}"`);
  expect(rows.filter(r => /<tr[^>]*data-wiersz-pozycji/u.test(r))).toHaveLength(1);
  expect(html).toContain('name="dodaj_wiersz" value="1"');
  // Enter w polu tabeli „klika” PIERWSZY przycisk formularza — musi to być zwykły zapis, nie „×” ani „Przywróć”.
  const formularz = html.match(/<form[^>]*class="formularz-pozycji"[\s\S]*?<\/form>/u)[0];
  expect(formularz.match(/<button\b[^>]*>/u)[0]).toMatch(/^<button type="submit"(?![^>]*\b(?:name|formaction)=)[^>]*>$/u);
  expect(html).toContain('Sumy przeliczą się po zapisie');
  expect(html).toContain('pozycje-wiersze.js');
  expect(html).not.toContain('suma-podglad.js');
  expect(html).not.toContain('class="nowa-pozycja"');
  expect(html).not.toContain('Dodaj pozycję');
  expect(html).toContain('Dodaj z magazynu');
});

it('WDT: nowy wiersz ma ukryty VAT zamiast listy', async () => {
  const id = await panel({ nip: 'DE123456789' });
  const row = wiersze(tabela(await karta(id))).find(r => /<tr[^>]*data-wiersz-pozycji/u.test(r));
  expect(row).toBeDefined();
  expect(row).not.toContain('<select');
  expect(row).toContain('type="hidden" name="vat" value=""');
});

it.each([false, true])('opcja zw w HTML pochodzi z programu: %s', async (zw) => {
  const id = await panel({ zw });
  const row = wiersze(tabela(await karta(id))).find(r => /<tr[^>]*data-wiersz-pozycji/u.test(r));
  expect(row).toBeDefined();
  expect(row.includes('<option value="zw">zw</option>')).toBe(zw);
});

it('usunięta pozycja z kontekstu ma nazwę i przywracanie; odczyt ma drobne zdanie', async () => {
  const id = await panel();
  const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/pozycje/s41/usun`, headers });
  expect(r.statusCode).toBe(303);
  const html = await karta(id);
  expect(html).toContain('Usunięte ręcznie:');
  expect(html).toContain('Lampa Półcień');
  expect(html).toContain(`action="/zamowienia/${id}/pozycje/s41/przywroc"`);
  expect(html).toContain('Przywróć ze sklepu');
  const odczyt = await karta(id, false);
  expect(odczyt).toContain('1 pozycja ze sklepu usunięta ręcznie');
  expect(odczyt).not.toContain('/s41/przywroc');
});
