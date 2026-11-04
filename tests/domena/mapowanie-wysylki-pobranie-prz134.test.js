import { describe, it, expect } from 'vitest';
import { metodaWysylkiZamowienia } from '../../src/domena/mapowanie-wysylki.js';
import { mapujZamowienie } from '../../src/domena/mapowanie.js';

// PRZ-134.01 (plan D1/D2) — sklep z panelu wskazuje bramki płatności, które znaczą „zapłacę przy
// odbiorze" (`mapowanie.bramkiPobrania`). Bramka zamówienia (`payment_method`) jest wtedy sygnałem
// głównym, flaga `pobranie` instancji wysyłki — drugim. Zachowanie sklepów BEZ `bramkiPobrania`
// pilnuje złoty test (mapowanie-wysylki-zloty-prz134.test.js).

// Zmyślony sklep „Pracownia Półcień".
const SKLEP = {
  instancje: {
    1: { metoda: 'dpd' },
    2: { metoda: 'dpd', pobranie: true },
    4: { metoda: 'odbior_osobisty' },
    5: { metoda: 'odbior_osobisty', pobranie: true },
    6: { metoda: 'inpost_paczkomat' },
    8: { metoda: 'teleport' },
  },
  poPozycji: [{ sku: 'pc-wysylka', metoda: 'dpd' }],
  bramkiPobrania: ['cod'],
};

const zam = (instancja, bramka, reszta = {}) => {
  const z = {
    id: 41, number: '4101', total: '238.40', status: 'processing',
    shipping_lines: instancja === null ? [] : [{ instance_id: instancja, method_id: 'flat_rate', method_title: 'Kurier' }],
    line_items: [{ name: 'Kinkiet Półcień', sku: 'pc-7', quantity: 1, total: '238.40' }],
    ...reszta,
  };
  if (bramka !== undefined) z.payment_method = bramka;
  return z;
};

describe('PRZ-134 — bramka płatności z bramkiPobrania daje pobranie', () => {
  it('cod na zwykłej metodzie kurierskiej (bez flagi) → pobranie, kwota = cała suma zamówienia', () => {
    expect(metodaWysylkiZamowienia(zam(1, 'cod'), SKLEP)).toEqual({ metoda: 'dpd', pobranie: true });
    const z = mapujZamowienie(zam(1, 'cod'), SKLEP);
    expect(z.metoda_wysylki).toBe('dpd');
    expect(z.pobranie).toBe(1);
    expect(z.kwota_pobrania).toBe('238.40');
  });

  it('bacs na tej samej metodzie → bez pobrania, kwota pobrania pusta', () => {
    expect(metodaWysylkiZamowienia(zam(1, 'bacs'), SKLEP)).toEqual({ metoda: 'dpd', pobranie: false });
    const z = mapujZamowienie(zam(1, 'bacs'), SKLEP);
    expect(z.pobranie).toBe(0);
    expect(z.kwota_pobrania).toBeNull();
  });

  it('cod na paczkomacie → paczkomat z pobraniem', () => {
    expect(metodaWysylkiZamowienia(zam(6, 'cod'), SKLEP)).toEqual({ metoda: 'inpost_paczkomat', pobranie: true });
  });

  it('cod na metodzie z flagą pobrania → pobranie (oba sygnały zgodne)', () => {
    expect(metodaWysylkiZamowienia(zam(2, 'cod'), SKLEP)).toEqual({ metoda: 'dpd', pobranie: true });
  });

  it('cod przy wysyłce rozpoznanej po pozycji (bez linii wysyłki) → pobranie', () => {
    const z = zam(null, 'cod', { line_items: [{ name: 'wysyłka', sku: 'pc-wysylka', quantity: 1, total: '0.00' }] });
    expect(metodaWysylkiZamowienia(z, SKLEP)).toEqual({ metoda: 'dpd', pobranie: true });
  });

  it('bramka wtyczki z listy działa tak samo jak cod', () => {
    const sklep = { ...SKLEP, bramkiPobrania: ['cod', 'wtyczka_pobranie.dpd'] };
    expect(metodaWysylkiZamowienia(zam(1, 'wtyczka_pobranie.dpd'), sklep)).toEqual({ metoda: 'dpd', pobranie: true });
  });

  it('porównanie bramki jest dokładne: COD to nie cod (bez toLowerCase), ale spacje na brzegach są obcinane', () => {
    expect(metodaWysylkiZamowienia(zam(1, 'COD'), SKLEP)).toEqual({ metoda: 'dpd', pobranie: false });
    expect(metodaWysylkiZamowienia(zam(1, ' cod '), SKLEP)).toEqual({ metoda: 'dpd', pobranie: true });
  });
});

describe('PRZ-134 — sprzeczność flagi instancji i bramki', () => {
  // „Kurier DPD pobranie" i zapłata przelewem: obie pomyłki kosztują (towar za darmo albo klient
  // płaci dwa razy), więc panel nie zgaduje — operator ustawia metodę i pobranie na karcie.
  it('instancja z flagą pobrania + bacs → nieznana, bez pobrania i bez kwoty', () => {
    expect(metodaWysylkiZamowienia(zam(2, 'bacs'), SKLEP)).toEqual({ metoda: 'nieznana', pobranie: false });
    const z = mapujZamowienie(zam(2, 'bacs'), SKLEP);
    expect(z.metoda_wysylki).toBe('nieznana');
    expect(z.pobranie).toBe(0);
    expect(z.kwota_pobrania).toBeNull();
  });

  it('pusta lista bramek + flaga instancji + cod → też sprzeczność', () => {
    expect(metodaWysylkiZamowienia(zam(2, 'cod'), { ...SKLEP, bramkiPobrania: [] }))
      .toEqual({ metoda: 'nieznana', pobranie: false });
  });
});

describe('PRZ-134 — odbiór osobisty nie niesie pobrania kurierskiego', () => {
  it('odbiór osobisty + cod → odbiór osobisty bez pobrania', () => {
    expect(metodaWysylkiZamowienia(zam(4, 'cod'), SKLEP)).toEqual({ metoda: 'odbior_osobisty', pobranie: false });
    expect(mapujZamowienie(zam(4, 'cod'), SKLEP).kwota_pobrania).toBeNull();
  });

  it('odbiór osobisty z flagą + bacs albo cod → odbiór osobisty bez pobrania (nie „nieznana")', () => {
    expect(metodaWysylkiZamowienia(zam(5, 'bacs'), SKLEP)).toEqual({ metoda: 'odbior_osobisty', pobranie: false });
    expect(metodaWysylkiZamowienia(zam(5, 'cod'), SKLEP)).toEqual({ metoda: 'odbior_osobisty', pobranie: false });
  });
});

describe('PRZ-134 — bez bramki w zamówieniu decyduje flaga instancji (jak dziś)', () => {
  it('pusta, biała albo brakująca payment_method → wynik z flagi', () => {
    for (const bramka of ['', '   ', undefined, null]) {
      expect(metodaWysylkiZamowienia(zam(2, bramka), SKLEP)).toEqual({ metoda: 'dpd', pobranie: true });
      expect(metodaWysylkiZamowienia(zam(1, bramka), SKLEP)).toEqual({ metoda: 'dpd', pobranie: false });
    }
  });

  it('pusta payment_method przy odbiorze osobistym z flagą → flaga, jak dziś', () => {
    expect(metodaWysylkiZamowienia(zam(5, ''), SKLEP)).toEqual({ metoda: 'odbior_osobisty', pobranie: true });
  });
});

describe('PRZ-134 — granice reguły', () => {
  it('pusta lista bramek + cod → bez pobrania', () => {
    expect(metodaWysylkiZamowienia(zam(1, 'cod'), { ...SKLEP, bramkiPobrania: [] }))
      .toEqual({ metoda: 'dpd', pobranie: false });
  });

  it('metoda nieznana (spoza mapy albo literówka) + cod → nieznana, bez pobrania', () => {
    expect(metodaWysylkiZamowienia(zam(8, 'cod'), SKLEP)).toEqual({ metoda: 'nieznana', pobranie: false });
    expect(metodaWysylkiZamowienia(zam(999, 'cod'), SKLEP)).toEqual({ metoda: 'nieznana', pobranie: false });
    expect(metodaWysylkiZamowienia(zam(null, 'cod'), SKLEP)).toEqual({ metoda: 'nieznana', pobranie: false });
  });

  it('bramkiPobrania, które nie są tablicą, nie włączają reguły (zachowanie sprzed PRZ-134)', () => {
    for (const bramkiPobrania of ['cod', null, { cod: true }]) {
      const sklep = { ...SKLEP, bramkiPobrania };
      expect(metodaWysylkiZamowienia(zam(1, 'cod'), sklep)).toEqual({ metoda: 'dpd', pobranie: false });
      expect(metodaWysylkiZamowienia(zam(2, 'bacs'), sklep)).toEqual({ metoda: 'dpd', pobranie: true });
    }
  });
});
