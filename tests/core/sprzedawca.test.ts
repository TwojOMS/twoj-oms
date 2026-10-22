import { describe, it, expect } from 'vitest';
import { wczytajSprzedawce, sprawdzNumerNip, sprawdzNumerBdo, ZDANIE_NIP_SUMA, ZDANIE_NIP_FORMAT, ZDANIE_BDO } from '../../src/core/sprzedawca.ts';
import { poprawnyNip, poprawnyRachunek } from '../../src/core/walidatory.ts';

const OK = { OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000' };

describe('walidatory', () => {
  it('NIP odrzuca złą sumę, długość, znaki oraz resztę 10', () => {
    expect(poprawnyNip(OK.OMS_SPRZEDAWCA_NIP)).toBe(true);
    for (const nip of ['1234563219', '123456321', '12345632180', '123456321x', '1234567890']) {
      expect(poprawnyNip(nip)).toBe(false);
    }
  });
  it('NRB wymaga 26 cyfr oraz poprawnej sumy mod 97', () => {
    expect(poprawnyRachunek(OK.OMS_RACHUNEK)).toBe(true);
    for (const nrb of ['34109010140000000000000001', '3410901014000000000000000', '341090101400000000000000000', '3410901014000000000000000x']) {
      expect(poprawnyRachunek(nrb)).toBe(false);
    }
  });
});

describe('wczytajSprzedawce', () => {
  it('normalizuje prefiks PL, spacje i myślniki, nie dokłada BDO ani banku', () => {
    expect(wczytajSprzedawce({ OMS_SPRZEDAWCA_NIP: ' pl 123-456-32-18 ', OMS_RACHUNEK: 'PL34 1090 1014 0000 0000 0000 0000' }))
      .toEqual({ nip: '1234563218', rachunek: '34109010140000000000000000', bdo: null, bank: null });
  });
  // PRZ-102.20: brak rachunku nie blokuje startu — rachunek można wpisać w panelu (Ustawienia → Firma).
  // PRZ-108.10 (zmiana zachowania, decyzja właściciela 21.10 „NIP i BDO w panelu”): brak NIP-u też nie blokuje startu —
  // NIP wpisuje się w Ustawienia → Firma, a dokumenty bez NIP-u odmawiają przy użyciu
  // (tests/moduly/ustawienia/nip-bdo-firmy-prz108-10.test.js). Wcześniej ten test żądał odmowy startu.
  it('brak NIP-u i rachunku nie blokuje startu (nip: null, rachunek: null)', () => {
    expect(wczytajSprzedawce({})).toEqual({ nip: null, rachunek: null, bdo: null, bank: null });
    expect(wczytajSprzedawce({ OMS_SPRZEDAWCA_NIP: ' \t ' }).nip).toBeNull();
    expect(wczytajSprzedawce({ OMS_SPRZEDAWCA_NIP: '1234563218' }).rachunek).toBeNull();
    expect(wczytajSprzedawce({ OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '\t' }).rachunek).toBeNull();
  });
  it('PRZ-108.10: NIP i BDO z panelu — ta sama walidacja i to samo zdanie co przy starcie, bez wpisanej wartości', () => {
    expect(sprawdzNumerNip(' pl 123-456-32-18 ')).toEqual({ nip: '1234563218', blad: null });
    expect(sprawdzNumerNip('  ')).toEqual({ nip: null, blad: null });
    expect(sprawdzNumerNip('1234563219')).toEqual({ nip: null, blad: ZDANIE_NIP_SUMA });
    expect(sprawdzNumerNip('12345632x8')).toEqual({ nip: null, blad: ZDANIE_NIP_FORMAT });
    expect(sprawdzNumerBdo(' 000123456 ')).toEqual({ bdo: '000123456', blad: null });
    expect(sprawdzNumerBdo('')).toEqual({ bdo: null, blad: null });
    for (const zly of ['12345', '000 123 456', '00012345x']) expect(sprawdzNumerBdo(zly)).toEqual({ bdo: null, blad: ZDANIE_BDO });
    expect(() => wczytajSprzedawce({ OMS_SPRZEDAWCA_NIP: '1234563219' })).toThrow(`OMS_SPRZEDAWCA_NIP: ${ZDANIE_NIP_SUMA}`);
    expect(() => wczytajSprzedawce({ OMS_SPRZEDAWCA_BDO: '12345' })).toThrow(`OMS_SPRZEDAWCA_BDO: ${ZDANIE_BDO}`);
  });
  it('literówka rachunku blokuje start', () => {
    expect(() => wczytajSprzedawce({ ...OK, OMS_RACHUNEK: '34109010140000000000000001' })).toThrow('OMS_RACHUNEK: niepoprawny numer rachunku');
  });
  it('BDO ma 9 cyfr, bank pochodzi z konfiguracji', () => {
    expect(wczytajSprzedawce({ ...OK, OMS_SPRZEDAWCA_BDO: ' 000123456 ', OMS_BANK: ' Bank próbny ' }))
      .toEqual({ nip: '1234563218', rachunek: '34109010140000000000000000', bdo: '000123456', bank: 'Bank próbny' });
    expect(() => wczytajSprzedawce({ ...OK, OMS_SPRZEDAWCA_BDO: '12345' })).toThrow('OMS_SPRZEDAWCA_BDO');
    expect(wczytajSprzedawce({ ...OK, OMS_SPRZEDAWCA_BDO: ' ', OMS_BANK: ' ' }).bank).toBeNull();
  });
  describe('komunikat mówi, którą zmienną poprawić, w jakim formacie i w którym pliku (PRZ-093.04)', () => {
    const blad = (env: Record<string, string>) => {
      try { wczytajSprzedawce(env); } catch (e) { return (e as Error).message; }
      throw new Error('Oczekiwano odmowy startu');
    };
    // PRZ-108.10: brak NIP-u przestał być błędem startu — plik konfiguracji wskazuje teraz komunikat o ZŁYM NIP-ie.
    it('zły NIP: nazwa zmiennej, format i plik konfiguracji (brak rachunku nie jest błędem — PRZ-102.20)', () => {
      const m = blad({ OMS_SPRZEDAWCA_NIP: '123' });
      expect(m).toContain('OMS_SPRZEDAWCA_NIP: niepoprawny NIP');
      expect(m).toContain('10 cyfr');
      expect(m).not.toContain('OMS_RACHUNEK');
      expect(m).toContain('produkcja.env');
      expect(m).toContain('docs/instalacja-docker.md');
    });
    it('NIP z literą albo złą liczbą cyfr: opisuje, co kod akceptuje (PL, spacje, myślniki)', () => {
      for (const nip of ['12345632x8', '123456321', '12345632180']) {
        const m = blad({ ...OK, OMS_SPRZEDAWCA_NIP: nip });
        expect(m).toContain('OMS_SPRZEDAWCA_NIP: niepoprawny NIP');
        expect(m).toContain('dokładnie 10 cyfr');
        expect(m).toMatch(/PL.*spacje.*myślniki/);
        expect(m).not.toContain(nip);
      }
    });
    it('NIP z dobrą długością, lecz złą cyfrą kontrolną: mówi o literówce, nie o długości', () => {
      const m = blad({ ...OK, OMS_SPRZEDAWCA_NIP: '1234563219' });
      expect(m).toContain('cyfra kontrolna');
      expect(m).not.toContain('dokładnie 10 cyfr');
    });
    it('rachunek: 26 cyfr, PL/spacje/myślniki dozwolone; osobno zła długość i zła suma', () => {
      const dlugosc = blad({ ...OK, OMS_RACHUNEK: '3410901014' });
      expect(dlugosc).toContain('OMS_RACHUNEK: niepoprawny numer rachunku');
      expect(dlugosc).toContain('dokładnie 26 cyfr');
      expect(dlugosc).toMatch(/PL.*spacje.*myślniki/);
      const suma = blad({ ...OK, OMS_RACHUNEK: '34109010140000000000000001' });
      expect(suma).toContain('cyfry kontrolne');
      expect(suma).not.toContain('dokładnie 26 cyfr');
    });
    it('BDO: 9 cyfr bez spacji, albo zostaw puste', () => {
      const m = blad({ ...OK, OMS_SPRZEDAWCA_BDO: '000 123 456' });
      expect(m).toContain('OMS_SPRZEDAWCA_BDO: oczekiwano 9 cyfr');
      expect(m).toMatch(/bez spacji/);
      expect(m).toMatch(/puste|usuń/);
      expect(m).not.toContain('000 123 456');
    });
  });
  it('błąd wymienia nazwy zmiennych, lecz nie wartości wejściowych', () => {
    const odczyt = () => wczytajSprzedawce({ OMS_SPRZEDAWCA_NIP: '1234563219', OMS_RACHUNEK: 'rachunek-sekret', OMS_SPRZEDAWCA_BDO: 'bdo-sekret' });
    expect(odczyt).toThrow(/OMS_SPRZEDAWCA_NIP[\s\S]*OMS_RACHUNEK[\s\S]*OMS_SPRZEDAWCA_BDO/);
    expect(odczyt).not.toThrow(/1234563219|rachunek-sekret|bdo-sekret/);
  });
});
