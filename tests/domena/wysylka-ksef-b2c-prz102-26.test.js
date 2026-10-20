import { describe, it, expect } from 'vitest';
import { coWolnoWyslac, doZaznaczeniaWszystkich, POWOD_KOREKTA, POWOD_KONSUMENCKA } from '../../src/domena/wysylka-ksef.js';

const b2c = { uuid: 'b2c', rodzaj: 'vat', number: 'FV/26', gross_price: 12300,
  client_first_name: 'Jan', client_last_name: 'Przykładowy', client_tax_code: '', stanKsef: 'brak' };

describe('PRZ-102.26 dobrowolna wysyłka B2C', () => {
  it('włączone: konsumencka z danymi nabywcy ma pole wyboru i przechodzi barierę', () => {
    expect(doZaznaczeniaWszystkich(b2c, true)).toBe(true);
    expect(coWolnoWyslac(['b2c'], [b2c], true).doWyslania).toEqual([{ uuid: 'b2c', numer: 'FV/26' }]);
  });
  it('wyłączone: identyczny zbiór i tekst jak domyślnie', () => {
    expect(doZaznaczeniaWszystkich(b2c, false)).toBe(false);
    expect(coWolnoWyslac(['b2c'], [b2c], false)).toEqual(coWolnoWyslac(['b2c'], [b2c]));
    expect(coWolnoWyslac(['b2c'], [b2c]).pominiete[0].powod).toBe(POWOD_KONSUMENCKA);
  });
  it.each([
    { number: null, gross_price: null, client_first_name: null, client_last_name: null },
    { number: null }, { gross_price: null }, { client_first_name: ' ', client_last_name: null },
  ])('włączone nie otwiera braku danych %j', (braki) => {
    const d = { ...b2c, ...braki };
    expect(doZaznaczeniaWszystkich(d, true)).toBe(false);
    expect(coWolnoWyslac(['b2c'], [d], true).doWyslania).toEqual([]);
    expect(coWolnoWyslac(['b2c'], [d], true).pominiete[0].powod).toContain('danych');
  });
  it('włączone nie otwiera korekty, rezerwacji, numeru KSeF ani obcego uuid', () => {
    const korekta = { ...b2c, rodzaj: 'korekta' };
    expect(coWolnoWyslac(['b2c'], [korekta], true).pominiete[0].powod).toBe(POWOD_KOREKTA);
    expect(doZaznaczeniaWszystkich(korekta, true)).toBe(false);
    for (const zmiana of [{ ksefZleconaAt: '2026-10-20' }, { ksef_number: 'KSEF-26' }]) {
      expect(coWolnoWyslac(['b2c'], [{ ...b2c, ...zmiana }], true).doWyslania).toEqual([]);
    }
    expect(coWolnoWyslac(['obcy'], [b2c], true).doWyslania).toEqual([]);
  });
});
