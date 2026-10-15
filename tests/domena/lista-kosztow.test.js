import { describe, it, expect } from 'vitest';
import { zlozWidok } from '../../src/domena/lista-kosztow.js';

// ⚠️ KWOTY JAKO NAPISY, nie liczby — brief Zadania 8 zostal napisany PRZED decyzja, ze
// `koszty.netto/vat/brutto` to TEXT (niezmiennik 4.5, docs/oms/PRZEWODNIK.md: arytmetyka
// pieniedzy WYLACZNIE przez `grosze()`, nigdy na floatach). Wiersze ponizej maja wiec dokladnie
// taki ksztalt, w jakim `naWiersz` (domain/koszt-metadane.js) faktycznie je produkuje —
// '100.00', nie 100 — a asercje o kwotach w wyniku sprawdzaja napisy w postaci `zl()`
// ('150.00'), bo tak zlozWidok oddaje kazda kwote pieniezna: gotowa do wstawienia na ekran
// bez dalszej arytmetyki po stronie widoku.
const w = (n = {}) => ({
  ksef_number: 'K', numer_dokumentu: 'FV/1', sprzedawca_nip: '5252674798',
  sprzedawca_nazwa: 'Allegro', data_wystawienia: '2026-06-05',
  netto: '100.00', vat: '23.00', brutto: '123.00', waluta: 'PLN', rodzaj: 'Vat', ...n,
});
const mapa = { 5252674798: { kategoria: 'Prowizje sprzedażowe', typ: 'zmienny' },
  1000001069: { kategoria: 'Kurierzy', typ: 'zmienny' } };
const kategoria = (nip) => mapa[nip] ?? null;

describe('widok miesiaca kosztow', () => {
  it('sumuje netto, VAT i brutto', () => {
    const wynik = zlozWidok({
      wiersze: [w(), w({ ksef_number: 'K2', netto: '50.00', vat: '11.50', brutto: '61.50' })],
      kategoria,
    });
    expect(wynik.suma).toEqual({ netto: '150.00', vat: '34.50', brutto: '184.50' });
  });

  it('grupuje po kategorii z udzialem procentowym', () => {
    const wynik = zlozWidok({
      wiersze: [
        w(),
        w({
          ksef_number: 'K2', sprzedawca_nip: '1000001069',
          netto: '300.00', vat: '69.00', brutto: '369.00',
        }),
      ],
      kategoria,
    });
    expect(wynik.kategorie).toEqual([
      { kategoria: 'Kurierzy', typ: 'zmienny', netto: '300.00', udzial: 75 },
      { kategoria: 'Prowizje sprzedażowe', typ: 'zmienny', netto: '100.00', udzial: 25 },
    ]);
  });

  it('⚠️ nieprzypisane stoja OSOBNO i w zlotowkach, nie w „drobnych"', () => {
    const wynik = zlozWidok({
      wiersze: [
        w(),
        w({ ksef_number: 'K2', sprzedawca_nip: '9999999999', netto: '40.00', vat: '9.20', brutto: '49.20' }),
      ],
      kategoria,
    });
    expect(wynik.nieprzypisane).toEqual({ ile: 1, netto: '40.00' });
    expect(wynik.kategorie.map((k) => k.kategoria)).not.toContain('Drobne zakupy bieżące');
  });

  it('⚠️ dokument w obcej walucie NIE wchodzi do sumy PLN i jest wymieniony osobno', () => {
    const wynik = zlozWidok({
      wiersze: [
        w(),
        w({
          ksef_number: 'K2', waluta: 'EUR', netto: '90.00', vat: '20.70', brutto: '110.70',
          numer_dokumentu: 'INV-9',
        }),
      ],
      kategoria,
    });
    expect(wynik.suma.netto).toBe('100.00');
    // ⚠️ Z KLUCZEM I ZRODLEM: faktury zagraniczne wpisuje sie RECZNIE i wychodzą właśnie tutaj,
    // więc bez klucza ekran nie miałby czym zaadresować poprawki kwoty ani usunięcia.
    expect(wynik.obcaWaluta).toEqual([{
      klucz: 'K2', zrodlo: undefined, numerDokumentu: 'INV-9', waluta: 'EUR', netto: '90.00',
    }]);
  });

  // ⚠️ ZALOZENIE DO POTWIERDZENIA POMIAREM (Zadanie 0, docs/superpowers/specs/
  // 2026-08-12-oms-koszty-ksef-design.md §1.5): test zaklada, ze KSeF
  // podaje kwoty korekty JUZ ROZNICOWO, ze znakiem, wiec korekta na minus po prostu wchodzi
  // do sumy miesiaca i ja pomniejsza. Jesli pomiar pokaze kwoty PELNE (dodatnie), ten test
  // i implementacja (`zlozWidok` w lista-kosztow.js) zmieniaja sie na odejmowanie po
  // `rodzaj === 'Kor'`.
  it('korekta wchodzi do sumy ze swoim znakiem', () => {
    const wynik = zlozWidok({
      wiersze: [w(), w({ ksef_number: 'K2', rodzaj: 'Kor', netto: '-30.00', vat: '-6.90', brutto: '-36.90' })],
      kategoria,
    });
    expect(wynik.suma.netto).toBe('70.00');
  });

  it('pusty miesiac oddaje zera, nie wywala sie na dzieleniu przez zero', () => {
    const wynik = zlozWidok({ wiersze: [], kategoria });
    expect(wynik.suma).toEqual({ netto: '0.00', vat: '0.00', brutto: '0.00' });
    expect(wynik.kategorie).toEqual([]);
  });
});
