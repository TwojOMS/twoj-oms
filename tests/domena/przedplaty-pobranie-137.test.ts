import { describe, expect, it } from 'vitest';
import { przedplatyPrzedPobraniem, resztaDoPobrania, limitPobraniaGrosze } from '../../src/domena/platnosci.js';

const z = { pobranie: 1, kwota_pobrania: '212.90' };
const w = (kwota: string, zrodlo = 'reczna', metoda = 'Przelew') => ({ kwota, zrodlo, metoda });

describe('przedpłaty przed pobraniem — wyniki w groszach', () => {
  it.each([
    [[], 0, 21290],
    [[w('100.00')], 10000, 11290],
    [[w('212.90')], 21290, 0],
    [[w('300.00')], 30000, 0],
    [[w('35.65'), w('35.65'), w('141.60')], 21290, 0],
    [[w('212.90', 'sklep')], 0, 21290],
    [[w('212.90', 'pobranie')], 0, 21290],
    [[w('212.90', 'reczna', 'Za pobraniem')], 0, 21290],
  ])('wpłaty %j → P=%i, reszta=%i', (wplaty, p, reszta) => {
    expect(przedplatyPrzedPobraniem(z, wplaty)).toBe(p);
    expect(resztaDoPobrania(z, wplaty)).toBe(reszta);
  });
  it('0.10 + 0.20 pokrywa dokładnie 0.30', () => {
    const male = { pobranie: 1, kwota_pobrania: '0.30' };
    expect(przedplatyPrzedPobraniem(male, [w('0.10'), w('0.20')])).toBe(30);
    expect(resztaDoPobrania(male, [w('0.10'), w('0.20')])).toBe(0);
  });
  it('czyta wpłaty zamówienia i efektywne nadpisanie kwoty', () => {
    const nadpisane = { ...z, platnosci: [w('100.00')], wysylka_reczna_json: JSON.stringify({ metoda: 'dpd', pobranie: 1, kwota_pobrania: '150.00' }) };
    expect(resztaDoPobrania(nadpisane)).toBe(5000);
  });
  it('pobranie włączone na karcie po opłacie online — wpłata sklepu JEST przedpłatą (recenzja 137-04)', () => {
    const wlaczoneNaKarcie = { pobranie: 0, kwota_pobrania: '212.90', wysylka_reczna_json: JSON.stringify({ metoda: 'dpd', pobranie: 1, kwota_pobrania: '212.90' }) };
    expect(przedplatyPrzedPobraniem(wlaczoneNaKarcie, [w('212.90', 'sklep')])).toBe(21290);
    expect(resztaDoPobrania(wlaczoneNaKarcie, [w('212.90', 'sklep')])).toBe(0);
  });
  it('po wyłączeniu pobrania wpłata sklepu jest zwykłą przedpłatą', () => {
    expect(przedplatyPrzedPobraniem({ ...z, pobranie: 0 }, [w('100.00', 'sklep')])).toBe(10000);
  });
});

// PRZ-143.05 (E3-D4): limit pobrania — podstawa to kwota pobrania, a gdy jej brak, kwota zamówienia.
describe('limitPobraniaGrosze — limit po przedpłatach także bez kwoty pobrania', () => {
  const bezKwoty = { pobranie: 1, kwota_pobrania: null, kwota_brutto: '212.90' };
  it.each([
    ['kwota pobrania jest', { ...z, kwota_brutto: '300.00' }, [w('100.00')], { limit: 11290, podstawa: 'pobranie' }],
    ['brak kwoty pobrania → kwota zamówienia', bezKwoty, [w('100.00')], { limit: 11290, podstawa: 'zamowienie' }],
    ['pusta kwota pobrania → kwota zamówienia', { ...bezKwoty, kwota_pobrania: '' }, [w('100.00')], { limit: 11290, podstawa: 'zamowienie' }],
    ['wpłaty ponad kwotę zamówienia → 0', bezKwoty, [w('300.00')], { limit: 0, podstawa: 'zamowienie' }],
    ['wpłata sklepu przy pobraniu sklepowym nie jest przedpłatą', bezKwoty, [w('212.90', 'sklep')], { limit: 21290, podstawa: 'zamowienie' }],
    ['wpłata „Za pobraniem" nie jest przedpłatą', bezKwoty, [w('50.00', 'reczna', 'Za pobraniem'), w('100.00')], { limit: 11290, podstawa: 'zamowienie' }],
    ['groszowo: 0.10 + 0.20 przy zamówieniu 0.30', { ...bezKwoty, kwota_brutto: '0.30' }, [w('0.10'), w('0.20')], { limit: 0, podstawa: 'zamowienie' }],
  ])('%s', (_opis, zam, wplaty, wynik) => {
    expect(limitPobraniaGrosze(zam, wplaty)).toEqual(wynik);
  });
  it('brak kwoty pobrania i kwoty zamówienia → null, bez wyjątku z grosze()', () => {
    expect(limitPobraniaGrosze({ ...bezKwoty, kwota_brutto: null }, [w('100.00')])).toBeNull();
    expect(limitPobraniaGrosze({ ...bezKwoty, kwota_brutto: '' }, [w('100.00')])).toBeNull();
  });
  it('czyta wpłaty zamówienia i nadpisanie kwoty z karty', () => {
    const nadpisane = { ...bezKwoty, platnosci: [w('100.00')], wysylka_reczna_json: JSON.stringify({ metoda: 'dpd', pobranie: 1, kwota_pobrania: '150.00' }) };
    expect(limitPobraniaGrosze(nadpisane)).toEqual({ limit: 5000, podstawa: 'pobranie' });
  });
  it('limit nigdy nie przekracza kwoty zamówienia minus przedpłaty, gdy kwoty pobrania brak', () => {
    for (const [brutto, wplata] of [['212.90', '100.00'], ['0.30', '0.10'], ['99.99', '99.98'], ['10.00', '0.01']]) {
      const wynik = limitPobraniaGrosze({ ...bezKwoty, kwota_brutto: brutto }, [w(wplata)]);
      expect(wynik?.limit).toBe(Math.round(Number(brutto) * 100) - Math.round(Number(wplata) * 100));
    }
  });
});
