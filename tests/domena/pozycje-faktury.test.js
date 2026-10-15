import { describe, it, expect } from 'vitest';
import { pozycjeDokumentu, sprawdzSumeDokumentu } from '../../src/domena/pozycje-faktury.js';

// Zamowienie budujemy recznie, bez bazy: obie funkcje sa czyste (argument `z`), wiec test
// domenowy nie ma powodu przechodzic przez openOmsDb/zapiszZamowienie — to samo pokrywa juz
// tests/oms/faktura.test.js na calej sciezce przez inFakt.
const zamowienie = (nad = {}) => ({
  kwota_brutto: '123.00',
  koszt_dostawy_brutto: '0.00',
  pozycje: [{ nazwa: 'STOP', ilosc: 2, cena_brutto: '61.50' }],
  ...nad,
});

describe('pozycjeDokumentu', () => {
  it('pozycja ze sklepu ma poprawny ksztalt {name, quantity, gross_price, tax_symbol}', () => {
    const services = pozycjeDokumentu(zamowienie());
    expect(services).toEqual([{ name: 'STOP', quantity: 2, gross_price: 12300, tax_symbol: '23' }]);
  });

  it('koszt dostawy dochodzi jako osobna pozycja "Dostawa"', () => {
    const services = pozycjeDokumentu(zamowienie({ kwota_brutto: '141.45', koszt_dostawy_brutto: '18.45' }));
    expect(services).toHaveLength(2);
    expect(services[1]).toEqual({ name: 'Dostawa', quantity: 1, gross_price: 1845, tax_symbol: '23' });
  });

  it('zerowy koszt dostawy NIE dodaje pozycji dostawy', () => {
    const services = pozycjeDokumentu(zamowienie({ koszt_dostawy_brutto: '0.00' }));
    expect(services).toHaveLength(1);
  });

  it('brak kolumny kosztu dostawy (null) tez nie dodaje pozycji dostawy', () => {
    const services = pozycjeDokumentu(zamowienie({ koszt_dostawy_brutto: null }));
    expect(services).toHaveLength(1);
  });
});

describe('sprawdzSumeDokumentu', () => {
  it('pusta lista pozycji -> odmowa z czytelnym komunikatem', () => {
    const z = zamowienie({ kwota_brutto: '0.00', koszt_dostawy_brutto: '0.00', pozycje: [] });
    expect(() => sprawdzSumeDokumentu([], z)).toThrow(/pozycji/i);
  });

  it('rozjazd sumy -> odmowa, a komunikat niesie OBIE kwoty', () => {
    // 2 x 61,50 = 123,00, a zamowienie opiewa na 141,45 — brakuje 18,45 zl dostawy w pozycjach.
    const z = zamowienie({ kwota_brutto: '141.45', koszt_dostawy_brutto: null });
    const services = pozycjeDokumentu(z);
    expect(() => sprawdzSumeDokumentu(services, z)).toThrow(/123\.00.*141\.45/s);
  });

  it('zgodna suma NIE rzuca', () => {
    const z = zamowienie();
    const services = pozycjeDokumentu(z);
    expect(() => sprawdzSumeDokumentu(services, z)).not.toThrow();
  });

  // REGRESJA: 3 szt., linia 100,00 zl (rabat 10%). Bariera liczona przez `cena_brutto * ilosc`
  // (33,33 x 3 = 99,99) odbijala sie od wlasnych zaokraglen sklepu. `brutto_linii` niesie sume
  // linii TAKA, jaka podal ja sklep — dokladnie tak, jak liczy ja wartoscPozycjiGrosze.
  it('3 szt. z rabatem 10% (linia 100,00 zl) NIE MOZE byc odrzucona — 33,33 x 3 = 99,99', () => {
    const z = zamowienie({
      kwota_brutto: '100.00',
      koszt_dostawy_brutto: null,
      pozycje: [{ nazwa: 'STOP', ilosc: 3, cena_brutto: '33.33', brutto_linii: '100.00' }],
    });
    const services = pozycjeDokumentu(z);
    expect(services).toEqual([{ name: 'STOP', quantity: 3, gross_price: 10000, tax_symbol: '23' }]);
    expect(() => sprawdzSumeDokumentu(services, z)).not.toThrow();
  });
});
