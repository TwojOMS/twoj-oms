// PRZ-119.12c — data zapłaty (`paid_date`) faktury wystawionej jako „zapłacona” (zlecenie właściciela 12.11):
// dzień opłacenia zamówienia, a gdy go nie znamy — data sprzedaży (bez niej: data wystawienia). Nigdy „dziś”.
//
// Fakturownia (pomiar F9B, tests/fixtures/fakturownia/F9B-data-zaplaty.json): `status: paid` bez `paid_date` wpisuje
// DZIŚ, a `paid_date` w utworzeniu i w PUT przyjmuje każdą datę — więc reguła idzie dosłownie, w ładunku wystawienia
// i w oznaczeniu. inFakt: dokumentacja `/paid.json` żąda daty nie wcześniejszej niż data wystawienia (niezmierzone),
// więc reguła przycięta do `invoice_date`, a ładunek wystawienia bez `paid_date` (bajt w bajt jak dotąd).
//
// Fakturownia: prawdziwy adapter i klient na wstrzykniętym fetch — żadne żądanie nie wychodzi z procesu.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajWplateReczna } from '../../../src/oms/db/platnosci.js';
import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';
import { createFakturowniaClient } from '../../../src/oms/fakturownia/client.js';
import { programFakturownia } from '../../../src/integracje/programy/fakturownia.ts';

const FIX = fileURLToPath(new URL('../../fixtures/fakturownia/', import.meta.url));
const pomiar = (nr) => JSON.parse(fs.readFileSync(path.join(FIX, fs.readdirSync(FIX).find((n) => n.startsWith(`${nr}-`))), 'utf8'));
const ODPOWIEDZ_F04 = pomiar('F04').wymiany[1].odpowiedz.cialo;

const zamowienie = (nad = {}) => ({
  zrodlo_id: 4121, numer: 'R/2026/121',
  klient: {
    first_name: 'Ewa', last_name: 'Półcień', company: 'Pracownia Półcień', email: 'biuro@polcien.invalid',
    address_1: 'Lampowa 7', postcode: '00-950', city: 'Warszawa',
  },
  dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null,
  chce_fakture: 1, nip: '5250000009', kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00',
  status_woo: 'processing',
  oplacone_at: '2026-11-03T10:00:00', anulowane: 0, utworzone_at: '2026-11-03T09:00:00',
  pozycje: [{ nazwa: 'Lampa stołowa Kałamarz', sku: 'LMP-KAL-01', ilosc: 2, cena_brutto: '61.50', vat: null }],
  ...nad,
});

/** Udawana Fakturownia: POST /invoices.json, change_status, PUT /invoices/{id}.json. */
function fakturownia() {
  const zadania = [];
  const json = (cialo, status = 200) => new Response(JSON.stringify(cialo), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, opcje = {}) => {
    const z = { url: String(url), metoda: opcje.method ?? 'GET', cialo: opcje.body ? JSON.parse(opcje.body) : null };
    zadania.push(z);
    const u = new URL(z.url);
    if (z.metoda === 'POST' && u.pathname === '/invoices.json') return json(ODPOWIEDZ_F04, 201);
    if (z.metoda === 'POST' && /\/change_status\.json$/.test(u.pathname)) return json({ status: 'ok' });
    const m = /^\/invoices\/(\d+)\.json$/.exec(u.pathname);
    if (z.metoda === 'PUT' && m) return json({ id: Number(m[1]), status: 'paid', ...z.cialo.invoice });
    throw new Error(`żądanie spoza testu: ${z.metoda} ${z.url}`);
  };
  const klient = createFakturowniaClient({ token: 'ZmyslonyTokenPolcien123/firma-testowa', domena: 'firma-testowa', fetchImpl });
  const alarm = { dopisz: () => {}, wczytaj: () => [], zgas: () => {} };
  const program = programFakturownia(klient, { alarmAutoKsef: alarm, teraz: () => new Date('2026-11-12T10:00:00Z') });
  return {
    program,
    wystawienie: () => zadania.filter((z) => z.metoda === 'POST' && new URL(z.url).pathname === '/invoices.json').map((z) => z.cialo.invoice),
    zapisDaty: () => zadania.filter((z) => z.metoda === 'PUT').map((z) => z.cialo.invoice.paid_date),
  };
}

function zFakturownia(nad = {}) {
  const db = openOmsDb(':memory:');
  const id = zapiszZamowienie(db, 'pro', zamowienie(nad), {});
  const f = fakturownia();
  return { db, id, ...f, faktura: createFaktura({ db, program: f.program }) };
}

function zInfaktem(nad = {}) {
  const db = openOmsDb(':memory:');
  const infakt = {
    znajdzKlientaPoNip: vi.fn().mockResolvedValue(null),
    zalozKlienta: vi.fn().mockResolvedValue(555),
    wystaw: vi.fn().mockResolvedValue({ uuid: 'u1', numer: 'FV/1/11/2026', ksefStatus: 'sent' }),
    oznaczZaplacona: vi.fn().mockResolvedValue({ referencja: 'ref-1' }),
  };
  const id = zapiszZamowienie(db, 'pro', zamowienie(nad), {});
  return { db, id, infakt, faktura: createFaktura({ db, infakt }) };
}

/** Wpłata, której dnia nie da się odczytać (uszkodzona wartość w bazie) — „dzień opłacenia” pusty. */
function wplataBezDaty(db, id) {
  dodajWplateReczna(db, id, { kwota: '123.00', data: '2026-11-03' });
  db.prepare("UPDATE platnosci SET data = 'nie-data', utworzona_at = 'nie-data' WHERE zamowienie_id = ?").run(id);
}

const ZAPLACONE = { dataWystawienia: '2026-11-07', dataSprzedazy: '2026-11-03', termin: 'zaplacone' };

describe('PRZ-119.12c Fakturownia — paid_date = dzień opłacenia, inaczej data sprzedaży', () => {
  it('opłacone 03.11, sprzedaż 03.11, wystawienie 07.11 → 2026-11-03 w wystawieniu i w oznaczeniu', async () => {
    const { id, faktura, wystawienie, zapisDaty } = zFakturownia();
    await faktura.wystaw(id, ZAPLACONE);
    expect(wystawienie()).toHaveLength(1);
    expect(wystawienie()[0]).toMatchObject({ status: 'paid', paid: '123.00', paid_date: '2026-11-03', issue_date: '2026-11-07', sell_date: '2026-11-03' });
    expect(zapisDaty()).toEqual(['2026-11-03']);
  });

  // właściciel 12.11 (raport A–G): kolejność reguły pilnowana także dla Fakturowni — dzień opłacenia wygrywa z datą sprzedaży.
  it('opłacone 05.11, sprzedaż 03.11, wystawienie 07.11 → 2026-11-05 (dzień opłacenia, nie data sprzedaży)', async () => {
    const { id, faktura, wystawienie, zapisDaty } = zFakturownia({ oplacone_at: '2026-11-05T10:00:00' });
    await faktura.wystaw(id, ZAPLACONE);
    expect(wystawienie()[0]).toMatchObject({ status: 'paid', paid_date: '2026-11-05', issue_date: '2026-11-07', sell_date: '2026-11-03' });
    expect(zapisDaty()).toEqual(['2026-11-05']);
  });
  it('brak dnia opłacenia (uszkodzona data wpłaty) → data sprzedaży, nie data wystawienia ani dziś', async () => {
    const { db, id, faktura, wystawienie, zapisDaty } = zFakturownia({ oplacone_at: null });
    wplataBezDaty(db, id);
    await faktura.wystaw(id, { ...ZAPLACONE, dataSprzedazy: '2026-11-04' });
    expect(wystawienie()[0].paid_date).toBe('2026-11-04');
    expect(zapisDaty()).toEqual(['2026-11-04']);
  });

  it('brak dnia opłacenia i brak daty sprzedaży → data wystawienia (= data sprzedaży na dokumencie)', async () => {
    const { db, id, faktura, wystawienie, zapisDaty } = zFakturownia({ oplacone_at: null });
    wplataBezDaty(db, id);
    await faktura.wystaw(id, { dataWystawienia: '2026-11-07', termin: 'zaplacone' });
    expect(wystawienie()[0].paid_date).toBe('2026-11-07');
    expect(zapisDaty()).toEqual(['2026-11-07']);
  });

  it('termin 14 dni → bez paid_date i bez oznaczenia (faktura nieopłacona)', async () => {
    const { id, faktura, wystawienie, zapisDaty } = zFakturownia();
    await faktura.wystaw(id, { ...ZAPLACONE, termin: '14' });
    expect(wystawienie()[0]).not.toHaveProperty('paid_date');
    expect(zapisDaty()).toEqual([]);
  });

  it('adapter: ładunek zapłacony BEZ paid_date (np. faktura okresu) → data sprzedaży, nigdy pusta', async () => {
    const { program, wystawienie } = fakturownia();
    const { client_id } = await program.przygotujNabywce({ firma: 'Pracownia Półcień', nip: '5250000009', ulica: 'Lampowa 7', kod: '00-950', miasto: 'Warszawa', kraj: 'PL' }, { zalozGdyBrak: true });
    await program.wystaw({
      client_id, invoice_date: '2026-11-07', sale_date: '2026-11-02', paid_price: 12300,
      services: [{ name: 'Lampa stołowa Kałamarz', quantity: 1, gross_price: 12300, tax_symbol: '23' }],
    }, { oid: 'pro-R/2026/121' });
    expect(wystawienie()[0]).toMatchObject({ status: 'paid', paid_date: '2026-11-02' });
  });
});

describe('PRZ-119.12c inFakt — ta sama reguła, przycięta do daty wystawienia (dokumentacja /paid.json)', () => {
  it('opłacone 03.11, sprzedaż 03.11, wystawienie 07.11 → 2026-11-07 (przycięcie)', async () => {
    const { id, infakt, faktura } = zInfaktem();
    await faktura.wystaw(id, ZAPLACONE);
    expect(infakt.oznaczZaplacona).toHaveBeenCalledWith('u1', { paidDate: '2026-11-07' });
    // Ładunek wystawienia inFaktu bez `paid_date` — jak dotąd (niezmierzone).
    expect(infakt.wystaw.mock.calls[0][0]).not.toHaveProperty('paid_date');
  });

  it('wpłata 09.11 po wystawieniu 07.11 → 2026-11-09', async () => {
    const { db, id, infakt, faktura } = zInfaktem({ oplacone_at: null });
    dodajWplateReczna(db, id, { kwota: '123.00', data: '2026-11-09' });
    await faktura.wystaw(id, ZAPLACONE);
    expect(infakt.oznaczZaplacona).toHaveBeenCalledWith('u1', { paidDate: '2026-11-09' });
  });

  it('brak dnia opłacenia, sprzedaż 09.11 po wystawieniu 07.11 → data sprzedaży 2026-11-09', async () => {
    const { db, id, infakt, faktura } = zInfaktem({ oplacone_at: null });
    wplataBezDaty(db, id);
    await faktura.wystaw(id, { ...ZAPLACONE, dataSprzedazy: '2026-11-09' });
    expect(infakt.oznaczZaplacona).toHaveBeenCalledWith('u1', { paidDate: '2026-11-09' });
  });
});
