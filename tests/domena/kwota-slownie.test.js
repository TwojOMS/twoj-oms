import { describe, it, expect } from 'vitest';
import { kwotaSlownie } from '../../src/domena/kwota-slownie.js';

// Test kontrolny: wzięty CO DO ZNAKU z prawdziwego dokumentu (PRO_1_08_2026-4131.pdf).
// Jeśli ten test pada, cała reszta nie ma znaczenia — to jest wzorzec, z którym panel
// ma się zgadzać, nie zgadywanie.
describe('kwotaSlownie — test kontrolny z dokumentu Apilo', () => {
  it('65400 groszy (654,00 zł) → „sześćset pięćdziesiąt cztery złote"', () => {
    expect(kwotaSlownie(65400)).toBe('sześćset pięćdziesiąt cztery złote');
  });
});

describe('kwotaSlownie — grosze', () => {
  it('65450 groszy → złotówki + grosze jako ułamek /100', () => {
    expect(kwotaSlownie(65450)).toBe('sześćset pięćdziesiąt cztery złote 50/100');
  });

  it('zero groszy pomija część groszową w ogóle (nie "0/100")', () => {
    expect(kwotaSlownie(65400)).not.toContain('/100');
  });

  it('grosze jednocyfrowe dostają wiodące zero — 5 groszy to "05/100", nie "5/100"', () => {
    expect(kwotaSlownie(65405)).toBe('sześćset pięćdziesiąt cztery złote 05/100');
  });
});

describe('kwotaSlownie — zero', () => {
  it('0 → "zero złotych"', () => {
    expect(kwotaSlownie(0)).toBe('zero złotych');
  });
});

// Odmiana „złoty/złote/złotych" — klasyczna polska liczebnikowa pułapka.
//
// Reguła (poprawiona po recenzji — pierwsza wersja tego testu ZASZYŁA błędną regułę
// „jedność 1 → złoty" i przez to potwierdzała zły kod zamiast go łapać):
//   - liczba RÓWNA DOKŁADNIE 1 → „złoty" (forma pojedyncza — WYŁĄCZNIE dla samej jedynki,
//     nie dla każdej liczby kończącej się na 1: „21 złotych", nie „21 złoty");
//   - ostatnia cyfra 2-4 ORAZ dwie ostatnie cyfry NIE są 12/13/14 → „złote";
//   - wszystko pozostałe (0, 5-21, 25-31, 11-14, 101, 1001…) → „złotych".
describe('kwotaSlownie — odmiana rzeczownika „złoty"', () => {
  it.each([
    [100, 'jeden złoty'],
    [200, 'dwa złote'],
    [300, 'trzy złote'],
    [400, 'cztery złote'],
    [500, 'pięć złotych'],
    [1000, 'dziesięć złotych'],
    [1100, 'jedenaście złotych'],
    [1200, 'dwanaście złotych'],
    [1500, 'piętnaście złotych'],
    [2200, 'dwadzieścia dwa złote'],
  ])('%i groszy → "%s"', (groszy, oczekiwana) => {
    expect(kwotaSlownie(groszy)).toBe(oczekiwana);
  });

  // Pułapki wprost z zadania, plus liczby złożone kończące się na 1 (21, 31, 101, 111, 1001) —
  // to jest DOKŁADNIE ten przypadek, którego pierwsza wersja testu nie łapała, bo test i kod
  // dzieliły tę samą (błędną) regułę „jednosc===1 → złoty".
  it.each([
    [1, 100, 'jeden złoty'],
    [2, 200, 'dwa złote'],
    [4, 400, 'cztery złote'],
    [5, 500, 'pięć złotych'],
    [11, 1100, 'jedenaście złotych'],
    [12, 1200, 'dwanaście złotych'],
    [14, 1400, 'czternaście złotych'],
    [21, 2100, 'dwadzieścia jeden złotych'],
    [22, 2200, 'dwadzieścia dwa złote'],
    [24, 2400, 'dwadzieścia cztery złote'],
    [25, 2500, 'dwadzieścia pięć złotych'],
    [31, 3100, 'trzydzieści jeden złotych'],
    [101, 10100, 'sto jeden złotych'],
    [102, 10200, 'sto dwa złote'],
    [111, 11100, 'sto jedenaście złotych'],
    [112, 11200, 'sto dwanaście złotych'],
    [1001, 100100, 'jeden tysiąc jeden złotych'],
    [1002, 100200, 'jeden tysiąc dwa złote'],
  ])('%i zł (%i groszy) → "%s"', (_zl, groszy, oczekiwana) => {
    expect(kwotaSlownie(groszy)).toBe(oczekiwana);
  });

  it('112 złotych → "sto dwanaście złotych" (setki nie psują reguły 11-14)', () => {
    expect(kwotaSlownie(11200)).toBe('sto dwanaście złotych');
  });

  it('102 złote → "sto dwa złote" (2 na końcu poza zakresem 11-14 daje „złote")', () => {
    expect(kwotaSlownie(10200)).toBe('sto dwa złote');
  });

  it('21 → „dwadzieścia jeden złotych" — kończy się na 1, ale TO NIE JEST liczba 1, więc forma pojedyncza nie przysługuje', () => {
    expect(kwotaSlownie(2100)).toBe('dwadzieścia jeden złotych');
  });
});

// Ta sama reguła dotyczy rzeczowników odmienianych przy grupach tysięcy i milionów —
// „tysiąc/tysiące/tysięcy", „milion/miliony/milionów". Liczba grupy równa DOKŁADNIE 1 daje
// formę pojedynczą, każda inna liczba kończąca się na 1 (21, 101…) daje formę dopełniaczową.
describe('kwotaSlownie — ta sama pułapka odmiany w grupach tysięcy i milionów', () => {
  it('21 000 zł → "dwadzieścia jeden tysięcy złotych" (grupa 21, nie grupa 1 — dopełniacz)', () => {
    expect(kwotaSlownie(2100000)).toBe('dwadzieścia jeden tysięcy złotych');
  });

  it('101 000 000 zł → "sto jeden milionów złotych" (grupa 101, nie grupa 1 — dopełniacz)', () => {
    expect(kwotaSlownie(10100000000)).toBe('sto jeden milionów złotych');
  });
});

describe('kwotaSlownie — liczebniki 11-19', () => {
  it.each([
    [1100, 'jedenaście złotych'],
    [1200, 'dwanaście złotych'],
    [1300, 'trzynaście złotych'],
    [1400, 'czternaście złotych'],
    [1500, 'piętnaście złotych'],
    [1600, 'szesnaście złotych'],
    [1700, 'siedemnaście złotych'],
    [1800, 'osiemnaście złotych'],
    [1900, 'dziewiętnaście złotych'],
  ])('%i groszy → "%s"', (groszy, oczekiwana) => {
    expect(kwotaSlownie(groszy)).toBe(oczekiwana);
  });
});

describe('kwotaSlownie — dziesiątki', () => {
  it.each([
    [2000, 'dwadzieścia złotych'],
    [3000, 'trzydzieści złotych'],
    [4000, 'czterdzieści złotych'],
    [5000, 'pięćdziesiąt złotych'],
    [6000, 'sześćdziesiąt złotych'],
    [7000, 'siedemdziesiąt złotych'],
    [8000, 'osiemdziesiąt złotych'],
    [9000, 'dziewięćdziesiąt złotych'],
  ])('%i groszy → "%s"', (groszy, oczekiwana) => {
    expect(kwotaSlownie(groszy)).toBe(oczekiwana);
  });
});

describe('kwotaSlownie — setki', () => {
  it.each([
    [10000, 'sto złotych'],
    [20000, 'dwieście złotych'],
    [30000, 'trzysta złotych'],
    [40000, 'czterysta złotych'],
    [50000, 'pięćset złotych'],
    [60000, 'sześćset złotych'],
    [70000, 'siedemset złotych'],
    [80000, 'osiemset złotych'],
    [90000, 'dziewięćset złotych'],
  ])('%i groszy → "%s"', (groszy, oczekiwana) => {
    expect(kwotaSlownie(groszy)).toBe(oczekiwana);
  });

  it('999 złotych — złożenie setek, dziesiątek i jedności', () => {
    expect(kwotaSlownie(99900)).toBe('dziewięćset dziewięćdziesiąt dziewięć złotych');
  });
});

describe('kwotaSlownie — tysiące', () => {
  it('1 000 → "jeden tysiąc złotych" (1 przy "tysiąc" to "jeden", nie "jedna")', () => {
    expect(kwotaSlownie(100000)).toBe('jeden tysiąc złotych');
  });

  it('2 000 → "dwa tysiące złotych" (2-4 → "tysiące")', () => {
    expect(kwotaSlownie(200000)).toBe('dwa tysiące złotych');
  });

  it('5 000 → "pięć tysięcy złotych" (5+ → "tysięcy")', () => {
    expect(kwotaSlownie(500000)).toBe('pięć tysięcy złotych');
  });

  it('12 000 → "dwanaście tysięcy złotych" (11-14 → "tysięcy", nie "tysiące")', () => {
    expect(kwotaSlownie(1200000)).toBe('dwanaście tysięcy złotych');
  });

  it('22 000 → "dwadzieścia dwa tysiące złotych"', () => {
    expect(kwotaSlownie(2200000)).toBe('dwadzieścia dwa tysiące złotych');
  });

  it('123 456,78 zł — pełne złożenie tysięcy, setek i groszy', () => {
    expect(kwotaSlownie(12345678)).toBe(
      'sto dwadzieścia trzy tysiące czterysta pięćdziesiąt sześć złotych 78/100',
    );
  });

  it('1 001 zł → "jeden tysiąc jeden złotych" (1001 kończy się na 1, ale to nie liczba 1 — dopełniacz)', () => {
    expect(kwotaSlownie(100100)).toBe('jeden tysiąc jeden złotych');
  });
});

describe('kwotaSlownie — miliony', () => {
  it('1 000 000 → "jeden milion złotych"', () => {
    expect(kwotaSlownie(100000000)).toBe('jeden milion złotych');
  });

  it('2 000 000 → "dwa miliony złotych" (2-4 → "miliony")', () => {
    expect(kwotaSlownie(200000000)).toBe('dwa miliony złotych');
  });

  it('5 000 000 → "pięć milionów złotych" (5+ → "milionów")', () => {
    expect(kwotaSlownie(500000000)).toBe('pięć milionów złotych');
  });

  it('12 000 000 → "dwanaście milionów złotych" (11-14 → "milionów")', () => {
    expect(kwotaSlownie(1200000000)).toBe('dwanaście milionów złotych');
  });

  it('1 234 567,89 zł — miliony, tysiące, setki i grosze razem', () => {
    expect(kwotaSlownie(123456789)).toBe(
      'jeden milion dwieście trzydzieści cztery tysiące pięćset sześćdziesiąt siedem złotych 89/100',
    );
  });
});
