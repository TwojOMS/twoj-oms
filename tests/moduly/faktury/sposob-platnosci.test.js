import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie, zapiszNadpisanieWysylki } from '../../../src/oms/db/zamowienia.js';

import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';
import { sposobPlatnosciFaktury, PLATNOSC_POBRANIE } from '../../../src/domena/sposob-platnosci.js';

// ZGŁOSZENIE WŁAŚCICIELA 2026-08-07: faktura 18/08/2026 do allegrowego zamówienia ZA
// POBRANIEM (220,89 zł) wyszła z sposobem płatności „przelew" i terminem na dziś. Panel
// pola `payment_method` nie wysyłał w ogóle, więc inFakt podstawiał domyślne z ustawień
// konta. Zmierzone na żywym dokumencie przed poprawką: payment_method='transfer'.
//
// Wartość `delivery` jest ZMIERZONA na koncie (30 dokumentów z Apilo), nie wzięta
// z dokumentacji — szczegóły pomiaru w domain/sposob-platnosci.js.
describe('sposób płatności na fakturze — reguła', () => {
  it('zamówienie za pobraniem dostaje payment_method „delivery”', () => {
    expect(sposobPlatnosciFaktury({ pobranie: 1 })).toEqual({ payment_method: PLATNOSC_POBRANIE });
  });

  // ⚠️ PUSTY OBIEKT, NIE „transfer". Zamówienie przedpłacone bywa opłacone kartą, P24 albo
  // PayU — wpisanie im wszystkim „przelewu" byłoby tym samym kłamstwem, tylko naszym.
  it('zamówienie przedpłacone NIE dostaje żadnego pola — payload jak dotąd', () => {
    expect(sposobPlatnosciFaktury({ pobranie: 0 })).toEqual({});
    expect(sposobPlatnosciFaktury({})).toEqual({});
    expect(sposobPlatnosciFaktury(null)).toEqual({});
  });
});

const zmapowane = (nad = {}) => ({
  zrodlo_id: 1301, numer: '1301',
  klient: { first_name: 'Jan', last_name: 'Kowalski', company: 'ACME', email: 'j@k.pl', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki' },
  dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null,
  chce_fakture: 1, nip: '1000001201', kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-07-29T13:19:52',
  pozycje: [{ nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 2, cena_brutto: '61.50', vat: null }],
  ...nad,
});

function zestaw(nad = {}) {
  const db = openOmsDb(':memory:');
  const infakt = {
    znajdzKlientaPoNip: vi.fn().mockResolvedValue(7),
    zalozKlienta: vi.fn().mockResolvedValue(555),
    wystaw: vi.fn().mockResolvedValue({ uuid: 'u1', numer: 'FV/1/2026', ksefStatus: null }),
    oznaczZaplacona: vi.fn().mockResolvedValue({ referencja: 'ref-1' }),
  };
  const id = zapiszZamowienie(db, 'pro', zmapowane(nad), {});
  return { db, infakt, id, faktura: createFaktura({ db, infakt }) };
}

describe('sposób płatności trafia na dokument', () => {
  it('faktura do zamówienia za pobraniem niesie payment_method „delivery”', async () => {
    const { infakt, faktura, id } = zestaw({ metoda_wysylki: 'dpd', pobranie: 1, kwota_pobrania: '123.00' });
    await faktura.wystaw(id);
    expect(infakt.wystaw.mock.calls[0][0].payment_method).toBe('delivery');
  });

  // Płatność przy odbiorze to fakt o zamówieniu, nie o terminie wybranym w formularzu —
  // więc pole ma jechać niezależnie od tego, co operator wybrał w „terminie".
  it('jedzie niezależnie od wybranego terminu płatności', async () => {
    const { infakt, faktura, id } = zestaw({ metoda_wysylki: 'dpd', pobranie: 1, kwota_pobrania: '123.00' });
    await faktura.wystaw(id, { termin: 14 });
    expect(infakt.wystaw.mock.calls[0][0].payment_method).toBe('delivery');
  });

  // ⚠️ NAJWAŻNIEJSZY TEST OCHRONNY: payload zamówienia przedpłaconego ma zostać taki,
  // jaki był. Faktura to dokument księgowy — nowe pole ma dojść TYLKO tam, gdzie coś znaczy.
  it('faktura do zamówienia przedpłaconego NIE MA tego pola w ogóle', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id);
    expect(Object.hasOwn(infakt.wystaw.mock.calls[0][0], 'payment_method')).toBe(false);
  });

  // Ręczna korekta metody na karcie wygrywa nad tym, co powiedział sklep — inaczej
  // poprawka operatora i treść faktury rozjeżdżałyby się po cichu.
  it('pobranie ustawione RĘCZNIE na karcie też trafia na dokument', async () => {
    const { db, infakt, faktura, id } = zestaw();
    zapiszNadpisanieWysylki(db, id, { metoda: 'dpd', pobranie: 1, kwota_pobrania: '123.00' });
    expect(pobierzZamowienie(db, id).pobranie).toBeTruthy();
    await faktura.wystaw(id);
    expect(infakt.wystaw.mock.calls[0][0].payment_method).toBe('delivery');
  });
});
