import { describe, it, expect } from 'vitest';
import { createFakturaHurtem } from '../../../src/moduly/faktury/services/faktura-hurtem.js';
import { proponowanaDataSprzedazy } from '../../../src/domena/data-sprzedazy.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { POST, zamowienie, serwer, cialo, POZYCJA_100 } from './_hurtem-pomocniki.js';

// PRZ-070 (właściciel 14.10.2026): faktura hurtem dla zamówień za pobraniem — wariant
// „przy odbiorze" z tej samej reguły, co formularz karty; opłacone dalej „zapłacone".
const pobranieWiersz = (n = {}) => ({
  id: 1, numer: '1589', kwota_brutto: '104.00', pozycje: [], platnosci: [], wyslane_at: null,
  pobranie: 1, kwota_pobrania: '104.00', ...n,
});
const oplaconeWiersz = { id: 2, numer: '1590', kwota_brutto: '100.00', pozycje: [], platnosci: [{ kwota: '100.00', data: '2026-10-12T09:00:00Z' }], wyslane_at: null };

describe('PRZ-070: usługa faktur hurtem — wariant per zamówienie', () => {
  it('pobranie idzie „przy odbiorze” z datą z propozycji, opłacone „zapłacone” z datą wpłaty', async () => {
    const przekazane = new Map();
    const faktura = { wystaw: async (id, t) => { przekazane.set(id, t); return { numer: `F-${id}` }; } };
    const z = pobranieWiersz();
    await createFakturaHurtem({ faktura }).wystawWiele([z, oplaconeWiersz]);
    expect(przekazane.get(1)).toEqual({ termin: 'przy_odbiorze', dataSprzedazy: proponowanaDataSprzedazy(z).data });
    expect(przekazane.get(2)).toEqual({ termin: 'zaplacone', dataSprzedazy: '2026-10-12' });
  });
});

// Prośba właściciela 14.10 (pierwszy test na produkcji): z ekranu wyniku ma się dać kliknąć
// w zamówienie i od razu poprawić dane do faktury (np. NIP „NIP: 5250000009" z Allegro).
describe('PRZ-070: wynik faktur hurtem prowadzi do zamówienia', () => {
  it('numer to link do karty, a przy błędzie link otwiera edycję danych do faktury', async () => {
    const { app, db } = serwer({
      wystawWiele: async (lista) => ({
        wystawione: [{ id: lista[0].id, numer: 'OK', numerFaktury: 'F-1' }],
        bledy: [{ id: lista[1].id, numer: 'ZLY', powod: 'inFakt odrzucił założenie klienta (422): Podany NIP jest nieprawidłowy.' }],
        nietkniete: [],
      }),
    });
    const a = zamowienie(db, { numer: 'OK', zrodlo: 1, oplacone: true });
    const b = zamowienie(db, { numer: 'ZLY', zrodlo: 2, oplacone: true });
    const r = await app.inject({ method: 'POST', url: '/zamowienia/faktury-hurtem', headers: POST, payload: cialo([a, b]) });
    expect(r.statusCode).toBe(200);
    const bledy = r.body.slice(r.body.indexOf('Nie udało się'));
    expect(r.body).toMatch(new RegExp(`<a class="link-numer"[^>]*href="/zamowienia/${a}"[^>]*>OK</a>`));
    expect(bledy).toMatch(new RegExp(`<a class="link-numer"[^>]*href="/zamowienia/${b}"[^>]*>ZLY</a>`));
    expect(bledy).toContain(`href="/zamowienia/${b}?edytuj=faktura#dane-faktury">Popraw dane do faktury</a>`);
  });
});

describe('PRZ-070: podgląd faktur hurtem z pobraniem', () => {
  it('pobranie nieopłacone stoi w „Pójdzie do inFaktu” z wariantem, a pasek nie twierdzi „wszystkie zapłacone”', async () => {
    const { app, db } = serwer();
    const op = zamowienie(db, { numer: 'OP', zrodlo: 1, oplacone: true });
    const pb = zapiszZamowienie(db, 'pro', {
      zrodlo_id: 2, numer: 'PB', klient: { first_name: 'Jan' }, dostawa: {},
      metoda_wysylki: 'dpd', pobranie: 1, kwota_pobrania: '100.00', chce_fakture: 1, nip: '1234563218',
      kwota_brutto: '100.00', status_woo: 'processing', oplacone_at: null, anulowane: 0, pozycje: [POZYCJA_100],
    }, {});
    const r = await app.inject({ method: 'POST', url: '/zamowienia/faktury-hurtem/podglad', headers: POST, payload: cialo([op, pb]) });
    expect(r.statusCode).toBe(200);
    const sekcja = r.body.slice(r.body.indexOf('Pójdzie do inFaktu'), r.body.indexOf('</ul>', r.body.indexOf('Pójdzie do inFaktu')));
    expect(sekcja).toMatch(/<b>PB<\/b>[^<]*· za pobraniem — przy odbiorze/);
    expect(sekcja).toMatch(/<b>OP<\/b>[^<]*· zapłacona/);
    expect(r.body).not.toContain('Wszystkie faktury z tej drogi idą jako <b>zapłacone</b>');
    expect(r.body).toContain('za pobraniem — z terminem <b>przy odbiorze</b>');
  });
});
