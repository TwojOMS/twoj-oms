import { describe, it, expect } from 'vitest';
import { daneFaktury, bezEtykietyNip } from '../../src/domena/dane-faktury.js';
import { mapujZamowienieAllegro } from '../../src/domena/allegro-mapowanie.js';
import { metodaZId } from '../../src/domena/allegro-dostawa.js';

// Zgłoszenie właściciela 14.10 (pierwszy test faktur hurtem): kupujący na Allegro wpisał w pole
// NIP „NIP: 5250000009”, OMS przekazał to dosłownie, inFakt odrzucił (422 „Podany NIP jest
// nieprawidłowy”). W bazie produkcyjnej były co najmniej dwa takie zamówienia.
describe('NIP bez etykiety „NIP”', () => {
  it.each([
    ['NIP: 5250000009', '5250000009'],
    ['NIP: 1000001098', '1000001098'],
    ['nip 1000001098', '1000001098'],
    ['NIP:PL1234563218', 'PL1234563218'],
    ['NIP. 123-456-32-18', '123-456-32-18'],
    ['  NIP -  5250000009 ', '5250000009'],
  ])('„%s” → „%s”', (surowy, czysty) => {
    expect(bezEtykietyNip(surowy)).toBe(czysty);
  });

  it.each([
    ['5250000009'], ['SK1000000001'], ['PL1234563218'], ['123-456-32-18'],
  ])('numer bez etykiety „%s” zostaje bajt w bajt', (n) => {
    expect(bezEtykietyNip(n)).toBe(n);
  });

  it.each([[null], [''], ['NIP:'], ['  ']])('pusty albo sama etykieta (%s) → null', (n) => {
    expect(bezEtykietyNip(n)).toBeNull();
  });

  it('dane do faktury zamówienia JUŻ zapisanego z etykietą dają czysty NIP', () => {
    expect(daneFaktury({ nip: 'NIP: 5250000009', klient: {} }).nip).toBe('5250000009');
  });

  it('ręczna poprawka operatora dalej wygrywa', () => {
    const z = { nip: 'NIP: 5250000009', klient: {}, klient_reczny_json: JSON.stringify({ nip: '1234563218' }) };
    expect(daneFaktury(z).nip).toBe('1234563218');
  });

  it('nowe zamówienie z Allegro zapisuje NIP już bez etykiety', () => {
    const surowe = {
      id: 'f1f1f1f1-0000-0000-0000-000000000070',
      status: 'READY_FOR_PROCESSING',
      buyer: { email: 'k@example.com', firstName: 'Jan', lastName: 'Kowalski' },
      payment: { type: 'ONLINE', finishedAt: '2026-10-13T12:56:00Z' },
      delivery: { method: { id: 'x', name: 'Allegro Kurier DPD (AD)' }, cost: { amount: '0.00', currency: 'PLN' } },
      invoice: { required: true, address: { company: { name: 'Firma Testowa', taxId: 'NIP: 5250000009' } } },
      lineItems: [{
        id: 'li1', offer: { id: '111', name: 'Szablon' }, quantity: 1,
        price: { amount: '74.90', currency: 'PLN' }, boughtAt: '2026-10-13T12:55:00Z', tax: { rate: '23' },
      }],
      summary: { totalToPay: { amount: '74.90', currency: 'PLN' } },
      surcharges: [],
    };
    expect(mapujZamowienieAllegro(surowe, { metodaZId }).nip).toBe('5250000009');
  });
});
