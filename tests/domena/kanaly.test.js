import { definicjeKanalowHistoryczne } from '../pomoc/kanaly-historyczne-fixture.js';
import { describe, it, expect } from 'vitest';
import { adresKanalu } from '../../src/domena/kanaly.js';

// Zadanie „strona głowna": kanał sprzedaży na liście ma pochodzić z kolumny `sklep`,
// NIGDY z tekstu zaszytego na sztywno w widoku — kolejne sklepy (swietlik.example.test, Allegro...)
// dojdą, a lista nie może wtedy dalej pokazywać „pro.swietlik.example.test" wszystkim wierszom.
describe('adresKanalu', () => {
  it('mapuje znany klucz sklepu na jego adres', () => {
    expect(adresKanalu('pro', definicjeKanalowHistoryczne)).toBe('pro.swietlik.example.test');
  });

  // ⚠️ Etap 2: dwa sklepy naraz. Bez tego wiersza lista pisala przy zamowieniach
  // z swietlik.example.test surowy klucz „swietlik" — wygladajacy na adres, ktoremu ktos uciac
  // koncowke.
  it('każdy klucz sklepu, który panel realnie zapisuje, ma czytelną nazwę', () => {
    expect(adresKanalu('swietlik', definicjeKanalowHistoryczne)).toBe('swietlik.example.test');
    expect(adresKanalu('reczne', definicjeKanalowHistoryczne)).toBe('ręczne');
  });

  // Klucz spoza mapy NIE ma dawać pustki ani zawsze tej samej wartości — inaczej dwa
  // zamówienia z różnych kanałów wyglądałyby na liście identycznie, mimo że kolumna
  // `sklep` w bazie jest różna. To jest test, który łapie „na sztywno wpisany adres".
  it('nieznany klucz sklepu oddaje wprost, nie wartość zaszytą na sztywno', () => {
    expect(adresKanalu('nowy-kanal', definicjeKanalowHistoryczne)).toBe('nowy-kanal');
  });

  // ⚠️ „indywidualne" NIE jest wartością kolumny `sklep` — to kanał wyprowadzony ze
  // znacznika `zamowienia.indywidualne`. Etykieta mieszka mimo to w TEJ SAMEJ mapie:
  // pozycję filtra kanału i kolumnę „Kanał sprzedaży" opisuje jedna funkcja, więc nie
  // mają prawa nazwać tego samego inaczej.
  it('„indywidualne" ma własną etykietę — tę samą w filtrze, co w kolumnie', () => {
    expect(adresKanalu('indywidualne', definicjeKanalowHistoryczne)).toBe('Indywidualne');
  });

  it('brak wartości nie wywala funkcji', () => {
    expect(adresKanalu(null, definicjeKanalowHistoryczne)).toBeFalsy();
    expect(adresKanalu(undefined, definicjeKanalowHistoryczne)).toBeFalsy();
  });

  it('kanały Allegro mają nazwę konta, a nie surowy klucz kolumny', () => {
    expect(adresKanalu('allegro_swietlik', definicjeKanalowHistoryczne)).toBe('Allegro swietlik_pl');
    expect(adresKanalu('allegro_polcien2', definicjeKanalowHistoryczne)).toBe('Allegro Półcień Druga');
  });

  it('klucz sklepu swietlik.example.test NIE MYLI SIĘ z kontem Allegro swietlik_pl', () => {
    expect(adresKanalu('swietlik', definicjeKanalowHistoryczne)).toBe('swietlik.example.test');
  });
});
