import { expect, it } from 'vitest';
import { importMozeZapisac } from '../../src/domena/zrodla-pol.js';

const lista = ['woo:sklep', 'woo:drugi', 'allegro:konto', 'allegro:drugie'];
const z = (zrodlo, reczne = 0) => ({ zrodlo, reczne });

it.each(['cena_gr', 'zdjecia', 'opis'])('%s: wyższe połączenie przejmuje pole, niższe nie', (pole) => {
  const wartosc = pole === 'zdjecia' ? [{}] : 120;
  expect(importMozeZapisac(pole, wartosc, z('allegro:konto'), 'woo:sklep', lista)).toBe(true);
  expect(importMozeZapisac(pole, wartosc, z('woo:sklep'), 'allegro:konto', lista)).toBe(false);
  expect(importMozeZapisac(pole, wartosc, z('woo:drugi'), 'woo:sklep', lista)).toBe(true);
  expect(importMozeZapisac(pole, wartosc, z('allegro:drugie'), 'allegro:konto', lista)).toBe(true);
  expect(importMozeZapisac(pole, wartosc, z('allegro:konto'), 'woo:sklep', [...lista].reverse())).toBe(false);
});

it('chroni ręczne i zastane pola przy obu kolejnościach, także celowo puste', () => {
  for (const kolejnosc of [lista, [...lista].reverse()]) {
    for (const wartosc of [null, 120]) {
      for (const zrodlo of ['reczne', 'zastane', 'api', 'allegro:konto', 'allegro:odlaczone']) {
        expect(importMozeZapisac('cena_gr', wartosc, z(zrodlo, 1), 'woo:sklep', kolejnosc)).toBe(false);
      }
    }
    expect(importMozeZapisac('cena_gr', 120, null, 'woo:sklep', kolejnosc)).toBe(false);
  }
});

it.each(['cena_gr', 'zdjecia', 'opis'])('%s: znane połączenie przejmuje pole od właściciela spoza listy', (pole) => {
  const wartosc = pole === 'zdjecia' ? [{}] : 120;
  expect(importMozeZapisac(pole, wartosc, z('allegro:odlaczone'), 'woo:sklep', lista)).toBe(true);
  expect(importMozeZapisac(pole, wartosc, z('allegro:odlaczone'), 'woo:obcy', lista)).toBe(false);
  expect(importMozeZapisac(pole, wartosc, z('allegro:odlaczone', 1), 'woo:sklep', lista)).toBe(false);
  expect(importMozeZapisac(pole, wartosc, z('zastane', 1), 'woo:sklep', lista)).toBe(false);
  expect(importMozeZapisac(pole, wartosc, null, 'woo:sklep', lista)).toBe(false);
});

it('spoza listy nie przejmuje pola; puste i własne aktualizuje; api respektuje reczne', () => {
  expect(importMozeZapisac('cena_gr', 120, z('allegro:konto'), 'woo:obcy', lista)).toBe(false);
  expect(importMozeZapisac('cena_gr', null, z('allegro:konto'), 'woo:obcy', lista)).toBe(true);
  expect(importMozeZapisac('cena_gr', 120, z('woo:obcy'), 'woo:obcy', lista)).toBe(true);
  expect(importMozeZapisac('cena_gr', 120, z('api'), 'woo:sklep', ['woo:sklep', 'api'])).toBe(true);
});
