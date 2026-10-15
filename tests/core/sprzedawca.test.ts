import { describe, it, expect } from 'vitest';
import { wczytajSprzedawce } from '../../src/core/sprzedawca.ts';
import { poprawnyNip, poprawnyRachunek } from '../../src/core/walidatory.ts';

const OK = { OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000' };

describe('walidatory', () => {
  it('NIP odrzuca złą sumę, długość, znaki oraz resztę 10', () => {
    expect(poprawnyNip(OK.OMS_SPRZEDAWCA_NIP)).toBe(true);
    for (const nip of ['1234563219', '123456321', '12345632180', '123456321x', '1234567890']) {
      expect(poprawnyNip(nip)).toBe(false);
    }
  });
  it('NRB wymaga 26 cyfr oraz poprawnej sumy mod 97', () => {
    expect(poprawnyRachunek(OK.OMS_RACHUNEK)).toBe(true);
    for (const nrb of ['34109010140000000000000001', '3410901014000000000000000', '341090101400000000000000000', '3410901014000000000000000x']) {
      expect(poprawnyRachunek(nrb)).toBe(false);
    }
  });
});

describe('wczytajSprzedawce', () => {
  it('normalizuje prefiks PL, spacje i myślniki, nie dokłada BDO ani banku', () => {
    expect(wczytajSprzedawce({ OMS_SPRZEDAWCA_NIP: ' pl 123-456-32-18 ', OMS_RACHUNEK: 'PL34 1090 1014 0000 0000 0000 0000' }))
      .toEqual({ nip: '1234563218', rachunek: '34109010140000000000000000', bdo: null, bank: null });
  });
  it('brak obu pól daje jeden błąd z obiema nazwami', () => {
    expect(() => wczytajSprzedawce({})).toThrow(/OMS_SPRZEDAWCA_NIP[\s\S]*OMS_RACHUNEK/);
    expect(() => wczytajSprzedawce({ OMS_SPRZEDAWCA_NIP: ' ', OMS_RACHUNEK: '\t' })).toThrow(/OMS_SPRZEDAWCA_NIP[\s\S]*OMS_RACHUNEK/);
  });
  it('literówka rachunku blokuje start', () => {
    expect(() => wczytajSprzedawce({ ...OK, OMS_RACHUNEK: '34109010140000000000000001' })).toThrow('OMS_RACHUNEK: niepoprawny numer rachunku');
  });
  it('BDO ma 9 cyfr, bank pochodzi z konfiguracji', () => {
    expect(wczytajSprzedawce({ ...OK, OMS_SPRZEDAWCA_BDO: ' 000123456 ', OMS_BANK: ' Bank próbny ' }))
      .toEqual({ nip: '1234563218', rachunek: '34109010140000000000000000', bdo: '000123456', bank: 'Bank próbny' });
    expect(() => wczytajSprzedawce({ ...OK, OMS_SPRZEDAWCA_BDO: '12345' })).toThrow('OMS_SPRZEDAWCA_BDO');
    expect(wczytajSprzedawce({ ...OK, OMS_SPRZEDAWCA_BDO: ' ', OMS_BANK: ' ' }).bank).toBeNull();
  });
  it('błąd wymienia nazwy zmiennych, lecz nie wartości wejściowych', () => {
    const odczyt = () => wczytajSprzedawce({ OMS_SPRZEDAWCA_NIP: '1234563219', OMS_RACHUNEK: 'rachunek-sekret', OMS_SPRZEDAWCA_BDO: 'bdo-sekret' });
    expect(odczyt).toThrow(/OMS_SPRZEDAWCA_NIP[\s\S]*OMS_RACHUNEK[\s\S]*OMS_SPRZEDAWCA_BDO/);
    expect(odczyt).not.toThrow(/1234563219|rachunek-sekret|bdo-sekret/);
  });
});
