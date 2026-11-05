// PRZ-137.02 (plan docs/plany/PRZ-137-pobranie-sklepowe.md, D2): przełącznik „umowa na pobranie"
// obowiązuje tylko pobranie OMS-owe (zamówienie ręczne, metoda albo pobranie zmienione na karcie).
// POST karty dostaje barierę PRZED wołaniem kuriera — dotąd jej nie było (hurt odmawiał, karta
// przepuszczała). Pobranie sprzedane przez sklep jedzie z `cod` jak dotąd, DPD bez zmian.
// Dane zmyślone („Pracownia Półcień”, example.test); kurierzy to wyłącznie atrapy `fetch`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createInpostClient } from '../../../src/oms/kurierzy/inpost.js';
import { createDpdClient } from '../../../src/oms/kurierzy/dpd.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { zapiszUmowePobrania } from '../../../src/moduly/wysylka/db/umowy-pobrania.js';
import { powodUmowyPobrania } from '../../../src/domena/kurier-nadania.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// Od PRZ-152.G1 błąd nadania to strona w układzie OMS — porównujemy sam komunikat z paska uwagi.
const komunikatNadania = (html) => (html.match(/<p class="pasek-uwaga" role="alert">([\s\S]*?)<\/p>/)?.[1] ?? html)
  .replace(/&#34;|&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(__dir, 'fixtures', 'dpd', n), 'utf8');
const odp = (status, tekst) => ({ status, ok: status >= 200 && status < 300, text: async () => tekst });

const naglowki = { authorization: 'Basic ' + Buffer.from('operator:atrapa').toString('base64'), origin: 'http://localhost' };
const ADRES = { nazwa: 'Ala Przykładowa', ulica: 'Przykładowa 12', kod: '00-001', miasto: 'Warszawa', kraj: 'PL', phone: '+48500100200', email: 'ala@example.test' };
const NADAWCA = { ...ADRES, nazwa: 'Pracownia Półcień' };
const FORMULARZ_PACZKOMAT = { ...ADRES, waga: '1', gabaryt: 'A', kolejnosc: '1', punkt_odbioru: 'POL01A', kwota_pobrania: '212.90' };
const FORMULARZ_DPD = { ...ADRES, waga: '1', dlugosc: '30', szerokosc: '20', wysokosc: '10', kolejnosc: '1', kwota_pobrania: '212.90' };
const ODMOWA = 'Pobranie przez InPost wymaga umowy — włącz ją w Ustawieniach → Integracje albo zmień kuriera na karcie zamówienia';
const OSTRZEZENIE = 'wymaga umowy';

let db, serwer, katalog;
beforeEach(() => { db = openOmsDb(':memory:'); });
afterEach(async () => {
  if (serwer) await serwer.close();
  serwer = undefined;
  db.close();
  if (katalog) rmSync(katalog, { recursive: true, force: true });
  katalog = undefined;
});

function atrapaShipX() {
  return vi.fn(async (url, opcje) => {
    if (String(url).includes('format=')) return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('%PDF-1.4\n') };
    const body = JSON.parse(opcje.body);
    return { ok: true, status: 201, text: async () => JSON.stringify({ id: 13702, tracking_number: '520000000000000000013702', cod: body.cod ?? { amount: null, currency: null } }) };
  });
}

function atrapaDpd() {
  const v10 = fixture('v10-ok.xml');
  return vi.fn()
    .mockResolvedValueOnce(odp(200, v10))
    .mockResolvedValueOnce(odp(200, fixture('v4-ok.xml')))
    .mockResolvedValueOnce(odp(200, fixture('v4-ok-zpl.xml')));
}

// kanal: 'polcien' = sklep WooCommerce „Pracowni Półcień", 'reczne' = zamówienie założone w OMS-ie.
function przygotuj({ kanal, metoda = 'inpost_paczkomat', umowa, nadpisanie, pobranieSklep = 1 } = {}) {
  if (umowa !== undefined) zapiszUmowePobrania(db, 'inpost', umowa);
  const fetchInpost = atrapaShipX();
  const fetchDpd = atrapaDpd();
  const inpost = createInpostClient({ url: 'https://shipx.example.test/v1', token: 'atrapa', organizacja: 13702, nadawca: NADAWCA, fetchImpl: fetchInpost });
  const dpd = createDpdClient({ url: 'https://dpd.example.test/api', login: '99999999', haslo: 'x', fid: '100137', nadawca: NADAWCA, fetchImpl: fetchDpd });
  katalog = mkdtempSync(join(tmpdir(), 'pobranie-umowa-oms-137-'));
  const nadanie = createNadanie({ db, kurierzy: { inpost, dpd }, katalogEtykiet: katalog });
  const config = { auth: { user: 'operator', pass: 'atrapa' },
    definicje: [{ klucz: 'polcien', typ: 'woo', prefiks: 'PC', etykieta: 'Pracownia Półcień', raport: 'PC' }],
    kanaly: { polcien: {} }, sklepy: {} };
  serwer = buildOmsServer({ db, config, nadanie, poller: { stan: () => ({}) } });
  const id = zapiszZamowienie(db, kanal, {
    zrodlo_id: 'pc-137', numer: 'PC-137', klient: { email: ADRES.email, phone: ADRES.phone },
    dostawa: { first_name: 'Ala', last_name: 'Przykładowa', address_1: ADRES.ulica, postcode: ADRES.kod, city: ADRES.miasto, country: 'PL' },
    metoda_wysylki: metoda, pobranie: pobranieSklep, kwota_pobrania: pobranieSklep ? '212.90' : null, kwota_brutto: '212.90', chce_fakture: 0, nip: null,
    punkt_odbioru: metoda === 'inpost_paczkomat' ? 'POL01A' : null, status_woo: 'processing', oplacone_at: null, anulowane: 0,
    pozycje: [], utworzone_at: '2026-11-03T12:00:00',
  }, {});
  if (nadpisanie) db.prepare('UPDATE zamowienia SET wysylka_reczna_json = ? WHERE id = ?').run(JSON.stringify(nadpisanie), id);
  const post = (payload) => serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowki, payload });
  const get = () => serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowki });
  const cialoShipX = () => JSON.parse(fetchInpost.mock.calls.find(([url]) => !String(url).includes('format='))[1].body);
  const przesylki = () => db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').all(id);
  return { id, post, get, fetchInpost, fetchDpd, cialoShipX, przesylki, nadanie };
}

describe('POST karty: pobranie sklepowe jedzie jak dotąd', () => {
  it.each([false, undefined])('Woo paczkomat za pobraniem, umowa %s → ShipX dostaje cod 212.90', async (umowa) => {
    const t = przygotuj({ kanal: 'polcien', umowa });
    const r = await t.post(FORMULARZ_PACZKOMAT);
    expect(r.statusCode).toBe(302);
    expect(t.cialoShipX().cod).toEqual({ amount: 212.90, currency: 'PLN' });
  });

  it('Woo paczkomat za pobraniem ze zmienionym tylko punktem → dalej sklepowe, cod 212.90', async () => {
    const t = przygotuj({ kanal: 'polcien', umowa: false,
      nadpisanie: { metoda: 'inpost_paczkomat', pobranie: 1, kwota_pobrania: '212.90', punkt_odbioru: 'POL02B' } });
    const r = await t.post({ ...FORMULARZ_PACZKOMAT, punkt_odbioru: 'POL02B' });
    expect(r.statusCode).toBe(302);
    expect(t.cialoShipX().cod).toEqual({ amount: 212.90, currency: 'PLN' });
  });
});

describe('POST karty: pobranie OMS-owe u InPostu wymaga umowy', () => {
  it.each([false, undefined])('ręczne, paczkomat + pobranie, umowa %s → odmowa, ZERO wywołań ShipX', async (umowa) => {
    const t = przygotuj({ kanal: 'reczne', umowa });
    const r = await t.post(FORMULARZ_PACZKOMAT);
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain(ODMOWA);
    expect(komunikatNadania(r.body)).not.toMatch(/DPD/);
    expect(t.fetchInpost).not.toHaveBeenCalled();
    expect(t.przesylki()).toHaveLength(0);
  });

  it('Woo z metodą zmienioną na karcie (DPD → paczkomat), umowa wył. → odmowa bez ShipX', async () => {
    const t = przygotuj({ kanal: 'polcien', metoda: 'dpd', umowa: false,
      nadpisanie: { metoda: 'inpost_paczkomat', pobranie: 1, kwota_pobrania: '212.90', punkt_odbioru: 'POL01A' } });
    const r = await t.post(FORMULARZ_PACZKOMAT);
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain(ODMOWA);
    expect(t.fetchInpost).not.toHaveBeenCalled();
  });

  it('Woo przedpłacone, pobranie włączone na karcie (paczkomat), umowa wył. → odmowa bez ShipX', async () => {
    const t = przygotuj({ kanal: 'polcien', umowa: false, pobranieSklep: 0,
      nadpisanie: { metoda: 'inpost_paczkomat', pobranie: 1, kwota_pobrania: '212.90', punkt_odbioru: 'POL01A' } });
    const r = await t.post(FORMULARZ_PACZKOMAT);
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain(ODMOWA);
    expect(t.fetchInpost).not.toHaveBeenCalled();
  });

  it('usługa bez trasy (wywołanie spoza HTTP) odmawia tak samo', async () => {
    const t = przygotuj({ kanal: 'reczne', umowa: false });
    await expect(t.nadanie.nadaj(t.id, { waga: 1, gabaryt: 'A' }, { punktOdbioru: 'POL01A' })).rejects.toThrow(ODMOWA);
    expect(t.fetchInpost).not.toHaveBeenCalled();
  });

  it('usługa: pierwsza paczka odmawia nawet z pobranieNaTejPaczce: false (adapter i tak wysłałby cod)', async () => {
    const t = przygotuj({ kanal: 'reczne', umowa: false });
    await expect(t.nadanie.nadaj(t.id, { waga: 1, gabaryt: 'A' }, { punktOdbioru: 'POL01A', pobranieNaTejPaczce: false }))
      .rejects.toThrow(ODMOWA);
    expect(t.fetchInpost).not.toHaveBeenCalled();
  });

  it('ręczne, paczkomat + pobranie, umowa włączona → ShipX dostaje cod 212.90', async () => {
    const t = przygotuj({ kanal: 'reczne', umowa: true });
    const r = await t.post(FORMULARZ_PACZKOMAT);
    expect(r.statusCode).toBe(302);
    expect(t.cialoShipX().cod).toEqual({ amount: 212.90, currency: 'PLN' });
  });
});

describe('POST karty: DPD bez zmian', () => {
  it('ręczne, DPD + pobranie, umowa InPost wył. → koperta DPD z <cod> 212.90', async () => {
    const t = przygotuj({ kanal: 'reczne', metoda: 'dpd', umowa: false });
    const r = await t.post(FORMULARZ_DPD);
    expect(r.statusCode).toBe(302);
    const koperta = t.fetchDpd.mock.calls.map((c) => c[1].body).find((b) => b.includes('generatePackagesNumbersV10'));
    expect(koperta).toContain('<cod><amount>212.90</amount><currency>PLN</currency></cod>');
    expect(t.fetchInpost).not.toHaveBeenCalled();
  });
});

describe('GET karty: ostrzeżenie o umowie tylko przy pobraniu OMS-owym', () => {
  it('ręczne, paczkomat + pobranie, umowa wył. → ostrzeżenie z nazwą kuriera z rejestru', async () => {
    const t = przygotuj({ kanal: 'reczne', umowa: false });
    const r = await t.get();
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(OSTRZEZENIE);
    expect(r.body).toContain('Pobranie przez InPost');
  });

  it.each([
    ['Woo sklepowe, umowa wył.', { kanal: 'polcien', umowa: false }],
    ['ręczne, umowa wł.', { kanal: 'reczne', umowa: true }],
    ['ręczne DPD, umowa wył.', { kanal: 'reczne', metoda: 'dpd', umowa: false }],
  ])('%s → formularz bez ostrzeżenia', async (_, opcje) => {
    const t = przygotuj(opcje);
    const r = await t.get();
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(OSTRZEZENIE);
  });
});

describe('powodUmowyPobrania — wspólny tekst hurtu i karty', () => {
  it('nazwa kuriera z rejestru, bez założenia DPD', () => {
    expect(powodUmowyPobrania('inpost_paczkomat')).toBe('pobranie przez InPost wymaga umowy — włącz ją w Ustawieniach → Integracje albo zmień kuriera na karcie zamówienia');
    expect(powodUmowyPobrania('nieznana')).toContain('pobranie przez tego kuriera wymaga umowy');
  });
});
