import { beforeEach, describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const ONE_BOX = '0b9bed2c-0bc1-4e1f-9694-29bb39ebb483';
const ORLEN = '09164667-daa5-42dc-8087-33d7485790ac';
const ONE_BOX_DPD = '0b257488-c85d-4507-b967-9b45ffbfa2e8';
const DHL_BOX = '0fe5b4af-9f09-443d-9d49-62331a20b5b2';
const DHL_POINT = '0560b75e-88c3-4b79-bcf7-62331a20b5b2';
const DPD_AUTOMAT = '09bcdcdb-c62a-41c4-ba42-f2c599280e3c';
const ONE_COURIER = '0d83955a-4297-4169-adef-9790d53b11ff';
const AUTH = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`, origin: 'http://localhost' };
const CONFIG = { auth: { user: 'adam', pass: 'x' } };
const POLLER = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
const ADRES = {
  nazwa: 'Jan Kowalski', company: 'Jan Kowalski', ulica: 'Polna 1', kod: '00-650',
  miasto: 'Pęki', kraj: 'PL', phone: '+48500600700', email: 'j@k.pl',
};

const zamowienie = (nad = {}) => ({
  zrodlo_id: 'ord-gabaryty-1', numer: 'ord-gabaryty-1',
  klient: { email: 'j@allegromail.pl', phone: '+48500600700' },
  dostawa: {
    first_name: 'Jan', last_name: 'Kowalski', company: '', address_1: 'Polna 1',
    postcode: '00-650', city: 'Pęki', country: 'PL',
  },
  metoda_wysylki: 'allegro_punkt', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '99.00', status_woo: 'processing', oplacone_at: '2026-09-20T13:00:00',
  anulowane: 0, utworzone_at: '2026-09-20T13:19:52', pozycje: [], ...nad,
});

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

function zServerem({ liveId = ONE_BOX, nad = {} } = {}) {
  const nadania = [];
  const nadanie = { nadaj: async (...args) => { nadania.push(args); return { numerListu: 'TEST-GABARYT' }; } };
  const stan = { liveId };
  const kurierzy = { allegro_wza: { pobierzMetodeDostawy: async () => {
    if (stan.blad) throw stan.blad;
    return stan.liveId;
  } } };
  const serwer = buildOmsServer({ db, config: CONFIG, poller: POLLER, nadanie, kurierzy });
  const id = zapiszZamowienie(db, 'allegro_szkicownia', zamowienie(nad), {});
  return { serwer, id, nadania, stan };
}

const ekran = async (serwer, id, query = '') => {
  await serwer.ready();
  return serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj${query}`, headers: AUTH });
};

const formularz = (html, id) => {
  const akcja = html.indexOf(`action="/zamowienia/${id}/nadaj"`);
  const od = html.lastIndexOf('<form', akcja);
  return html.slice(od, html.indexOf('</form>', akcja));
};
const post = async (serwer, id, payload) => {
  await serwer.ready();
  return serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: AUTH, payload });
};
const PACZKA = { ...ADRES, kolejnosc: '1', waga: '0,5', gabaryt: 'M', delivery_method_id_allegro: ONE_BOX };

describe('gabaryty Allegro na formularzu nadania', () => {
  it('One Box otwiera formularz z wagą 1 kg i zaznaczonym S, bez szablonów i wolnych wymiarów', async () => {
    const { serwer, id } = zServerem();
    const r = await ekran(serwer, id);
    expect(r.statusCode).toBe(200);
    const f = formularz(r.body, id);
    expect(f).toContain(`name="delivery_method_id_allegro" value="${ONE_BOX}"`);
    expect(f).toContain('name="waga" value="1"');
    expect(f).toContain('name="gabaryt" value="S"');
    expect(f).toContain('name="gabaryt" value="M"');
    expect(f).toContain('name="gabaryt" value="L"');
    expect(f).toContain('64 × 38 × 8 cm');
    expect(f).toContain('64 × 38 × 19 cm');
    expect(f).toContain('64 × 38 × 41 cm');
    expect(f).toMatch(/name="gabaryt" value="S"[^>]*checked/);
    expect(f).not.toMatch(/name="gabaryt" value="[ML]"[^>]*checked/);
    expect(f).not.toContain('id="szablon-paczki"');
    expect(f).not.toContain('name="dlugosc"');
    expect(f).not.toContain('name="szerokosc"');
    expect(f).not.toContain('name="wysokosc"');
  });

  it.each([
    [ONE_BOX_DPD, 64], [ORLEN, 60], [DHL_BOX, 64], [DHL_POINT, 64], [DPD_AUTOMAT, 59],
  ])('%s zachowuje pustą wagę i wybór S/M/L bez zaznaczenia', async (liveId, dlugosc) => {
    const { serwer, id } = zServerem({ liveId });
    const f = formularz((await ekran(serwer, id)).body, id);
    for (const wysokosc of [8, 19, 41]) expect(f).toContain(`${dlugosc} × 38 × ${wysokosc} cm`);
    expect(f).toContain(`name="delivery_method_id_allegro" value="${liveId}"`);
    expect(f).toContain('name="waga" value=""');
    expect(f).not.toMatch(/name="gabaryt"[^>]*checked/);
    expect(f).not.toContain('id="szablon-paczki"');
  });

  it('One Kurier zachowuje szablon i edytowalne wymiary', async () => {
    const { serwer, id } = zServerem({ liveId: ONE_COURIER, nad: { metoda_wysylki: 'allegro_kurier' } });
    const f = formularz((await ekran(serwer, id)).body, id);
    expect(f).toContain(`name="delivery_method_id_allegro" value="${ONE_COURIER}"`);
    expect(f).toContain('id="szablon-paczki"');
    expect(f).toContain('name="dlugosc"');
    expect(f).not.toContain('name="gabaryt"');
  });

  it('świadomie wybrane własne DPD nie pobiera usługi WzA i zachowuje wymiary', async () => {
    const { serwer, id, stan } = zServerem();
    stan.blad = new Error('Allegro nie działa');
    const f = formularz((await ekran(serwer, id, '?kurier=dpd')).body, id);
    expect(f).toContain('id="szablon-paczki"');
    expect(f).toContain('name="dlugosc"');
    expect(f).not.toContain('name="delivery_method_id_allegro"');
  });

  it('POST nadaje wybrany rozmiar i wymiary kanoniczne bez ręcznych wymiarów', async () => {
    const { serwer, id, nadania } = zServerem();
    const r = await post(serwer, id, PACZKA);
    expect(r.statusCode).toBe(302);
    expect(nadania).toHaveLength(1);
    expect(nadania[0][1]).toEqual({ waga: 0.5, dlugosc: 64, szerokosc: 38, wysokosc: 19,
      gabaryt: 'M', oczekiwanyDeliveryMethodId: ONE_BOX });
  });

  it.each([
    ['brak gabarytu', { gabaryt: undefined }],
    ['fałszywy gabaryt', { gabaryt: 'XL' }],
    ['brak wagi', { waga: undefined }],
    ['waga ponad limit', { waga: '21' }],
    ['brak ID metody', { delivery_method_id_allegro: undefined }],
    ['zmienione ID metody', { delivery_method_id_allegro: ORLEN }],
  ])('POST odmawia: %s', async (_opis, zmiana) => {
    const { serwer, id, nadania } = zServerem();
    const r = await post(serwer, id, { ...PACZKA, ...zmiana });
    expect(r.statusCode).toBe(400);
    expect(nadania).toHaveLength(0);
  });

  it('zmiana usługi Allegro między GET i POST odmawia przed nadaniem', async () => {
    const { serwer, id, nadania, stan } = zServerem();
    expect((await ekran(serwer, id)).statusCode).toBe(200);
    stan.liveId = ORLEN;
    const r = await post(serwer, id, PACZKA);
    expect(r.statusCode).toBe(400);
    expect(nadania).toHaveLength(0);
  });

  it('nieznana usługa nie dostaje mylącego formularza ani nadania', async () => {
    const { serwer, id, nadania } = zServerem({ liveId: 'nieznany-identyfikator' });
    expect((await ekran(serwer, id)).statusCode).toBe(400);
    expect((await post(serwer, id, { ...PACZKA, delivery_method_id_allegro: 'nieznany-identyfikator' })).statusCode).toBe(400);
    expect(nadania).toHaveLength(0);
  });

  it('awaria odczytu Allegro nie pokazuje formularza ani nie nadaje', async () => {
    const { serwer, id, nadania, stan } = zServerem();
    stan.blad = new Error('sieć nie działa');
    expect((await ekran(serwer, id)).statusCode).toBe(503);
    expect((await post(serwer, id, PACZKA)).statusCode).toBe(503);
    expect(nadania).toHaveLength(0);
  });
});
