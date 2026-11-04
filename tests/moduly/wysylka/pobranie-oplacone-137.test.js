import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajWplateReczna, zsynchronizujWplateSklepu } from '../../../src/oms/db/platnosci.js';
import { podzielDoNadania } from '../../../src/domena/masowe.js';
import { przedplatyPrzedPobraniem } from '../../../src/domena/platnosci.js';
import { createDpdClient } from '../../../src/oms/kurierzy/dpd.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(__dir, 'fixtures', 'dpd', n), 'utf8');
const odp = (status, tekst) => ({ status, ok: status >= 200 && status < 300, text: async () => tekst });

const naglowki = { authorization: 'Basic ' + Buffer.from('operator:atrapa').toString('base64'), origin: 'http://localhost' };
const ADRES = { nazwa: 'Ala Przykładowa', ulica: 'Przykładowa 12', kod: '00-001', miasto: 'Warszawa', kraj: 'PL', phone: '+48500100200', email: 'ala@example.test' };
const NADAWCA = { ...ADRES, nazwa: 'Pracownia Półcień' };
const FORMULARZ_DPD = { ...ADRES, waga: '1', dlugosc: '30', szerokosc: '20', wysokosc: '10', kolejnosc: '1', kwota_pobrania: '212.90' };

let db, serwer, katalog;
beforeEach(() => { db = openOmsDb(':memory:'); });
afterEach(async () => {
  if (serwer) await serwer.close();
  serwer = undefined;
  db.close();
  if (katalog) rmSync(katalog, { recursive: true, force: true });
  katalog = undefined;
});

function atrapaDpd() {
  const v10 = fixture('v10-ok.xml');
  return vi.fn()
    .mockResolvedValueOnce(odp(200, v10))
    .mockResolvedValueOnce(odp(200, fixture('v4-ok.xml')))
    .mockResolvedValueOnce(odp(200, fixture('v4-ok-zpl.xml')));
}

// kanal: 'polcien' = sklep WooCommerce „Pracowni Półcień", 'reczne' = zamówienie założone w OMS-ie.
function przygotuj({ kanal, metoda = 'dpd' }) {
  const fetchDpd = atrapaDpd();
  const dpd = createDpdClient({ url: 'https://dpd.example.test/api', login: '99999999', haslo: 'x', fid: '100137', nadawca: NADAWCA, fetchImpl: fetchDpd });
  katalog = mkdtempSync(join(tmpdir(), 'pobranie-oplacone-137-'));
  const nadanie = createNadanie({ db, kurierzy: { dpd }, katalogEtykiet: katalog });
  const config = { auth: { user: 'operator', pass: 'atrapa' },
    definicje: [{ klucz: 'polcien', typ: 'woo', prefiks: 'PC', etykieta: 'Pracownia Półcień', raport: 'PC' }],
    kanaly: { polcien: {} }, sklepy: {} };
  serwer = buildOmsServer({ db, config, nadanie, poller: { stan: () => ({}) } });
  const id = zapiszZamowienie(db, kanal, {
    zrodlo_id: 'pc-137', numer: 'PC-137', klient: { email: ADRES.email, phone: ADRES.phone },
    dostawa: { first_name: 'Ala', last_name: 'Przykładowa', address_1: ADRES.ulica, postcode: ADRES.kod, city: ADRES.miasto, country: 'PL' },
    metoda_wysylki: metoda, pobranie: 1, kwota_pobrania: '212.90', kwota_brutto: '212.90', chce_fakture: 0, nip: null,
    punkt_odbioru: metoda === 'inpost_paczkomat' ? 'POL01A' : null, status_woo: 'processing', oplacone_at: null, anulowane: 0,
    pozycje: [], utworzone_at: '2026-11-03T12:00:00',
  }, {});
  const post = (payload) => serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowki, payload });
  const get = () => serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowki });
  const przesylki = () => db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').all(id);
  return { id, post, get, fetchDpd, przesylki, nadanie };
}

function zPrzedplata(kwota) {
  const t = przygotuj({ kanal: 'polcien', metoda: 'dpd' });
  dodajWplateReczna(db, t.id, { kwota, data: '2026-11-03', metoda: 'Przelew' });
  return t;
}

describe('przedpłata i pobranie — rzeczywista trasa, usługa i koperta kuriera', () => {
  it('P3: pełna przedpłata → odmowa przed kurierem i zapisem przesyłki', async () => {
    const t = zPrzedplata('212.90');
    const r = await t.post(FORMULARZ_DPD);
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Zamówienie ma wpłaty 212.90 zł — pobierz najwyżej 0.00 zł albo wyłącz pobranie. Panel niczego nie nadał.');
    expect(t.fetchDpd).not.toHaveBeenCalled();
    expect(t.przesylki()).toHaveLength(0);
    await expect(t.nadanie.nadaj(t.id, undefined, { pobranieNaTejPaczce: false })).rejects.toThrow('Panel niczego nie nadał.');
    expect(t.fetchDpd).not.toHaveBeenCalled();
    expect(t.przesylki()).toHaveLength(0);
  });
  it.each([['212.90', 'opłacone — wyłącz pobranie'], ['100.00', 'częściowo opłacone — nadaj z karty']])('hurt: %s → %s', (kwota, powod) => {
    const t = zPrzedplata(kwota);
    const wynik = podzielDoNadania([pobierzZamowienie(db, t.id)]);
    expect(wynik.doNadania).toHaveLength(0);
    expect(wynik.pominiete[0].powod).toBe(powod);
  });
  it('GET po wpłacie 100.00 podpowiada 112.90 i ostrzega o przedpłacie', async () => {
    const t = zPrzedplata('100.00');
    const r = await t.get();
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/name="kwota_pobrania" value="112.90"/);
    expect(r.body).toContain('Zamówienie ma wpłaty 100.00 zł');
  });
  it('POST 112.90 po wpłacie 100.00 → koperta z 112.90', async () => {
    const t = zPrzedplata('100.00');
    expect((await t.post({ ...FORMULARZ_DPD, kwota_pobrania: '112.90' })).statusCode).toBe(302);
    expect(t.fetchDpd.mock.calls[0][1].body).toContain('<cod><amount>112.90</amount><currency>PLN</currency></cod>');
  });
  it('POST 212.90 po wpłacie 100.00 → odmowa bez kuriera', async () => {
    const t = zPrzedplata('100.00');
    const r = await t.post(FORMULARZ_DPD);
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('pobierz najwyżej 112.90 zł');
    expect(t.fetchDpd).not.toHaveBeenCalled();
    expect(t.przesylki()).toHaveLength(0);
  });
  it('stare Woo: wpłata sklep 212.90 → P=0 i pełne pobranie', async () => {
    const t = przygotuj({ kanal: 'polcien', metoda: 'dpd' });
    zsynchronizujWplateSklepu(db, t.id, { kwota: '212.90', metoda: 'Płatność przy odbiorze', oplacone_at: '2026-11-03' });
    const z = pobierzZamowienie(db, t.id);
    expect(przedplatyPrzedPobraniem(z, z.platnosci)).toBe(0);
    expect(podzielDoNadania([z]).doNadania).toHaveLength(1);
    expect((await t.get()).body).toMatch(/name="kwota_pobrania" value="212.90"/);
    expect((await t.post(FORMULARZ_DPD)).statusCode).toBe(302);
    expect(t.fetchDpd.mock.calls[0][1].body).toContain('<cod><amount>212.90</amount><currency>PLN</currency></cod>');
  });
});

