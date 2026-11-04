import { afterEach, describe, expect, it, vi } from 'vitest';
import { METODA_DOMYSLNA, MODULY_KURIEROW, metodaDomyslna } from '../../src/domena/moduly-kurierow.ts';
import { parsujNoweZamowienie } from '../../src/domena/nowe-zamowienie.js';

afterEach(() => {
  vi.doUnmock('../../src/domena/moduly-kurierow.ts');
  vi.resetModules();
});

describe('domyślna metoda z rejestru kurierów — PRZ-135.06', () => {
  it('wybiera pierwszą metodę pierwszego kuriera na własnej umowie', () => {
    const rejestr = {
      polcien_ekspres: {
        ...MODULY_KURIEROW.dpd,
        klucz: 'polcien_ekspres', nazwa: 'Półcień Ekspres', umowa: 'wlasna' as const,
        metody: [{ ...MODULY_KURIEROW.dpd.metody[0], klucz: 'polcien_ekspres' }],
      },
      ...MODULY_KURIEROW,
    };
    expect(metodaDomyslna(rejestr)).toBe('polcien_ekspres');
  });

  it('zachowuje dzisiejszą domyślną metodę i stosuje ją przy braku dostawy', () => {
    expect(METODA_DOMYSLNA).toBe('dpd');
    expect(parsujNoweZamowienie({}).metoda_wysylki).toBe(METODA_DOMYSLNA);
  });

  it('parser odczytuje domyślną metodę z rejestru', async () => {
    vi.resetModules();
    vi.doMock('../../src/domena/moduly-kurierow.ts', async (importOriginal) => ({
      ...await importOriginal<typeof import('../../src/domena/moduly-kurierow.ts')>(),
      METODA_DOMYSLNA: 'odbior_osobisty',
    }));
    const { parsujNoweZamowienie: parsuj } = await import('../../src/domena/nowe-zamowienie.js');
    expect(parsuj({}).metoda_wysylki).toBe('odbior_osobisty');
  });

  it('zapisuje kod punktu dla paczkomatu i usuwa go dla kuriera bez punktu', () => {
    expect(parsujNoweZamowienie({ dostawa: 'inpost_paczkomat', punkt_odbioru: ' fik01m ' }).punkt_odbioru)
      .toBe('FIK01M');
    expect(parsujNoweZamowienie({ dostawa: 'dpd', punkt_odbioru: 'fik01m' }).punkt_odbioru)
      .toBeNull();
  });
});
