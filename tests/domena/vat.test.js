import { describe, it, expect } from 'vitest';
import {
  STAWKA_VAT, STAWKI_VAT, czyStawkaVat, stawkaPozycji, nettoZBruttoDoPokazania, bruttoZNetto,
} from '../../src/domena/vat.js';

// PRZ-105: stawka per pozycja (decyzja właściciela 21.10: 23/8/5/0, bez „zw” i „np”).
describe('STAWKI_VAT i czyStawkaVat', () => {
  it('dopuszcza dokładnie 23, 8, 5 i 0 — napis albo liczbę', () => {
    expect([...STAWKI_VAT]).toEqual(['23', '8', '5', '0']);
    for (const s of ['23', '8', '5', '0', 23, 8, 5, 0, ' 8 ']) expect(czyStawkaVat(s)).toBe(true);
  });

  it('odrzuca wszystko inne: 22, 7, zw, np, pusty, null', () => {
    for (const s of ['22', '7', 'zw', 'np', '', null, undefined, '8.0', '08', 'abc']) expect(czyStawkaVat(s)).toBe(false);
  });
});

describe('stawkaPozycji — stawka efektywna linii', () => {
  it('pozycja ręczna ze stawką dozwoloną → jej stawka', () => {
    expect(stawkaPozycji({ zrodlo: 'reczna', vat: '8' }, '23')).toBe('8');
    expect(stawkaPozycji({ zrodlo: 'reczna', vat: '0' }, '23')).toBe('0');
  });

  it('pozycja ze sklepu/Allegro → domyślna, choć Allegro przysłało swoją (decyzja właściciela 21.10)', () => {
    expect(stawkaPozycji({ zrodlo: 'sklep', vat: '8' }, '23')).toBe('23');
    expect(stawkaPozycji({ zrodlo: 'sklep', vat: null }, '5')).toBe('5');
  });

  it('stara pozycja ręczna bez stawki (NULL) i pozycja ze stawką spoza listy → domyślna', () => {
    expect(stawkaPozycji({ zrodlo: 'reczna', vat: null }, '5')).toBe('5');
    expect(stawkaPozycji({ zrodlo: 'reczna', vat: '22' }, '23')).toBe('23');
  });
});

describe('bruttoZNetto ze stawką', () => {
  it('liczy po podanej stawce, a bez niej po STAWKA_VAT', () => {
    expect(bruttoZNetto('100', '8')).toBe('108.00');
    expect(bruttoZNetto('100', '5')).toBe('105.00');
    expect(bruttoZNetto('100', '0')).toBe('100.00');
    expect(bruttoZNetto('100')).toBe('123.00');
  });

  it('netto → brutto → netto jest tożsamością 0,01–200,00 zł dla każdej stawki', () => {
    for (const s of STAWKI_VAT) {
      for (let gr = 1; gr <= 20000; gr += 1) {
        const netto = (gr / 100).toFixed(2);
        expect(nettoZBruttoDoPokazania(bruttoZNetto(netto, s), s)).toBe(netto);
      }
    }
  });
});

describe('STAWKA_VAT', () => {
  it('jest tą samą stawką, którą wysyła faktura', () => {
    expect(STAWKA_VAT).toBe('23');
  });
});

describe('nettoZBruttoDoPokazania', () => {
  it('liczy netto ze stawki VAT — 61,50 brutto to 50,00 netto', () => {
    expect(nettoZBruttoDoPokazania('61.50')).toBe('50.00');
  });

  it('zaokrągla do pełnych groszy, na liczbach całkowitych', () => {
    // 100,00 / 1,23 = 81,300813... zł → 81,30 zł
    expect(nettoZBruttoDoPokazania('100.00')).toBe('81.30');
  });

  it('zero brutto → zero netto, nie null', () => {
    expect(nettoZBruttoDoPokazania('0.00')).toBe('0.00');
  });

  // Ta funkcja jedzie na karcie zamówienia, która NIE MA PRAWA wywalić się na uszkodzonej
  // wartości — brak danych ma wyglądać jak brak danych, a nie jak awaria panelu.
  it('brak / nieliczbowa wartość → null, nigdy wyjątek', () => {
    expect(nettoZBruttoDoPokazania(null)).toBeNull();
    expect(nettoZBruttoDoPokazania('')).toBeNull();
    expect(nettoZBruttoDoPokazania('zła')).toBeNull();
  });
});
