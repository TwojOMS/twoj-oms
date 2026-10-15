import { describe, it, expect } from 'vitest';
import { naWiersz, czyPLN } from '../../src/domena/koszt-metadane.js';
import { grosze } from '../../src/domena/kwoty.js';

const przyklad = {
  ksefNumber: '1000001193-20260605-0100AB-CD',
  invoiceNumber: 'FV/2026/06/12',
  issueDate: '2026-06-05',
  permanentStorageDate: '2026-06-05T14:03:11.000Z',
  seller: { nip: '5252674798', name: 'Allegro sp. z o.o.' },
  buyer: { identifier: { type: 'Nip', value: '1000001193' } },
  netAmount: 1067.0, vatAmount: 245.41, grossAmount: 1312.41,
  currency: 'PLN', invoiceType: 'Vat', hasAttachment: false,
};

describe('metadane KSeF → wiersz panelu', () => {
  it('przepisuje komplet pol', () => {
    expect(naWiersz(przyklad)).toEqual({
      ksefNumber: '1000001193-20260605-0100AB-CD',
      numerDokumentu: 'FV/2026/06/12',
      sprzedawcaNip: '5252674798',
      sprzedawcaNazwa: 'Allegro sp. z o.o.',
      dataWystawienia: '2026-06-05',
      dataTrwalegoZapisu: '2026-06-05T14:03:11.000Z',
      netto: '1067.00', vat: '245.41', brutto: '1312.41',
      waluta: 'PLN', rodzaj: 'Vat', maZalacznik: 0,
    });
  });

  // ⚠️ KWOTY WYCHODZĄ STĄD JAKO NAPISY „z dwoma miejscami" — i to jest decyzja, a nie
  // przypadek. Kolumny `netto/vat/brutto` są TEXT-em (niezmiennik 4.5: arytmetyka pieniędzy
  // idzie przez `grosze()`, nigdy na floatach), a KSeF oddaje je jako liczby JSON-a.
  // Konwersja żyje TUTAJ, bo to jedyne miejsce styku kształtu KSeF z kształtem panelu.
  //
  // Dlaczego `toFixed(2)`, a nie `String(v)`:
  //   • `String(1067.0)` daje `'1067'` — przez `grosze()` przechodzi poprawnie, ale w bazie
  //     i na ekranie leżałaby kwota w innym zapisie niż wszystkie pozostałe („1067" obok
  //     „245.41"), a porównanie dwóch napisów tej samej kwoty przestawałoby cokolwiek znaczyć.
  //   • `toString()` liczby, która przeszła przez JAKĄKOLWIEK arytmetykę zmiennoprzecinkową,
  //     potrafi oddać `'0.30000000000000004'` — czyli napis, który już NIE jest kwotą.
  //     `toFixed(2)` ucina to u źródła: wartości z KSeF mają najwyżej dwa miejsca po przecinku,
  //     więc zaokrąglenie do dwóch miejsc jest tu wierne, a nie „prawie wierne".
  // Ujemna kwota (korekta) i zero mają przejść tą samą drogą — bez nich pułapka
  // „pusta kwota rzuca w `grosze()`" (zero to nie brak) wyszłaby dopiero na produkcji.
  it.each([
    [1067, '1067.00', 106700],
    [245.41, '245.41', 24541],
    [1312.41, '1312.41', 131241],
    [0, '0.00', 0],
    [-36.9, '-36.90', -3690],
  ])('kwota %p zapisuje sie jako %p i wraca przez grosze() jako %p', (wejscie, napis, gr) => {
    const w = naWiersz({ ...przyklad, netAmount: wejscie });
    expect(w.netto).toBe(napis);
    expect(typeof w.netto).toBe('string');
    expect(grosze(w.netto, 'netto')).toBe(gr);
  });

  // ⚠️⚠️ BRAK KWOTY MA BYĆ GŁOŚNY — i to jest najdroższa usterka tej warstwy (recenzja, K1).
  //
  // `Number(null)` i `Number('')` dają `0`, więc samo `Number(n).toFixed(2)` zamieniało brak
  // kwoty w napis `'0.00'`: faktura bez kwoty lądowała w bazie jako koszt ZEROWY, wyglądała
  // poprawnie, wchodziła do sumy miesiąca — a przez `INSERT OR IGNORE` NIGDY BY SIĘ SAMA NIE
  // POPRAWIŁA, bo przy każdym kolejnym przebiegu czuwacza wiersz z tym numerem KSeF już jest.
  // Przed zmianą kwot na TEXT chronił przed tym `grosze(null)` („Brak kwoty"); ta osłona
  // została wyłączona u źródła i musi wrócić TUTAJ, w jedynym miejscu styku z KSeF.
  it.each([
    ['null', null],
    ['pusty napis', ''],
    ['same spacje', '   '],
    ['NaN', NaN],
    ['nie-liczba', 'brak danych'],
  ])('%s w kwocie z KSeF RZUCA, zamiast wpisac ciche zero', (_opis, wejscie) => {
    expect(() => naWiersz({ ...przyklad, netAmount: wejscie })).toThrow(/netto/);
  });

  // Brak POLA to inna droga niż `null` (`Number(undefined)` daje NaN, nie zero) i dlatego ma
  // własny przypadek: bez niego poprawka wyglądałaby na kompletną, obsługując trzy z czterech.
  it('BRAK POLA kwoty tez rzuca — i mowi, KTOREJ kwoty brakuje', () => {
    const { grossAmount, ...bezBrutto } = przyklad;
    expect(grossAmount).toBe(1312.41);
    expect(() => naWiersz(bezBrutto)).toThrow(/brutto/);
  });

  // ...a ZERO to nie brak. Faktura na 0,00 zł jest dokumentem poprawnym i ma przejść.
  it('zero zostaje poprawna kwota — „zero to nie brak"', () => {
    expect(naWiersz({ ...przyklad, netAmount: 0, vatAmount: 0, grossAmount: 0 }))
      .toMatchObject({ netto: '0.00', vat: '0.00', brutto: '0.00' });
  });

  // NIP wchodzi do bazy ZNORMALIZOWANY (recenzja, D3). Kategoria dobiera się po NIP-ie, więc
  // '525-267-47-98' z jednego dokumentu i '5252674798' z drugiego to dziś DWA różne klucze —
  // nietrafiony odczyt kategorii wygląda wtedy na „brak kategorii", a nie na rozjazd zapisu.
  it('NIP sprzedawcy normalizuje sie u zrodla', () => {
    expect(naWiersz({ ...przyklad, seller: { nip: '525-267-47-98' } }).sprzedawcaNip).toBe('5252674798');
    expect(naWiersz({ ...przyklad, seller: { nip: 'PL 5252674798' } }).sprzedawcaNip).toBe('5252674798');
    // ...a sprzedawca bez NIP-u zostaje NULL-em, nie pustym napisem: pusty napis byłby
    // KLUCZEM w `kategorie_kosztow` i skleiłby ze sobą wszystkich takich sprzedawców.
    expect(naWiersz({ ...przyklad, seller: { name: 'Bez NIP-u' } }).sprzedawcaNip).toBeNull();
  });

  it('sprzedawca bez nazwy nie wywraca mapowania — NIP wystarcza do kategorii', () => {
    const w = naWiersz({ ...przyklad, seller: { nip: '5252674798' } });
    expect(w.sprzedawcaNazwa).toBeNull();
    expect(w.sprzedawcaNip).toBe('5252674798');
  });

  it('rozpoznaje walute obca', () => {
    expect(czyPLN(naWiersz(przyklad))).toBe(true);
    expect(czyPLN(naWiersz({ ...przyklad, currency: 'EUR' }))).toBe(false);
  });
});

// ⚠️⚠️ TEST, DLA KTÓREGO POWSTAŁ CAŁY TEN MODUŁ. Sens zakładki kosztów stoi na jednym
// zdaniu: suma miesiąca ma wyjść CO DO GROSZA (maj 2026 = 2 269,55 zł, czerwiec = 2 881,04 zł).
// Jeśli arytmetyka potrafi się rozjechać sama z siebie, to przy pierwszej niezgodności nikt
// nie odróżni błędu integracji z KSeF od błędu dodawania — a to jest dokładnie ta pomyłka,
// która kosztuje dzień szukania w złym miejscu.
//
// Czternaście kwot jednego miesiąca, sumujących się dokładnie do 2 269,55 zł. RÓŻNICA JEST
// WYŁĄCZNIE W KOLEJNOŚCI — te same faktury, raz posortowane tak, jak przyszły, raz tak, jak
// pokazuje je zakładka (`ORDER BY data_wystawienia, numer_dokumentu`).
const KWOTY_MAJA = [1067, 245.41, 36.9, 12.3, 199.99, 45.67, 88.88, 7.77, 123.45, 64.2, 310.15, 15.99, 5.55, 46.29];
const INNA_KOLEJNOSC = [45.67, 15.99, 5.55, 199.99, 310.15, 88.88, 1067, 46.29, 36.9, 123.45, 7.77, 12.3, 245.41, 64.2];

const sumaGroszy = (kwoty) => kwoty
  .map((k) => naWiersz({ ...przyklad, grossAmount: k }))
  .reduce((acc, w) => acc + grosze(w.brutto, 'brutto'), 0);

const sumaFloatow = (kwoty) => kwoty.reduce((acc, k) => acc + k, 0);

describe('suma miesiaca — grosze kontra floaty', () => {
  it('suma kilkunastu kwot przez grosze() jest DOKLADNA i nie zalezy od kolejnosci', () => {
    expect(sumaGroszy(KWOTY_MAJA)).toBe(226955);
    expect(sumaGroszy(INNA_KOLEJNOSC)).toBe(226955);
    expect(sumaGroszy(KWOTY_MAJA)).toBe(sumaGroszy(INNA_KOLEJNOSC));
  });

  // ⚠️ TEST PONIŻEJ NIE JEST STRAŻNIKIEM NASZEGO KODU I NIE MA UDAWAĆ, ŻE JEST (recenzja, D2).
  // Nie dotyka `naWiersz` ani `grosze()` — mierzy arytmetykę silnika JS, która nie zmieni się
  // od żadnej naszej edycji, więc nie ma mutacji w `src/`, która by go zapaliła. Zostaje
  // WYŁĄCZNIE jako dokumentacja tego, przed czym broni decyzja o TEXT-cie i groszach; asercja
  // o NASZEJ ścieżce stoi obok, w tym samym `it`, żeby nikt nie wziął tego za ochronę.
  //
  // Tak wygląda ta sama seria dodana na liczbach zmiennoprzecinkowych — DWA różne wyniki,
  // zależnie od kolejności sumowania:
  //   [1067, 245.41, ...]  → 2269.55
  //   [45.67, 15.99, ...]  → 2269.5499999999997
  // Uczciwie: po `Math.round(suma * 100)` obie te liczby wracają jeszcze do 226955 — szukałem
  // serii kilkunastu realnych kwot faktur, w której samo dodawanie przesuwa GROSZ, i nie
  // znalazłem (3 mln losowań). Nie jest to jednak argument za floatami, tylko opis, jak ta
  // awaria wygląda ZANIM urośnie: porównanie `suma === 2269.55` jest tu prawdą albo fałszem
  // ZALEŻNIE OD SORTOWANIA LISTY, a każde kolejne działanie (VAT, podział na kategorie,
  // przeliczenie netto↔brutto) dokłada do tego błędu zamiast go zdejmować. Na liczbach
  // całkowitych ta klasa pytań w ogóle nie istnieje.
  it('DOKUMENTACJA (nie straznik): floaty zaleza od kolejnosci, NASZA sciezka nie', () => {
    // Sam silnik JS — żadnego kodu z `src/`:
    expect(sumaFloatow(KWOTY_MAJA)).toBe(2269.55);
    expect(sumaFloatow(INNA_KOLEJNOSC)).not.toBe(2269.55);
    expect(sumaFloatow(INNA_KOLEJNOSC)).toBe(2269.5499999999997);
    expect(sumaFloatow(KWOTY_MAJA)).not.toBe(sumaFloatow(INNA_KOLEJNOSC));
    // ...i asercja o NASZEJ ścieżce tuż obok, dla kontrastu z floatami powyżej — to ona
    // pilnuje, żeby `naWiersz` nie zaczął oddawać liczb zamiast napisów.
    //
    // ⚠️ CZEGO TA ASERCJA NIE PILNUJE: usunięcie strażnika braku kwoty (`kwota()` w
    // koszt-metadane.js, testowanego wyżej w `it.each`) zostawiłoby ją zieloną — wszystkie
    // wejścia w tym teście są poprawnymi liczbami, więc nie ma tu żadnej mutacji tego strażnika,
    // która by ją zapaliła. Sumę przez `sumaGroszy` niezależną od kolejności sprawdza już test
    // wyżej („suma kilkunastu kwot przez grosze() jest DOKŁADNA…") — powtarzanie jej tutaj było
    // pozorem drugiego dowodu.
    expect(naWiersz({ ...przyklad, grossAmount: 2269.55 }).brutto).toBe('2269.55');
  });
});
