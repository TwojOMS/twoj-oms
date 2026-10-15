import { describe, expect, it } from 'vitest';

const ORLEN = '09164667-daa5-42dc-8087-33d7485790ac';
const ONE_ONE = '0b9bed2c-0bc1-4e1f-9694-29bb39ebb483';
const ONE_DPD = '0b257488-c85d-4507-b967-9b45ffbfa2e8';
const DHL_BOX = '0fe5b4af-9f09-443d-9d49-62331a20b5b2';
const DHL_POINT = '0560b75e-88c3-4b79-bcf7-62331a20b5b2';
const DPD_AUTOMAT = '09bcdcdb-c62a-41c4-ba42-f2c599280e3c';

describe('gabaryty Allegro', () => {
  it('ORLEN M zamienia świadomy wybór na 60 × 38 × 19 cm i rzeczywistą wagę', async () => {
    const { parsujGabarytAllegro } = await import('../../src/domena/gabaryty-allegro.js');
    expect(parsujGabarytAllegro({ gabaryt: 'M', waga: '0,5' }, ORLEN)).toEqual({
      paczka: {
        waga: 0.5, dlugosc: 60, szerokosc: 38, wysokosc: 19,
        gabaryt: 'M', oczekiwanyDeliveryMethodId: ORLEN,
      },
    });
  });

  it.each([
    [ONE_ONE, 'S', 64, 8], [ONE_ONE, 'M', 64, 19], [ONE_ONE, 'L', 64, 41],
    [ONE_DPD, 'S', 64, 8], [ONE_DPD, 'M', 64, 19], [ONE_DPD, 'L', 64, 41],
    [ORLEN, 'S', 60, 8], [ORLEN, 'M', 60, 19], [ORLEN, 'L', 60, 41],
    [DHL_BOX, 'S', 64, 8], [DHL_BOX, 'M', 64, 19], [DHL_BOX, 'L', 64, 41],
    [DHL_POINT, 'S', 64, 8], [DHL_POINT, 'M', 64, 19], [DHL_POINT, 'L', 64, 41],
    [DPD_AUTOMAT, 'S', 59, 8], [DPD_AUTOMAT, 'M', 59, 19], [DPD_AUTOMAT, 'L', 59, 41],
  ])('%s: gabaryt %s daje właściwą długość %i i wysokość %i', async (id, gabaryt, dlugosc, wysokosc) => {
    const { parsujGabarytAllegro } = await import('../../src/domena/gabaryty-allegro.js');
    expect(parsujGabarytAllegro({ gabaryt, waga: '0,5' }, id)).toEqual({
      paczka: {
        waga: 0.5, dlugosc, szerokosc: 38, wysokosc,
        gabaryt, oczekiwanyDeliveryMethodId: id,
      },
    });
  });

  it.each(['', '0', '-1', '20,01', 'abc', 'Infinity'])(
    'odmawia wagi „%s” zamiast kupić etykietę z wagą błędną lub domyślną',
    async (waga) => {
      const { parsujGabarytAllegro } = await import('../../src/domena/gabaryty-allegro.js');
      const wynik = parsujGabarytAllegro({ gabaryt: 'S', waga }, ONE_ONE);
      expect(wynik).not.toHaveProperty('paczka');
      expect(wynik.blad).toMatch(/waga/i);
    },
  );

  it('udostępnia gabaryty tylko dla pięciu znanych identyfikatorów, nie po nazwie usługi', async () => {
    const { profilGabarytuAllegro } = await import('../../src/domena/gabaryty-allegro.js');
    expect(profilGabarytuAllegro(ONE_ONE)).toEqual({
      dlugosc: 64, szerokosc: 38, gabaryty: { S: 8, M: 19, L: 41 },
      domyslnaWaga: 1, domyslnyGabaryt: 'S',
    });
    expect(profilGabarytuAllegro(ORLEN)).toEqual({
      dlugosc: 60, szerokosc: 38, gabaryty: { S: 8, M: 19, L: 41 },
      domyslnaWaga: null, domyslnyGabaryt: null,
    });
    expect(profilGabarytuAllegro('Allegro One Box')).toBeNull();
    expect(profilGabarytuAllegro('nieznane-id')).toBeNull();
  });

  // Limit zmierzony 01.10.2026 w `delivery-proposals` zamówienia #1376 (Automaty DPD, APM).
  it('Automat DPD mieści L w żywym limicie 59 × 38 × 41 cm, a domyślnej paczki 110 × 75 nie', async () => {
    const { parsujGabarytAllegro, sprawdzLimityGabarytuAllegro } = await import('../../src/domena/gabaryty-allegro.js');
    const opcje = [{ deliveryType: 'APM', packageType: 'PACKAGE', limits: {
      dimensions: {
        length: { value: 59, unit: 'CENTIMETER' },
        width: { value: 38, unit: 'CENTIMETER' },
        height: { value: 41, unit: 'CENTIMETER' },
      },
      weight: { value: 20, unit: 'KILOGRAMS' },
    } }];
    const { paczka } = parsujGabarytAllegro({ gabaryt: 'L', waga: '0,5' }, DPD_AUTOMAT);
    expect(sprawdzLimityGabarytuAllegro(paczka, opcje)).toEqual({ paczka });
    const domyslna = { waga: 1, dlugosc: 110, szerokosc: 75, wysokosc: 1 };
    expect(sprawdzLimityGabarytuAllegro(domyslna, opcje).blad).toMatch(/limit/i);
  });

  it('odmawia M, gdy żywy limit wysokości to 8 cm, lecz dopuszcza S', async () => {
    const { sprawdzLimityGabarytuAllegro } = await import('../../src/domena/gabaryty-allegro.js');
    const opcje = [{ packageType: 'PACKAGE', limits: {
      dimensions: {
        length: { value: 64, unit: 'CENTIMETER' },
        width: { value: 38, unit: 'CENTIMETER' },
        height: { value: 8, unit: 'CENTIMETER' },
      },
      weight: { value: 20, unit: 'KILOGRAMS' },
    } }];
    const s = { waga: 0.5, dlugosc: 64, szerokosc: 38, wysokosc: 8 };
    const m = { waga: 0.5, dlugosc: 64, szerokosc: 38, wysokosc: 19 };
    expect(sprawdzLimityGabarytuAllegro(s, opcje)).toEqual({ paczka: s });
    expect(sprawdzLimityGabarytuAllegro(m, opcje).blad).toMatch(/limit/i);
  });

  it('odmawia, gdy Allegro nie podało opcji PACKAGE ani kompletnych limitów', async () => {
    const { sprawdzLimityGabarytuAllegro } = await import('../../src/domena/gabaryty-allegro.js');
    const paczka = { waga: 0.5, dlugosc: 64, szerokosc: 38, wysokosc: 8 };
    expect(sprawdzLimityGabarytuAllegro(paczka, []).blad).toMatch(/limit/i);
    expect(sprawdzLimityGabarytuAllegro(paczka, [{ packageType: 'DOX' }]).blad).toMatch(/limit/i);
    expect(sprawdzLimityGabarytuAllegro(paczka, [{ packageType: 'PACKAGE', limits: {} }]).blad).toMatch(/limit/i);
  });

  it('odmawia, gdy limit ma błędną jednostkę, null lub rzeczywistą wagę ponad limitem', async () => {
    const { sprawdzLimityGabarytuAllegro } = await import('../../src/domena/gabaryty-allegro.js');
    const paczka = { waga: 10.1, dlugosc: 64, szerokosc: 38, wysokosc: 8 };
    const opcja = { packageType: 'PACKAGE', limits: {
      dimensions: {
        length: { value: 64, unit: 'CENTIMETER' },
        width: { value: 38, unit: 'CENTIMETER' },
        height: { value: 41, unit: 'CENTIMETER' },
      },
      weight: { value: 10, unit: 'KILOGRAMS' },
    } };
    expect(sprawdzLimityGabarytuAllegro(paczka, [opcja]).blad).toMatch(/waga/);
    expect(sprawdzLimityGabarytuAllegro(paczka, [{ ...opcja, limits: {
      ...opcja.limits, weight: { value: 20, unit: 'GRAM' },
    } }]).blad).toMatch(/limit/);
    expect(sprawdzLimityGabarytuAllegro(paczka, [{ ...opcja, limits: {
      ...opcja.limits, weight: { value: null, unit: 'KILOGRAMS' },
    } }]).blad).toMatch(/limit/);
  });

  it('stosuje niższy limit z dwóch opcji PACKAGE, nigdy wygodniejszy pierwszy', async () => {
    const { sprawdzLimityGabarytuAllegro } = await import('../../src/domena/gabaryty-allegro.js');
    const paczka = { waga: 0.5, dlugosc: 64, szerokosc: 38, wysokosc: 19 };
    const opcja = { packageType: 'PACKAGE', limits: {
      dimensions: {
        length: { value: 64, unit: 'CENTIMETER' },
        width: { value: 38, unit: 'CENTIMETER' },
        height: { value: 41, unit: 'CENTIMETER' },
      },
      weight: { value: 20, unit: 'KILOGRAMS' },
    } };
    const nizsza = { ...opcja, limits: { ...opcja.limits, dimensions: {
      ...opcja.limits.dimensions, height: { value: 8, unit: 'CENTIMETER' },
    } } };
    expect(sprawdzLimityGabarytuAllegro(paczka, [opcja, nizsza]).blad).toMatch(/wysokosc/);
  });

  it.each([undefined, '', 's', 'XL', '__proto__'])(
    'nie zamienia gabarytu „%s” na S ani nie przyjmuje go poza zamkniętą listą',
    async (gabaryt) => {
      const { parsujGabarytAllegro } = await import('../../src/domena/gabaryty-allegro.js');
      const wynik = parsujGabarytAllegro({ gabaryt, waga: '0,5' }, ONE_ONE);
      expect(wynik).not.toHaveProperty('paczka');
      expect(wynik.blad).toMatch(/gabaryt/i);
    },
  );
});
