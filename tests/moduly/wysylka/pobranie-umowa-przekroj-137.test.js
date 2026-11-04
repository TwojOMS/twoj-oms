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
    definicje: [{ klucz: 'polcien', typ: 'woo', prefiks: 'PC', etykieta: 'Pracownia Półcień', raport: 'PC' }, { klucz: 'allegro_test', typ: 'allegro', prefiks: 'AT', etykieta: 'Allegro test', raport: 'AT' }],
    kanaly: { polcien: {}, allegro_test: {} }, sklepy: {} };
  serwer = buildOmsServer({ db, config, nadanie, poller: { stan: () => ({}) } });
  const id = zapiszZamowienie(db, kanal, {
    zrodlo_id: 'pc-137', numer: 'PC-137', klient: { email: ADRES.email, phone: ADRES.phone },
    dostawa: { first_name: 'Ala', last_name: 'Przykładowa', address_1: ADRES.ulica, postcode: ADRES.kod, city: ADRES.miasto, country: 'PL' },
    metoda_wysylki: metoda, pobranie: pobranieSklep, kwota_pobrania: pobranieSklep ? '212.90' : null, kwota_brutto: '212.90', chce_fakture: 0, nip: null,
    punkt_odbioru: /paczkomat/.test(metoda) ? 'POL01A' : null, status_woo: 'processing', oplacone_at: null, anulowane: 0,
    pozycje: [], utworzone_at: '2026-11-03T12:00:00',
  }, {});
  if (nadpisanie) db.prepare('UPDATE zamowienia SET wysylka_reczna_json = ? WHERE id = ?').run(JSON.stringify(nadpisanie), id);
  const post = (payload) => serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowki, payload });
  const get = () => serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowki });
  const cialoShipX = () => JSON.parse(fetchInpost.mock.calls.find(([url]) => !String(url).includes('format='))[1].body);
  const przesylki = () => db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').all(id);
  const hurt = (koncowka = 'nadaj-podglad', pola = {}) => serwer.inject({ method: 'POST', url: `/zamowienia/masowe/${koncowka}`, headers: naglowki, payload: { id: String(id), ...pola } });
  return { id, hurt, post, get, fetchInpost, fetchDpd, cialoShipX, przesylki, nadanie };
}

describe('PRZ-137.02 przekrój recenzji: Allegro paczkomat sklepowy', () => {
  it.each([false, undefined])('POST karty, umowa %s → cod', async (umowa) => {
    const t = przygotuj({ kanal: 'allegro_test', metoda: 'allegro_paczkomat', umowa });
    const r = await t.post(FORMULARZ_PACZKOMAT);
    console.log('ALLEGRO POST', r.statusCode, r.body.slice(0, 200));
    expect(r.statusCode).toBe(302);
    expect(t.cialoShipX().cod).toEqual({ amount: 212.90, currency: 'PLN' });
  });
  it('GET karty Allegro paczkomat umowa wył. → brak ostrzeżenia', async () => {
    const t = przygotuj({ kanal: 'allegro_test', metoda: 'allegro_paczkomat', umowa: false });
    const r = await t.get();
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('wymaga umowy');
  });
  it('Allegro paczkomat ze zmienionym punktem (nadpisanie z tą samą metodą) → cod', async () => {
    const t = przygotuj({ kanal: 'allegro_test', metoda: 'allegro_paczkomat', umowa: false,
      nadpisanie: { metoda: 'allegro_paczkomat', pobranie: 1, kwota_pobrania: '212.90', punkt_odbioru: 'POL02B' } });
    const r = await t.post({ ...FORMULARZ_PACZKOMAT, punkt_odbioru: 'POL02B' });
    console.log('ALLEGRO PUNKT', r.statusCode, r.body.slice(0, 200));
    expect(r.statusCode).toBe(302);
  });
  it('Woo sklepowe z kwotą zmienioną na karcie → cod (sklepowe)', async () => {
    const t = przygotuj({ kanal: 'polcien', umowa: false,
      nadpisanie: { metoda: 'inpost_paczkomat', pobranie: 1, kwota_pobrania: '200.00', punkt_odbioru: 'POL01A' } });
    const r = await t.post({ ...FORMULARZ_PACZKOMAT, kwota_pobrania: '200.00' });
    console.log('WOO KWOTA', r.statusCode, r.body.slice(0, 200));
    expect(r.statusCode).toBe(302);
  });
});

describe('PRZ-137.02 przekrój recenzji: karta = hurt', () => {
  it.each([
    ['reczne paczkomat', { kanal: 'reczne', umowa: false }],
    ['woo zmiana metody', { kanal: 'polcien', metoda: 'dpd', umowa: false, nadpisanie: { metoda: 'inpost_paczkomat', pobranie: 1, kwota_pobrania: '212.90', punkt_odbioru: 'POL01A' } }],
    ['woo sklep', { kanal: 'polcien', umowa: false }],
    ['allegro sklep', { kanal: 'allegro_test', metoda: 'allegro_paczkomat', umowa: false }],
    ['reczne umowa wl', { kanal: 'reczne', umowa: true }],
  ])('%s', async (nazwa, opcje) => {
    const t = przygotuj(opcje);
    const h = await t.hurt();
    const hurtOdmawia = h.body.includes('wymaga umowy');
    const r = await t.post(FORMULARZ_PACZKOMAT);
    const kartaOdmawia = r.statusCode === 400 && r.body.includes('wymaga umowy');
    console.log('ZGODNOSC', nazwa, 'hurt', hurtOdmawia, 'karta', kartaOdmawia, r.statusCode);
    expect(hurtOdmawia).toBe(kartaOdmawia);
  });
});

describe('PRZ-137.02 przekrój recenzji: paczka 2 OMS-owa', () => {
  it('reczne paczkomat, paczka 1 DPD istnieje, paczka 2 paczkomat bez zaznaczenia → bez cod', async () => {
    const t = przygotuj({ kanal: 'reczne', umowa: false });
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, kolejnosc, status, numer_listu, utworzona_at) VALUES (?, 'inpost', 1, 'nadana', 'X1', '2026-11-03T12:00:00')").run(t.id);
    const r = await t.post({ ...FORMULARZ_PACZKOMAT, kolejnosc: '2' });
    console.log('PACZKA2', r.statusCode, r.body.slice(0, 300));
    if (r.statusCode === 302) expect(t.cialoShipX().cod).toBeUndefined();
  });
  it('paczka 2 z zaznaczeniem pobrania → odmowa bez ShipX', async () => {
    const t = przygotuj({ kanal: 'reczne', umowa: false });
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, kolejnosc, status, numer_listu, utworzona_at) VALUES (?, 'inpost', 1, 'nadana', 'X1', '2026-11-03T12:00:00')").run(t.id);
    const r = await t.post({ ...FORMULARZ_PACZKOMAT, kolejnosc: '2', pobranie_na_tej_paczce: 'tak' });
    console.log('PACZKA2Z', r.statusCode, r.body.slice(0, 300));
    expect(t.fetchInpost).not.toHaveBeenCalled();
  });
});
