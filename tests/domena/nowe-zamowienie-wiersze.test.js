import { describe, it, expect } from 'vitest';
import {
  POLA_WIERSZA_POZYCJI, dodajWierszFormularza, usunWierszFormularza, liczbaWierszyFormularza,
} from '../../src/domena/nowe-zamowienie.js';

// PRZ-103 (21.10.2026): na ekranie „Nowe zamówienie" operator dokłada i kasuje wiersze pozycji.
// Wiersz to OSIEM równoległych tablic (`poz_nazwa[]`, `poz_cena_brutto[]`, ukryte `poz_produkt_id[]`…).
// Skasowanie wiersza w jednej tablicy, a nie w drugiej, przesuwa cenę i tożsamość produktu
// o jeden wiersz w dół — po cichu, bo każdy wiersz z osobna wygląda poprawnie.

const trzyWiersze = () => ({
  w_nazwa: 'Anna Kowalska',
  poz_nazwa: ['Lampa Grzybek', 'Kinkiet Sowa', 'Abażur lniany'],
  poz_sku: ['LMP-1', 'KNK-2', 'ABZ-3'],
  poz_ilosc: ['1', '2', '3'],
  poz_cena_netto: ['', '', ''],
  poz_cena_brutto: ['74.90', '129.00', '45.00'],
  poz_produkt_id: ['101', '202', '303'],
  poz_wariant_id: ['', '22', ''],
  poz_cena_katalogowa: ['74.90', '129.00', '45.00'],
});

describe('usunWierszFormularza', () => {
  it('kasuje wskazany wiersz we WSZYSTKICH tablicach naraz', () => {
    const wynik = usunWierszFormularza(trzyWiersze(), 1);
    expect(wynik.poz_nazwa).toEqual(['Lampa Grzybek', 'Abażur lniany']);
    expect(wynik.poz_cena_brutto).toEqual(['74.90', '45.00']);
    expect(wynik.poz_produkt_id).toEqual(['101', '303']);
    expect(wynik.poz_wariant_id).toEqual(['', '']);
    expect(wynik.poz_cena_katalogowa).toEqual(['74.90', '45.00']);
    for (const pole of POLA_WIERSZA_POZYCJI) expect(wynik[pole]).toHaveLength(2);
  });

  it('nie rusza reszty formularza', () => {
    expect(usunWierszFormularza(trzyWiersze(), 0).w_nazwa).toBe('Anna Kowalska');
  });

  it('pojedynczy wiersz (pola jako napisy, nie tablice) da się skasować', () => {
    const wynik = usunWierszFormularza({ poz_nazwa: 'Lampa', poz_cena_brutto: '10.00' }, 0);
    expect(wynik.poz_nazwa).toEqual([]);
    expect(wynik.poz_cena_brutto).toEqual([]);
  });

  it('tablica krótsza od innych dostaje puste napisy, zanim wiersz zniknie', () => {
    const wynik = usunWierszFormularza({ poz_nazwa: ['A', 'B', 'C'], poz_sku: ['a'] }, 0);
    expect(wynik.poz_nazwa).toEqual(['B', 'C']);
    expect(wynik.poz_sku).toEqual(['', '']);
  });

  it.each([['-1'], ['3'], ['x'], [''], [undefined], ['1.5']])('numer %s spoza tabeli niczego nie kasuje', (nr) => {
    const wynik = usunWierszFormularza(trzyWiersze(), nr);
    expect(wynik.poz_nazwa).toEqual(trzyWiersze().poz_nazwa);
  });
});

describe('dodajWierszFormularza', () => {
  it('dokłada jeden pusty wiersz na końcu każdej tablicy', () => {
    const wynik = dodajWierszFormularza(trzyWiersze());
    for (const pole of POLA_WIERSZA_POZYCJI) {
      expect(wynik[pole]).toHaveLength(4);
      // PRZ-106: ilość w nowym wierszu to 1 (wartość, nie podpowiedź), reszta pusta.
      expect(wynik[pole][3]).toBe(pole === 'poz_ilosc' ? '1' : '');
    }
    expect(wynik.poz_nazwa.slice(0, 3)).toEqual(trzyWiersze().poz_nazwa);
  });

  it('pusty formularz (pierwsze wejście) dostaje drugi wiersz — inaczej przycisk nic by nie zrobił', () => {
    expect(liczbaWierszyFormularza(dodajWierszFormularza({}))).toBe(2);
  });
});

describe('liczbaWierszyFormularza', () => {
  // Prośba właściciela 21.10: „zrób 1 wiersz na start”. Do PRZ-103 było pięć pustych.
  it('pierwsze wejście na ekran: jeden pusty wiersz', () => {
    expect(liczbaWierszyFormularza({})).toBe(1);
  });

  // Operator skasował wiersze — formularz wracający z „Pobierz z GUS" albo „Dodaj z magazynu"
  // ma ich mieć tyle, ile zostawił, a nie dopełniać z powrotem do podłogi.
  it('formularz z pozycjami ma tyle wierszy, ile przyszło', () => {
    expect(liczbaWierszyFormularza({ poz_nazwa: ['A', 'B'], poz_ilosc: ['1', '1'] })).toBe(2);
    expect(liczbaWierszyFormularza(trzyWiersze())).toBe(3);
  });

  it('jeden wiersz przysłany napisem to jeden wiersz', () => {
    expect(liczbaWierszyFormularza({ poz_nazwa: 'Lampa' })).toBe(1);
  });

  it('wszystkie wiersze skasowane: zostaje jeden pusty, nie zero', () => {
    expect(liczbaWierszyFormularza({ poz_nazwa: [], poz_ilosc: [] })).toBe(1);
  });

  it('liczy najdłuższą tablicę, także ukrytą', () => {
    expect(liczbaWierszyFormularza({ poz_nazwa: ['A'], poz_produkt_id: ['1', '2', '3', '4', '5', '6', '7'] })).toBe(7);
  });
});
