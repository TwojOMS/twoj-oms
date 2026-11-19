import { describe, expect, it } from 'vitest';
import { cenaPoZmianie } from '../../src/domena/cena-kanalu.js';

describe('cenaPoZmianie', () => {
  it.each([
    [4999, 1000, 5499],
    [333, 5000, 500],
    [1000, -750, 925],
    [1000, -9900, 10],
    [1000, 100000, 11000],
    [Number.MAX_SAFE_INTEGER, -1, 9006298534815517],
  ])('zmienia %i gr o %i bp na %i gr', (gr, wartosc, wynik) => {
    expect(cenaPoZmianie({ gr, tryb: 'o_procent', wartosc })).toEqual({ gr: wynik });
  });

  it.each([-9901, 100001])('odrzuca procent %i bp poza zakresem', (wartosc) => {
    expect(cenaPoZmianie({ gr: 1000, tryb: 'o_procent', wartosc })).toEqual({
      blad: 'PROCENT_POZA_ZAKRESEM',
    });
  });

  it.each([
    [1000, 6120],
    [-1000, 4120],
  ])('zmienia cenę o %i gr na %i gr', (wartosc, wynik) => {
    expect(cenaPoZmianie({ gr: 5120, tryb: 'o_kwote', wartosc, zaokraglenie: 'grosz' })).toEqual({ gr: wynik });
  });

  it.each([null, 0])('pomija cenę %s przy zmianach względnych', (gr) => {
    expect(cenaPoZmianie({ gr, tryb: 'o_procent', wartosc: 1000 })).toEqual({ pominieta: true });
    expect(cenaPoZmianie({ gr, tryb: 'o_kwote', wartosc: 1000 })).toEqual({ pominieta: true });
  });

  it.each([
    [null, '99'],
    [0, 'zloty'],
    [4999, '99'],
  ])('ustawia z ceny %s dokładną kwotę mimo zaokrąglenia %s', (gr, zaokraglenie) => {
    expect(cenaPoZmianie({ gr, tryb: 'na_kwote', wartosc: 5120, zaokraglenie })).toEqual({ gr: 5120 });
  });

  it.each([
    [5120, 5199],
    [5499, 5499],
    [5400, 5499],
    [1, 99],
  ])('zaokrągla %i gr do najbliższej ceny z końcówką 99 od góry (%i gr)', (gr, wynik) => {
    expect(cenaPoZmianie({ gr, tryb: 'o_kwote', wartosc: 0, zaokraglenie: '99' })).toEqual({ gr: wynik });
  });

  it.each([
    [5449, 5400],
    [5450, 5500],
    [50, 100],
  ])('zaokrągla %i gr do pełnych złotych (%i gr)', (gr, wynik) => {
    expect(cenaPoZmianie({ gr, tryb: 'o_kwote', wartosc: 0, zaokraglenie: 'zloty' })).toEqual({ gr: wynik });
  });

  it('zaokrągla procent najpierw do grosza, a potem do złotego', () => {
    expect(cenaPoZmianie({ gr: 333, tryb: 'o_procent', wartosc: 3500, zaokraglenie: 'zloty' })).toEqual({ gr: 500 });
  });

  it.each([
    [-1000, 'grosz', '4,99 zł − 10,00 zł = −5,01 zł'],
    [-499, '99', '4,99 zł − 4,99 zł = 0,00 zł'],
    [-450, 'zloty', '0,49 zł → 0,00 zł'],
  ])('odrzuca niedodatni wynik zmiany o %i gr z zaokrągleniem %s', (wartosc, zaokraglenie, rachunek) => {
    expect(cenaPoZmianie({ gr: 499, tryb: 'o_kwote', wartosc, zaokraglenie })).toEqual({
      blad: 'CENA_NIEDODATNIA',
      rachunek,
    });
  });

  it('odrzuca procent dający zero groszy', () => {
    expect(cenaPoZmianie({ gr: 1, tryb: 'o_procent', wartosc: -9900 })).toEqual({
      blad: 'CENA_NIEDODATNIA',
      rachunek: '0,01 zł × (100% − 99,00%) = 0,00 zł',
    });
  });

  it.each([
    [0, '0,00 zł'],
    [-1, '−0,01 zł'],
  ])('odrzuca ustawienie ceny na %i gr', (wartosc, rachunek) => {
    expect(cenaPoZmianie({ gr: null, tryb: 'na_kwote', wartosc })).toEqual({
      blad: 'CENA_NIEDODATNIA',
      rachunek,
    });
  });

  it.each([
    ['o_procent', 100000, 'grosz'],
    ['o_kwote', 2, 'grosz'],
    ['o_kwote', 0, '99'],
  ])('odrzuca wynik poza zakresem bezpiecznych groszy (%s, %i, %s)', (tryb, wartosc, zaokraglenie) => {
    expect(cenaPoZmianie({ gr: Number.MAX_SAFE_INTEGER, tryb, wartosc, zaokraglenie })).toEqual({
      blad: 'CENA_POZA_ZAKRESEM',
    });
  });
});
