import { describe, it, expect } from 'vitest';
import { kwotaEkspresu } from '../../../src/domena/z-panelu/ekspres-kwota.js';

/* ============================================================================
   DOPŁATA ZA EKSPRES JAKO LICZBA.

   W /settings stoi TEKST pisany przez człowieka („+50zł"), a w trzech miejscach
   potrzebna jest z niego liczba: kwota w mailu, dodatek na formularzu proformy
   i pozycja zamówienia w OMS-ie. Ten plik pilnuje jednej reguły odczytu — i tego,
   że wartość nieczytelna NIGDY nie zamienia się w zero.
============================================================================ */

describe('kwotaEkspresu', () => {
  it('czyta zapisy, które człowiek naprawdę wpisuje', () => {
    expect(kwotaEkspresu('+50zł')).toBe(50);
    expect(kwotaEkspresu('+50 zł')).toBe(50);
    expect(kwotaEkspresu('50zł')).toBe(50);
    expect(kwotaEkspresu('+49,99 zł')).toBe(49.99);
    expect(kwotaEkspresu('+49.50zł')).toBe(49.5);
    expect(kwotaEkspresu('  +120 zł brutto ')).toBe(120);
  });

  /* ⚠️ TO JEST CAŁY POWÓD ISTNIENIA TEJ FUNKCJI. Zero znaczyłoby „ekspres gratis":
     klient dostałby dopłatę za darmo albo — gorzej — zamówienie na kwotę niższą niż
     zaakceptowana, a wtedy „opłacone" (wymaga pokrycia CAŁEJ kwoty) nie zapaliłoby się
     nigdy i ETAP IV stanąłby po cichu. */
  it('⚠️ wartość nieczytelna oddaje null, NIGDY zera', () => {
    expect(kwotaEkspresu('')).toBeNull();
    expect(kwotaEkspresu(null)).toBeNull();
    expect(kwotaEkspresu(undefined)).toBeNull();
    expect(kwotaEkspresu('gratis')).toBeNull();
    expect(kwotaEkspresu('w cenie')).toBeNull();
    expect(kwotaEkspresu('zł')).toBeNull();
    expect(kwotaEkspresu('0zł')).toBeNull();
    expect(kwotaEkspresu('-50zł')).toBeNull();
  });

  it('nie zaokrągla w górę ani nie gubi groszy', () => {
    expect(kwotaEkspresu('+50,005zł')).toBe(50.01);
    expect(kwotaEkspresu('+0,01zł')).toBe(0.01);
  });
});
