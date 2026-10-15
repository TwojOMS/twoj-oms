import { describe, it, expect } from 'vitest';
import { kwotaOczekiwanaGrosze, sumaPozycjiZWysylkaGrosze } from '../../../src/domena/suma-pozycji.js';
import { podsumowaniePozycji } from '../../../src/domena/tabela-pozycji.js';

const reczne = (nad = {}) => ({
  sklep: 'reczne', kwota_brutto: '223.00', koszt_dostawy_brutto: '23.00',
  pozycje: [
    { nazwa: 'A', ilosc: 2, cena_brutto: '50.00', brutto_linii: '100.00', zrodlo: 'reczna' },
    { nazwa: 'B', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00', zrodlo: 'reczna' },
  ],
  ...nad,
});

describe('kwota oczekiwana przy zamówieniu ręcznym', () => {
  // 100 + 100 pozycji + 23 dostawy = 223. Bez poprawki wyszloby 223 + 200 = 423.
  it('równa się kwocie zamówienia, bez podwajania pozycji ręcznych', () => {
    expect(kwotaOczekiwanaGrosze(reczne())).toBe(22300);
  });

  it('zgadza się z sumą pozycji — bariera arytmetyczna przechodzi', () => {
    const z = reczne();
    expect(sumaPozycjiZWysylkaGrosze(z)).toBe(kwotaOczekiwanaGrosze(z));
    expect(podsumowaniePozycji(z).zgadzaSie).toBe(true);
  });

  // ⚠️ Bariera NIE SLABNIE: zla kwota dalej ma byc zlapana.
  it('rozjazd kwoty dalej jest wykrywany', () => {
    expect(podsumowaniePozycji(reczne({ kwota_brutto: '999.00' })).zgadzaSie).toBe(false);
  });

  it('zamówienie ze sklepu liczy się tak jak dotąd — z członem różnicowym', () => {
    const zeSklepu = {
      sklep: 'pro', kwota_brutto: '100.00', koszt_dostawy_brutto: '0.00',
      pozycje: [
        { nazwa: 'A', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00', zrodlo: 'sklep' },
        { nazwa: 'Dodatek', ilosc: 1, cena_brutto: '20.00', brutto_linii: '20.00', zrodlo: 'reczna' },
      ],
    };
    // kwota ze sklepu 100 + dopisane recznie 20 = 120 oczekiwane
    expect(kwotaOczekiwanaGrosze(zeSklepu)).toBe(12000);
  });
});
