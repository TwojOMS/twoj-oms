import { describe, expect, it } from 'vitest';
import { walidujProducenta, producentKarty, opisProducenta, KRAJE_PRODUCENTA } from '../../src/domena/producenci.js';

const PELNY = {
  nazwa: '  Pracownia Półcień  ',
  ulica: ' ul. Przykładowa 1 ',
  kod: ' 00-001 ',
  miasto: ' Miasto Przykładowe ',
  kraj: 'PL',
  email: ' kontakt@polcien.invalid ',
  www: '',
};

describe('walidujProducenta', () => {
  it('pełne dane: wartości po trim, adres złożony z pól w trzech liniach z krajem, puste pole elektroniczne to null', () => {
    expect(walidujProducenta(PELNY)).toEqual({
      ok: true,
      bledy: {},
      wartosci: {
        nazwa: 'Pracownia Półcień',
        ulica: 'ul. Przykładowa 1',
        kod: '00-001',
        miasto: 'Miasto Przykładowe',
        kraj: 'PL',
        adres: 'ul. Przykładowa 1\n00-001 Miasto Przykładowe\nPolska',
        email: 'kontakt@polcien.invalid',
        www: null,
      },
    });
  });

  it('złożony adres w jednej linii opisu ma kraj także dla Polski', () => {
    const w = walidujProducenta({ ...PELNY, ulica: 'ul. Zmyślona 19', kod: '00950', miasto: 'Przykładowo' });
    expect(opisProducenta(w.wartosci)).toBe('Pracownia Półcień, ul. Zmyślona 19, 00-950 Przykładowo, Polska');
  });

  it('bez nazwy odmowa z tekstem pola', () => {
    const w = walidujProducenta({ ...PELNY, nazwa: '   ' });
    expect(w.ok).toBe(false);
    expect(w.bledy).toEqual({ nazwa: 'Podaj nazwę producenta' });
  });

  it('bez ulicy, kodu albo miejscowości odmowa z tekstem pola', () => {
    for (const pusty of [undefined, '', '  \n ']) {
      expect(walidujProducenta({ ...PELNY, ulica: pusty }).bledy).toEqual({ ulica: 'Podaj ulicę i numer' });
      expect(walidujProducenta({ ...PELNY, kod: pusty }).bledy).toEqual({ kod: 'Podaj kod pocztowy' });
      expect(walidujProducenta({ ...PELNY, miasto: pusty }).bledy).toEqual({ miasto: 'Podaj miejscowość' });
    }
  });

  it('sam adres jednym tekstem (import, stary klient) nie wystarcza — błąd przy ulicy', () => {
    const w = walidujProducenta({
      nazwa: 'Pracownia Półcień',
      adres: 'ul. Przykładowa 1\n00-001 Miasto Przykładowe',
      email: 'kontakt@polcien.invalid',
    });
    expect(w.ok).toBe(false);
    expect(w.bledy.ulica).toBe('Podaj ulicę i numer');
    expect(Object.keys(w.bledy).sort()).toEqual(['kod', 'miasto', 'ulica']);
  });

  it('kod polski: pięć cyfr bez kreski zapisuje z kreską, inna postać odmowa', () => {
    expect(walidujProducenta({ ...PELNY, kod: '00950' }).wartosci.kod).toBe('00-950');
    expect(walidujProducenta({ ...PELNY, kod: '00-950' }).wartosci.kod).toBe('00-950');
    for (const kod of ['0095', '009501', '00 950', 'AB-CDE', '00--950']) {
      const w = walidujProducenta({ ...PELNY, kod });
      expect(w.ok, kod).toBe(false);
      expect(w.bledy, kod).toEqual({ kod: 'Kod pocztowy w Polsce ma postać 00-000' });
    }
  });

  it('kod zagraniczny: litery, cyfry, spacja i kreska, zapis wielkimi literami', () => {
    const gb = walidujProducenta({ ...PELNY, kraj: 'GB', kod: 'sw1a 1aa' });
    expect(gb.ok).toBe(true);
    expect(gb.wartosci).toMatchObject({ kraj: 'GB', kod: 'SW1A 1AA' });
    expect(gb.wartosci.adres).toBe('ul. Przykładowa 1\nSW1A 1AA Miasto Przykładowe\nWielka Brytania');
    expect(walidujProducenta({ ...PELNY, kraj: 'DE', kod: '10115' }).wartosci.kod).toBe('10115');
    for (const kod of ['1', 'D/10115', 'ABCDEFGHIJKLM', '10115!']) {
      const w = walidujProducenta({ ...PELNY, kraj: 'DE', kod });
      expect(w.ok, kod).toBe(false);
      expect(w.bledy, kod).toEqual({ kod: 'Kod pocztowy może mieć tylko litery, cyfry, spację i kreskę' });
    }
  });

  it('kraj: pusty to Polska, spoza listy odmowa (także prefiks VAT EL zamiast GR)', () => {
    expect(walidujProducenta({ ...PELNY, kraj: '' }).wartosci.kraj).toBe('PL');
    expect(walidujProducenta({ ...PELNY, kraj: undefined }).wartosci.kraj).toBe('PL');
    expect(walidujProducenta({ ...PELNY, kraj: 'GR', kod: '105 57' }).ok).toBe(true);
    for (const kraj of ['XX', 'EL', 'Polska', 'POL']) {
      const w = walidujProducenta({ ...PELNY, kraj });
      expect(w.ok, kraj).toBe(false);
      expect(w.bledy.kraj, kraj).toBe('Wybierz kraj z listy');
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

  it('długości: nazwa 200, ulica 200, miejscowość 100, kod 12, e-mail 254, www 500; złożony adres mieści się w 500', () => {
    expect(walidujProducenta({ ...PELNY, nazwa: 'N'.repeat(200) }).ok).toBe(true);
    expect(walidujProducenta({ ...PELNY, nazwa: 'N'.repeat(201) }).bledy).toHaveProperty('nazwa');
    expect(walidujProducenta({ ...PELNY, ulica: 'U'.repeat(201) }).bledy).toEqual({
      ulica: 'Ulica i numer producenta może mieć najwyżej 200 znaków',
    });
    expect(walidujProducenta({ ...PELNY, miasto: 'M'.repeat(101) }).bledy).toEqual({
      miasto: 'Miejscowość producenta może mieć najwyżej 100 znaków',
    });
    const najdluzszy = walidujProducenta({
      ...PELNY,
      ulica: 'U'.repeat(200),
      miasto: 'M'.repeat(100),
      kraj: 'KR',
      kod: '1'.repeat(12),
    });
    expect(najdluzszy.ok).toBe(true);
    expect(najdluzszy.wartosci.adres.length).toBeLessThanOrEqual(500);
    const email = (n) => `${'e'.repeat(n - '@polcien.invalid'.length)}@polcien.invalid`;
    expect(walidujProducenta({ ...PELNY, email: email(254) }).ok).toBe(true);
    expect(walidujProducenta({ ...PELNY, email: email(255) }).bledy).toHaveProperty('email');
    const www = (n) => `https://polcien.example/${'w'.repeat(n - 'https://polcien.example/'.length)}`;
    expect(walidujProducenta({ ...PELNY, www: www(500) }).ok).toBe(true);
    expect(walidujProducenta({ ...PELNY, www: www(501) }).bledy).toHaveProperty('www');
  });

  it('wartości spoza tekstu (dwa pola formularza, liczba) traktuje jak brak', () => {
    const w = walidujProducenta({ ...PELNY, nazwa: ['A', 'B'], ulica: 7, miasto: ['X', 'Y'] });
    expect(w.ok).toBe(false);
    expect(Object.keys(w.bledy).sort()).toEqual(['miasto', 'nazwa', 'ulica']);
  });
});

describe('KRAJE_PRODUCENTA', () => {
  it('Polska, potem 26 państw UE po polskiej nazwie, potem 12 spoza UE po nazwie — kody ISO, nie prefiksy VAT', () => {
    const kody = KRAJE_PRODUCENTA.map((k) => k.kod);
    expect(KRAJE_PRODUCENTA[0]).toEqual({ kod: 'PL', nazwa: 'Polska', ue: true });
    expect(kody.slice(1, 27)).toEqual(
      'AT BE BG HR CY CZ DK EE FI FR GR ES NL IE LT LU LV MT DE PT RO SK SI SE HU IT'.split(' '),
    );
    expect(KRAJE_PRODUCENTA.slice(0, 27).every((k) => k.ue)).toBe(true);
    expect(kody.slice(27)).toEqual('CN IN JP KR NO US CH TW TR UA GB VN'.split(' '));
    expect(KRAJE_PRODUCENTA.slice(27).some((k) => k.ue)).toBe(false);
    expect(kody).not.toContain('EL');
    expect(KRAJE_PRODUCENTA.find((k) => k.kod === 'DE')?.nazwa).toBe('Niemcy');
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
