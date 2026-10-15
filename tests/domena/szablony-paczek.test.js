import { describe, expect, it } from 'vitest';
import {
  odczytajSzablony, zmienSzablon, ustawDomyslnySzablon, usunSzablon, zapiszSzablony,
} from '../../src/domena/szablony-paczek.js';
import { domyslnaPaczka } from '../../src/domena/ustawienia-panelu.js';

const MALA = { nazwa: 'Mała', waga: '0,5', dlugosc: '30', szerokosc: '20', wysokosc: '10' };

describe('szablony paczek', () => {
  it('bez nowego klucza zachowuje dotychczasową paczkę i fallback per pole', () => {
    const stan = odczytajSzablony({ 'paczka.waga': '2,5', 'paczka.dlugosc': '0', 'paczka.szerokosc': '60' });

    expect(stan.domyslnyId).toBe('domyslna');
    expect(stan.szablony).toEqual([{
      id: 'domyslna', nazwa: 'Paczka domyślna', waga: 2.5, dlugosc: 110, szerokosc: 60, wysokosc: 1,
    }]);
  });

  it('dodaje zestaw bez zmiany paczki masowej, a wybór domyślnego synchronizuje stare klucze', () => {
    const start = odczytajSzablony({});
    const dodany = zmienSzablon(start, MALA, 'mala');
    expect(dodany.bledy).toEqual([]);
    expect(zapiszSzablony(dodany.stan)['paczka.dlugosc']).toBe('110');

    const wybrany = ustawDomyslnySzablon(dodany.stan, 'mala');
    expect(wybrany.bledy).toEqual([]);
    const zapis = zapiszSzablony(wybrany.stan);
    expect(zapis).toMatchObject({
      'paczka.waga': '0.5', 'paczka.dlugosc': '30', 'paczka.szerokosc': '20', 'paczka.wysokosc': '10',
    });
    expect(domyslnaPaczka(zapis)).toEqual({ waga: 0.5, dlugosc: 30, szerokosc: 20, wysokosc: 10 });
  });

  it('zmienia istniejący zestaw bez tworzenia duplikatu ID', () => {
    const dodany = zmienSzablon(odczytajSzablony({}), MALA, 'mala').stan;
    const wynik = zmienSzablon(dodany, { ...MALA, id: 'mala', nazwa: 'Mała poprawiona', wysokosc: '12' });

    expect(wynik.bledy).toEqual([]);
    expect(wynik.stan.szablony).toHaveLength(2);
    expect(wynik.stan.szablony[1]).toMatchObject({ id: 'mala', nazwa: 'Mała poprawiona', wysokosc: 12 });
  });

  it('odmawia pustej i powtórzonej nazwy oraz niedodatnich wymiarów bez częściowego wyniku', () => {
    const dodany = zmienSzablon(odczytajSzablony({}), MALA, 'mala').stan;
    for (const dane of [
      { ...MALA, nazwa: ' ' },
      { ...MALA, nazwa: ' mAŁa ' },
      { ...MALA, nazwa: 'Duża', wysokosc: '0' },
    ]) {
      const wynik = zmienSzablon(dodany, dane, 'nowa');
      expect(wynik.stan).toBeUndefined();
      expect(wynik.bledy.length).toBeGreaterThan(0);
      expect(dodany.szablony).toHaveLength(2);
    }
  });

  it('nie pozwala usunąć domyślnego ani ostatniego zestawu', () => {
    const start = odczytajSzablony({});
    const wynik = usunSzablon(start, 'domyslna');
    expect(wynik.stan).toBeUndefined();
    expect(wynik.bledy.join(' ')).toContain('domyśl');
  });

  it('uszkodzony JSON nie zmienia paczki domyślnej w zero', () => {
    const zapis = { 'paczka.szablony': '{', 'paczka.waga': '3', 'paczka.dlugosc': '90' };
    expect(odczytajSzablony(zapis).szablony[0]).toMatchObject({ waga: 3, dlugosc: 90, szerokosc: 75, wysokosc: 1 });
    expect(domyslnaPaczka(zapis)).toEqual({ waga: 3, dlugosc: 90, szerokosc: 75, wysokosc: 1 });
  });

  it('ręcznie uszkodzony JSON z tekstem zamiast liczby wraca do bezpiecznych pól legacy', () => {
    const zapis = {
      'paczka.szablony': JSON.stringify({ version: 1, domyslnyId: 'domyslna', szablony: [{
        id: 'domyslna', nazwa: 'Paczka domyślna', waga: '2', dlugosc: 30, szerokosc: 20, wysokosc: 10,
      }] }),
      'paczka.waga': '3', 'paczka.dlugosc': '90', 'paczka.szerokosc': '60', 'paczka.wysokosc': '4',
    };

    expect(domyslnaPaczka(zapis)).toEqual({ waga: 3, dlugosc: 90, szerokosc: 60, wysokosc: 4 });
  });
});
