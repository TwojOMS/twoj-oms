// PRZ-122.B07d — WDT zależne od zwolnienia sprzedawcy. Firma zwolniona z VAT (art. 113) nie robi WDT: nabywca
// z unijnym numerem VAT dostaje zwykłą sprzedaż „zw”. Bez flagi `zwolniona` — dokładnie jak dziś (`czyNipUe`).
// Funkcje czyste; dane zmyślone (DE123456789, „Pracownia Półcień”).
import { describe, it, expect } from 'vitest';
import { czyWdt, czyNipUe } from '../../src/domena/wdt.js';
import { pozycjeDokumentu } from '../../src/domena/pozycje-faktury.js';

const NIP_UE = 'DE123456789';
const NIP_PL = '5250000009';

const zamowienie = (nad = {}) => ({
  kwota_brutto: '139.00',
  koszt_dostawy_brutto: '16.00',
  pozycje: [{ nazwa: 'Lampa stołowa Kałamarz', ilosc: 2, cena_brutto: '61.50' }],
  nip: NIP_UE,
  ...nad,
});

describe('czyWdt — numer UE i zwolnienie sprzedawcy', () => {
  it('numer UE, sprzedawca zwolniony → to nie jest WDT', () => {
    expect(czyWdt(NIP_UE, { zwolniona: true })).toBe(false);
  });

  it('numer UE bez flagi → WDT, jak dziś (czyNipUe)', () => {
    expect(czyWdt(NIP_UE)).toBe(true);
    expect(czyWdt(NIP_UE, {})).toBe(true);
    expect(czyWdt(NIP_UE, { zwolniona: false })).toBe(true);
    expect(czyWdt(NIP_UE)).toBe(czyNipUe(NIP_UE));
  });

  it('polski NIP → nie WDT, z flagą i bez', () => {
    expect(czyWdt(NIP_PL)).toBe(false);
    expect(czyWdt(NIP_PL, { zwolniona: true })).toBe(false);
    expect(czyWdt(`PL${NIP_PL}`)).toBe(false);
  });
});

describe('pozycjeDokumentu — opcja `zwolniona`', () => {
  it('numer UE + zwolniona → „zw” na pozycjach i dostawie (jak dla polskiego nabywcy)', () => {
    const services = pozycjeDokumentu(zamowienie(), { stawkaDomyslna: 'zw', zw: true, zwolniona: true });
    expect(services).toEqual([
      { name: 'Lampa stołowa Kałamarz', quantity: 2, gross_price: 12300, tax_symbol: 'zw' },
      { name: 'Dostawa', quantity: 1, gross_price: 1600, tax_symbol: 'zw' },
    ]);
  });

  it('numer UE + zwolniona: pozycja ręczna ze stawką bierze swoją stawkę, nie 0', () => {
    const services = pozycjeDokumentu(zamowienie({
      kwota_brutto: '139.00',
      pozycje: [{ nazwa: 'Lampa stołowa Kałamarz', ilosc: 2, cena_brutto: '61.50', zrodlo: 'reczna', vat: 'zw' }],
    }), { stawkaDomyslna: 'zw', zw: true, zwolniona: true });
    expect(services.map((s) => s.tax_symbol)).toEqual(['zw', 'zw']);
  });

  it('numer UE bez `zwolniona` → 0 (WDT) jak dziś', () => {
    const services = pozycjeDokumentu(zamowienie(), { stawkaDomyslna: '23' });
    expect(services.map((s) => s.tax_symbol)).toEqual(['0', '0']);
    const zFlagaZw = pozycjeDokumentu(zamowienie(), { stawkaDomyslna: 'zw', zw: true });
    expect(zFlagaZw.map((s) => s.tax_symbol)).toEqual(['0', '0']);
  });

  it('polski nabywca + zwolniona → bez zmian (stawka domyślna)', () => {
    const services = pozycjeDokumentu(zamowienie({ nip: NIP_PL }), { stawkaDomyslna: 'zw', zw: true, zwolniona: true });
    expect(services.map((s) => s.tax_symbol)).toEqual(['zw', 'zw']);
  });
});
