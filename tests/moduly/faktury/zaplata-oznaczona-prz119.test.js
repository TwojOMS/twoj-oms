// PRZ-119.05 (recenzja) — Fakturownia oznacza zapłatę dwoma żądaniami: zmiana statusu, potem PUT daty zapłaty. Gdy padnie
// sam PUT, klient rzuca błąd z `zaplataOznaczona: true` — faktura JEST opłacona. Wpis w historii zamówienia ma to
// powiedzieć wprost („popraw tylko datę zapłaty”), bez „NIEOPŁACONA”, które kazałoby oznaczać zapłatę drugi raz.
// Dane zmyślone, bez sieci.
import { describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';
import { programTestowy } from '../../pomoc/program-testowy.js';

const bladPut = () => Object.assign(new Error('Fakturownia nie przyjęła daty zapłaty (zmyślony błąd).'), { status: 422, zaplataOznaczona: true });

describe('PRZ-119.05 wystawienie: padł sam zapis daty zapłaty', () => {
  it('wpis mówi „już oznaczona jako opłacona — popraw tylko datę zapłaty”, bez „NIEOPŁACONA”', async () => {
    const db = openOmsDb(':memory:');
    const p = programTestowy({ id: 'test', metody: { oznaczZaplacona: async () => { throw bladPut(); } } });
    try {
      const id = zapiszZamowienie(db, 'pro', { zrodlo_id: 11, numer: '11', klient: { first_name: 'Ala', last_name: 'Półcień', address_1: 'Lampowa 1', postcode: '00-950', city: 'Warszawa' }, dostawa: {},
        metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: null, kwota_brutto: '100.00', koszt_dostawy_brutto: '0.00',
        status_woo: 'processing', oplacone_at: '2026-07-01', anulowane: 0,
        pozycje: [{ zrodlo_id: 1, nazwa: 'Klosz', sku: 'K1', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00', vat: null }] }, {});
      await createFaktura({ db, program: p }).wystaw(id, { termin: 'zaplacone' });
      const wpisy = db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'faktura'").all(id).map((w) => w.wynik).join(' ');
      expect(wpisy).toContain('jest już oznaczona jako opłacona w Testowniku — popraw tylko datę zapłaty');
      expect(wpisy).not.toContain('NIEOPŁACONA');
    } finally { db.close(); }
  });
});
