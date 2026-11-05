import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createInpostClient } from '../../../src/oms/kurierzy/inpost.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { zapiszUmowePobrania } from '../../../src/moduly/wysylka/db/umowy-pobrania.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// Od PRZ-152.G1 błąd nadania to strona w układzie OMS — porównujemy sam komunikat z paska uwagi.
const komunikatNadania = (html) => (html.match(/<p class="pasek-uwaga" role="alert">([\s\S]*?)<\/p>/)?.[1] ?? html)
  .replace(/&#34;|&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const naglowki = { authorization: 'Basic ' + Buffer.from('operator:atrapa').toString('base64'), origin: 'http://localhost' };
const PODPOWIEDZ = 'Paczkomat za pobraniem włączysz w <a href="/ustawienia/integracje/inpost#inpost-pobranie">Ustawienia → Integracje → Kurier InPost</a>, jeśli masz umowę na pobranie.';
const ADRES = { nazwa: 'Ala Przykładowa', ulica: 'Przykładowa 12', kod: '00-001', miasto: 'Warszawa', kraj: 'PL', phone: '+48500100200', email: 'ala@example.test' };
const FORMULARZ = { ...ADRES, waga: '1', gabaryt: 'A', kolejnosc: '1', punkt_odbioru: 'WAW01M', kurier: 'inpost_paczkomat', kwota_pobrania: '212.90' };
let db, serwer, katalog;

beforeEach(() => { db = openOmsDb(':memory:'); });
afterEach(async () => {
  if (serwer) await serwer.close();
  serwer = undefined;
  db.close();
  if (katalog) rmSync(katalog, { recursive: true, force: true });
  katalog = undefined;
});

function przygotuj({ umowa, metoda = 'allegro_dpd', kwota = '212.90', pobranie = 1 } = {}) {
  if (umowa !== undefined) zapiszUmowePobrania(db, 'inpost', umowa);
  const fetchImpl = vi.fn(async (url, opcje) => {
    if (String(url).includes('format=')) return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('%PDF-1.4\n') };
    const body = JSON.parse(opcje.body);
    return { ok: true, status: 201, text: async () => JSON.stringify({ id: 12345, tracking_number: '520000000000000000000001', cod: body.cod }) };
  });
  const inpost = createInpostClient({ url: 'https://shipx.example.test/v1', token: 'atrapa', organizacja: 12345,
    nadawca: { ...ADRES, nazwa: 'Pracownia Półcień' }, fetchImpl });
  katalog = mkdtempSync(join(tmpdir(), 'pobranie-inpost-t2-'));
  const nadanie = createNadanie({ db, kurierzy: { inpost }, katalogEtykiet: katalog });
  const config = { auth: { user: 'operator', pass: 'atrapa' },
    definicje: [{ klucz: 'allegro_test', typ: 'allegro', prefiks: 'TEST', etykieta: 'Allegro test', raport: 'TEST' }],
    kanaly: { allegro_test: {} }, sklepy: {} };
  serwer = buildOmsServer({ db, config, nadanie, poller: { stan: () => ({}) } });
  const id = zapiszZamowienie(db, 'allegro_test', {
    zrodlo_id: 'test-1', numer: 'TEST-1', klient: { email: ADRES.email, phone: ADRES.phone },
    dostawa: { first_name: 'Ala', last_name: 'Przykładowa', address_1: ADRES.ulica, postcode: ADRES.kod, city: ADRES.miasto, country: 'PL' },
    metoda_wysylki: metoda, pobranie, kwota_pobrania: kwota, kwota_brutto: '212.90', chce_fakture: 0, nip: null,
    punkt_odbioru: 'WAW01M', status_woo: 'processing', oplacone_at: null, anulowane: 0, pozycje: [], utworzone_at: '2026-11-03T12:00:00',
  }, {});
  const post = (payload = FORMULARZ) => serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowki, payload });
  const get = (query = '?wybor=1') => serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj${query}`, headers: naglowki });
  const hurt = (koncowka = 'nadaj-podglad', pola = {}) => serwer.inject({ method: 'POST', url: `/zamowienia/masowe/${koncowka}`, headers: naglowki, payload: { id: String(id), ...pola } });
  const cialo = () => JSON.parse(fetchImpl.mock.calls.find(([url]) => !String(url).includes('format='))[1].body);
  return { id, post, get, hurt, fetchImpl, cialo, nadanie };
}

describe('umowa InPost na pobranie w nadaniu', () => {
  it('włączone: POST Allegro wysyła cod.amount 212.90 i paczka nie wymaga wyjaśnienia', async () => {
    const t = przygotuj({ umowa: true });
    expect((await t.post()).statusCode).toBe(302);
    expect(t.cialo().cod).toEqual({ amount: 212.90, currency: 'PLN' });
    expect(db.prepare('SELECT status FROM przesylki WHERE zamowienie_id = ?').get(t.id).status).toBe('nadana');
  });

  it.each(['', null])('włączone, pusta kolumna %s i brak kwoty w żądaniu: odmowa bez fetch', async (kwota) => {
    const t = przygotuj({ umowa: true, kwota });
    const { kwota_pobrania, ...bezKwoty } = FORMULARZ;
    const r = await t.post(bezKwoty);
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/pusta.*|bez pobrania/i);
    expect(t.fetchImpl).not.toHaveBeenCalled();
    expect(db.prepare('SELECT * FROM przesylki').all()).toHaveLength(0);
  });

  it('włączone: GET daje opcję paczkomatu i jego formularz bez podpowiedzi', async () => {
    const t = przygotuj({ umowa: true });
    const r = await t.get();
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('kurier=inpost_paczkomat');
    expect(r.body).not.toContain(PODPOWIEDZ);
    expect((await t.get('?kurier=inpost_paczkomat')).statusCode).toBe(200);
  });

  it.each([false, undefined])('wyłączone (%s): POST odmawia, GET pokazuje podpowiedź bez paczkomatu', async (umowa) => {
    const t = przygotuj({ umowa });
    const r = await t.post();
    expect(r.statusCode).toBe(400);
    expect(komunikatNadania(r.body)).toBe('Nie umiem nadać tej paczki jako „inpost_paczkomat" — do wyboru jest Wysyłam z Allegro — umowa Allegro (domyślnie) albo DPD — nasza umowa. Panel niczego nie nadał.');
    expect(t.fetchImpl).not.toHaveBeenCalled();
    const karta = await t.get();
    expect(karta.statusCode).toBe(200);
    expect(karta.body).toContain(PODPOWIEDZ);
    expect(karta.body).not.toContain('kurier=inpost_paczkomat');
  });

  it('bez pobrania i bez umowy nie pokazuje podpowiedzi', async () => {
    const t = przygotuj({ pobranie: 0 });
    const r = await t.get();
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('kurier=inpost_paczkomat');
    expect(r.body).not.toContain(PODPOWIEDZ);
  });

  // PRZ-137.01: paczkomat Allegro za pobraniem to pobranie SKLEPOWE — idzie do kuriera niezależnie
  // od przełącznika umowy (decyzja właściciela 03.11). Odmowę dla pobrania OMS-owego pilnuje
  // tests/domena/pobranie-sklepowe-137.test.ts.
  it.each([true, false])('podgląd hurtu, umowa %s: sklepowy paczkomat za pobraniem idzie do kuriera', async (umowa) => {
    const t = przygotuj({ umowa, metoda: 'allegro_paczkomat' });
    const r = await t.hurt();
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Pójdzie do kuriera — 1');
    expect(r.body).toContain('212.90');
    expect(r.body).not.toContain('wymaga umowy');
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([false, undefined])('hurt BEZ umowy (%s): sklepowy paczkomat za pobraniem nadany z cod 212.90', async (umowa) => {
    const t = przygotuj({ umowa, metoda: 'allegro_paczkomat' });
    const r = await t.hurt('nadaj', { [`gabaryt_${t.id}`]: 'A' });
    expect(r.statusCode).toBe(200);
    expect(t.cialo().cod).toEqual({ amount: 212.90, currency: 'PLN' });
    expect(db.prepare('SELECT status FROM przesylki WHERE zamowienie_id = ?').get(t.id).status).toBe('nadana');
  });

  it('hurt z umową wysyła cod.amount 212.90 przez usługę', async () => {
    const t = przygotuj({ umowa: true, metoda: 'allegro_paczkomat' });
    const r = await t.hurt('nadaj', { [`gabaryt_${t.id}`]: 'A' });
    expect(r.statusCode).toBe(200);
    expect(t.cialo().cod.amount).toBe(212.90);
  });
});
