import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { pobierzZamowienie, oznaczWyslane, zapiszFaktyStatusu } from '../../../src/oms/db/zamowienia.js';
import { faktyDlaStatusu } from '../../../src/domena/status-reczny.js';

// Odczyt dla pollera wysylki w panelu indywidualnym: karta ma przejsc na „Wyslane",
// gdy zamowienie w OMS-ie dostanie `wyslane_at`. Klucz to ID ZAMOWIENIA (jak /dostawa),
// bo tor auto nie ma `karta_id` po stronie OMS-u — trasa po karcie oddawalaby 404
// dokladnie tym zamowieniom, ktorych ta funkcja dotyczy najczesciej.
const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
const naglowki = {
  authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'),
  origin: 'http://localhost',
  host: 'localhost',
};

const cialo = {
  kartaId: 'karta-abc',
  klient: { first_name: 'Jan', last_name: 'Kowalski', email: 'jan@example.com', phone: '500900008' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Długa 45', postcode: '30-001', city: 'Kraków' },
  nip: null, chceFakture: false,
  kosztDostawyBrutto: '19.00',
  pozycje: [{ nazwa: 'Szablon malarski — logo 70x100cm', ilosc: 1, cena_brutto: '250.00' }],
  uwagi: 'Zamówienie indywidualne — karta karta-abc',
};

let db;
let app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config });
  await app.ready();
});

async function zalozZamowienie() {
  const res = await app.inject({ method: 'POST', url: '/api/zamowienia-z-karty', headers: naglowki, payload: cialo });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe('GET /api/zamowienia/:id/stan-wysylki', () => {
  it('swieze zamowienie: wyslane=false, bez daty, nieanulowane', async () => {
    const { id, numer } = await zalozZamowienie();
    const res = await app.inject({ method: 'GET', url: `/api/zamowienia/${id}/stan-wysylki`, headers: naglowki });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id, numer, wyslane: false, wyslaneAt: null, anulowane: false });
  });

  it('po oznaczeniu wysylki oddaje wyslane=true z DATA z bazy', async () => {
    const { id } = await zalozZamowienie();
    oznaczWyslane(db, id, '2026-08-25T10:00:00.000Z');
    const res = await app.inject({ method: 'GET', url: `/api/zamowienia/${id}/stan-wysylki`, headers: naglowki });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ wyslane: true, wyslaneAt: '2026-08-25T10:00:00.000Z' });
  });

  it('anulowane RECZNIE widac jako anulowane (wartosc efektywna, nie kolumna sklepu)', async () => {
    const { id } = await zalozZamowienie();
    zapiszFaktyStatusu(db, id, faktyDlaStatusu(pobierzZamowienie(db, id), 'anulowane'));
    const res = await app.inject({ method: 'GET', url: `/api/zamowienia/${id}/stan-wysylki`, headers: naglowki });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ anulowane: true });
  });

  it('nieznane zamowienie to 404 z powodem', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/zamowienia/999999/stan-wysylki', headers: naglowki });
    expect(res.statusCode).toBe(404);
    expect(res.json().powod).toMatch(/zamówieni/i);
  });

  it('bez logowania nie oddaje niczego', async () => {
    const { id } = await zalozZamowienie();
    const res = await app.inject({ method: 'GET', url: `/api/zamowienia/${id}/stan-wysylki` });
    expect(res.statusCode).toBe(401);
  });
});
