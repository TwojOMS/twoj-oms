import { describe, expect, it } from 'vitest';
import { ekranZdekodowany } from '../../../src/core/bezpieczenstwo/straznik.js';

describe('strażnik: ekran z adresu zdekodowanego jak w routerze', () => {
  it('zakodowane litery dają ten sam ekran co adres jawny', () => {
    expect(ekranZdekodowany('/magazyn/%75stawienia/parametry')).toBe(ekranZdekodowany('/magazyn/ustawienia/parametry'));
  });

  it.each(['/magazyn/%zz', '/zamowienia/1%3F/dane/faktura'])('%s → brak ekranu (odmowa)', (adres) => {
    expect(ekranZdekodowany(adres)).toBeNull();
  });

  it('`#` w identyfikatorze nie skraca ścieżki — zostaje ekran dokumentów', () => {
    expect(ekranZdekodowany('/zamowienia/1%23x/faktura')).toBe(ekranZdekodowany('/zamowienia/1/faktura'));
  });

  it('zwykłe zapytanie po `?` nie przeszkadza', () => {
    expect(ekranZdekodowany('/magazyn/ustawienia?zapisano=1')).toBe(ekranZdekodowany('/magazyn/ustawienia'));
  });
});
