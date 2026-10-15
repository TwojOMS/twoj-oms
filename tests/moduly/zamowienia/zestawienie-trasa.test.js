import { describe, it, expect } from 'vitest';
import { AUTH, POST, serwer, cialo } from '../faktury/_hurtem-pomocniki.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { PDFTOTEXT, pdfNaTekst } from './_pdf-tekst.js';

// „Zestawienie zamówień" (PRZ-084) — wewnetrzny wydruk jak „order-shipping" z Apilo: bloki
// zamowien CIAGIEM (nie strona na zamowienie), dane wysylki w pelni (decyzja właściciela 15.10),
// pozycje z cenami, wysylka jako wiersz, kwota i uwagi klienta. Dane zmyslone.

function zam(db, n = {}) {
  return zapiszZamowienie(db, 'pro', {
    zrodlo_id: n.zrodlo ?? 28313,
    numer: n.numer ?? 'WO-1',
    klient: { first_name: 'Zofia', last_name: 'Zmyślona', email: 'halina@przyklad.test', phone: '600100200' },
    dostawa: {
      first_name: 'Zofia', last_name: 'Zmyślona', address_1: 'Leśna 7', city: 'Bździszewo', postcode: '99-999', country: 'PL',
    },
    metoda_wysylki: 'dpd',
    kwota_pobrania: null,
    chce_fakture: 0,
    nip: null,
    kwota_brutto: '223.90',
    koszt_dostawy_brutto: '0.00',
    status_woo: 'processing',
    oplacone_at: null,
    anulowane: 0,
    uwagi: n.uwagi ?? 'zależy mi na otrzymaniu łuku w środę',
    utworzone_at: n.utworzone ?? '2026-10-14T21:41:52',
    pozycje: [
      { nazwa: 'Półkola zestaw 3szt', sku: 'PK-3', ilosc: 1, cena_brutto: '199.00', brutto_linii: '199.00', vat: null },
      { nazwa: 'Gingerbread - Craft', sku: null, ilosc: 2, cena_brutto: '12.45', brutto_linii: '24.90', vat: null },
    ],
  }, {});
}

describe('trasa: GET /zamowienia/:id/zestawienie.pdf', () => {
  it('PDF inline', async () => {
    const { app, db } = serwer();
    const id = zam(db);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zestawienie.pdf`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toBe('inline; filename="zestawienie-WO-1.pdf"');
  });

  it.skipIf(!PDFTOTEXT)('niesie naglowek, dane wysylki, pozycje z cenami, wysylke, kwote i uwagi', async () => {
    const { app, db } = serwer();
    const id = zam(db);
    const tekst = pdfNaTekst((await app.inject({ method: 'GET', url: `/zamowienia/${id}/zestawienie.pdf`, headers: AUTH })).rawPayload);
    for (const oczekiwane of [
      'WO-1', '28313', 'Data zamówienia: 2026-10-14 21:41', 'Faktura: Nie',
      'Dane wysyłki:', 'Zofia Zmyślona', 'Leśna 7', '99-999 Bździszewo', '600100200', 'halina@przyklad.test',
      'Półkola zestaw 3szt', 'PK-3', '199.00 PLN', 'Gingerbread - Craft', '12.45 PLN', '24.90 PLN',
      'Kwota: 223.90 PLN', 'Uwagi do zamówienia: zależy mi na otrzymaniu łuku w środę', 'str. 1/1',
    ]) {
      expect(tekst, `na zestawieniu ma stac: ${oczekiwane}`).toContain(oczekiwane);
    }
    expect(tekst).toMatch(/DPD/);
  });
});

describe('trasa zbiorcza: POST /zamowienia/zestawienie.pdf', () => {
  it.skipIf(!PDFTOTEXT)('wszystkie zaznaczone CIAGIEM — trzy krotkie zamowienia na jednej stronie', async () => {
    const { app, db } = serwer();
    const ids = [
      zam(db, { numer: 'WO-1', zrodlo: 1, utworzone: '2026-10-14T10:00:00' }),
      zam(db, { numer: 'AL-2', zrodlo: 2, utworzone: '2026-10-13T10:00:00' }),
      zam(db, { numer: 'WO-3', zrodlo: 3, utworzone: '2026-10-12T10:00:00', uwagi: '' }),
    ];
    const r = await app.inject({ method: 'POST', url: '/zamowienia/zestawienie.pdf', headers: POST, payload: cialo(ids) });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toBe('inline; filename="zestawienie-3-zamowien.pdf"');
    const tekst = pdfNaTekst(r.rawPayload);
    expect(tekst).toContain('str. 1/1');
    for (const n of [/1\.\s+WO-1/, /2\.\s+AL-2/, /3\.\s+WO-3/]) expect(tekst).toMatch(n);
  });

  it('bez zaznaczenia — 400', async () => {
    const { app } = serwer();
    const r = await app.inject({ method: 'POST', url: '/zamowienia/zestawienie.pdf', headers: POST, payload: '' });
    expect(r.statusCode).toBe(400);
  });
});

describe('menu „Wydruki"', () => {
  it('karta: specyfikacja, lista produktow (PDF) i zestawienie', async () => {
    const { app, db } = serwer();
    const id = zam(db);
    const html = (await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: AUTH })).body;
    const menu = html.slice(html.indexOf('<details class="wydruki">'), html.indexOf('</details>', html.indexOf('<details class="wydruki">')));
    expect(menu).toContain(`/zamowienia/${id}/specyfikacja.pdf`);
    expect(menu).toContain(`/zamowienia/${id}/lista-produktow.pdf`);
    expect(menu).toContain(`/zamowienia/${id}/zestawienie.pdf`);
  });

  it('lista: menu z trzema wydrukami w miejsce samego przycisku specyfikacji', async () => {
    const { app, db } = serwer();
    zam(db);
    const html = (await app.inject({ method: 'GET', url: '/', headers: AUTH })).body;
    const start = html.indexOf('<details class="wydruki wydruki--masowe">');
    expect(start).toBeGreaterThan(-1);
    const menu = html.slice(start, html.indexOf('</details>', start));
    expect(menu).toMatch(/formaction="\/zamowienia\/specyfikacje\.pdf">Specyfikacje do paczek/);
    expect(menu).toMatch(/formaction="\/zamowienia\/lista-produktow\.pdf" formtarget="_blank">Lista produktów/);
    expect(menu).toMatch(/formaction="\/zamowienia\/zestawienie\.pdf" formtarget="_blank">Zestawienie zamówień/);
    // Przycisk specyfikacji nie stoi juz osobno poza menu.
    expect(html.match(/formaction="\/zamowienia\/specyfikacje\.pdf"/g)).toHaveLength(1);
  });
});
