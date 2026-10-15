import { describe, it, expect } from 'vitest';
import { normalizujMetode, opcjeMetodPlatnosci, METODY_WPLATY_RECZNEJ } from '../../src/domena/metody-platnosci.js';

// SLOWNIK METOD PLATNOSCI — naprawa skazenia z audytu 22.08.2026: „BLIK" i „Blik" jako dwa
// byty, trzy warianty przelewu, 11 wplat bez metody na 3194,56 zl.
//
// Regula dziala PRZY ODCZYCIE (filtry, opcje pola wyboru), surowa wartosc w bazie zostaje
// nietknieta — ten sam wzorzec, co „status wyliczany z faktow": obejmuje wstecznie wszystkie
// zamowienia bez zadnego backfillu, a na ekranie karty dalej widac doslownie to, co przyslal
// sklep. Nieznana bramka przechodzi BEZ SKLEJANIA (sklep doklada bramki bez pytania nas
// o zdanie — kubelek „inne" ukrylby nowa bramke do pierwszego reczne przegladu).

describe('normalizujMetode', () => {
  it('skleja warianty wielkosci liter BLIK-a', () => {
    expect(normalizujMetode('BLIK').klucz).toBe('blik');
    expect(normalizujMetode('Blik').klucz).toBe('blik');
    expect(normalizujMetode('blik').klucz).toBe('blik');
  });

  it('skleja trzy warianty przelewu w jeden', () => {
    for (const w of ['Przelew', 'Przelew tradycyjny', 'Przelew bankowy', 'przelew na konto']) {
      expect(normalizujMetode(w).klucz).toBe('przelew');
    }
    expect(normalizujMetode('Przelew').etykieta).toBe('Przelew');
  });

  // ⚠️ „Przelewy24" ZAWIERA slowo „przelew" — kolejnosc regul jest trescia, nie szczegolem.
  it('Przelewy24 NIE wpada do przelewu', () => {
    expect(normalizujMetode('Przelewy24').klucz).toBe('przelewy24');
    expect(normalizujMetode('Przelewy24 - BLIK').klucz).toBe('przelewy24');
  });

  it('rozpoznaje pozostale bramki ze sklepow', () => {
    expect(normalizujMetode('Za pobraniem').klucz).toBe('pobranie');
    expect(normalizujMetode('Allegro (płatność online)').klucz).toBe('allegro');
    expect(normalizujMetode('PayU').klucz).toBe('payu');
    expect(normalizujMetode('PayU (płatność odroczona)').klucz).toBe('payu');
    expect(normalizujMetode('Apple Pay').klucz).toBe('apple_pay');
    expect(normalizujMetode('Karta płatnicza').klucz).toBe('karta');
    expect(normalizujMetode('Gotówka').klucz).toBe('gotowka');
  });

  it('pusta wartosc dostaje jawny kubelek „nieokreślona", nie znika', () => {
    for (const w of [null, undefined, '', '   ']) {
      const n = normalizujMetode(w);
      expect(n.klucz).toBe('nieokreslona');
      expect(n.etykieta).toBe('Nieokreślona');
    }
  });

  it('nieznana bramka przechodzi bez sklejania, z wlasna etykieta', () => {
    const n = normalizujMetode('Klarna');
    expect(n.klucz).toBe('Klarna');
    expect(n.etykieta).toBe('Klarna');
  });

  // Klucz kanoniczny jest PUNKTEM STALYM: normalizacja wlasnego wyniku niczego nie zmienia.
  // Bez tego stary link `?platnosc=przelew` i nowy z pola wyboru daja rozne wyniki.
  it('kazdy klucz kanoniczny normalizuje sie sam do siebie', () => {
    for (const klucz of ['blik', 'przelew', 'przelewy24', 'pobranie', 'allegro', 'payu', 'apple_pay', 'karta', 'gotowka', 'nieokreslona']) {
      expect(normalizujMetode(klucz).klucz).toBe(klucz);
    }
  });
});

describe('opcjeMetodPlatnosci', () => {
  it('skleja surowe wartosci z bazy w unikalne kubelki, posortowane po etykiecie', () => {
    const opcje = opcjeMetodPlatnosci(['BLIK', 'Blik', 'Przelew', 'Przelew tradycyjny', 'Za pobraniem', null]);
    const klucze = opcje.map((o) => o.klucz);
    expect(klucze).toEqual([...new Set(klucze)]);
    expect(klucze).toContain('blik');
    expect(klucze).toContain('przelew');
    expect(klucze).toContain('pobranie');
    expect(klucze).toContain('nieokreslona');
    expect(klucze.filter((k) => k === 'blik')).toHaveLength(1);
    const etykiety = opcje.map((o) => o.etykieta);
    expect([...etykiety].sort((a, b) => a.localeCompare(b, 'pl'))).toEqual(etykiety);
  });
});

describe('METODY_WPLATY_RECZNEJ', () => {
  // Pole wyboru na formularzu wplaty — etykiety zapisywane do bazy WPROST (surowe zostaje
  // czytelne), a normalizacja i tak je skleja z odpowiednikami ze sklepu.
  it('kazda opcja formularza normalizuje sie do klucza kanonicznego, nie do przepustki', () => {
    expect(METODY_WPLATY_RECZNEJ.length).toBeGreaterThanOrEqual(4);
    for (const etykieta of METODY_WPLATY_RECZNEJ) {
      const n = normalizujMetode(etykieta);
      expect(n.klucz).not.toBe(etykieta);
    }
  });
});
