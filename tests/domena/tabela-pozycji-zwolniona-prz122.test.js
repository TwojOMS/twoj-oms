// PRZ-122.B07f — firma zwolniona z VAT (TwojeFaktury + zapisane zwolnienie) a nabywca z numerem VAT UE: to NIE WDT
// (decyzja właściciela 27.10). Domena zamówień dostaje flagę `zwolniona` (liczy ją wołający: `sprzedawcaZwolniony`)
// i zachowuje się jak przy polskim nabywcy — stawki „zw”/z Ustawień, bez „0% — WDT”, netto bez stawki 0.
// Bez flagi (firma niezwolniona, inFakt) — dokładnie jak dotąd. Dane zmyślone („Pracownia Półcień”, DE123456789).
import { describe, it, expect } from 'vitest';
import { wierszePozycji, podsumowanieVatKarty } from '../../src/domena/tabela-pozycji.js';
import { wdtZFormularza, wstawPozycjeDoFormularza, parsujNoweZamowienie } from '../../src/domena/nowe-zamowienie.js';
import { parsujZamowienieZKarty } from '../../src/domena/zamowienie-z-karty.js';

const UE = 'DE123456789';
const zamowienie = (nad = {}) => ({
  sklep: 'pro',
  nip: UE,
  kwota_brutto: '256.00',
  koszt_dostawy_brutto: '25.00',
  pozycje: [
    { klucz: 's1', nazwa: 'Lampa stołowa Kałamarz', ilosc: 1, cena_brutto: '123.00', brutto_linii: '123.00', zrodlo: 'sklep', vat: null },
    { klucz: 'r2', nazwa: 'Album Półcień', ilosc: 1, cena_brutto: '108.00', brutto_linii: '108.00', zrodlo: 'reczna', reczna: true, vat: '8' },
  ],
  ...nad,
});
const ZW = Object.freeze({ stawkaDomyslna: 'zw', zw: true });
const POZYCJA_Z_MAGAZYNU = Object.freeze({ nazwa: 'Klosz lniany Półcień', sku: 'KL-LN-01', ilosc: 1, cena_brutto: '123.00' });
const FORMULARZ = Object.freeze({
  w_nazwa: 'Hans Testmann', dostawa: 'dpd', platnosc: 'przelew', koszt_dostawy_brutto: '0', f_nip: UE,
  poz_nazwa: 'Lampa stołowa Kałamarz', poz_ilosc: '1', poz_sku: '', poz_cena_brutto: '', poz_cena_netto: '100', poz_vat: '23',
});

describe('PRZ-122.B07f tabela pozycji — firma zwolniona, nabywca z numerem UE', () => {
  it('wiersze: stawki jak dla polskiego nabywcy („zw”, 8%), opis bez „0% — WDT”', () => {
    const w = wierszePozycji(zamowienie(), { ...ZW, zwolniona: true }).filter((x) => !x.podsumowanie);
    expect(w.map((x) => x.stawka)).toEqual(['zw', '8', 'zw']);
    expect(w.map((x) => x.stawkaOpis)).toEqual(['zw', '8%', 'zw']);
  });

  it('podsumowanie VAT: „zw” i 8% (VAT 8,00), wdt: false — nie 0% WDT', () => {
    expect(podsumowanieVatKarty(zamowienie(), { ...ZW, zwolniona: true }))
      .toMatchObject({ nettoZl: '248.00', vatZl: '8.00', bruttoZl: '256.00', wdt: false, zeroKrajowe: false, blad: null });
  });

  it('kontrolnie bez flagi (firma niezwolniona / inFakt): „0% — WDT”, VAT 0, wdt: true — jak dotąd', () => {
    const w = wierszePozycji(zamowienie(), ZW).filter((x) => !x.podsumowanie);
    expect(w.map((x) => x.stawkaOpis)).toEqual(['0% — WDT', '0% — WDT', '0% — WDT']);
    expect(podsumowanieVatKarty(zamowienie(), ZW)).toMatchObject({ nettoZl: '256.00', vatZl: '0.00', wdt: true });
    expect(podsumowanieVatKarty(zamowienie(), { stawkaDomyslna: '23' })).toMatchObject({ vatZl: '0.00', wdt: true });
  });
});

describe('PRZ-122.B07f formularz nowego zamówienia i zamówienie z karty — firma zwolniona', () => {
  it('wdtZFormularza: numer UE przy firmie zwolnionej → false; bez flagi → true', () => {
    expect(wdtZFormularza({ f_nip: UE }, { zwolniona: true })).toBe(false);
    expect(wdtZFormularza({ f_nip: UE })).toBe(true);
  });

  it('wstawienie z magazynu do formularza: netto liczone stawką wiersza (23%), nie stawką 0', () => {
    const f = wstawPozycjeDoFormularza({ f_nip: UE }, POZYCJA_Z_MAGAZYNU, { stawkaDomyslna: '23', zw: true, zwolniona: true });
    expect(f.poz_cena_netto).toEqual(['100.00']);
    expect(f.poz_cena_brutto).toEqual(['123.00']);
    const wdt = wstawPozycjeDoFormularza({ f_nip: UE }, POZYCJA_Z_MAGAZYNU, { stawkaDomyslna: '23', zw: true });
    expect(wdt.poz_cena_netto).toEqual(['123.00']);
  });

  it('nowe zamówienie: netto 100 przy 23% → brutto 123,00 (bez flagi: 100,00 jak WDT)', () => {
    expect(parsujNoweZamowienie(FORMULARZ, { stawkaDomyslna: 'zw', zw: true, zwolniona: true }).pozycje[0].cena_brutto).toBe('123.00');
    expect(parsujNoweZamowienie(FORMULARZ, { stawkaDomyslna: 'zw', zw: true }).pozycje[0].cena_brutto).toBe('100.00');
  });

  it('zamówienie z karty (API panelu): netto 100 przy 23% → brutto 123,00 (bez flagi: 100,00)', () => {
    const body = { kartaId: 'K-1', nip: UE, pozycje: [{ nazwa: 'Lampa stołowa Kałamarz', ilosc: '1', cena_netto: '100', vat: '23' }] };
    expect(parsujZamowienieZKarty(body, { stawkaDomyslna: 'zw', zw: true, zwolniona: true }).pozycje[0].cena_brutto).toBe('123.00');
    expect(parsujZamowienieZKarty(body, { stawkaDomyslna: 'zw', zw: true }).pozycje[0].cena_brutto).toBe('100.00');
  });
});
