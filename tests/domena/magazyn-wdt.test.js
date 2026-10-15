import { describe, it, expect } from 'vitest';
import { cenaWdtGrosze } from '../../src/domena/wdt.js';
import { pozycjaZProduktu } from '../pomoc/cenniki-historyczne-fixture.js';
import { przeliczenieRabatu, czyPozycjaPanelu } from '../../src/domena/rabat.js';

// CENY WDT PRZY WSTAWIANIU Z MAGAZYNU (zgłoszenie właściciela 26.08 wieczór: „jak dodaję
// produkty do nowego zamówienia dla Alfatrend, pojawia się cena z rabatem brutto").
// Reguła cenowa z wiki: cena sklepowa brutto − rabat → ÷1,23 = kwota na dokumencie WDT.
// Dzielenie idzie NA POZIOMIE CENY JEDNOSTKOWEJ — dokładnie jak w Apilo (WDT/1/06/2026):
// cyfry 10cm 39,90 → 50% → 19,95 → 16,22; STOP 70x100 108,90 → 54,45 → 44,27.

describe('cenaWdtGrosze', () => {
  it('zdejmuje 23% z ceny brutto — wektory z prawdziwej faktury Apilo', () => {
    expect(cenaWdtGrosze(1995)).toBe(1622); // cyfry 0-9 10cm: 19,95 → 16,22
    expect(cenaWdtGrosze(5445)).toBe(4427); // STOP 70x100: 54,45 → 44,27
    expect(cenaWdtGrosze(4950)).toBe(4024); // przykład z wiki: 49,50 → 40,24
    expect(cenaWdtGrosze(1900)).toBe(1545); // kurier DPD: 19,00 → 15,45
  });

  it('podłoga jeden grosz — pozycja groszowa nie wypada do zera', () => {
    expect(cenaWdtGrosze(1)).toBe(1);
  });
});

describe('pozycjaZProduktu — klient WDT', () => {
  const produkt = {
    kanal: 'pro', produkt_id: '77', wariant_id: '', nazwa: 'Szablon malarski STOP 70x100cm',
    sku_sklepu: 'PRO-STOP-001', cena_gr: 10890, rozmiar_tekst: '70x100cm',
  };

  it('cena jednostkowa: katalogowa − rabat → ÷1,23; linia = jednostkowa × ilość', () => {
    const p = pozycjaZProduktu(produkt, '2', { rabatProcent: 50, wdt: true });
    expect(p.cena_brutto).toBe('44.27');
    expect(p.brutto_linii).toBe('88.54');
    // Cena katalogowa zostaje SKLEPOWA (przed rabatem i przed ÷1,23) — migawka źródła.
    expect(p.cena_katalogowa).toBe('108.90');
  });

  it('bez flagi wdt zachowanie dokładnie jak dotąd (rabat brutto)', () => {
    const p = pozycjaZProduktu(produkt, '2', { rabatProcent: 50 });
    expect(p.cena_brutto).toBe('54.45');
  });
});

describe('przeliczenieRabatu — zamówienie WDT', () => {
  // Pozycja wstawiona z magazynu dla klienta WDT: 108,90 → 50% → 54,45 → ÷1,23 → 44,27.
  const pozycjaWdt = {
    id: 5, nazwa: 'STOP 70x100', ilosc: 2, zrodlo: 'reczna',
    cena_katalogowa: '108.90', cena_brutto: '44.27', brutto_linii: '88.54',
  };

  it('rozpoznaje pozycję WDT jako panelową i przelicza nowy rabat przez ÷1,23', () => {
    expect(czyPozycjaPanelu(pozycjaWdt, 50, { wdt: true })).toBe(true);
    const { doZmiany, pominiete } = przeliczenieRabatu([pozycjaWdt], {
      rabatPoprzedni: 50, rabatNowy: 40, wdt: true,
    });
    expect(pominiete).toEqual([]);
    // 108,90 − 40% = 65,34 → ÷1,23 = 53,12; linia 106,24.
    expect(doZmiany).toEqual([{
      id: 5, nazwa: 'STOP 70x100', ilosc: 2, cena_brutto: '53.12', brutto_linii: '106.24',
    }]);
  });

  it('bez flagi wdt pozycja WDT wygląda na ręcznie wycenioną — POMIJANA, nie psuta', () => {
    const { doZmiany, pominiete } = przeliczenieRabatu([pozycjaWdt], {
      rabatPoprzedni: 50, rabatNowy: 40,
    });
    expect(doZmiany).toEqual([]);
    expect(pominiete).toEqual([{ id: 5, nazwa: 'STOP 70x100' }]);
  });

  it('cena wpisana ręcznie na zamówieniu WDT dalej jest nietykalna', () => {
    const reczna = { ...pozycjaWdt, cena_brutto: '40.00', brutto_linii: '80.00' };
    const { doZmiany, pominiete } = przeliczenieRabatu([reczna], {
      rabatPoprzedni: 50, rabatNowy: 40, wdt: true,
    });
    expect(doZmiany).toEqual([]);
    expect(pominiete).toEqual([{ id: 5, nazwa: 'STOP 70x100' }]);
  });
});
