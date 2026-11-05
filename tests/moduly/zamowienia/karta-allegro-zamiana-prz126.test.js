import { describe, it, expect, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createFakturaAllegro } from '../../../src/moduly/faktury/services/faktura-allegro.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// PRZ-126 C09e — karta zamówienia po zamianie faktury (zły NIP) w stanie D (plan C09, Z10): kupujący ma w Allegro
// POPRZEDNIĄ fakturę, zamówienie wskazuje już nową. Karta nie ma prawa mówić „kupujący ma ją na swoim koncie” —
// „ją” to teraz nowa faktura, której kupujący nie dostał. Pełna droga: GET → trasa → kontekst → widok. Bez sieci.
// Dane zmyślone (Pracownia Półcień).

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: '2026-11-02T12:00:00', ostatni_blad: null }) };
const PDF = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(64)]);
const klient = {
  pobierzFakturyZamowienia: async () => [],
  zglosFakture: async () => { throw new Error('test nie wysyła do Allegro'); },
  wyslijPlikFaktury: async () => { throw new Error('test nie wysyła do Allegro'); },
};

function baza({ program = 'twojefaktury', invoiceId = null, weryfikacja = 'ACCEPTED', wyslanaAt = '2026-10-20T11:00:00.000Z' } = {}) {
  const db = openOmsDb(':memory:');
  const id = zapiszZamowienie(db, 'allegro_polcien', {
    zrodlo_id: 'PC-1', numer: 'PC-1', kwota_brutto: '100.00', chce_fakture: 1, pozycje: [],
    klient: { first_name: 'Jan', company: 'Pracownia Półcień', email: 'jan@polcien.example' }, dostawa: { city: 'Warszawa' },
    metoda_wysylki: 'allegro_dpd', kwota_pobrania: null, nip: '1234563218', status_woo: null,
    oplacone_at: '2026-10-20T09:00:00', anulowane: 0, utworzone_at: '2026-10-20T08:00:00',
  }, {});
  db.prepare(`INSERT INTO faktury (zamowienie_id, program, dokument_id, infakt_uuid, numer, ksef_numer,
    allegro_invoice_id, allegro_wyslana_at, allegro_weryfikacja, utworzona_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, program, program === 'infakt' ? null : '17', program === 'infakt' ? 'u-1' : null, 'FV/2/11/2026', null,
      invoiceId, wyslanaAt, weryfikacja, '2026-11-02T10:00:00.000Z');
  return { db, id };
}

const apki = [];
afterEach(async () => { for (const a of apki.splice(0)) await a.close(); });

async function karta(opcje) {
  const { db, id } = baza(opcje);
  const fakturaAllegro = createFakturaAllegro({ db, infakt: { pobierzPdf: async () => PDF }, klienciKanalow: { allegro_polcien: klient } });
  const app = buildOmsServer({ db, config, poller, fakturaAllegro });
  apki.push(app);
  await app.ready();
  const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
  expect(r.statusCode).toBe(200);
  return r.body.replace(/\s+/g, ' ');
}

const ZDANIE_D = 'Kupujący ma w Allegro poprzednią fakturę (sprzed zamiany NIP-u), wysłaną 20.10. Nowej FV/2/11/2026 panel nie wysyła sam.';

describe('PRZ-126 C09e — karta zamówienia, znacznik D', () => {
  it('znacznik D → zdanie o poprzedniej fakturze, bez „kupujący ma ją na swoim koncie”', async () => {
    const html = await karta();
    expect(html).toContain(ZDANIE_D);
    expect(html).not.toMatch(/Faktura jest na koncie kupującego w Allegro — błąd poprawisz tylko korektą\./);
    // Recenzja G10c: nowa faktura dziedziczy datę wysłania poprzedniej — plakietka w tabeli nie może mówić „Wysłana”.
    expect(html).not.toContain('Wysłana do Allegro');
    expect(html).not.toMatch(/Wyślij fakturę do Allegro/);
  });

  it('zwykła wysłana (z id zgłoszenia) → dzisiejsze zdanie', async () => {
    const html = await karta({ invoiceId: 'INV-7' });
    expect(html).toMatch(/Faktura jest na koncie kupującego w Allegro — błąd poprawisz tylko korektą\./);
    expect(html).not.toContain('sprzed zamiany NIP-u');
  });

  it('spóźnione REJECTED po przepięciu (bez id) → bez zdania D', async () => {
    const html = await karta({ weryfikacja: 'REJECTED' });
    expect(html).not.toContain('sprzed zamiany NIP-u');
    expect(html).not.toMatch(/Faktura jest na koncie kupującego w Allegro — błąd poprawisz tylko korektą\./);
  });

  it('wiersz inFaktu bez id → dzisiejsze zdanie, nie zdanie D', async () => {
    const html = await karta({ program: 'infakt' });
    expect(html).toMatch(/Faktura jest na koncie kupującego w Allegro — błąd poprawisz tylko korektą\./);
    expect(html).not.toContain('sprzed zamiany NIP-u');
  });
});
