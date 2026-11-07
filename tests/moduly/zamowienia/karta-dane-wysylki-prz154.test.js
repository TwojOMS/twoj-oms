import { it, expect, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

let app, db;
afterEach(async () => { await app?.close(); db?.close(); });
async function karta({ kraj = 'PL', punkt = false } = {}) {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'x' } }, poller: { stan: () => ({}) } });
  await app.ready();
  const id = zapiszZamowienie(db, 'pro', {
    zrodlo_id: 15407, numer: 'DEMO-15407', klient: { first_name: 'Ewa', last_name: 'Próbna', email: 'ewa@example.test' },
    dostawa: { first_name: 'Ewa', last_name: 'Próbna', company: 'Pracownia Półcień', address_1: 'Przykładowa 7', postcode: '00-000', city: 'Miasto', country: kraj },
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, oplacone_at: null, kwota_brutto: '50.00', koszt_dostawy_brutto: '0.00',
    status_woo: 'processing', anulowane: 0, utworzone_at: '2026-11-06T10:00:00Z', pozycje: [],
  }, {});
  if (punkt) db.prepare('UPDATE zamowienia SET punkt_odbioru = ?, punkt_odbioru_opis = ? WHERE id = ?').run('TST01M', 'Przy sklepie próbnym', id);
  const r = await app.inject({ url: `/zamowienia/${id}`, headers: { authorization: 'Basic ' + Buffer.from('operator:x').toString('base64') } });
  expect(r.statusCode).toBe(200);
  return { html: r.body, wysylka: r.body.match(/<section[^>]*id="wysylka"[\s\S]*?<\/section>/u)[0] };
}

it.each(['PL', 'DE'])('wysyłka %s ma etykiety jak faktura i pełną nazwę obcego kraju', async (kraj) => {
  const { wysylka } = await karta({ kraj });
  expect(wysylka).toContain('<dl class="dane">');
  for (const etykieta of ['Odbiorca', 'Adres', 'Telefon', 'E-mail']) expect(wysylka).toContain(`<dt>${etykieta}</dt>`);
  expect(wysylka).toContain('<strong>Ewa Próbna</strong>');
  expect(wysylka).toContain('Pracownia Półcień');
  expect(wysylka).toMatch(/<dt>Telefon<\/dt><dd>—<\/dd>/u);
  expect(wysylka).not.toMatch(/brak telefonu|Skopiuj do faktury|>PL</iu);
  expect(wysylka.includes('Niemcy')).toBe(kraj === 'DE');
});

it('punkt zastępuje adres w wysyłce, znika ze Szczegółów, adres klienta jest zwinięty', async () => {
  const { html, wysylka } = await karta({ punkt: true });
  expect(wysylka).toContain('<dt>Punkt odbioru</dt>');
  expect(wysylka).toContain('<strong>TST01M</strong>');
  expect(wysylka).toContain('Przy sklepie próbnym');
  expect(wysylka).not.toContain('<dt>Adres</dt>');
  expect(wysylka).toMatch(/<details class="drobne"><summary>Adres klienta[^<]*<\/summary>[\s\S]*?Przykładowa 7[\s\S]*?<\/details>/u);
  expect(html.replace(wysylka, '')).not.toMatch(/<(?:dt|span)>Punkt odbioru<\//u);
});
