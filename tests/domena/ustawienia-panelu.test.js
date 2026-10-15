import { describe, it, expect } from 'vitest';
import {
  PACZKA_DOMYSLNA, KOSZT_DOSTAWY_DOMYSLNY_GR,
  domyslnaPaczka, kwotyDostawy, kosztDostawy, sprawdzPaczke, sprawdzKoszty,
} from '../../src/domena/ustawienia-panelu.js';
import { DOSTAWY } from '../../src/domena/nowe-zamowienie.js';

describe('domyślna paczka', () => {
  // ⚠️ TO JEST NAJWAŻNIEJSZY TEST TEGO MODUŁU. Pusty zapis to stan bazy TUŻ PO WDROŻENIU —
  // panel ma się wtedy zachować dokładnie jak przed nim.
  it('pusty zapis oddaje dzisiejsze wartości panelu, a nie zera', () => {
    expect(domyslnaPaczka({})).toEqual({ waga: 1, dlugosc: 110, szerokosc: 75, wysokosc: 1 });
  });

  it('brak argumentu też oddaje wartości domyślne', () => {
    expect(domyslnaPaczka()).toEqual(PACZKA_DOMYSLNA);
  });

  it('czyta wartości z zapisu', () => {
    const zapis = {
      'paczka.waga': '2,5', 'paczka.dlugosc': '100', 'paczka.szerokosc': '70', 'paczka.wysokosc': '5',
    };

    expect(domyslnaPaczka(zapis)).toEqual({ waga: 2.5, dlugosc: 100, szerokosc: 70, wysokosc: 5 });
  });

  // ⚠️ FALLBACK JEST PER POLE. Jeden zepsuty wiersz (ręczny UPDATE w SQLite, migracja) nie ma
  // prawa wyzerować pozostałych trzech — a wymiary jadą do DPD i są rozliczane.
  it('zepsuta pojedyncza wartość wraca do domyślnej TEGO pola, reszta zostaje', () => {
    const zapis = { 'paczka.waga': '0', 'paczka.dlugosc': '100', 'paczka.szerokosc': 'ala', 'paczka.wysokosc': '-3' };

    expect(domyslnaPaczka(zapis)).toEqual({ waga: 1, dlugosc: 100, szerokosc: 75, wysokosc: 1 });
  });
});

describe('kwoty dostawy', () => {
  it('pusty zapis oddaje 19,00 dla KAŻDEJ metody — tyle podstawia panel dziś', () => {
    expect(kwotyDostawy({})).toEqual({ dpd: '19,00', inpost_paczkomat: '19,00', odbior_osobisty: '19,00' });
  });

  it('lista metod jest ta sama, co lista dostaw na ekranie zakładania', () => {
    expect(Object.keys(kwotyDostawy({}))).toEqual(Object.keys(DOSTAWY));
  });

  it('czyta grosze z zapisu i formatuje po polsku, z przecinkiem', () => {
    const zapis = { 'dostawa.dpd': '1900', 'dostawa.inpost_paczkomat': '1300', 'dostawa.odbior_osobisty': '0' };

    expect(kwotyDostawy(zapis)).toEqual({ dpd: '19,00', inpost_paczkomat: '13,00', odbior_osobisty: '0,00' });
  });

  // ⚠️ ZERO JEST WARTOŚCIĄ, NIE BRAKIEM. Odbiór osobisty nie kosztuje i to jest poprawny wpis.
  it('zapisane zero oddaje 0,00, a nie wartość domyślną', () => {
    expect(kwotyDostawy({ 'dostawa.odbior_osobisty': '0' }).odbior_osobisty).toBe('0,00');
  });

  it('zepsuta wartość wraca do domyślnej tej metody', () => {
    expect(kwotyDostawy({ 'dostawa.dpd': 'ala', 'dostawa.inpost_paczkomat': '-5' }))
      .toEqual({ dpd: '19,00', inpost_paczkomat: '19,00', odbior_osobisty: '19,00' });
  });

  it('kosztDostawy oddaje kwotę jednej metody', () => {
    expect(kosztDostawy({ 'dostawa.inpost_paczkomat': '1300' }, 'inpost_paczkomat')).toBe('13,00');
  });

  // Metoda spoza listy (stary formularz, literówka) nie ma prawa oddać `undefined` — pole
  // formularza dostałoby wtedy pusty napis i operator nie zobaczyłby żadnej kwoty.
  it('nieznana metoda dostaje kwotę domyślną', () => {
    expect(kosztDostawy({}, 'kurier_z_ksiezyca')).toBe('19,00');
  });
});

describe('walidacja formularza paczki', () => {
  it('przyjmuje poprawne wartości i oddaje je pod kluczami ustawień', () => {
    const { wartosci, bledy } = sprawdzPaczke({ waga: '1,5', dlugosc: '110', szerokosc: '75', wysokosc: '1' });

    expect(bledy).toEqual([]);
    expect(wartosci).toEqual({
      'paczka.waga': '1.5', 'paczka.dlugosc': '110', 'paczka.szerokosc': '75', 'paczka.wysokosc': '1',
    });
  });

  // ⚠️ ZERO TO ODMOWA. Paczki o boku 0 cm kurier nie przyjmie, a etykieta i tak by powstała.
  it('odmawia zeru, wartości ujemnej i tekstowi — z nazwą pola', () => {
    const { wartosci, bledy } = sprawdzPaczke({ waga: '0', dlugosc: '-1', szerokosc: 'ala', wysokosc: '' });

    expect(wartosci).toEqual({});
    expect(bledy).toHaveLength(4);
    expect(bledy.join(' ')).toContain('waga');
    expect(bledy.join(' ')).toContain('długość');
    expect(bledy.join(' ')).toContain('szerokość');
    expect(bledy.join(' ')).toContain('wysokość');
  });

  // ⚠️ ODMOWA JEST CAŁOŚCIOWA. Zapisanie trzech poprawnych boków i odrzucenie czwartego dałoby
  // paczkę, której nikt świadomie nie ustawił.
  it('jedno złe pole blokuje zapis wszystkich', () => {
    const { wartosci, bledy } = sprawdzPaczke({ waga: '1', dlugosc: '110', szerokosc: '75', wysokosc: '0' });

    expect(bledy).toHaveLength(1);
    expect(wartosci).toEqual({});
  });
});

describe('walidacja formularza kosztów', () => {
  it('przyjmuje kwoty i przelicza je na grosze', () => {
    const { wartosci, bledy } = sprawdzKoszty({ dpd: '19,00', inpost_paczkomat: '13', odbior_osobisty: '0,00' });

    expect(bledy).toEqual([]);
    expect(wartosci).toEqual({
      'dostawa.dpd': '1900', 'dostawa.inpost_paczkomat': '1300', 'dostawa.odbior_osobisty': '0',
    });
  });

  // ⚠️ PUSTE POLE TO ODMOWA, NIE ZERO — inaczej przypadkowo wyczyszczone pole robi z dostawy
  // darmową i nikt tego nie zauważy. To jest INNA zasada niż przy kwocie na ekranie zakładania
  // zamówienia (tam puste znaczy zero), bo tam człowiek wpisuje kwotę JEDNEGO zamówienia,
  // a tutaj ustawia wartość startową dla wszystkich następnych.
  it('puste pole to odmowa, nie ciche zero', () => {
    const { wartosci, bledy } = sprawdzKoszty({ dpd: '', inpost_paczkomat: '13,00', odbior_osobisty: '0' });

    expect(wartosci).toEqual({});
    expect(bledy).toHaveLength(1);
    expect(bledy[0]).toContain('DPD');
  });

  it('odmawia kwocie ujemnej i nieliczbowej', () => {
    const { bledy } = sprawdzKoszty({ dpd: '-1', inpost_paczkomat: 'dużo', odbior_osobisty: '0' });

    expect(bledy).toHaveLength(2);
  });

  it('zero jest poprawną kwotą', () => {
    const { wartosci, bledy } = sprawdzKoszty({ dpd: '0', inpost_paczkomat: '0', odbior_osobisty: '0' });

    expect(bledy).toEqual([]);
    expect(wartosci['dostawa.dpd']).toBe('0');
  });
});

describe('stałe', () => {
  it('KOSZT_DOSTAWY_DOMYSLNY_GR to 19,00 zł — dokładnie to, co panel wpisywał w widoku', () => {
    expect(KOSZT_DOSTAWY_DOMYSLNY_GR).toBe(1900);
  });
});
