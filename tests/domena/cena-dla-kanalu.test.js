import { describe, expect, it } from 'vitest';
import { cenaDlaKanalu, cenyBruttoSklepu, roznicaBp } from '../../src/domena/cena-kanalu.js';

describe('cenaDlaKanalu — jedno źródło ceny docelowej', () => {
  it('ręczna cena kanału wygrywa z narzutem (100 zł, 10%, ręczna 105 zł → 105,00 zł)', () => {
    expect(cenaDlaKanalu({ kartaGr: 10000, narzutBp: 1000, recznaGr: 10500 })).toEqual({
      bledy: [],
      grosze: 10500,
      zrodlo: 'reczna',
    });
  });

  it('ręczna cena nie potrzebuje poprawnej ceny karty ani narzutu', () => {
    expect(cenaDlaKanalu({ kartaGr: null, narzutBp: undefined, recznaGr: 3999 })).toEqual({
      bledy: [],
      grosze: 3999,
      zrodlo: 'reczna',
    });
  });

  it.each([null, undefined])('bez ręcznej ceny (%s) liczy kartę z narzutem (100 zł + 10% → 110,00 zł)', (recznaGr) => {
    expect(cenaDlaKanalu({ kartaGr: 10000, narzutBp: 1000, recznaGr })).toEqual({
      bledy: [],
      grosze: 11000,
      zrodlo: 'narzut',
    });
  });

  it('zaokrągla połówkę grosza w górę (33,33 zł + 15% = 38,3295 → 38,33 zł)', () => {
    expect(cenaDlaKanalu({ kartaGr: 3333, narzutBp: 1500 })).toEqual({ bledy: [], grosze: 3833, zrodlo: 'narzut' });
  });

  it('dokładna połówka idzie w górę (0,10 zł + 5% = 10,5 gr → 11 gr), narzut 0 zostawia cenę karty', () => {
    expect(cenaDlaKanalu({ kartaGr: 10, narzutBp: 500 }).grosze).toBe(11);
    expect(cenaDlaKanalu({ kartaGr: 6638, narzutBp: 0 }).grosze).toBe(6638);
  });

  it.each([
    ['zero', 0],
    ['ujemna', -1],
    ['ułamek grosza', 1.5],
    ['tekst', '105'],
    ['NaN', Number.NaN],
  ])('błędna ręczna cena (%s) to błąd „reczna”, bez cichego spadku do narzutu', (_, recznaGr) => {
    expect(cenaDlaKanalu({ kartaGr: 10000, narzutBp: 1000, recznaGr })).toEqual({
      bledy: ['reczna'],
      grosze: null,
      zrodlo: 'reczna',
    });
  });

  it('bez ręcznej ceny przekazuje błędy karty i narzutu', () => {
    expect(cenaDlaKanalu({ kartaGr: 0, narzutBp: -5 })).toEqual({
      bledy: ['cena', 'narzut'],
      grosze: null,
      zrodlo: 'narzut',
    });
    expect(cenaDlaKanalu({ kartaGr: 99.5, narzutBp: 1000 }).bledy).toEqual(['cena']);
  });

  it('wynik to zawsze grosze całkowite', () => {
    for (const [kartaGr, narzutBp] of [
      [1, 1],
      [3333, 1250],
      [999999, 333],
      [12345, 9999],
    ]) {
      expect(Number.isSafeInteger(cenaDlaKanalu({ kartaGr, narzutBp }).grosze)).toBe(true);
    }
  });
});

describe('roznicaBp — różnica w punktach bazowych względem starej ceny', () => {
  it.each([
    [10000, 11000, 1000],
    [11000, 10000, -909],
    [9500, 11000, 1579],
    [10000, 10000, 0],
    [20000, 20001, 1],
    [20000, 19999, -1],
    [20001, 20000, 0],
    [3, 4, 3333],
  ])('%i → %i gr = %i bp', (stara, nowa, bp) => {
    expect(roznicaBp(stara, nowa)).toBe(bp);
  });

  it.each([
    [0, 100],
    [null, 100],
    [100, null],
    [-100, 100],
    [100.5, 100],
    [100, 0],
  ])('bez sensownej pary (%s → %s) zwraca null', (stara, nowa) => {
    expect(roznicaBp(stara, nowa)).toBeNull();
  });
});

describe('cenyBruttoSklepu — reguła odczytu lustra Woo', () => {
  it.each([
    ['yes', 'yes', true],
    ['yes', 'no', false],
    ['no', 'no', true],
    ['no', 'yes', true],
    ['yes', true, true],
    [null, null, false],
    ['yes', null, false],
    [null, 'yes', true],
  ])('liczy podatki %s, ceny z podatkiem %s → brutto %s', (liczyPodatki, cenyBrutto, wynik) => {
    expect(cenyBruttoSklepu(liczyPodatki, cenyBrutto)).toBe(wynik);
  });
});
