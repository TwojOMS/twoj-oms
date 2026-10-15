// tests/core/sprawdz-moduly.test.ts
import { describe, it, expect } from 'vitest';
import { sprawdzModuly, kolejnoscBudowy } from '../../src/core/sprawdz-moduly.ts';
import type { ModulOms } from '../../src/core/kontrakty.ts';

const modul = (nadpisz: Partial<ModulOms> = {}): ModulOms => ({
  nazwa: 'magazyn', wersja: '1.0.0', wymaga: [], konfiguracja: () => ({}),
  migracje: [], uprawnienia: [{ klucz: 'magazyn', etykieta: 'Magazyn', role: ['sprzedaz'] }],
  menu: [{ dzial: 'Sprzedaż', etykieta: 'Magazyn', adres: '/magazyn', uprawnienie: 'magazyn', kolejnosc: 50 }],
  zbuduj: () => ({}), ...nadpisz,
});

describe('sprawdzModuly', () => {
  it.each(['Wysylka.dpd', 'wysylka.dpd', ''])('odrzuca niepoprawną nazwę modułu: %s', (nazwa) => {
    expect(() => sprawdzModuly([modul({ nazwa })])).toThrow('nazwa musi pasować');
  });
  it.each([0, -1, 1.5, NaN, Infinity])('odrzuca niedodatni lub niecałkowity numer migracji: %s', (numer) => {
    expect(() => sprawdzModuly([modul({ migracje: [{ numer, nazwa: 'a', wykonaj: () => {} }] })]))
      .toThrow('musi być dodatnią liczbą całkowitą');
  });
  it('przepuszcza poprawny moduł', () => {
    expect(() => sprawdzModuly([modul()])).not.toThrow();
  });
  it('odrzuca dwa moduły o tej samej nazwie', () => {
    expect(() => sprawdzModuly([modul(), modul({ uprawnienia: [], menu: [] })])).toThrow('zarejestrowany dwa razy');
  });
  it('odrzuca dwa moduły deklarujące ten sam klucz uprawnienia', () => {
    expect(() => sprawdzModuly([modul(), modul({ nazwa: 'koszty', menu: [] })])).toThrow('Uprawnienie „magazyn" deklarują moduły');
  });
  it('odrzuca pozycję menu z nieznanym uprawnieniem', () => {
    expect(() => sprawdzModuly([modul({ menu: [{ dzial: 'x', etykieta: 'X', adres: '/x', uprawnienie: 'brak', kolejnosc: 1 }] })]))
      .toThrow('nieznane uprawnienie „brak"');
  });
  it('odrzuca powtórzony numer migracji', () => {
    const m = { numer: 2, nazwa: 'a', wykonaj: () => {} };
    expect(() => sprawdzModuly([modul({ migracje: [m, { ...m, nazwa: 'b' }] })])).toThrow('numer migracji 2 powtórzony');
  });
  it('odrzuca zależność od modułu, którego nie ma', () => {
    expect(() => sprawdzModuly([modul({ wymaga: ['zamowienia'] })])).toThrow('wymaga modułu „zamowienia"');
  });
  it('odrzuca wersję spoza X.Y.Z', () => {
    expect(() => sprawdzModuly([modul({ wersja: '1.0' })])).toThrow('X.Y.Z');
  });
});

describe('kolejnoscBudowy', () => {
  it('buduje zależność przed modułem, który jej wymaga', () => {
    const a = modul({ nazwa: 'faktury', wymaga: ['zamowienia'], uprawnienia: [], menu: [] });
    const b = modul({ nazwa: 'zamowienia', uprawnienia: [], menu: [] });
    expect(kolejnoscBudowy([a, b]).map((m) => m.nazwa)).toEqual(['zamowienia', 'faktury']);
  });
  it('nazywa cykl zależności zamiast zawiesić start', () => {
    const a = modul({ nazwa: 'a', wymaga: ['b'], uprawnienia: [], menu: [] });
    const b = modul({ nazwa: 'b', wymaga: ['a'], uprawnienia: [], menu: [] });
    expect(() => kolejnoscBudowy([a, b])).toThrow('Cykl zależności modułów: a → b → a');
  });
});
