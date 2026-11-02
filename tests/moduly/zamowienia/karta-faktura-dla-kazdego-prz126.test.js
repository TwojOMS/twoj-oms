// PRZ-126.F02 — karta zamówienia przy opcji firmy „faktura także bez prośby klienta”.
// Sekcja `id="faktura"` renderuje się ZAWSZE (proforma stoi na każdej karcie), więc znakiem
// „wolno wystawić fakturę” jest formularz `id="wystaw-fakture"` z przyciskiem „Wystaw fakturę”.
// PRZ-126.P1: wyłączona opcja = bez pól, z przyciskiem disabled i powodem.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';
import { zapiszFakturaDlaKazdego } from '../../../src/moduly/faktury/db/faktury-dla-kazdego.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: '2026-10-29T08:00:00', ostatni_blad: null }) };

const zmapowane = (nad = {}) => ({
  zrodlo_id: 12601, numer: 'PC-12601',
  klient: { first_name: 'Anna', last_name: 'Półcień', email: 'anna@polcien.invalid', address_1: 'Fikcyjna 1', postcode: '00-001', city: 'Miasto Testowe' }, dostawa: { city: 'Warszawa' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '129.00', koszt_dostawy_brutto: '0.00',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-28T10:00:00',
  pozycje: [{ nazwa: 'Lampa wisząca Półcień', sku: 'LAMPA-W1', ilosc: 1, cena_brutto: '129.00', vat: null }],
  ...nad,
});

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

async function karta(nad = {}) {
  const infakt = {
    znajdzKlientaPoNip: vi.fn().mockResolvedValue(null),
    zalozKlienta: vi.fn().mockResolvedValue(555),
    wystaw: vi.fn().mockResolvedValue({ uuid: 'u1', numer: 'FV/1/2026', ksefStatus: null }),
  };
  const serwer = buildOmsServer({ db, config, poller, faktura: createFaktura({ db, infakt }) });
  await serwer.ready();
  const id = zapiszZamowienie(db, 'pro', zmapowane(nad), {});
  const pobierz = async () => {
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    return r.body;
  };
  return { serwer, id, infakt, pobierz };
}

describe('karta — faktura dla zamówienia bez żądania (PRZ-126)', () => {
  it('opcja wyłączona (brak wpisu): sekcja jest, ale bez formularza wystawienia', async () => {
    const { pobierz } = await karta();
    const body = await pobierz();
    expect(body).toContain('id="faktura"');
    expect(body).not.toContain('id="wystaw-fakture"');
    expect(body).toMatch(/<button[^>]*disabled[^>]*>Wystaw fakturę<\/button>/);
  });

  it('opcja wyłączona zapisem „nie”: karta jak bez wpisu', async () => {
    const { pobierz } = await karta();
    zapiszFakturaDlaKazdego(db, false);
    const body = await pobierz();
    expect(body).not.toContain('id="wystaw-fakture"');
    expect(body).toMatch(/<button[^>]*disabled[^>]*>Wystaw fakturę<\/button>/);
  });

  it('opcja włączona: formularz wystawienia jest; wyłączenie zdejmuje go od następnego odczytu', async () => {
    const { pobierz } = await karta();
    zapiszFakturaDlaKazdego(db, true);
    const wl = await pobierz();
    expect(wl).toContain('id="wystaw-fakture"');
    expect(wl).toContain('Wystaw fakturę');
    zapiszFakturaDlaKazdego(db, false);
    expect(await pobierz()).not.toContain('id="wystaw-fakture"');
  });

  it('opcja włączona i zamówienie ANULOWANE: bez formularza', async () => {
    const { pobierz } = await karta({ anulowane: 1 });
    zapiszFakturaDlaKazdego(db, true);
    const body = await pobierz();
    expect(body).not.toContain('id="wystaw-fakture"');
    expect(body).toMatch(/<button[^>]*disabled[^>]*>Wystaw fakturę<\/button>/);
  });

  it('opcja włączona: wystawienie z karty dochodzi do programu raz', async () => {
    const { serwer, id, infakt } = await karta();
    zapiszFakturaDlaKazdego(db, true);
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/faktura`, headers: naglowek });
    expect(r.statusCode).toBe(302);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
  });

  it('opcja wyłączona: POST z karty odmawia i nie dotyka programu', async () => {
    const { serwer, id, infakt } = await karta();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/faktura`, headers: naglowek });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Klient nie prosił o fakturę.');
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });
});
