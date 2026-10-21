import { describe, it, expect } from 'vitest';
import {
  POLA_POZYCJI, kluczPozycji, parsujNowaPozycje, parsujEdycjePozycji,
  nalozNadpisaniaPozycji, ustawNadpisaniePozycji, roznicePozycji,
} from '../../src/domena/pozycje-reczne.js';

const zeSklepu = (nad = {}) => ({
  id: 7, zrodlo: 'sklep', zrodlo_id: 4321, nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 2,
  cena_brutto: '61.50', cena_netto: '50.00', brutto_linii: '123.00', netto_linii: '100.00',
  ...nad,
});

const reczna = (nad = {}) => ({
  id: 91, zrodlo: 'reczna', zrodlo_id: null, nazwa: 'Dodatkowy szablon', sku: null, ilosc: 1,
  cena_brutto: '80.00', cena_netto: null, brutto_linii: '80.00', netto_linii: null,
  ...nad,
});

describe('kluczPozycji', () => {
  // ⚠️ Klucz MUSI przeżyć przebieg pollera, który kasuje i wstawia pozycje sklepowe od nowa
  // (nowe `id` przy każdej synchronizacji). Dlatego identyfikator linii U ŹRÓDŁA, nie nasze `id`.
  it('pozycja ze sklepu → klucz z identyfikatora linii w sklepie, nie z naszego id', () => {
    expect(kluczPozycji(zeSklepu(), 0)).toBe('s4321');
  });

  it('pozycja ze sklepu bez identyfikatora (wiersz sprzed migracji) → klucz z numeru porządkowego', () => {
    expect(kluczPozycji(zeSklepu({ zrodlo_id: null }), 2)).toBe('p2');
  });

  // Wiersza ręcznego poller NIE KASUJE, więc nasze `id` jest przy nim trwałe — i jest
  // jedynym, co tę pozycję identyfikuje, bo sklep o niej nie wie.
  it('pozycja ręczna → klucz z naszego id', () => {
    expect(kluczPozycji(reczna(), 0)).toBe('r91');
  });

  it('klucze różnych pozycji tego samego zamówienia się nie zbiegają', () => {
    const klucze = [kluczPozycji(zeSklepu(), 0), kluczPozycji(zeSklepu({ zrodlo_id: 4322 }), 1), kluczPozycji(reczna(), 2)];
    expect(new Set(klucze).size).toBe(3);
  });
});

// PRZ-105: stawka pozycji ręcznej — z pola `vat` (lista 23/8/5/0), pusta = domyślna z Ustawień; netto przelicza
// się stawką wiersza, a przy nabywcy z UE (wdt) stawką 0. Zapisana zostaje stawka WYBRANA (dokument i tak da 0).
describe('parsujNowaPozycje — stawka VAT (PRZ-105)', () => {
  const baza = { nazwa: 'Album o lampach', ilosc: '1' };

  it('netto 100 przy stawce 8 → brutto 108,00, vat 8', () => {
    const p = parsujNowaPozycje({ ...baza, cena_netto: '100', vat: '8' }, { stawkaDomyslna: '23' });
    expect(p).toMatchObject({ cena_brutto: '108.00', brutto_linii: '108.00', vat: '8' });
  });

  it('pusta stawka → domyślna z Ustawień; brutto wpisane wygrywa z netto', () => {
    expect(parsujNowaPozycje({ ...baza, cena_brutto: '50.00', vat: '' }, { stawkaDomyslna: '5' }).vat).toBe('5');
    expect(parsujNowaPozycje({ ...baza, cena_netto: '100', cena_brutto: '50.00', vat: '8' }, { stawkaDomyslna: '23' }).cena_brutto).toBe('50.00');
  });

  it('stawka spoza listy (22, zw, abc) → odmowa z „stawka”, nie cicha domyślna', () => {
    for (const vat of ['22', 'zw', 'abc']) {
      expect(() => parsujNowaPozycje({ ...baza, cena_brutto: '10.00', vat }, { stawkaDomyslna: '23' })).toThrow(/stawk/i);
    }
  });

  it('nabywca z UE (wdt): netto 100 → brutto 100,00 (0%), zapisana stawka wybrana', () => {
    const p = parsujNowaPozycje({ ...baza, cena_netto: '100', vat: '23' }, { stawkaDomyslna: '23', wdt: true });
    expect(p).toMatchObject({ cena_brutto: '100.00', vat: '23' });
  });
});

describe('parsujNowaPozycje', () => {
  it('przyjmuje nazwę, SKU, ilość i cenę brutto; sumę linii liczy w groszach', () => {
    const p = parsujNowaPozycje({ nazwa: 'Dodatkowy szablon', sku: 'X-1', ilosc: '3', cena_brutto: '61.50' });
    // PRZ-105: wynik niesie też stawkę — bez pola `vat` domyślną (tu wbudowane 23).
    expect(p).toEqual({
      nazwa: 'Dodatkowy szablon', sku: 'X-1', ilosc: 3, cena_brutto: '61.50', brutto_linii: '184.50', vat: '23',
    });
  });

  it('SKU jest opcjonalne → null, nie pusty string', () => {
    expect(parsujNowaPozycje({ nazwa: 'X', ilosc: '1', cena_brutto: '1.00' }).sku).toBeNull();
  });

  // Panel już tak działa przy wadze paczki i przy wpłacie — odrzucanie przecinka tutaj
  // byłoby niespójnością w obrębie jednego panelu.
  it('przyjmuje przecinek dziesiętny w cenie', () => {
    expect(parsujNowaPozycje({ nazwa: 'X', ilosc: '2', cena_brutto: '61,50' }).brutto_linii).toBe('123.00');
  });

  it('przyjmuje przecinek dziesiętny w ilości, gdy oznacza liczbę całkowitą', () => {
    expect(parsujNowaPozycje({ nazwa: 'X', ilosc: '3,0', cena_brutto: '1.00' }).ilosc).toBe(3);
  });

  it('brak nazwy → odmowa dla operatora', () => {
    expect(() => parsujNowaPozycje({ ilosc: '1', cena_brutto: '1.00' })).toThrow(/nazwę/i);
  });

  it('ilość 0 → odmowa (pozycja na zero sztuk nie jest pozycją)', () => {
    expect(() => parsujNowaPozycje({ nazwa: 'X', ilosc: '0', cena_brutto: '1.00' })).toThrow(/ilość/i);
  });

  it('ilość ujemna → odmowa', () => {
    expect(() => parsujNowaPozycje({ nazwa: 'X', ilosc: '-2', cena_brutto: '1.00' })).toThrow(/ilość/i);
  });

  // Arytmetyka całego modułu jest CAŁKOWITA, w groszach. Ilość ułamkowa robiłaby z sumy
  // linii wartość niecałkowitą w groszach (0,01 zł × 1,5 szt.), czyli dokładnie ten rodzaj
  // rozjazdu, przed którym broni bariera arytmetyczna.
  it('ilość ułamkowa → odmowa z wyjaśnieniem', () => {
    expect(() => parsujNowaPozycje({ nazwa: 'X', ilosc: '1,5', cena_brutto: '1.00' })).toThrow(/całkowit/i);
  });

  it('cena 0 → odmowa (pozycja za darmo nie wymaga dopłaty)', () => {
    expect(() => parsujNowaPozycje({ nazwa: 'X', ilosc: '1', cena_brutto: '0' })).toThrow(/cen/i);
  });

  it('cena nieliczbowa → odmowa, nigdy NaN', () => {
    expect(() => parsujNowaPozycje({ nazwa: 'X', ilosc: '1', cena_brutto: 'dużo' })).toThrow(/cen/i);
  });

  it('suma linii liczona w groszach, nie na floatach', () => {
    // 0,07 × 3 na floatach daje 0,21000000000000002
    expect(parsujNowaPozycje({ nazwa: 'X', ilosc: '3', cena_brutto: '0.07' }).brutto_linii).toBe('0.21');
  });
});

describe('parsujEdycjePozycji', () => {
  it('oddaje komplet trzech pól w postaci znormalizowanej', () => {
    expect(parsujEdycjePozycji({ nazwa: '  STOP  ', ilosc: '3', cena_brutto: '61,5' }))
      .toEqual({ nazwa: 'STOP', ilosc: 3, cena_brutto: '61.50' });
  });

  it('SKU nie jest polem edycji — edycja go nie tyka', () => {
    expect(POLA_POZYCJI).not.toContain('sku');
    expect(Object.keys(parsujEdycjePozycji({ nazwa: 'X', ilosc: '1', cena_brutto: '1.00', sku: 'PODMIENIONE' })))
      .toEqual(POLA_POZYCJI);
  });

  it('puste pola odrzuca tak samo jak przy dopisywaniu', () => {
    expect(() => parsujEdycjePozycji({ nazwa: '', ilosc: '1', cena_brutto: '1.00' })).toThrow(/nazwę/i);
  });
});

describe('roznicePozycji', () => {
  // Ta sama zasada, co przy danych klienta (domain/dane-reczne.js): klucz powstaje WYŁĄCZNIE
  // tam, gdzie wartość faktycznie odbiega od sklepu.
  it('zapisuje WYŁĄCZNIE pola różne od sklepowych', () => {
    const r = roznicePozycji(zeSklepu(), { nazwa: 'STOP', ilosc: 3, cena_brutto: '61.50' });
    expect(r).toEqual({ ilosc: 3 });
  });

  it('nic nie odbiega od sklepu → pusty obiekt nadpisań', () => {
    expect(roznicePozycji(zeSklepu(), { nazwa: 'STOP', ilosc: 2, cena_brutto: '61.50' })).toEqual({});
  });

  it('porównanie ceny idzie po wartości, nie po zapisie — 61,5 to nie zmiana wobec 61.50', () => {
    expect(roznicePozycji(zeSklepu({ cena_brutto: '61.50' }), { nazwa: 'STOP', ilosc: 2, cena_brutto: '61.50' }))
      .toEqual({});
  });
});

describe('nalozNadpisaniaPozycji', () => {
  it('brak nadpisań → wartości sklepowe bez zmian, nic nie oznaczone', () => {
    const [p] = nalozNadpisaniaPozycji([zeSklepu()], null);
    expect(p).toMatchObject({ nazwa: 'STOP', ilosc: 2, cena_brutto: '61.50', brutto_linii: '123.00' });
    expect(p.polaZmienione).toEqual([]);
    expect(p.reczna).toBe(false);
  });

  it('nadpisana ilość wygrywa i przelicza sumę linii', () => {
    const [p] = nalozNadpisaniaPozycji([zeSklepu()], JSON.stringify({ s4321: { ilosc: 3 } }));
    expect(p.ilosc).toBe(3);
    expect(p.brutto_linii).toBe('184.50');
    expect(p.polaZmienione).toEqual(['ilosc']);
  });

  // ⚠️ SEDNO: nadpisanie jest POLOWE. Zmiana samej ilości NIE MOŻE zamrozić nazwy ani ceny —
  // inaczej poprawka ceny w sklepie przestałaby dochodzić na zawsze.
  it('nadpisana sama ilość NIE zamraża ceny — poprawka ceny w sklepie dochodzi dalej', () => {
    const nadpisania = JSON.stringify({ s4321: { ilosc: 3 } });
    const [p] = nalozNadpisaniaPozycji([zeSklepu({ cena_brutto: '70.00', brutto_linii: '140.00' })], nadpisania);
    expect(p.cena_brutto).toBe('70.00');
    expect(p.brutto_linii).toBe('210.00');
  });

  it('nadpisana sama ilość NIE zamraża nazwy', () => {
    const nadpisania = JSON.stringify({ s4321: { ilosc: 3 } });
    const [p] = nalozNadpisaniaPozycji([zeSklepu({ nazwa: 'STOP nowa nazwa' })], nadpisania);
    expect(p.nazwa).toBe('STOP nowa nazwa');
  });

  it('nadpisana sama nazwa zostawia kwoty ze sklepu nietknięte (rabat linii się nie gubi)', () => {
    const nadpisania = JSON.stringify({ s4321: { nazwa: 'STOP (uzgodniona nazwa)' } });
    const [p] = nalozNadpisaniaPozycji([zeSklepu({ brutto_linii: '100.00' })], nadpisania);
    expect(p.brutto_linii).toBe('100.00');
    expect(p.cena_netto).toBe('50.00');
    expect(p.polaZmienione).toEqual(['nazwa']);
  });

  // Netto ze sklepu przestaje pasować do przecenionej linii — pokazywanie go dalej byłoby
  // kłamstwem. Kolumnę netto liczy wtedy widok, ze stawki VAT (domain/vat.js).
  it('nadpisana cena zeruje netto ze sklepu (nie pasuje już do linii)', () => {
    const [p] = nalozNadpisaniaPozycji([zeSklepu()], JSON.stringify({ s4321: { cena_brutto: '70.00' } }));
    expect(p.cena_brutto).toBe('70.00');
    expect(p.brutto_linii).toBe('140.00');
    expect(p.cena_netto).toBeNull();
    expect(p.netto_linii).toBeNull();
  });

  it('wartości SKLEPOWE nie giną — leżą obok, w `sklep`', () => {
    const [p] = nalozNadpisaniaPozycji([zeSklepu()], JSON.stringify({ s4321: { ilosc: 3 } }));
    expect(p.sklep).toMatchObject({ ilosc: 2, cena_brutto: '61.50', brutto_linii: '123.00' });
  });

  // Sklep dogonił ręczną poprawkę → nie ma już czego oznaczać (ta sama zasada, co
  // polaZmienione w domain/dane-reczne.js).
  it('nadpisanie równe wartości ze sklepu nie jest oznaczane jako zmiana', () => {
    const [p] = nalozNadpisaniaPozycji([zeSklepu()], JSON.stringify({ s4321: { ilosc: 2 } }));
    expect(p.polaZmienione).toEqual([]);
  });

  it('pozycja ręczna nie bierze nadpisań i nie ma wartości sklepowych', () => {
    const [p] = nalozNadpisaniaPozycji([reczna()], JSON.stringify({ r91: { ilosc: 9 } }));
    expect(p.reczna).toBe(true);
    expect(p.ilosc).toBe(1);
    expect(p.sklep).toBeNull();
  });

  it('uszkodzony JSON nadpisań → same wartości ze sklepu, nigdy wyjątek', () => {
    expect(() => nalozNadpisaniaPozycji([zeSklepu()], '{to nie jest json')).not.toThrow();
    expect(nalozNadpisaniaPozycji([zeSklepu()], '{to nie jest json')[0].ilosc).toBe(2);
  });

  it('nadpisanie pod nieznanym kluczem nie dotyka żadnej pozycji', () => {
    const [p] = nalozNadpisaniaPozycji([zeSklepu()], JSON.stringify({ s9999: { ilosc: 99 } }));
    expect(p.ilosc).toBe(2);
  });
});

describe('ustawNadpisaniePozycji', () => {
  it('dokłada nadpisanie pod kluczem, nie ruszając pozostałych', () => {
    const m = ustawNadpisaniePozycji(JSON.stringify({ s1: { ilosc: 2 } }), 's2', { cena_brutto: '9.00' });
    expect(m).toEqual({ s1: { ilosc: 2 }, s2: { cena_brutto: '9.00' } });
  });

  it('puste nadpisanie KASUJE klucz — „Przywróć ze sklepu"', () => {
    expect(ustawNadpisaniePozycji(JSON.stringify({ s1: { ilosc: 2 }, s2: { ilosc: 3 } }), 's1', {}))
      .toEqual({ s2: { ilosc: 3 } });
  });

  it('skasowanie ostatniego nadpisania daje null, nie pusty obiekt', () => {
    expect(ustawNadpisaniePozycji(JSON.stringify({ s1: { ilosc: 2 } }), 's1', {})).toBeNull();
  });
});
