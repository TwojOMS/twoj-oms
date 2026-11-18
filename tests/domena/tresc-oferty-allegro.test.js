// Czysta funkcja: odpowiedź `GET /sale/product-offers/{id}` + opis kategorii z pamięci
// → pola karty, sekcje opisu, zdjęcia i dane kanału. Fixture: zmyślona lampa „Pracowni Półcień” w pełnym kształcie
// odpowiedzi, bez danych prawdziwych ofert.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  opisKategorii,
  trescOfertyAllegro,
  PARAMETR_EAN,
  PROG_SLOWNIKA,
} from '../../src/domena/tresc-oferty-allegro.js';

const OFERTA = JSON.parse(readFileSync(new URL('../fixtures/allegro/oferta-lampa.json', import.meta.url), 'utf8'));
const oferta = (zmiany = {}) => ({ ...structuredClone(OFERTA), ...zmiany });

const slownik = (n, prefiks) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefiks}_${i + 1}`,
    value: `Wartość ${i + 1}`,
    dependsOnValueIds: [],
  }));
const param = (id, name, type, describesProduct, dodatki = {}) => ({
  id,
  name,
  type,
  required: false,
  unit: null,
  options: { describesProduct, variantsAllowed: false, customValuesEnabled: false },
  restrictions: {},
  ...dodatki,
});

// Ścieżka od korzenia do liścia, tak jak oddaje ją `GET /sale/categories/{id}` po kolei dla rodziców.
const SCIEZKA = [
  { id: '5', name: 'Dom i Ogród', parent: null, leaf: false },
  { id: '256', name: 'Oświetlenie', parent: { id: '5' }, leaf: false },
  { id: '257', name: 'Lampy', parent: { id: '256' }, leaf: true },
];
const PARAMETRY = {
  parameters: [
    param('11323', 'Stan', 'dictionary', false, { required: true, dictionary: slownik(3, '11323') }),
    param('248811', 'Marka', 'dictionary', true, { dictionary: slownik(300, '248811') }),
    param('224017', 'Kod producenta', 'string', true),
    param('225693', 'EAN (GTIN)', 'string', true, { restrictions: { minLength: 8, maxLength: 14 } }),
    param('17448', 'Waga produktu z opakowaniem jednostkowym', 'float', true, { unit: 'kg' }),
    // W odpowiedzi oferty „Wysokość” stoi na poziomie oferty, ale kategoria mówi, że opisuje produkt.
    param('2977', 'Wysokość', 'float', true, { unit: 'cm' }),
    param('211830', 'Liczba sztuk', 'integer', false, { unit: 'szt.' }),
    param('229205', 'Stan opakowania', 'dictionary', false, { dictionary: slownik(50, '229205') }),
  ],
};
const KATEGORIA = opisKategorii(SCIEZKA, PARAMETRY);
const ids = (lista) => lista.map((p) => p.id);

describe('opis kategorii do pamięci podręcznej', () => {
  it('ścieżka od korzenia, opisy parametrów z typem, jednostką i describesProduct', () => {
    expect(KATEGORIA.sciezka).toEqual([
      { id: '5', nazwa: 'Dom i Ogród' },
      { id: '256', nazwa: 'Oświetlenie' },
      { id: '257', nazwa: 'Lampy' },
    ]);
    expect(KATEGORIA.parametry.find((p) => p.id === '17448')).toEqual({
      id: '17448',
      nazwa: 'Waga produktu z opakowaniem jednostkowym',
      typ: 'float',
      jednostka: 'kg',
      opisujeProdukt: true,
      slownik: null,
      liczbaWartosci: 0,
      wymagany: false,
      wymaganyDlaProduktu: false,
      wymaganyGdy: null,
      widocznyGdy: null,
      ograniczenia: {},
      zalezyOd: null,
    });
  });
  it(`słownik ponad ${PROG_SLOWNIKA} wartości jest wycięty (zostaje znacznik), 50 wartości zostaje`, () => {
    const marka = KATEGORIA.parametry.find((p) => p.id === '248811');
    expect(marka.slownik).toBeNull();
    expect(marka.slownikWyciety).toBe(true);
    expect(marka.liczbaWartosci).toBe(300);
    const opakowanie = KATEGORIA.parametry.find((p) => p.id === '229205');
    expect(opakowanie.slownik).toHaveLength(50);
    expect(opakowanie.slownik[0]).toEqual({ id: '229205_1', wartosc: 'Wartość 1' });
    expect(opakowanie).not.toHaveProperty('slownikWyciety');
    expect(JSON.stringify(KATEGORIA).length).toBeLessThan(10_000);
  });
  it('granica: 200 zostaje, 201 wycięte', () => {
    const k = opisKategorii([], {
      parameters: [
        param('1', 'A', 'dictionary', true, { dictionary: slownik(200, 'a') }),
        param('2', 'B', 'dictionary', true, { dictionary: slownik(201, 'b') }),
      ],
    });
    expect(k.parametry[0].slownik).toHaveLength(200);
    expect(k.parametry[1].slownik).toBeNull();
  });
  it('pusta odpowiedź nie rzuca', () => {
    expect(opisKategorii(undefined, undefined)).toEqual({
      wersja: 2,
      lisc: null,
      tworzenieProduktu: null,
      sciezka: [],
      parametry: [],
    });
  });
});

// Opis kategorii v2: wymagalność parametrów i to, czy w kategorii można tworzyć produkt.
// Fixture: kształt odpowiedzi z pomiaru P9, nazwy zmyślone, słownik marek skrócony do 262 wartości.
const P9 = JSON.parse(
  readFileSync(new URL('../fixtures/allegro/e3-pomiar-p9-kategoria.json', import.meta.url), 'utf8'),
);

describe('opis kategorii v2 (E3.05, fixture P9)', () => {
  const opis = opisKategorii(P9.sciezka, P9.parametry);
  const parametr = (idp) => opis.parametry.find((p) => p.id === idp);

  it('wersja 2, liść i tworzenie produktu z opcji liścia', () => {
    expect(opis).toMatchObject({ wersja: 2, lisc: true, tworzenieProduktu: true });
    expect(opis.sciezka.map((k) => k.id)).toEqual(['5', '256', '257']);
  });
  it('kategoria nie-liść bez tworzenia produktu', () => {
    expect(opisKategorii(P9.sciezka.slice(0, 2), P9.parametry)).toMatchObject({
      lisc: false,
      tworzenieProduktu: false,
    });
  });
  it('„Marka” wymagana i wymagana dla produktu, słownik wycięty', () => {
    expect(parametr('248811')).toMatchObject({
      nazwa: 'Marka',
      wymagany: true,
      wymaganyDlaProduktu: true,
      slownik: null,
      slownikWyciety: true,
      liczbaWartosci: 262,
    });
    expect(JSON.stringify(opis)).not.toContain('bez marki');
  });
  it('EAN niewymagany, „Kod producenta” wymagany tylko w ofercie, z ograniczeniami 1–45', () => {
    expect(parametr('225693')).toMatchObject({ wymagany: false, wymaganyDlaProduktu: false });
    expect(parametr('224017')).toMatchObject({
      wymagany: true,
      wymaganyDlaProduktu: false,
      ograniczenia: { minLength: 1, maxLength: 45, allowedNumberOfValues: 1 },
    });
    expect(parametr('201')).toMatchObject({ jednostka: 'cm', ograniczenia: { precision: 2 } });
  });
  it('requiredIf, displayedIf i dependsOnParameterId przechodzą do opisu; słownik zależny niesie wartości nadrzędne', () => {
    const gwint = parametr('4388');
    expect(gwint.wymaganyGdy).toEqual({
      parametersWithValue: [{ id: '4387', oneOfValueIds: ['4387_1'] }],
      parametersWithoutValue: [],
    });
    expect(gwint.widocznyGdy).toEqual(gwint.wymaganyGdy);
    expect(gwint.zalezyOd).toBe('4387');
    expect(gwint.slownik[0]).toEqual({ id: '4388_1', wartosc: 'E14', zalezyOdWartosci: ['4387_1'] });
    expect(parametr('11323').slownik[0]).toEqual({ id: '11323_1', wartosc: 'Nowy' });
  });
  it('nie zmienia wejścia i nie dzieli referencji z odpowiedzią', () => {
    const kopia = structuredClone(P9);
    const o = opisKategorii(kopia.sciezka, kopia.parametry);
    o.parametry.find((p) => p.id === '4388').wymaganyGdy.parametersWithValue.length = 0;
    expect(kopia).toEqual(P9);
  });
});

describe('treść oferty Allegro → karta', () => {
  it('fixture lampy w pełnym kształcie daje komplet pól', () => {
    const w = trescOfertyAllegro(OFERTA, KATEGORIA);
    expect(w.pola).toEqual({
      nazwa: 'Lampa stołowa Grzyb, ceramika szkliwiona, 35 cm',
      ean: '5901234123457',
      cena_gr: 24990,
      stawka_vat: '23',
    });
    expect(w.zdjecia).toEqual([
      'https://zdjecia.przyklad.invalid/original/lampa-grzyb-1.jpg',
      'https://zdjecia.przyklad.invalid/original/lampa-grzyb-2.jpg',
      'https://zdjecia.przyklad.invalid/original/lampa-grzyb-3.jpg',
    ]);
    expect(w.daneKanalu).toMatchObject({
      kategoria_id: '257',
      sciezka: KATEGORIA.sciezka,
      ai_wspoltworzone: 0,
      updatedAt: '2026-10-28T14:12:33.000Z',
      oferta_id: '17000000000042',
      produkt_id: 'a1b2c3d4-0000-4000-8000-000000000042',
    });
    expect(w.daneKanalu.parametry.produkt.find((p) => p.id === '17448')).toEqual({
      id: '17448',
      nazwa: 'Waga produktu z opakowaniem jednostkowym',
      wartosci: ['1.8'],
      wartosciId: null,
      zakres: null,
      typ: 'float',
      jednostka: 'kg',
    });
    expect(w.opisSekcje.sekcje).toHaveLength(2);
  });
  it('sekcja dwuelementowa zostaje, adres zdjęcia z „&amp;” bez zmian', () => {
    const [pierwsza, druga] = trescOfertyAllegro(OFERTA, KATEGORIA).opisSekcje.sekcje;
    expect(pierwsza.elementy).toEqual([
      { typ: 'zdjecie', adres: 'https://zdjecia.przyklad.invalid/original/lampa-grzyb-1.jpg?w=800&amp;h=600' },
      { typ: 'tekst', html: '<p>Ręcznie szkliwiona ceramika, abażur z lnu.</p>' },
    ]);
    expect(druga.elementy).toHaveLength(1);
  });
  it(`EAN tylko z parametru produktu ${PARAMETR_EAN}, nie z innego parametru, który wygląda jak EAN`, () => {
    expect(PARAMETR_EAN).toBe('225693');
    expect(trescOfertyAllegro(OFERTA, KATEGORIA).pola.ean).toBe('5901234123457');
    const bezEan = oferta();
    bezEan.productSet[0].product.parameters = bezEan.productSet[0].product.parameters.filter((p) => p.id !== '225693');
    expect(trescOfertyAllegro(bezEan, KATEGORIA).pola.ean).toBeNull();
  });
  it('parametry podzielone na produkt i ofertę według describesProduct z kategorii', () => {
    const { parametry } = trescOfertyAllegro(OFERTA, KATEGORIA).daneKanalu;
    expect(ids(parametry.produkt)).toEqual(['224017', '248811', '225693', '17448', '2977']);
    expect(ids(parametry.oferta)).toEqual(['11323', '211830', '229205']);
  });
  it('bez opisu kategorii podział według miejsca w odpowiedzi, bez typu i jednostki', () => {
    const { parametry, sciezka } = trescOfertyAllegro(OFERTA, null).daneKanalu;
    expect(ids(parametry.produkt)).toEqual(['224017', '248811', '225693', '17448']);
    expect(ids(parametry.oferta)).toEqual(['11323', '2977', '211830', '229205']);
    expect(parametry.produkt[0]).toMatchObject({ typ: null, jednostka: null });
    expect(sciezka).toEqual([]);
  });
  it('kategoria z pamięci może przenieść parametr produktu do oferty', () => {
    const k = opisKategorii(SCIEZKA, { parameters: [param('17448', 'Waga', 'float', false, { unit: 'kg' })] });
    const { parametry } = trescOfertyAllegro(OFERTA, k).daneKanalu;
    expect(ids(parametry.oferta)).toContain('17448');
    expect(ids(parametry.produkt)).not.toContain('17448');
  });
  it('oferta pusta nie rzuca i daje puste pola', () => {
    for (const pusta of [{}, null, undefined]) {
      const w = trescOfertyAllegro(pusta, null);
      expect(w.pola).toEqual({ nazwa: null, ean: null, cena_gr: null, stawka_vat: null });
      expect(w.opisSekcje).toEqual({ sekcje: [] });
      expect(w.zdjecia).toEqual([]);
      expect(w.daneKanalu).toEqual({
        kategoria_id: null,
        sciezka: [],
        parametry: { produkt: [], oferta: [] },
        ai_wspoltworzone: 0,
        updatedAt: null,
        oferta_id: null,
        produkt_id: null,
      });
    }
  });
  it('VAT ze stawki PL w taxSettings; bez taxSettings albo stawki spoza listy — pole puste', () => {
    const z = (taxSettings) => trescOfertyAllegro(oferta({ taxSettings }), KATEGORIA).pola.stawka_vat;
    expect(z({ rates: [{ rate: '8.00', countryCode: 'PL' }] })).toBe('8');
    expect(z({ rates: [{ rate: '0.00', countryCode: 'PL' }] })).toBe('0');
    expect(z(undefined)).toBeNull();
    expect(z(null)).toBeNull();
    expect(z({ rates: [{ rate: '21.00', countryCode: 'CZ' }] })).toBeNull();
    expect(z({ rates: [{ rate: '7.00', countryCode: 'PL' }] })).toBeNull();
    expect(
      z({
        rates: [
          { rate: '5.00', countryCode: 'HU' },
          { rate: '23.00', countryCode: 'PL' },
        ],
      }),
    ).toBe('23');
    expect(z({ rates: [{ rate: '0.00', countryCode: 'PL' }], exemption: 'ART_43' })).toBeNull();
  });
  it('cena w groszach bez float; brak ceny = puste pole; obca waluta jest błędem jak w lustrze', () => {
    const z = (price) =>
      trescOfertyAllegro(oferta({ sellingMode: { format: 'BUY_NOW', price } }), KATEGORIA).pola.cena_gr;
    expect(z({ amount: '0.29', currency: 'PLN' })).toBe(29);
    expect(z({ amount: '1234.10', currency: 'PLN' })).toBe(123410);
    expect(z(undefined)).toBeNull();
    expect(() => z({ amount: '10.00', currency: 'EUR' })).toThrow(/walucie/);
  });
  it('znacznik AI z deklaracji zdjęć sprzedawcy, nie Katalogu (D27)', () => {
    const z = (images) => {
      const o = oferta({ aiCoCreatedContent: { images } });
      return trescOfertyAllegro(o, KATEGORIA).daneKanalu.ai_wspoltworzone;
    };
    expect(z([OFERTA.images[0]])).toBe(1);
    expect(z([])).toBe(0);
    expect(z(undefined)).toBe(0);
  });
  it('producenta, osoby odpowiedzialnej i informacji o bezpieczeństwie nie przenosi (D28)', () => {
    const tekst = JSON.stringify(trescOfertyAllegro(OFERTA, KATEGORIA));
    expect(tekst).not.toMatch(/Osoba Przykładowa|producent-przyklad|bezpieczeństwie/);
  });
  it('nie zmienia wejścia', () => {
    const wejscie = oferta();
    const kopia = structuredClone(wejscie);
    trescOfertyAllegro(wejscie, KATEGORIA);
    expect(wejscie).toEqual(kopia);
  });
});
