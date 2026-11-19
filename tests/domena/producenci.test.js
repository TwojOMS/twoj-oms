import { describe, expect, it } from 'vitest';
import { walidujProducenta, producentKarty, opisProducenta } from '../../src/domena/producenci.js';

const PELNY = {
  nazwa: '  Pracownia Półcień  ',
  adres: ' ul. Przykładowa 1, 00-001 Miasto ',
  email: ' kontakt@polcien.invalid ',
  www: '',
};

describe('walidujProducenta', () => {
  it('pełne dane: wartości po trim, puste pole elektroniczne to null', () => {
    expect(walidujProducenta(PELNY)).toEqual({
      ok: true,
      bledy: {},
      wartosci: {
        nazwa: 'Pracownia Półcień',
        adres: 'ul. Przykładowa 1, 00-001 Miasto',
        email: 'kontakt@polcien.invalid',
        www: null,
      },
    });
  });

  it('bez nazwy odmowa z tekstem pola', () => {
    const w = walidujProducenta({ ...PELNY, nazwa: '   ' });
    expect(w.ok).toBe(false);
    expect(w.bledy).toEqual({ nazwa: 'Podaj nazwę producenta' });
  });

  it('bez adresu odmowa z tekstem pola', () => {
    for (const adres of [undefined, '', '  \n ']) {
      const w = walidujProducenta({ ...PELNY, adres });
      expect(w.ok, String(adres)).toBe(false);
      expect(w.bledy).toEqual({ adres: 'Podaj adres pocztowy producenta' });
    }
  });

  it('bez e-maila i www odmowa — GPSR wymaga adresu elektronicznego', () => {
    const w = walidujProducenta({ ...PELNY, email: ' ', www: null });
    expect(w.ok).toBe(false);
    expect(w.bledy).toEqual({
      email: 'Podaj e-mail albo stronę www producenta — przepisy GPSR wymagają adresu elektronicznego',
    });
  });

  it('e-mail bez @ albo bez kropki po @ odmowa', () => {
    for (const email of ['kontakt.polcien.invalid', 'kontakt@polcien', 'a b@polcien.invalid']) {
      const w = walidujProducenta({ ...PELNY, email });
      expect(w.ok, email).toBe(false);
      expect(Object.keys(w.bledy)).toEqual(['email']);
      expect(w.bledy.email).toMatch(/e-mail/i);
    }
  });

  it('www bez schematu dostaje https://, http i https przechodzą', () => {
    const bez = walidujProducenta({ ...PELNY, email: '', www: 'polcien.example/kontakt' });
    expect(bez.ok).toBe(true);
    expect(bez.wartosci.www).toBe('https://polcien.example/kontakt');
    expect(walidujProducenta({ ...PELNY, www: 'http://polcien.example' }).wartosci.www).toBe('http://polcien.example');
    expect(walidujProducenta({ ...PELNY, www: 'HTTPS://polcien.example' }).ok).toBe(true);
  });

  it('www z innym schematem niż http/https odmowa', () => {
    for (const www of ['javascript:alert(1)', 'JavaScript:alert(1)', 'ftp://polcien.example', 'data:text/html,x']) {
      const w = walidujProducenta({ ...PELNY, email: '', www });
      expect(w.ok, www).toBe(false);
      expect(Object.keys(w.bledy), www).toEqual(['www']);
    }
  });

  it('długości: nazwa 200, adres 500, e-mail 254, www 500', () => {
    expect(walidujProducenta({ ...PELNY, nazwa: 'N'.repeat(200) }).ok).toBe(true);
    expect(walidujProducenta({ ...PELNY, nazwa: 'N'.repeat(201) }).bledy).toHaveProperty('nazwa');
    expect(walidujProducenta({ ...PELNY, adres: 'A'.repeat(500) }).ok).toBe(true);
    expect(walidujProducenta({ ...PELNY, adres: 'A'.repeat(501) }).bledy).toHaveProperty('adres');
    const email = (n) => `${'e'.repeat(n - '@polcien.invalid'.length)}@polcien.invalid`;
    expect(walidujProducenta({ ...PELNY, email: email(254) }).ok).toBe(true);
    expect(walidujProducenta({ ...PELNY, email: email(255) }).bledy).toHaveProperty('email');
    const www = (n) => `https://polcien.example/${'w'.repeat(n - 'https://polcien.example/'.length)}`;
    expect(walidujProducenta({ ...PELNY, www: www(500) }).ok).toBe(true);
    expect(walidujProducenta({ ...PELNY, www: www(501) }).bledy).toHaveProperty('www');
  });

  it('wartości spoza tekstu (dwa pola formularza, liczba) traktuje jak brak', () => {
    const w = walidujProducenta({ nazwa: ['A', 'B'], adres: 7, email: 'kontakt@polcien.invalid' });
    expect(w.ok).toBe(false);
    expect(Object.keys(w.bledy).sort()).toEqual(['adres', 'nazwa']);
  });
});

describe('producentKarty', () => {
  const POLCIEN = { id: 1, nazwa: 'Pracownia Półcień', adres: 'ul. Przykładowa 1, 00-001 Miasto' };
  const DOMYSLNY = { id: 2, nazwa: 'Warsztat Przykładowy', adres: 'ul. Zmyślona 2, 00-002 Miasto' };
  const producenci = [POLCIEN, DOMYSLNY];
  const przypisania = new Map([['Półcień', 1]]);

  it('marka z przypisanym producentem → producent marki', () => {
    expect(producentKarty({ karta: { marka: 'Półcień' }, przypisania, producenci, domyslny: DOMYSLNY })).toEqual({
      producent: POLCIEN,
      zrodlo: 'marka',
      marka: 'Półcień',
    });
  });

  it('marka bez producenta → domyślny z dopiskiem', () => {
    expect(producentKarty({ karta: { marka: 'Lampa Półcień' }, przypisania, producenci, domyslny: DOMYSLNY })).toEqual({
      producent: DOMYSLNY,
      zrodlo: 'domyslny',
      marka: 'Lampa Półcień',
      dopisek: 'marka Lampa Półcień nie ma producenta — użyto domyślnego',
    });
  });

  it('karta bez marki → domyślny bez dopisku', () => {
    expect(producentKarty({ karta: { marka: '  ' }, przypisania, producenci, domyslny: DOMYSLNY })).toEqual({
      producent: DOMYSLNY,
      zrodlo: 'domyslny',
    });
  });

  it('marka bez producenta i brak domyślnego → wskazówka dla marki', () => {
    expect(producentKarty({ karta: { marka: 'Lampa Półcień' }, przypisania, producenci, domyslny: null })).toEqual({
      producent: null,
      zrodlo: 'brak',
      marka: 'Lampa Półcień',
      brak: 'Przypisz producenta marce Lampa Półcień',
    });
  });

  it('bez marki i bez domyślnego → wskaż producenta domyślnego', () => {
    expect(producentKarty({ karta: {}, przypisania: new Map(), producenci: [], domyslny: null })).toEqual({
      producent: null,
      zrodlo: 'brak',
      brak: 'Wskaż producenta domyślnego',
    });
  });

  it('przypisania jako zwykły obiekt i przypisanie do nieistniejącego producenta to brak przypisania', () => {
    expect(
      producentKarty({ karta: { marka: 'Półcień' }, przypisania: { Półcień: 1 }, producenci, domyslny: null }).zrodlo,
    ).toBe('marka');
    expect(
      producentKarty({ karta: { marka: 'Półcień' }, przypisania: { Półcień: 99 }, producenci, domyslny: null }).zrodlo,
    ).toBe('brak');
  });
});

it('opisProducenta: „nazwa, adres” w jednej linii', () => {
  expect(opisProducenta({ nazwa: 'Pracownia Półcień', adres: 'ul. Przykładowa 1\n00-001 Miasto' })).toBe(
    'Pracownia Półcień, ul. Przykładowa 1, 00-001 Miasto',
  );
  expect(opisProducenta(null)).toBe('');
});
