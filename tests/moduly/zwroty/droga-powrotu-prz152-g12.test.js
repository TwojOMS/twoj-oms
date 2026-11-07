// PRZ-152.G12: z każdego ekranu zwrotu widać drogę powrotu na kartę zamówienia.
import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const AUTH = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
  'content-type': 'application/x-www-form-urlencoded',
};
const CONFIG = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };

const zmapowane = () => ({
  zrodlo_id: 2474, numer: '2474', klient: { email: 'j@k.pl' }, dostawa: {},
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '99.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00',
  utworzone_at: '2026-08-01T10:00:00',
  pozycje: [{ zrodlo_id: 77, nazwa: 'Kot 70x100', sku: 'PRO-KOT-001', ilosc: 1, cena_brutto: '99.00', brutto_linii: '99.00', vat: null }],
});

let db; let app; let id;
beforeEach(() => {
  db = openOmsDb(':memory:');
  id = zapiszZamowienie(db, 'pro', zmapowane(), {});
  app = buildOmsServer({ db, config: CONFIG });
});

const karta = () => `/zamowienia/${id}`;
const podglad = () => app.inject({
  method: 'POST', url: `/zamowienia/${id}/zwrot/podglad`, headers: AUTH,
  payload: new URLSearchParams([
    ['data', '2026-08-14'], ['kwota_dostawy', ''], ['powod', 'nie pasuje'],
    ['klucz', 's77'], ['ilosc', '1'], ['nazwa', 'Kot 70x100'], ['pozycja_kwota', '99.00'],
  ]).toString(),
});
const ekrany = async () => {
  const krok1 = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
  const krok2 = await podglad();
  return { krok1, krok2 };
};
const przyciskiLinki = (html) => [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);

describe('droga powrotu z ekranów zwrotu (PRZ-152.G12)', () => {
  it('ścieżka u góry: „Zamówienie N / Zwrot”, a nie „Zwrot — zamówienie N”', async () => {
    const { krok1, krok2 } = await ekrany();
    for (const r of [krok1, krok2]) {
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('<strong><a class="oms-breadcrumb-link" href="/zamowienia/' + id + '">Zamówienie 2474</a> / Zwrot</strong>');
    }
  });

  it('PRZ-152.G12b: „Zamówienie N” w ścieżce jest odnośnikiem na kartę; inne ekrany mają ścieżkę jak dotąd', async () => {
    const { krok1, krok2 } = await ekrany();
    for (const r of [krok1, krok2]) {
      const sciezka = r.body.slice(r.body.indexOf('class="oms-breadcrumb"'), r.body.indexOf('</div>', r.body.indexOf('class="oms-breadcrumb"')));
      expect(przyciskiLinki(sciezka)).toEqual([`<a class="oms-breadcrumb-link" href="${karta()}">Zamówienie 2474</a>`]);
    }
    const lista = await app.inject({ method: 'GET', url: '/', headers: AUTH });
    expect(lista.statusCode).toBe(200);
    const sc = lista.body.slice(lista.body.indexOf('class="oms-breadcrumb"'), lista.body.indexOf('</div>', lista.body.indexOf('class="oms-breadcrumb"')));
    expect(przyciskiLinki(sc)).toEqual([]);
    expect(sc).toMatch(/<strong>[^<]+<\/strong>/);
  });

  it('przy tytule jest zwykły przycisk „← Zamówienie N” na kartę (nie cichy)', async () => {
    const { krok1, krok2 } = await ekrany();
    for (const r of [krok1, krok2]) {
      // PRZ-154 E2.1: akcja zachowuje klasę i adres w slocie wspólnego nagłówka.
      const glowa = r.body.match(/<header class="naglowek-ekranu"[\s\S]*?<\/header>/)?.[0] ?? '';
      const a = przyciskiLinki(glowa).find((l) => l.includes('← Zamówienie 2474'));
      expect(a).toBeTruthy();
      expect(a).toContain(`href="${karta()}"`);
      expect(a).toMatch(/class="btn"/);
      expect(a).not.toContain('btn--cichy');
    }
  });

  it('krok 1: dolne „Wróć do zamówienia” jest drugorzędne i stoi PRZED „Dalej — sprawdź sumę”', async () => {
    const { krok1 } = await ekrany();
    const html = krok1.body;
    const wroc = html.indexOf('Wróć do zamówienia');
    const dalej = html.indexOf('Dalej — sprawdź sumę');
    expect(wroc).toBeGreaterThan(-1);
    expect(wroc).toBeLessThan(dalej);
    const a = przyciskiLinki(html).find((l) => l.includes('Wróć do zamówienia'));
    expect(a).toContain('btn--drugi');
    expect(a).not.toContain('btn--cichy');
    expect(a).toContain(`href="${karta()}"`);
  });

  it('krok 2 (sprawdzenie sumy) ma link na kartę zamówienia', async () => {
    const { krok2 } = await ekrany();
    expect(krok2.body).toContain(`href="${karta()}"`);
    expect(przyciskiLinki(krok2.body).some((l) => l.includes('Wróć do zamówienia') && l.includes('btn--drugi'))).toBe(true);
  });

  it('ekran po zapisie zwrotu (ten sam widok) ma link na kartę', async () => {
    const zapis = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwrot`, headers: AUTH,
      payload: new URLSearchParams([
        ['data', '2026-08-14'], ['kwota', '99.00'], ['kwota_dostawy', ''],
        ['klucz', 's77'], ['ilosc', '1'], ['nazwa', 'Kot 70x100'], ['pozycja_kwota', '99.00'],
      ]).toString(),
    });
    expect(zapis.statusCode).toBe(302);
    const r = await app.inject({ method: 'GET', url: zapis.headers.location, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(przyciskiLinki(r.body).some((l) => l.includes('← Zamówienie 2474') && l.includes(`href="${karta()}"`))).toBe(true);
  });
});
