import { describe, expect, it } from 'vitest';
import { ofertyPodjazdu } from '../../src/domena/podjazdy.js';

const adres = { name: 'Firma', street: 'Polna 1', postalCode: '32-600', city: 'Pęki', countryCode: 'PL', email: 'test@example.com', phone: '500600700' };
const termin = { date: '2026-09-30', minTime: '13:00', maxTime: '17:00' };
const oferta = (shipmentId, pickupTimes = [termin]) => ({ shipmentId, pickupTimes });
const element = (...proposals) => ({ proposals, address: adres });
const terminy = (odpowiedz, ids = ['a', 'b']) => ofertyPodjazdu(odpowiedz, ids, adres);

describe('oferty dla całego zaznaczonego zestawu', () => {
  it('trzy osobne elementy API mają jeden wspólny termin niezależnie od kolejności', () => {
    expect(terminy([element(oferta('c')), element(oferta('a')), element(oferta('b'))], ['a', 'b', 'c'])).toEqual([termin]);
  });
  it('łączy też mieszane wielkości elementów i wybiera przecięcie ofert', () => {
    const rano = { ...termin, minTime: '08:00', maxTime: '12:00' };
    expect(terminy([element(oferta('c', [rano, termin]), oferta('b')), element(oferta('a', [rano, termin]))], ['a', 'b', 'c'])).toEqual([termin]);
  });
  it('brak/null opcjonalnych pól adresu jest równoważny', () => {
    expect(terminy([element(oferta('a')), { ...element(oferta('b')), address: { ...adres, point: null, state: null, company: null } }])).toEqual([termin]);
  });
  it.each([
    [element(oferta('a'))],
    [element(oferta('a'), oferta('b'), oferta('obca'))],
    [element(oferta('a')), element(oferta('a'))],
    [element(oferta('a'), oferta('b')), element(oferta('a'))],
    [element(oferta('a')), { ...element(oferta('b')), address: { ...adres, street: 'Inna 2' } }],
    [element(oferta('a')), { ...element(oferta('b')), address: undefined }],
    [element(oferta('a')), { ...element(oferta('b')), address: { ...adres, point: 'PUNKT' } }],
    [element(oferta('a')), { ...element(oferta('b')), address: { ...adres, phone: '999999999' } }],
    [element(oferta('a')), element(oferta('b', []))],
    [element(oferta('a')), element(oferta('b', [{ ...termin, maxTime: '18:00' }]))],
    [element(oferta('a')), { proposals: null, address: adres }],
  ])('odmawia niekompletnej lub sprzecznej odpowiedzi %#', (...odpowiedz) => {
    expect(terminy(odpowiedz)).toEqual([]);
  });
  it('adres wspólny paczkom, ale inny niż żądany, nie staje się ofertą', () => {
    expect(terminy([{ ...element(oferta('a'), oferta('b')), address: { ...adres, city: 'Inne miasto' } }])).toEqual([]);
  });
  it('wymaga jawnego adresu żądania i unikalnego zestawu od 1 do 100 paczek', () => {
    expect(ofertyPodjazdu([element(oferta('a'))], ['a'], undefined)).toEqual([]);
    expect(terminy([], [])).toEqual([]);
    expect(terminy([element(oferta('a'), oferta('b'))], ['a', 'a'])).toEqual([]);
    const ids = Array.from({ length: 100 }, (_, i) => `shipment-${i}`);
    expect(terminy(ids.map(id => element(oferta(id))), ids)).toEqual([termin]);
    ids.push('shipment-100');
    expect(terminy(ids.map(id => element(oferta(id))), ids)).toEqual([]);
  });
});
