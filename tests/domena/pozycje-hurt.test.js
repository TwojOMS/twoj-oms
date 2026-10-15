import { describe, it, expect } from 'vitest';
import { parsujHurtPozycji, ustawWMapie, ustawNadpisaniePozycji } from '../../src/domena/pozycje-reczne.js';

// Tryb edycji CAŁEGO panelu pozycji (przebudowa karty 2026-07-31): jedno „Edytuj" otwiera
// wszystkie wiersze naraz, jeden „Zapisz" je zapisuje. Formularz niesie RÓWNOLEGŁE TABLICE
// (klucz[], nazwa[], ilosc[], cena_brutto[]), bo `@fastify/formbody` nie parsuje zagnieżdżonych
// nawiasów — `pozycje[s555][nazwa]` przyszłoby jako jeden klucz tekstowy.

describe('parsujHurtPozycji', () => {
  it('zszywa równoległe tablice po indeksie', () => {
    const wiersze = parsujHurtPozycji({
      klucz: ['s1', 'r2'],
      nazwa: ['STOP', 'Dopłata'],
      ilosc: ['2', '1'],
      cena_brutto: ['10,00', '80.00'],
    });
    expect(wiersze).toEqual([
      { klucz: 's1', nazwa: 'STOP', ilosc: '2', cena_brutto: '10,00' },
      { klucz: 'r2', nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' },
    ]);
  });

  // Przeglądarka przy JEDNYM wierszu przysyła pola jako pojedyncze wartości, nie tablice —
  // bez tego zamówienie z jedną pozycją byłoby jedynym, którego nie da się zapisać.
  it('pojedynczy wiersz przychodzi bez tablic i też działa', () => {
    expect(parsujHurtPozycji({ klucz: 's1', nazwa: 'STOP', ilosc: '1', cena_brutto: '10' }))
      .toEqual([{ klucz: 's1', nazwa: 'STOP', ilosc: '1', cena_brutto: '10' }]);
  });

  // ⚠️ Tablice różnej długości = żądanie urwane albo obce. Zszycie „na ile się da" wpisałoby
  // cenę jednej pozycji do drugiej — czyli po cichu zmieniłoby kwotę, której panel oczekuje
  // od klienta. To są pieniądze, więc odmowa jest jedyną poprawną odpowiedzią.
  it('tablice różnej długości = odmowa, bez zapisu czegokolwiek', () => {
    expect(() => parsujHurtPozycji({
      klucz: ['s1', 's2'], nazwa: ['A', 'B'], ilosc: ['1'], cena_brutto: ['10', '20'],
    })).toThrow(/tyle samo|różn/i);
  });

  it('żądanie bez ani jednego pola formularza = odmowa', () => {
    expect(() => parsujHurtPozycji({})).toThrow();
    expect(() => parsujHurtPozycji(undefined)).toThrow();
  });

  it('odmowa jest oznaczona jako komunikat dla operatora', () => {
    try {
      parsujHurtPozycji({});
      throw new Error('miało rzucić');
    } catch (e) {
      expect(e.dlaOperatora).toBe(true);
    }
  });
});

describe('ustawWMapie', () => {
  it('dokłada nadpisanie pod kluczem', () => {
    expect(ustawWMapie({}, 's1', { ilosc: 3 })).toEqual({ s1: { ilosc: 3 } });
  });

  it('puste nadpisanie KASUJE klucz — to jest „wróciło do wartości ze sklepu"', () => {
    expect(ustawWMapie({ s1: { ilosc: 3 }, s2: { nazwa: 'X' } }, 's1', {})).toEqual({ s2: { nazwa: 'X' } });
  });

  // ⚠️ Mutacja: mutowanie wejścia zamiast kopii ma zaczerwienić TEN test. Zapis hurtem
  // przepuszcza mapę przez tę funkcję raz na wiersz — mutowanie w miejscu znaczyłoby, że
  // odmowa w połowie pętli zostawia bazę w stanie pół-zapisanym.
  it('nie mutuje mapy wejściowej', () => {
    const wejscie = { s1: { ilosc: 3 } };
    ustawWMapie(wejscie, 's2', { nazwa: 'X' });
    expect(wejscie).toEqual({ s1: { ilosc: 3 } });
  });

  it('składa się wielokrotnie — wynik jednego wywołania jest wejściem następnego', () => {
    let mapa = {};
    mapa = ustawWMapie(mapa, 's1', { ilosc: 2 });
    mapa = ustawWMapie(mapa, 's2', { nazwa: 'B' });
    mapa = ustawWMapie(mapa, 's1', {});
    expect(mapa).toEqual({ s2: { nazwa: 'B' } });
  });
});

// Kontrola, że stara droga (edycja jednej pozycji) dalej działa tak samo — obie korzystają
// teraz z ustawWMapie, więc ten test pilnuje, że refaktor niczego nie przestawił.
describe('ustawNadpisaniePozycji (edycja pojedynczej pozycji)', () => {
  it('czyta JSON z bazy i oddaje mapę', () => {
    expect(ustawNadpisaniePozycji('{"s1":{"ilosc":3}}', 's2', { nazwa: 'X' }))
      .toEqual({ s1: { ilosc: 3 }, s2: { nazwa: 'X' } });
  });

  it('skasowanie ostatniego klucza daje null, nie pusty obiekt', () => {
    expect(ustawNadpisaniePozycji('{"s1":{"ilosc":3}}', 's1', {})).toBeNull();
  });
});
