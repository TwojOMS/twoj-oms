// PRZ-090 — wymiary i waga, które sklep WooCommerce podaje sam (`dimensions`, `weight`), oraz głębokość i waga karty.
import { describe, it, expect } from 'vitest';
import {
  wymiaryZeSklepu, wagaZeSklepu, gramyZKilogramow, kilogramyZGramow, opisWymiarow,
} from '../../src/domena/rozmiar.js';
import { kartaZProduktu } from '../../src/domena/karta-z-produktu.js';
import { ocenZapis } from '../../src/domena/zapis-do-sklepu.js';

const wym = (o) => JSON.stringify(o);

describe('wymiaryZeSklepu — Woo length/width/height → wysokość/szerokość/głębokość w mm', () => {
  it('przelicza jednostkę sklepu na milimetry (length = wysokość, width = szerokość, height = głębokość)', () => {
    expect(wymiaryZeSklepu(wym({ length: '45', width: '30', height: '12.5', unit: 'cm' })))
      .toEqual({ wysokosc_mm: 450, szerokosc_mm: 300, glebokosc_mm: 125 });
    expect(wymiaryZeSklepu(wym({ length: '0.45', width: '0.3', height: '', unit: 'm' })))
      .toEqual({ wysokosc_mm: 450, szerokosc_mm: 300, glebokosc_mm: null });
    expect(wymiaryZeSklepu(wym({ length: '450', width: '300', height: '20', unit: 'mm' })))
      .toEqual({ wysokosc_mm: 450, szerokosc_mm: 300, glebokosc_mm: 20 });
    expect(wymiaryZeSklepu(wym({ length: '10', width: '2', height: '1', unit: 'in' })))
      .toEqual({ wysokosc_mm: 254, szerokosc_mm: 51, glebokosc_mm: 25 });
  });

  it('nie zgaduje: bez jednostki, z nieznaną jednostką, z połową pary albo zerem oddaje null', () => {
    expect(wymiaryZeSklepu(wym({ length: '45', width: '30', height: '12' }))).toBe(null);
    expect(wymiaryZeSklepu(wym({ length: '45', width: '30', unit: 'stopy' }))).toBe(null);
    expect(wymiaryZeSklepu(wym({ length: '45', width: '', unit: 'cm' }))).toBe(null);
    expect(wymiaryZeSklepu(wym({ length: '0', width: '30', unit: 'cm' }))).toBe(null);
    expect(wymiaryZeSklepu('{zepsuty')).toBe(null);
    expect(wymiaryZeSklepu(null)).toBe(null);
  });
});

describe('wagaZeSklepu', () => {
  it('przelicza na gramy', () => {
    expect(wagaZeSklepu('1.25 kg')).toBe(1250);
    expect(wagaZeSklepu('800 g')).toBe(800);
    expect(wagaZeSklepu('2 lbs')).toBe(907);
    expect(wagaZeSklepu('10 oz')).toBe(283);
  });
  it('bez jednostki, pusta, zero albo śmieć — null', () => {
    for (const w of ['1.25', '', ' kg', '0 kg', 'abc kg', '2 funty', null, undefined]) expect(wagaZeSklepu(w)).toBe(null);
  });
});

describe('gramyZKilogramow / kilogramyZGramow — pole wagi na karcie', () => {
  it('kilogramy z formularza na gramy, pusty = świadome skasowanie, śmieć = nie rozumiem', () => {
    expect(gramyZKilogramow('1,25')).toEqual({ g: 1250 });
    expect(gramyZKilogramow('0.3')).toEqual({ g: 300 });
    expect(gramyZKilogramow('  ')).toEqual({ g: null });
    expect(gramyZKilogramow('1,2 kg')).toBe(null);
    expect(gramyZKilogramow('0')).toBe(null);
    expect(gramyZKilogramow(['1'])).toBe(null);
  });
  it('gramy na napis w kilogramach', () => {
    expect(kilogramyZGramow(1250)).toBe('1.25');
    expect(kilogramyZGramow(300)).toBe('0.3');
    expect(kilogramyZGramow(null)).toBe(null);
    expect(kilogramyZGramow(0)).toBe(null);
  });
});

describe('opisWymiarow z głębokością', () => {
  it('dwa wymiary jak dotąd, trzeci dopisany, gdy jest', () => {
    expect(opisWymiarow({ szerokosc_mm: 300, wysokosc_mm: 450 })).toBe('30 × 45 cm');
    expect(opisWymiarow({ szerokosc_mm: 300, wysokosc_mm: 450, glebokosc_mm: 125 })).toBe('30 × 45 × 12.5 cm');
    expect(opisWymiarow({ szerokosc_mm: null, wysokosc_mm: 450, glebokosc_mm: 125 })).toBe(null);
  });
});

describe('kartaZProduktu — wymiary sklepu obok rozmiaru z tekstu (atrybut / nazwa)', () => {
  const produkt = (nad) => ({ kanal: 'sklep', produkt_id: '1', wariant_id: '', nazwa: 'Lampa stołowa Grzybek 30x45cm',
    rozmiar_tekst: 'Lampa stołowa Grzybek 30x45cm', ...nad });

  it('nazwa bez rozmiaru, sklep podaje wymiary i wagę — karta bierze je ze sklepu', () => {
    const k = kartaZProduktu(produkt({ nazwa: 'Lampa stołowa Grzybek', rozmiar_tekst: 'Lampa stołowa Grzybek',
      wymiary_json: wym({ length: '50', width: '35', height: '20', unit: 'cm' }), waga_tekst: '2.4 kg' }));
    expect(k).toMatchObject({ szerokosc_mm: 350, wysokosc_mm: 500, glebokosc_mm: 200, waga_g: 2400 });
  });

  it('tekst i sklep zgodne — karta bierze wymiary sklepu razem z głębokością', () => {
    const k = kartaZProduktu(produkt({ wymiary_json: wym({ length: '45', width: '30', height: '20', unit: 'cm' }) }));
    expect(k).toMatchObject({ szerokosc_mm: 300, wysokosc_mm: 450, glebokosc_mm: 200 });
  });

  it('tekst i sklep mówią co innego (np. skopiowany produkt) — bez wymiarów, nie zgadujemy', () => {
    const k = kartaZProduktu(produkt({ wymiary_json: wym({ length: '100', width: '70', height: '', unit: 'cm' }),
      waga_tekst: '2.4 kg' }));
    expect(k).toMatchObject({ szerokosc_mm: null, wysokosc_mm: null, glebokosc_mm: null, waga_g: 2400 });
  });

  it('sklep wymiarów nie podaje — rozmiar z nazwy jak dotąd, bez głębokości i wagi', () => {
    const k = kartaZProduktu(produkt({ wymiary_json: null, waga_tekst: null }));
    expect(k).toMatchObject({ szerokosc_mm: 300, wysokosc_mm: 450, glebokosc_mm: null, waga_g: null });
  });
});

describe('ocenZapis — głębokość jedzie do Woo jako height', () => {
  const KANALY = ['sklep'];
  const p = (nad) => ({ kanal: 'sklep', produkt_id: '10', wariant_id: '', nazwa: 'x', sku_sklepu: null, ...nad });

  it('karta z głębokością wysyła length, width i height', () => {
    const { zmiany } = ocenZapis({ id: 1, sku: null, szerokosc_mm: 300, wysokosc_mm: 450, glebokosc_mm: 120 },
      [p()], { sklep: 'cm' }, KANALY);
    expect(zmiany[0].pola.dimensions).toEqual({ length: '45', width: '30', height: '12' });
    expect(zmiany[0].opis).toContain('45 × 30 × 12 cm');
  });

  it('karta bez głębokości wysyła wyłącznie length i width (zachowanie dotychczasowe)', () => {
    const { zmiany } = ocenZapis({ id: 1, sku: null, szerokosc_mm: 300, wysokosc_mm: 450, glebokosc_mm: null },
      [p()], { sklep: 'cm' }, KANALY);
    expect(zmiany[0].pola.dimensions).toEqual({ length: '45', width: '30' });
  });

  it('sklep ma już te same trzy wymiary — nic nie jedzie; inna głębokość — jedzie', () => {
    const karta = { id: 1, sku: null, szerokosc_mm: 300, wysokosc_mm: 450, glebokosc_mm: 120 };
    expect(ocenZapis(karta, [p({ wymiary: { length: '45', width: '30', height: '12' } })], { sklep: 'cm' }, KANALY).zmiany)
      .toEqual([]);
    expect(ocenZapis(karta, [p({ wymiary: { length: '45', width: '30', height: '9' } })], { sklep: 'cm' }, KANALY).zmiany)
      .toHaveLength(1);
  });
});
