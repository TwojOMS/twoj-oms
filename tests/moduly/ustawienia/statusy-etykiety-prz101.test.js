import { it, expect } from 'vitest';
import { nowyPanel, BASIC, post } from '../../pomoc/konta-prz068.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszStatusy } from '../../../src/oms/db/statusy.js';
import { domyslneStatusy } from '../../../src/domena/statusy-konfiguracja.js';

it('objaśnienie w podglądzie nadania używa zmienionej nazwy statusu Wysłane', async () => {
  const { db, app } = nowyPanel({ nadanie: {
    paczkaDomyslna: { waga: 1, dlugosc: 30, szerokosc: 20, wysokosc: 10 },
    nadaj: () => { throw new Error('Podgląd nie może nadać paczki.'); },
  } });
  try {
    await app.ready();
    const statusy = domyslneStatusy();
    statusy.find(s => s.klucz === 'wyslane').etykieta = 'W drodze';
    zapiszStatusy(db, statusy);
    const id = zapiszZamowienie(db, 'reczne', {
      zrodlo_id: 1, numer: 'LAMPA-1', klient: { email: 'klient@example.invalid', phone: '500000000' },
      dostawa: { first_name: 'Jan', last_name: 'Testowy', address_1: 'Przykładowa 1', postcode: '00-001', city: 'Testowo', country: 'PL' },
      metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '10.00',
      status_woo: 'processing', oplacone_at: '2026-10-18T12:00:00Z', anulowane: 0,
      utworzone_at: '2026-10-18T12:00:00Z', pozycje: [{ nazwa: 'Lampa testowa', sku: 'LAMPA-TEST', ilosc: 1, cena_brutto: '10.00', vat: '23' }],
    }, {});
    const r = await post(app, '/zamowienia/masowe/nadaj-podglad', BASIC, { id: [String(id)] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('na „W drodze”');
    expect(r.body).not.toContain('na „Wysłane”');
  } finally { await app.close(); db.close(); }
});
