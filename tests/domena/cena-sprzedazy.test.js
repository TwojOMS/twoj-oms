import { describe, it, expect } from 'vitest';
import {
  BRAK_STAWKI,
  cenaSprzedazyZFormularza,
  polaCenyPoZmianie,
  podgladMarzy,
} from '../../src/domena/cena-sprzedazy.js';
import { bruttoGrZNettoGr, nettoGrZBruttoGr, bruttoZNetto, nettoZBruttoDoPokazania } from '../../src/domena/vat.js';

describe('bruttoGrZNettoGr i nettoGrZBruttoGr — grosze, połówka w górę', () => {
  it('liczy po stawce na liczbach całkowitych', () => {
    expect(bruttoGrZNettoGr(1000, '23')).toBe(1230);
    expect(bruttoGrZNettoGr(1001, '23')).toBe(1231);
    expect(bruttoGrZNettoGr(1000, '8')).toBe(1080);
    expect(bruttoGrZNettoGr(1000, '0')).toBe(1000);
    expect(nettoGrZBruttoGr(1230, '23')).toBe(1000);
    expect(nettoGrZBruttoGr(2890, '23')).toBe(2350);
  });

  it('połowę grosza zaokrągla w górę, a mniej niż połowę w dół', () => {
    // 50 gr × 1,23 = 61,5 gr → 62; 10 gr × 1,05 = 10,5 → 11; 2 gr × 1,23 = 2,46 → 2
    expect(bruttoGrZNettoGr(50, '23')).toBe(62);
    expect(bruttoGrZNettoGr(10, '5')).toBe(11);
    expect(bruttoGrZNettoGr(2, '23')).toBe(2);
    expect(nettoGrZBruttoGr(1, '8')).toBe(1);
    // 1 gr / 1,08 = 0,93 → 1; 61 gr / 1,23 = 49,59 → 50; 3 gr / 1,08 = 2,78 → 3
    expect(nettoGrZBruttoGr(61, '23')).toBe(50);
    expect(nettoGrZBruttoGr(3, '8')).toBe(3);
  });

  it('„zw” liczy jak 0% tylko z flagą; bez niej nie ma liczby', () => {
    expect(bruttoGrZNettoGr(1234, 'zw', { zw: true })).toBe(1234);
    expect(nettoGrZBruttoGr(1234, 'zw', { zw: true })).toBe(1234);
    expect(bruttoGrZNettoGr(1234, 'zw')).toBeNaN();
  });

  it('stare funkcje na napisach dają to samo co groszowe (jedna arytmetyka)', () => {
    for (const s of ['23', '8', '5', '0']) {
      for (let gr = 0; gr <= 5000; gr += 7) {
        const zl = (gr / 100).toFixed(2);
        expect(bruttoZNetto(zl, s)).toBe((bruttoGrZNettoGr(gr, s) / 100).toFixed(2));
        expect(nettoZBruttoDoPokazania(zl, s)).toBe((nettoGrZBruttoGr(gr, s) / 100).toFixed(2));
      }
    }
  });
});

describe('cenaSprzedazyZFormularza — co trafia do cena_gr (brutto)', () => {
  it('netto 10,00 + 23% → 1230 gr brutto', () => {
    expect(cenaSprzedazyZFormularza({ netto: '10,00', brutto: '', stawka: '23' })).toEqual({
      cena_gr: 1230,
      blad: null,
    });
  });

  it('brutto 12,30 + 23% → 1230 gr, netto nie jest potrzebne', () => {
    expect(cenaSprzedazyZFormularza({ netto: '', brutto: '12,30', stawka: '23' })).toEqual({
      cena_gr: 1230,
      blad: null,
    });
  });

  it('brutto wygrywa z netto, nawet gdy się nie zgadzają', () => {
    expect(cenaSprzedazyZFormularza({ netto: '10,00', brutto: '15,00', stawka: '23' })).toEqual({
      cena_gr: 1500,
      blad: null,
    });
  });

  it('netto bez stawki VAT → odmowa z podpowiedzią', () => {
    for (const stawka of ['', undefined, null, '99'])
      expect(cenaSprzedazyZFormularza({ netto: '10,00', brutto: '', stawka })).toEqual({
        cena_gr: null,
        blad: BRAK_STAWKI,
      });
    expect(BRAK_STAWKI).toBe('Wybierz stawkę VAT albo wpisz cenę brutto.');
  });

  it('nic nie wpisane → brak ceny, bez błędu (obowiązkowa jest tylko nazwa)', () => {
    expect(cenaSprzedazyZFormularza({})).toEqual({ cena_gr: null, blad: null });
    expect(cenaSprzedazyZFormularza({ netto: '  ', brutto: ' ', stawka: '' })).toEqual({ cena_gr: null, blad: null });
  });

  it('„zw”: netto = brutto', () => {
    expect(cenaSprzedazyZFormularza({ netto: '19,99', brutto: '', stawka: 'zw' }, { zw: true })).toEqual({
      cena_gr: 1999,
      blad: null,
    });
  });

  it('netto 10,005 zaokrągla połówkę w górę: 1001 gr netto → 1231 gr brutto', () => {
    expect(cenaSprzedazyZFormularza({ netto: '10,005', brutto: '', stawka: '23' })).toEqual({
      cena_gr: 1231,
      blad: null,
    });
    expect(cenaSprzedazyZFormularza({ netto: '10,004', brutto: '', stawka: '23' }).cena_gr).toBe(1230);
  });

  it('kwota, której nie da się przeczytać, to błąd z wpisanym napisem', () => {
    expect(cenaSprzedazyZFormularza({ brutto: 'abc', stawka: '23' }).blad).toContain('„abc”');
    expect(cenaSprzedazyZFormularza({ netto: '-5', stawka: '23' }).blad).toContain('„-5”');
    expect(cenaSprzedazyZFormularza({ netto: '1,2,3', stawka: '23' }).cena_gr).toBeNull();
  });
});

describe('polaCenyPoZmianie — to samo liczenie w formularzu na żywo', () => {
  it('wpisane netto liczy brutto, wpisane brutto liczy netto', () => {
    expect(polaCenyPoZmianie({ netto: '10', brutto: '', stawka: '23', zrodlo: 'netto' })).toEqual({
      netto: '10',
      brutto: '12,30',
    });
    expect(polaCenyPoZmianie({ netto: '', brutto: '28,90', stawka: '23', zrodlo: 'brutto' })).toEqual({
      netto: '23,50',
      brutto: '28,90',
    });
  });

  it('zmiana VAT przelicza od pola wpisanego ostatnio', () => {
    expect(polaCenyPoZmianie({ netto: '10,00', brutto: '12,30', stawka: '8', zrodlo: 'netto' })).toEqual({
      netto: '10,00',
      brutto: '10,80',
    });
    expect(polaCenyPoZmianie({ netto: '10,00', brutto: '12,30', stawka: '8', zrodlo: 'brutto' })).toEqual({
      netto: '11,39',
      brutto: '12,30',
    });
  });

  it('bez znacznika liczy od brutto, a gdy brutto puste — od netto', () => {
    expect(polaCenyPoZmianie({ netto: '1,00', brutto: '12,30', stawka: '23' })).toEqual({
      netto: '10,00',
      brutto: '12,30',
    });
    expect(polaCenyPoZmianie({ netto: '10,00', brutto: '', stawka: '23' })).toEqual({
      netto: '10,00',
      brutto: '12,30',
    });
  });

  it('bez stawki, przy pustym albo złym źródle niczego nie zmienia; puste źródło czyści drugie pole', () => {
    expect(polaCenyPoZmianie({ netto: '10,00', brutto: '12,30', stawka: '', zrodlo: 'netto' })).toEqual({
      netto: '10,00',
      brutto: '12,30',
    });
    expect(polaCenyPoZmianie({ netto: '1x', brutto: '12,30', stawka: '23', zrodlo: 'netto' })).toEqual({
      netto: '1x',
      brutto: '12,30',
    });
    expect(polaCenyPoZmianie({ netto: '', brutto: '12,30', stawka: '23', zrodlo: 'netto' })).toEqual({
      netto: '',
      brutto: '',
    });
  });

  it('wynik formularza zgadza się z tym, co zapisze serwer', () => {
    for (const stawka of ['23', '8', '5', '0']) {
      for (let gr = 1; gr <= 3000; gr += 13) {
        const netto = (gr / 100).toFixed(2).replace('.', ',');
        const pola = polaCenyPoZmianie({ netto, brutto: '', stawka, zrodlo: 'netto' });
        expect(cenaSprzedazyZFormularza({ netto: '', brutto: pola.brutto, stawka }).cena_gr).toBe(
          cenaSprzedazyZFormularza({ netto, brutto: '', stawka }).cena_gr,
        );
      }
    }
  });
});

describe('podgladMarzy — tylko napis do pokazania', () => {
  it('marża w złotych netto i procent od ceny sprzedaży netto', () => {
    expect(podgladMarzy({ netto: '10,00', zakup: '7,50' })).toBe('Marża: 2,50 zł netto (25,0%)');
    expect(podgladMarzy({ netto: '30', zakup: '10' })).toBe('Marża: 20,00 zł netto (66,7%)');
    expect(podgladMarzy({ netto: '10,00', zakup: '12,00' })).toBe('Marża: -2,00 zł netto (-20,0%)');
  });

  it('bez obu kwot albo przy netto zero nie pokazuje nic', () => {
    expect(podgladMarzy({ netto: '', zakup: '7,50' })).toBeNull();
    expect(podgladMarzy({ netto: '10,00', zakup: '' })).toBeNull();
    expect(podgladMarzy({ netto: '0', zakup: '1' })).toBeNull();
    expect(podgladMarzy({ netto: 'abc', zakup: '1' })).toBeNull();
  });
});
