// PRZ-094.17: plakietka rodzaju kanału na liście zamówień. Rodzaj bierzemy z `typ` definicji kanału,
// nie z nazwy sklepu — nazwę wpisuje firma i może brzmieć dowolnie.
import { describe, it, expect } from 'vitest';
import { rodzajKanalu } from '../../src/domena/kanaly.js';

const DEFINICJE = [
  { klucz: 'sklep_polcien', typ: 'woo', prefiks: 'SKLEP', etykieta: 'Pracownia Półcień' },
  { klucz: 'konto_a', typ: 'allegro', prefiks: 'A', etykieta: 'Woo Sklep' },
  { klucz: 'outlet', typ: 'allegro', prefiks: 'B' },
];

describe('rodzajKanalu', () => {
  it('Woo i Allegro po typie definicji', () => {
    expect(rodzajKanalu('sklep_polcien', DEFINICJE)).toEqual({ klucz: 'woo', nazwa: 'WooCommerce', znak: 'W' });
    expect(rodzajKanalu('konto_a', DEFINICJE)).toEqual({ klucz: 'allegro', nazwa: 'Allegro', znak: 'a' });
    expect(rodzajKanalu('outlet', DEFINICJE).klucz).toBe('allegro');
  });
  it('nazwa nie rozstrzyga: kanał Allegro nazwany „Woo Sklep” to nadal Allegro, a Woo nazwany „Allegro Sklep” to Woo', () => {
    expect(rodzajKanalu('konto_a', DEFINICJE).klucz).toBe('allegro');
    expect(rodzajKanalu('sklep_allegro_w_nazwie', [{ klucz: 'sklep_allegro_w_nazwie', typ: 'woo', etykieta: 'Allegro Sklep' }]).klucz).toBe('woo');
  });
  it('kanały bez marki i nieznane klucze → null (bez plakietki)', () => {
    for (const k of ['reczne', 'indywidualne', 'nie-ma-takiego', '', null, undefined, '__proto__']) {
      expect(rodzajKanalu(k, DEFINICJE)).toBeNull();
    }
  });
  it('brak listy definicji → null, nie wyjątek', () => {
    expect(rodzajKanalu('sklep_polcien', undefined)).toBeNull();
    expect(rodzajKanalu('sklep_polcien', [])).toBeNull();
  });
  it('typ spoza słownika (np. „proto”) → null', () => {
    expect(rodzajKanalu('x', [{ klucz: 'x', typ: '__proto__' }])).toBeNull();
    expect(rodzajKanalu('x', [{ klucz: 'x', typ: 'constructor' }])).toBeNull();
  });
});
