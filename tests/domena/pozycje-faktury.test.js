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
    const services = pozycjeDokumentu(zamowienie(), { stawkaDomyslna: '23' });
    expect(services).toEqual([{ name: 'STOP', quantity: 2, gross_price: 12300, tax_symbol: '23' }]);
  });

  it('koszt dostawy dochodzi jako osobna pozycja "Dostawa"', () => {
    const services = pozycjeDokumentu(zamowienie({ kwota_brutto: '141.45', koszt_dostawy_brutto: '18.45' }), { stawkaDomyslna: '23' });
    expect(services).toHaveLength(2);
    expect(services[1]).toEqual({ name: 'Dostawa', quantity: 1, gross_price: 1845, tax_symbol: '23' });
  });

  it('zerowy koszt dostawy NIE dodaje pozycji dostawy', () => {
    const services = pozycjeDokumentu(zamowienie({ koszt_dostawy_brutto: '0.00' }), { stawkaDomyslna: '23' });
    expect(services).toHaveLength(1);
  });

  it('brak kolumny kosztu dostawy (null) tez nie dodaje pozycji dostawy', () => {
    const services = pozycjeDokumentu(zamowienie({ koszt_dostawy_brutto: null }), { stawkaDomyslna: '23' });
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
    const services = pozycjeDokumentu(z, { stawkaDomyslna: '23' });
    expect(() => sprawdzSumeDokumentu(services, z)).toThrow(/123\.00.*141\.45/s);
  });

  it('zgodna suma NIE rzuca', () => {
    const z = zamowienie();
    const services = pozycjeDokumentu(z, { stawkaDomyslna: '23' });
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
    const services = pozycjeDokumentu(z, { stawkaDomyslna: '23' });
    expect(services).toEqual([{ name: 'STOP', quantity: 3, gross_price: 10000, tax_symbol: '23' }]);
    expect(() => sprawdzSumeDokumentu(services, z)).not.toThrow();
  });
});

// PRZ-105: stawka PER POZYCJA (decyzja właściciela 21.10 — idzie na fakturę inFakt i proformę). Pozycja ręczna niesie
// własną (`vat`), pozycja ze sklepu/Allegro i dostawa dostają domyślną z Ustawień, NIP z UE wymusza 0 na wszystkim.
describe('pozycjeDokumentu — stawka per pozycja (PRZ-105)', () => {
  const mieszane = (nad = {}) => zamowienie({
    kwota_brutto: '231.00',
    koszt_dostawy_brutto: '0.00',
    pozycje: [
      { nazwa: 'Lampa', ilosc: 1, cena_brutto: '123.00', zrodlo: 'sklep', vat: '8' },
      { nazwa: 'Album o lampach', ilosc: 1, cena_brutto: '108.00', zrodlo: 'reczna', vat: '8' },
    ],
    ...nad,
  });

  it('pozycja ręczna z 8% → tax_symbol 8; sklepowa (choć Allegro podało 8) → domyślna', () => {
    const s = pozycjeDokumentu(mieszane(), { stawkaDomyslna: '23' });
    expect(s.map((x) => x.tax_symbol)).toEqual(['23', '8']);
  });

  it('domyślna 5: sklepowa, stara ręczna bez stawki i dostawa idą z 5', () => {
    const s = pozycjeDokumentu(zamowienie({
      kwota_brutto: '139.00', koszt_dostawy_brutto: '16.00',
      pozycje: [{ nazwa: 'STOP', ilosc: 2, cena_brutto: '61.50', zrodlo: 'reczna', vat: null }],
    }), { stawkaDomyslna: '5' });
    expect(s.map((x) => [x.name, x.tax_symbol])).toEqual([['STOP', '5'], ['Dostawa', '5']]);
  });

  it('NIP z UE: każda pozycja (także ręczna z 8%) i dostawa → 0', () => {
    const s = pozycjeDokumentu(mieszane({ nip: 'DE123456789', koszt_dostawy_brutto: '10.00', kwota_brutto: '241.00' }),
      { stawkaDomyslna: '23' });
    expect(s.map((x) => x.tax_symbol)).toEqual(['0', '0', '0']);
  });

  it('bez stawki domyślnej → wyjątek, nie ciche 23', () => {
    expect(() => pozycjeDokumentu(zamowienie())).toThrow(/stawk/i);
    expect(() => pozycjeDokumentu(zamowienie(), { stawkaDomyslna: '22' })).toThrow(/stawk/i);
  });
});
