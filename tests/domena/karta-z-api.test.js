import { describe, expect, it } from 'vitest';
import { parsujKarteZApi, wymiaryKompletne } from '../../src/domena/karta-z-api.js';
import { STAWKI_VAT } from '../../src/domena/vat.js';

const patch = (cialo) => parsujKarteZApi(cialo, { czesciowa: true });
function blad(cialo, pole, kod = 'walidacja') {
  const wynik = patch(cialo);
  expect(wynik).toEqual({ ok: false, kod, pole, powod: expect.any(String) });
  expect(wynik.powod).toMatch(/^[A-ZĄĆĘŁŃÓŚŹŻ].*\.$/u);
}

describe('parsujKarteZApi', () => {
  it('mapuje pełną kartę bez zmiany polskich znaków, emoji i wielkości liter SKU', () => {
    expect(parsujKarteZApi({
      nazwa: '  Żółta łódź 🛶  ', opis: 'Zażółć 🛶\n opis ', sku: ' abc ',
      ean: '1234567890128', cena_gr: 123, stawka_vat: '23', kategoria: 'Łodzie',
      wymiary: { szerokosc_mm: 0, wysokosc_mm: 2, glebokosc_mm: 3 }, waga_g: 0, wycofana: true,
    }, { czesciowa: false })).toEqual({ ok: true, karta: {
      nazwa: 'Żółta łódź 🛶', opis: 'Zażółć 🛶\n opis ', sku: 'abc', ean: '1234567890128',
      cena_gr: 123, stawka_vat: '23', kategoria_glowna: 'Łodzie',
      szerokosc_mm: 0, wysokosc_mm: 2, glebokosc_mm: 3, waga_g: 0, wycofana: 1,
    } });
    expect(patch({ sku: ' AbC ' })).toEqual({ ok: true, karta: { sku: 'AbC' } });
    expect(patch({ wycofana: false })).toEqual({ ok: true, karta: { wycofana: 0 } });
  });

  it('wymaga nazwy tylko przy tworzeniu, PATCH zwraca wyłącznie obecne pola', () => {
    expect(parsujKarteZApi({}, { czesciowa: false })).toMatchObject({ ok: false, kod: 'walidacja', pole: 'nazwa' });
    expect(parsujKarteZApi({ nazwa: 'A' }, { czesciowa: false })).toEqual({ ok: true, karta: { nazwa: 'A' } });
    expect(patch({ opis: 'Opis' })).toEqual({ ok: true, karta: { opis: 'Opis' } });
    expect(patch({})).toEqual({ ok: true, karta: {} });
    for (const nazwa of ['', ' \n ', null, 12, undefined, 'a'.repeat(301), '🛶'.repeat(301)]) blad({ nazwa }, 'nazwa');
    expect(patch({ nazwa: ' 🛶'.trim().repeat(300) })).toEqual({ ok: true, karta: { nazwa: '🛶'.repeat(300) } });
  });

  it('sprawdza typy i granice tekstów, licząc znaki zamiast jednostek UTF-16', () => {
    for (const [pole, limit] of [['sku', 64], ['opis', 20000], ['kategoria', 200]]) {
      const docelowe = pole === 'kategoria' ? 'kategoria_glowna' : pole;
      for (const tekst of ['a'.repeat(limit), '🛶'.repeat(limit)]) {
        expect(patch({ [pole]: tekst })).toEqual({ ok: true, karta: { [docelowe]: tekst } });
        blad({ [pole]: tekst + 'a' }, pole);
      }
      for (const wartosc of [123, true, {}, [], undefined]) blad({ [pole]: wartosc }, pole);
    }
    for (const sku of ['', ' \n ']) blad({ sku }, 'sku');
    expect(patch({ sku: 'x', opis: '', kategoria: '' })).toEqual({ ok: true, karta: { sku: 'x', opis: '', kategoria_glowna: null } });
  });

  it('obcina białe znaki kategorii, a pustą po obcięciu zapisuje jako null (jak NULLIF(TRIM) panelu)', () => {
    expect(patch({ kategoria: '  Łodzie 🛶 \n' })).toEqual({ ok: true, karta: { kategoria_glowna: 'Łodzie 🛶' } });
    for (const kategoria of ['', '   ', ' \r\n\t ']) {
      expect(patch({ kategoria })).toEqual({ ok: true, karta: { kategoria_glowna: null } });
    }
    expect(patch({ kategoria: ` ${'a'.repeat(200)} ` })).toEqual({ ok: true, karta: { kategoria_glowna: 'a'.repeat(200) } });
  });

  it.each(['12345670', '1234567890128'])('sprawdza cyfrę kontrolną GTIN %s', (ean) => {
    expect(patch({ ean })).toEqual({ ok: true, karta: { ean } });
    blad({ ean: ean.slice(0, -1) + ((Number(ean.at(-1)) + 1) % 10) }, 'ean');
  });

  it('odrzuca EAN innego typu, długości i znaki inne niż cyfry', () => {
    for (const ean of [12345670, '', '1234567', '123456789', '12345678901234', '1234567x', ' 12345670', '１２３４５６７０']) blad({ ean }, 'ean');
  });

  it('przyjmuje wyłącznie całkowite nieujemne kwoty, wagę i każdy wymiar', () => {
    for (const pole of ['cena_gr', 'waga_g', 'szerokosc_mm', 'wysokosc_mm', 'glebokosc_mm']) {
      const wejscie = (wartosc) => pole.endsWith('_mm') ? { wymiary: { [pole]: wartosc } } : { [pole]: wartosc };
      const sciezka = pole.endsWith('_mm') ? `wymiary.${pole}` : pole;
      for (const wartosc of [0, 1, 999]) expect(patch(wejscie(wartosc))).toEqual({ ok: true, karta: { [pole]: wartosc } });
      for (const wartosc of [-1, 0.5, '1', true, NaN, Infinity, undefined, 2 ** 53]) blad(wejscie(wartosc), sciezka);
    }
  });

  it('korzysta z dozwolonych stawek VAT i wymaga boolean dla wycofania', () => {
    for (const stawka_vat of STAWKI_VAT) expect(patch({ stawka_vat })).toEqual({ ok: true, karta: { stawka_vat } });
    for (const stawka_vat of ['zw', 'np', '22', '', 23, ' 23 ', undefined]) blad({ stawka_vat }, 'stawka_vat');
    for (const wycofana of [0, 1, 'true', {}, undefined, null]) blad({ wycofana }, 'wycofana');
  });

  it('parser mapuje null pól i pojedynczego wymiaru; komplet sprawdzają trasy po scaleniu', () => {
    const pola = ['opis', 'sku', 'ean', 'cena_gr', 'stawka_vat', 'kategoria', 'waga_g'];
    expect(patch(Object.fromEntries(pola.map((p) => [p, null])))).toEqual({ ok: true, karta: {
      opis: null, sku: null, ean: null, cena_gr: null, stawka_vat: null, kategoria_glowna: null, waga_g: null,
    } });
    expect(patch({ wymiary: null })).toEqual({ ok: true, karta: { szerokosc_mm: null, wysokosc_mm: null, glebokosc_mm: null } });
    for (const pole of ['szerokosc_mm', 'wysokosc_mm', 'glebokosc_mm']) {
      expect(patch({ wymiary: { [pole]: null } })).toEqual({ ok: true, karta: { [pole]: null } });
    }
    expect(patch({ wymiary: {} })).toEqual({ ok: true, karta: {} });
  });

  it('odrzuca nieznane pola także wewnątrz wymiarów', () => {
    for (const pole of ['id', 'kategoria_glowna', 'szerokosc_mm', '__proto__']) {
      blad(JSON.parse(`{"${pole}": 1}`), pole, 'pole');
    }
    blad({ wymiary: { dlugosc_mm: 1 } }, 'wymiary.dlugosc_mm', 'pole');
  });

  it('odrzuca ciało i wymiary inne niż obiekt', () => {
    for (const wartosc of [null, [], 'tekst', 12, true, undefined]) {
      const wynik = patch(wartosc);
      expect(wynik).toMatchObject({ ok: false, kod: 'walidacja', pole: 'cialo', powod: expect.any(String) });
    }
    for (const wymiary of [[], 'tekst', 12, true, undefined]) blad({ wymiary }, 'wymiary');
  });

  it('nie zmienia wejściowego obiektu', () => {
    const cialo = Object.freeze({ nazwa: ' Nazwa ', wymiary: Object.freeze({ szerokosc_mm: 1 }) });
    expect(patch(cialo)).toEqual({ ok: true, karta: { nazwa: 'Nazwa', szerokosc_mm: 1 } });
    expect(cialo.nazwa).toBe(' Nazwa ');
  });
});

describe('wymiaryKompletne — stan karty po scaleniu', () => {
  it('akceptuje trzy liczby (także zero), parę szerokość i wysokość (produkt płaski) albo trzy braki', () => {
    expect(wymiaryKompletne({ szerokosc_mm: 700, wysokosc_mm: 1000, glebokosc_mm: null })).toBe(true);
    expect(wymiaryKompletne({ szerokosc_mm: 0, wysokosc_mm: 0 })).toBe(true);
    expect(wymiaryKompletne({})).toBe(true);
    expect(wymiaryKompletne({ szerokosc_mm: null, wysokosc_mm: null, glebokosc_mm: null })).toBe(true);
    expect(wymiaryKompletne({ szerokosc_mm: 0, wysokosc_mm: 2, glebokosc_mm: 3 })).toBe(true);
  });

  it('odrzuca szerokość bez wysokości, wysokość bez szerokości i samą głębokość', () => {
    const pola = ['szerokosc_mm', 'wysokosc_mm', 'glebokosc_mm'];
    for (const maska of [1, 2, 4, 5, 6]) {
      for (const brak of [null, undefined]) {
        const karta = Object.freeze(Object.fromEntries(pola.map((p, i) => [p, maska & (1 << i) ? 0 : brak])));
        expect(wymiaryKompletne(karta)).toBe(false);
      }
    }
  });
});
