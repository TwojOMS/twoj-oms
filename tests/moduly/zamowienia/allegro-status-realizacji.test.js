import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
// ⚠️ Plan nazywal ten eksport `mapujAllegro` — w kodzie nazywa sie
// `mapujZamowienieAllegro` i bierze WSTRZYKNIETY slownik metod dostawy (adapter podaje
// `metodaZId` z domain/allegro-dostawa.js). Bierzemy prawdziwa funkcje, nie atrape:
// atrapa slownika nie ma tu co mierzyc, a przejscie przez produkcyjne wiazanie jest darmowe.
import { mapujZamowienieAllegro } from '../../../src/domena/allegro-mapowanie.js';
import { metodaZId } from '../../../src/domena/allegro-dostawa.js';

const mapujAllegro = (surowe) => mapujZamowienieAllegro(surowe, { metodaZId });

const surowe = (fulfillment) => ({
  id: 'f1f1f1f1-0000-0000-0000-000000000001',
  status: 'READY_FOR_PROCESSING',
  fulfillment: { status: fulfillment, shipmentSummary: { lineItemsSent: 'NONE' } },
  buyer: { email: 'k@example.com', firstName: 'Jan', lastName: 'Kowalski' },
  payment: { type: 'ONLINE', finishedAt: '2026-08-05T09:00:00Z' },
  delivery: { method: { id: 'x', name: 'Allegro Kurier DPD (AD)' }, cost: { amount: '0.00', currency: 'PLN' } },
  invoice: { required: false },
  lineItems: [{
    id: 'li1', offer: { id: '111', name: 'Szablon' }, quantity: 1,
    price: { amount: '100.00', currency: 'PLN' }, boughtAt: '2026-08-05T08:00:00Z', tax: { rate: '23' },
  }],
  summary: { totalToPay: { amount: '100.00', currency: 'PLN' } },
  surcharges: [],
});

describe('status realizacji z Allegro trafia do KOLUMNY, nie tylko do surowe_json', () => {
  it('zapisuje fulfillment.status i oddaje go przy odczycie', () => {
    const db = openOmsDb(':memory:');
    const id = zapiszZamowienie(db, 'allegro_szkicownia', mapujAllegro(surowe('PROCESSING')), surowe('PROCESSING'));
    expect(pobierzZamowienie(db, id).status_realizacji).toBe('PROCESSING');
  });

  // ⚠️ TO JEST TEST O POLLERZE, NIE O MAPOWANIU. Poller nadpisuje zamówienie co dwie minuty;
  // kolumna pominięta w liście UPDATE zapisze się przy pierwszym zapisie i ZAMROZI na zawsze —
  // a reguła z Zadania 2 czytałaby wtedy stan sprzed tygodnia i wysyłała PROCESSING na SENT.
  it('AKTUALIZUJE kolumnę przy powtórnym zapisie tego samego zamówienia', () => {
    const db = openOmsDb(':memory:');
    zapiszZamowienie(db, 'allegro_szkicownia', mapujAllegro(surowe('NEW')), surowe('NEW'));
    const id = zapiszZamowienie(db, 'allegro_szkicownia', mapujAllegro(surowe('SENT')), surowe('SENT'));
    expect(pobierzZamowienie(db, id).status_realizacji).toBe('SENT');
  });

  it('wartość SPOZA listy z dokumentacji przechodzi bez wywalenia parsera', () => {
    const db = openOmsDb(':memory:');
    const id = zapiszZamowienie(db, 'allegro_szkicownia', mapujAllegro(surowe('CANCELLED')), surowe('CANCELLED'));
    expect(pobierzZamowienie(db, id).status_realizacji).toBe('CANCELLED');
  });

  it('brak fulfillment w ogóle daje NULL, a nie wyjątek', () => {
    const db = openOmsDb(':memory:');
    const bez = { ...surowe('PROCESSING') }; delete bez.fulfillment;
    const id = zapiszZamowienie(db, 'allegro_szkicownia', mapujAllegro(bez), bez);
    expect(pobierzZamowienie(db, id).status_realizacji).toBeNull();
  });
});
