import { describe, it, expect } from 'vitest';
import { powodyProblemu, akcjeProblemu } from '../../src/domena/problemy-ofert.js';

describe('polskie powody problemów', () => {
  it.each([
    ['wiele-produktow', /produkt.*katalog/i],
    ['parameter-mismatch', /parametr/i],
    ['duplikat', /więcej niż jedn/i],
    ['walidacja', /walidac/i],
    ['zakonczona', /zakończona/i],
    ['brak-w-allegro', /Allegro.*nie zwraca/i],
    ['bez-potwierdzenia', /potwierdz/i],
    ['aktywacja', /aktywac/i],
    ['komenda', /poleceni/i],
    ['karta', /kart/i],
    ['cena', /cen/i],
  ])('%s ma polski opis', (kod, opis) => {
    expect(powodyProblemu({ problemy: [{ kod }] })).toEqual([expect.stringMatching(opis)]);
  });
  it('zachowuje tekst problemu i kolejność; nieznany kod ma opis zastępczy', () => {
    expect(
      powodyProblemu({ problemy: [{ kod: 'karta', tekst: 'Uzupełnij nazwę lampy' }, { kod: 'nowy-kod' }] }),
    ).toEqual(['Uzupełnij nazwę lampy', 'Problem: nowy-kod']);
  });
  it('cena zawiera nową i obecną kwotę mimo ogólnego tekstu z pętli', () => {
    expect(
      powodyProblemu({
        problemy: [{ kod: 'cena', tekst: 'Zmiana ponad próg' }],
        cenaDoPotwierdzeniaGr: 12900,
        odczytCenaGr: 9900,
      }),
    ).toEqual(['Nowa cena 129,00 zł (dziś 99,00 zł) — zmiana ponad próg']);
  });
  it('używa ceny wysłanej, gdy brak odczytanej, i nie zamienia braku ceny na zero', () => {
    expect(
      powodyProblemu({ problemy: [{ kod: 'cena' }], cenaDoPotwierdzeniaGr: 12900, wyslanaCenaGr: 9900 })[0],
    ).toContain('dziś 99,00 zł');
    expect(powodyProblemu({ problemy: [{ kod: 'cena' }], cenaDoPotwierdzeniaGr: 12900 })[0]).not.toContain('dziś 0,00');
  });
  it('stan blad bez problemów pokazuje błąd; pusta oferta nie ma powodów', () => {
    expect(powodyProblemu({ stan: 'blad', problemy: [], blad: 'Brak odpowiedzi kanału' })).toEqual([
      'Brak odpowiedzi kanału',
    ]);
    expect(powodyProblemu({ stan: 'blad' })).toEqual(['Błąd komunikacji z kanałem']);
    expect(powodyProblemu({})).toEqual([]);
  });
});

describe('dane akcji', () => {
  const o = { stan: 'problem', problemy: [{ kod: 'zakonczona', oplataGr: 1234, prognozaAt: '2026-11-14T10:00:00Z' }] };
  it('Wznów tylko dla zakończonej oferty Allegro; ignoruje dawną prognozę', () => {
    expect(akcjeProblemu(o, 'allegro')).toEqual({ wznow: {}, cena: null });
    expect(akcjeProblemu(o, 'erli').wznow).toBeNull();
    expect(akcjeProblemu(o, null).wznow).toBeNull();
    expect(akcjeProblemu({ problemy: [] }, 'allegro').wznow).toBeNull();
  });
  it('Wznów nie wymaga prognozy; zamiar już zlecony nie daje akcji', () => {
    expect(akcjeProblemu({ problemy: [{ kod: 'zakonczona' }] }, 'allegro').wznow).toEqual({});
    expect(
      akcjeProblemu({ ...o, wyslanePola: { wznow: { login: 'operator', at: '2026-11-14T10:00:00Z' } } }, 'allegro')
        .wznow,
    ).toBeNull();
  });
  it('cena wymaga podłączonego kanału i niepotwierdzonej kwoty, obecna cena może być zerem', () => {
    const cena = { cenaDoPotwierdzeniaGr: 12900, odczytCenaGr: 0, wyslanaCenaGr: 9900 };
    for (const typ of ['allegro', 'erli']) expect(akcjeProblemu(cena, typ).cena).toEqual({ nowaGr: 12900, dzisGr: 0 });
    expect(akcjeProblemu(cena, null).cena).toBeNull();
    expect(akcjeProblemu({ ...cena, wyslanePola: { cenaPotwierdzonaGr: 12900 } }, 'erli').cena).toBeNull();
    expect(akcjeProblemu({ cenaDoPotwierdzeniaGr: null }, 'erli').cena).toBeNull();
  });
});
