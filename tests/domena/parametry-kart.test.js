import { describe, expect, it } from 'vitest';
import {
  LIMIT_PARAMETROW,
  NAZWY_POL_STALYCH,
  kluczNazwy,
  walidujNazweParametru,
  parsujWartosciListy,
  walidujDefinicje,
  normalizujWartosc,
  zastosujZmianeNazwyWartosci,
} from '../../src/domena/parametry-kart.js';

// Dane zmyślone: parametry „Pracowni Półcień” — kolor klosza, moc żarówki, materiał.

const ok = (wartosc) => ({ ok: true, wartosc });
const blad = (re) => ({ blad: expect.stringMatching(re) });

describe('walidujNazweParametru', () => {
  it('przycina i składa odstępy; 1–60 znaków', () => {
    expect(walidujNazweParametru('  Kolor   klosza ')).toEqual(ok('Kolor klosza'));
    expect(walidujNazweParametru('ż'.repeat(60))).toEqual(ok('ż'.repeat(60)));
    expect(walidujNazweParametru('   ')).toEqual(blad(/Podaj nazwę parametru/));
    expect(walidujNazweParametru(undefined)).toEqual(blad(/Podaj nazwę parametru/));
    expect(walidujNazweParametru('ż'.repeat(61))).toEqual(blad(/najwyżej 60 znaków/));
  });

  it('nazwa zajęta bez względu na wielkość liter, także polskich', () => {
    expect(walidujNazweParametru('kolor', ['Kolor'])).toEqual(blad(/„kolor” już jest/));
    expect(walidujNazweParametru('MOŻLIWOŚĆ', ['możliwość'])).toEqual(blad(/już jest/));
    expect(walidujNazweParametru(' Kolor  klosza', ['kolor klosza'])).toEqual(blad(/już jest/));
    expect(walidujNazweParametru('Kolor', ['Materiał'])).toEqual(ok('Kolor'));
  });

  it('nie może być nazwą pola stałego karty (bez względu na wielkość liter)', () => {
    for (const pole of ['Szerokość', 'Wysokość', 'Głębokość', 'Waga', 'EAN', 'Cena', 'Cena zakupu', 'Stawka VAT']) {
      expect(NAZWY_POL_STALYCH).toContain(pole);
    }
    for (const pole of ['VAT', 'Marka', 'Kategoria', 'SKU', 'Nazwa']) expect(NAZWY_POL_STALYCH).toContain(pole);
    expect(walidujNazweParametru('waga')).toEqual(blad(/„waga” to pole stałe karty/));
    expect(walidujNazweParametru('CENA ZAKUPU')).toEqual(blad(/pole stałe/));
    expect(walidujNazweParametru('głębokość')).toEqual(blad(/pole stałe/));
    expect(walidujNazweParametru('ean')).toEqual(blad(/pole stałe/));
    expect(walidujNazweParametru('Waga netto')).toEqual(ok('Waga netto'));
  });

  it('klucz nazwy: przycięty, złożone odstępy, małe litery po polsku', () => {
    expect(kluczNazwy('  ŁĄKA  Zielona ')).toBe('łąka zielona');
  });
});

describe('parsujWartosciListy', () => {
  it('jedna wartość na linię, puste linie i odstępy pomija, kolejność zostaje', () => {
    expect(parsujWartosciListy('czarny\r\n\n  biały  \nmosiądz   satynowy\n')).toEqual(
      ok(['czarny', 'biały', 'mosiądz satynowy']),
    );
    expect(parsujWartosciListy(['czarny', ' biały '])).toEqual(ok(['czarny', 'biały']));
  });

  it('1–100 wartości, każda do 100 znaków, bez powtórzeń (bez względu na wielkość liter)', () => {
    expect(parsujWartosciListy('\n  \n')).toEqual(blad(/co najmniej jedną wartość/));
    expect(parsujWartosciListy(undefined)).toEqual(blad(/co najmniej jedną wartość/));
    const sto = Array.from({ length: 100 }, (_, i) => `w${i}`);
    expect(parsujWartosciListy(sto.join('\n'))).toEqual(ok(sto));
    expect(parsujWartosciListy([...sto, 'w100'].join('\n'))).toEqual(blad(/najwyżej 100 wartości/));
    expect(parsujWartosciListy(`a\n${'ź'.repeat(100)}`)).toEqual(ok(['a', 'ź'.repeat(100)]));
    expect(parsujWartosciListy(`a\n${'ź'.repeat(101)}`)).toEqual(blad(/najwyżej 100 znaków/));
    expect(parsujWartosciListy('czarny\nbiały\nCzarny')).toEqual(blad(/„Czarny” jest na liście dwa razy/));
  });
});

describe('walidujDefinicje', () => {
  it('liczba: jednostka do 12 znaków, bez wartości listy', () => {
    expect(
      walidujDefinicje({ nazwa: ' Moc ', typ: 'liczba', jednostka: ' W ', wartosci: 'a\nb', wymagany: 'on' }),
    ).toEqual(
      ok({ nazwa: 'Moc', typ: 'liczba', jednostka: 'W', wartosci: null, wymagany: true, zmianaWartosci: null }),
    );
    expect(walidujDefinicje({ nazwa: 'Moc', typ: 'liczba', jednostka: '' }).wartosc.jednostka).toBe(null);
    expect(walidujDefinicje({ nazwa: 'Moc', typ: 'liczba', jednostka: 'kilowatogodz' }).ok).toBe(true);
    expect(walidujDefinicje({ nazwa: 'Moc', typ: 'liczba', jednostka: 'kilowatogodzi' })).toEqual(
      blad(/Jednostka .* najwyżej 12 znaków/),
    );
  });

  it('pola nieużywane przez typ są ignorowane', () => {
    expect(walidujDefinicje({ nazwa: 'Uwagi', typ: 'tekst', jednostka: 'W', wartosci: 'a\na' })).toEqual(
      ok({ nazwa: 'Uwagi', typ: 'tekst', jednostka: null, wartosci: null, wymagany: false, zmianaWartosci: null }),
    );
    expect(
      walidujDefinicje({ nazwa: 'Kolor', typ: 'lista', jednostka: 'W', wartosci: 'czarny\nbiały', wymagany: '1' }),
    ).toEqual(
      ok({
        nazwa: 'Kolor',
        typ: 'lista',
        jednostka: null,
        wartosci: ['czarny', 'biały'],
        wymagany: true,
        zmianaWartosci: null,
      }),
    );
  });

  it('nieznany typ, zła nazwa i zła lista — odmowa', () => {
    expect(walidujDefinicje({ nazwa: 'Kolor', typ: 'data' })).toEqual(blad(/Wybierz typ parametru/));
    expect(walidujDefinicje({ nazwa: 'Kolor', typ: ['lista', 'tekst'] })).toEqual(blad(/Wybierz typ parametru/));
    expect(walidujDefinicje({ nazwa: 'Marka', typ: 'tekst' })).toEqual(blad(/pole stałe/));
    expect(walidujDefinicje({ nazwa: 'Kolor', typ: 'lista', wartosci: '' })).toEqual(blad(/co najmniej jedną/));
    expect(walidujDefinicje({ nazwa: 'kolor', typ: 'tekst' }, { istniejaceNazwy: ['Kolor'] })).toEqual(
      blad(/już jest/),
    );
  });

  it('wymagany tylko z jawnego zaznaczenia', () => {
    for (const w of [true, 1, '1', 'on', 'tak'])
      expect(walidujDefinicje({ nazwa: 'A', typ: 'tekst', wymagany: w }).wartosc.wymagany).toBe(true);
    for (const w of [false, 0, '0', '', undefined, 'nie', ['on', 'on']]) {
      expect(walidujDefinicje({ nazwa: 'A', typ: 'tekst', wymagany: w }).wartosc.wymagany).toBe(false);
    }
  });

  it(`nowy parametr ponad limit ${LIMIT_PARAMETROW} — odmowa; zmiana istniejącego przy pełnym limicie — można`, () => {
    const piecdziesiat = Array.from({ length: 50 }, (_, i) => `P${i}`);
    expect(walidujDefinicje({ nazwa: 'Kolor', typ: 'tekst' }, { istniejaceNazwy: piecdziesiat, nowy: true })).toEqual(
      blad(/najwyżej 50 parametrów/),
    );
    expect(
      walidujDefinicje({ nazwa: 'Kolor', typ: 'tekst' }, { istniejaceNazwy: piecdziesiat.slice(1), nowy: true }).ok,
    ).toBe(true);
    expect(walidujDefinicje({ nazwa: 'Kolor', typ: 'tekst' }, { istniejaceNazwy: piecdziesiat.slice(1) }).ok).toBe(
      true,
    );
  });

  it('zmiana nazwy wartości listy: zamiana w miejscu, połączenie z istniejącą, braki pól', () => {
    const lista = (dane) => walidujDefinicje({ nazwa: 'Materiał', typ: 'lista', ...dane });
    expect(lista({ wartosci: 'mosiadz\nstal', wartosc_z: 'mosiadz', wartosc_na: ' mosiądz ' })).toEqual(
      ok({
        nazwa: 'Materiał',
        typ: 'lista',
        jednostka: null,
        wartosci: ['mosiądz', 'stal'],
        wymagany: false,
        zmianaWartosci: { z: 'mosiadz', na: 'mosiądz' },
      }),
    );
    expect(lista({ wartosci: 'mosiadz\nstal', wartosc_z: '', wartosc_na: '' }).wartosc.zmianaWartosci).toBe(null);
    expect(
      lista({ wartosci: 'mosiadz\nstal', wartosc_z: 'mosiadz', wartosc_na: 'mosiadz' }).wartosc.zmianaWartosci,
    ).toBe(null);
    expect(lista({ wartosci: 'mosiadz\nstal', wartosc_z: 'mosiadz', wartosc_na: '' })).toEqual(
      blad(/Wpisz nową nazwę wartości „mosiadz”/),
    );
    expect(lista({ wartosci: 'mosiadz\nstal', wartosc_z: '', wartosc_na: 'mosiądz' })).toEqual(
      blad(/Wybierz wartość, której nazwę zmieniasz/),
    );
    expect(lista({ wartosci: 'mosiadz\nstal', wartosc_z: 'mosiadz', wartosc_na: 'ź'.repeat(101) })).toEqual(
      blad(/najwyżej 100 znaków/),
    );
    // Nowa nazwa różni się tylko wielkością liter od innej wartości — to duplikat, nie połączenie.
    expect(lista({ wartosci: 'mosiadz\nstal', wartosc_z: 'mosiadz', wartosc_na: 'Stal' })).toEqual(blad(/dwa razy/));
    // Typ inny niż lista: pola zmiany nazwy są ignorowane jak reszta pól listy.
    expect(walidujDefinicje({ nazwa: 'Uwagi', typ: 'tekst', wartosc_z: 'a', wartosc_na: '' }).ok).toBe(true);
  });
});

describe('zastosujZmianeNazwyWartosci', () => {
  it('zamienia w miejscu, zachowuje kolejność', () => {
    expect(zastosujZmianeNazwyWartosci(['czarny', 'mosiadz', 'stal'], 'mosiadz', 'mosiądz')).toEqual([
      'czarny',
      'mosiądz',
      'stal',
    ]);
    expect(zastosujZmianeNazwyWartosci(['czarny'], 'czarny', 'Czarny')).toEqual(['Czarny']);
  });

  it('nowa nazwa już jest na liście — stara znika (połączenie)', () => {
    expect(zastosujZmianeNazwyWartosci(['mosiadz', 'mosiądz', 'stal'], 'mosiadz', 'mosiądz')).toEqual([
      'mosiądz',
      'stal',
    ]);
  });

  it('starej nie ma już na liście, nowej też nie — nowa dochodzi na końcu', () => {
    expect(zastosujZmianeNazwyWartosci(['stal'], 'mosiadz', 'mosiądz')).toEqual(['stal', 'mosiądz']);
    expect(zastosujZmianeNazwyWartosci(['mosiądz', 'stal'], 'mosiadz', 'mosiądz')).toEqual(['mosiądz', 'stal']);
  });
});

describe('normalizujWartosc', () => {
  const moc = { nazwa: 'Moc', typ: 'liczba', jednostka: 'W', wartosci: null };
  const uwagi = { nazwa: 'Uwagi', typ: 'tekst', jednostka: null, wartosci: null };
  const kolor = { nazwa: 'Kolor', typ: 'lista', jednostka: null, wartosci: ['czarny', 'biały', 'Złoty'] };

  it('puste pole to brak wartości (null) dla każdego typu', () => {
    for (const p of [moc, uwagi, kolor]) {
      for (const s of ['', '   ', null, undefined]) expect(normalizujWartosc(p, s)).toEqual(ok(null));
    }
  });

  it('pole przysłane dwa razy — odmowa, nie zgadujemy', () => {
    for (const p of [moc, uwagi, kolor]) expect(normalizujWartosc(p, ['a', 'b'])).toEqual(blad(/dwa razy/));
  });

  it('liczba: przecinek i kropka, zapis kanoniczny bez zer końcowych', () => {
    expect(normalizujWartosc(moc, '12,5')).toEqual(ok('12.5'));
    expect(normalizujWartosc(moc, '12.50')).toEqual(ok('12.5'));
    expect(normalizujWartosc(moc, ' 40 ')).toEqual(ok('40'));
    expect(normalizujWartosc(moc, '40,000')).toEqual(ok('40'));
    expect(normalizujWartosc(moc, '007')).toEqual(ok('7'));
    expect(normalizujWartosc(moc, '0')).toEqual(ok('0'));
    expect(normalizujWartosc(moc, '0,125')).toEqual(ok('0.125'));
    expect(normalizujWartosc(moc, '1 250,5')).toEqual(ok('1250.5'));
    expect(normalizujWartosc(moc, 12.5)).toEqual(ok('12.5'));
  });

  it('liczba: ujemna, za dużo miejsc po przecinku i napis — odmowa z nazwą parametru', () => {
    expect(normalizujWartosc(moc, '-1')).toEqual(blad(/^Moc: .*nie może być ujemna/));
    expect(normalizujWartosc(moc, '1,2345')).toEqual(blad(/^Moc: .*najwyżej trzy miejsca po przecinku/));
    expect(normalizujWartosc(moc, 'dużo')).toEqual(blad(/^Moc: „dużo” to nie jest liczba/));
    expect(normalizujWartosc(moc, '1e3')).toEqual(blad(/to nie jest liczba/));
    expect(normalizujWartosc(moc, '1,2,3')).toEqual(blad(/to nie jest liczba/));
    expect(normalizujWartosc(moc, ',5')).toEqual(blad(/to nie jest liczba/));
    expect(normalizujWartosc(moc, '1'.repeat(13))).toEqual(blad(/za duża/));
  });

  it('tekst: przycięty, odstępy złożone, do 200 znaków', () => {
    expect(normalizujWartosc(uwagi, '  klosz  z\nlnu ')).toEqual(ok('klosz z lnu'));
    expect(normalizujWartosc(uwagi, 'ą'.repeat(200))).toEqual(ok('ą'.repeat(200)));
    expect(normalizujWartosc(uwagi, 'ą'.repeat(201))).toEqual(blad(/^Uwagi: .*najwyżej 200 znaków/));
  });

  it('lista: tylko wartość z listy; wielkość liter dopasowana do wpisu z listy', () => {
    expect(normalizujWartosc(kolor, 'czarny')).toEqual(ok('czarny'));
    expect(normalizujWartosc(kolor, ' BIAŁY ')).toEqual(ok('biały'));
    expect(normalizujWartosc(kolor, 'złoty')).toEqual(ok('Złoty'));
    expect(normalizujWartosc(kolor, 'zielony')).toEqual(
      blad(/^Kolor: „zielony” nie ma na liście.*czarny, biały, Złoty/),
    );
  });

  it('nieznany typ parametru — odmowa', () => {
    expect(normalizujWartosc({ nazwa: 'X', typ: 'data' }, 'a')).toEqual(blad(/nieznany typ/));
  });
});
