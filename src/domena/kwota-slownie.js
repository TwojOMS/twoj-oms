// Kwota słownie po polsku — do podsumowania proformy („Słownie: sześćset pięćdziesiąt cztery
// złote"). Czysta funkcja na LICZBIE CAŁKOWITEJ groszy: żadnej arytmetyki na floatach, bo
// 654.00 * 100 w JS-ie potrafi dać 65399.99999999999, a to jest kwota na dokumencie dla klienta.

const JEDNOSCI = [
  '', 'jeden', 'dwa', 'trzy', 'cztery', 'pięć', 'sześć', 'siedem', 'osiem', 'dziewięć',
];

// 11-19 NIE dają się złożyć z „dziesięć" + jedność (nie ma „jedennaście") — to jest
// klasyczna pułapka polskich liczebników, więc leżą tu jako gotowa tablica, nie wzór.
const NASTOLATKI = [
  'dziesięć', 'jedenaście', 'dwanaście', 'trzynaście', 'czternaście', 'piętnaście',
  'szesnaście', 'siedemnaście', 'osiemnaście', 'dziewiętnaście',
];

const DZIESIATKI = [
  '', '', 'dwadzieścia', 'trzydzieści', 'czterdzieści', 'pięćdziesiąt',
  'sześćdziesiąt', 'siedemdziesiąt', 'osiemdziesiąt', 'dziewięćdziesiąt',
];

const SETKI = [
  '', 'sto', 'dwieście', 'trzysta', 'czterysta', 'pięćset',
  'sześćset', 'siedemset', 'osiemset', 'dziewięćset',
];

// Rzeczowniki odmieniane przez liczbę — para [forma dla 2-4, forma dla 5+ i 0] plus
// specjalna forma dla 1, użyta przez `mianownik()` niżej. „Złoty" ma nieregularną liczbę
// pojedynczą („złoty", nie „złota"), dlatego jest osobnym argumentem, nie wpisanym na sztywno.
const ZLOTY = ['złoty', 'złote', 'złotych'];
const TYSIAC = ['tysiąc', 'tysiące', 'tysięcy'];
const MILION = ['milion', 'miliony', 'milionów'];

/**
 * Wybór formy rzeczownika wg polskiej liczebnikowej odmiany.
 *
 * ⚠️ POPRAWIONE PO RECENZJI. Pierwsza wersja traktowała KAŻDĄ liczbę o jedności 1 (1, 21, 31,
 * 101, 1001…) jak formę pojedynczą („21 złoty"), co jest błędem — forma pojedyncza w polskim
 * przysługuje WYŁĄCZNIE liczbie równej dokładnie 1, nie „liczbie kończącej się na 1". Test do
 * tej wersji zaszywał tę samą (błędną) regułę, więc ją potwierdzał, zamiast łapać.
 *
 * Reguła poprawna:
 * - liczba RÓWNA DOKŁADNIE 1 → forma pojedyncza (`jedynkowa`), np. „jeden złoty";
 * - ostatnia cyfra 2-4 ORAZ dwie ostatnie cyfry NIE są 12/13/14 → forma[0] (złote) — dwie
 *   ostatnie cyfry sprawdzamy, żeby wykluczyć „12/13/14" i „112/113/114" (te są dopełniaczem,
 *   mimo że kończą się na 2-4 — to jest właśnie pułapka z zadania);
 * - wszystko pozostałe (0, 5-9, 11-21 z jednością 1, 11-14, …) → forma[1] (złotych).
 */
function odmiana(liczba, [dwaCztery, piecPlus], jedynkowa) {
  if (liczba === 1) return jedynkowa;
  const jednosc = liczba % 10;
  const ostatnieDwie = liczba % 100;
  const wyjatek1214 = ostatnieDwie >= 12 && ostatnieDwie <= 14;
  if (jednosc >= 2 && jednosc <= 4 && !wyjatek1214) return dwaCztery;
  return piecPlus;
}

// Liczby 1-999 na słowa. Zero jako argument tej funkcji nie występuje na wyjściu (obsłużone
// wyżej, w grupach po trzy cyfry) — stąd `slowaGrupy(0)` daje pusty napis, nie „zero".
function slowaGrupy(n) {
  const setka = Math.floor(n / 100);
  const reszta = n % 100;
  const slowa = [];
  if (setka > 0) slowa.push(SETKI[setka]);

  if (reszta >= 10 && reszta <= 19) {
    slowa.push(NASTOLATKI[reszta - 10]);
  } else {
    const dziesiatka = Math.floor(reszta / 10);
    const jednosc = reszta % 10;
    if (dziesiatka > 0) slowa.push(DZIESIATKI[dziesiatka]);
    if (jednosc > 0) slowa.push(JEDNOSCI[jednosc]);
  }
  return slowa.join(' ');
}

// Grupa tysięcy/milionów dostaje słowo grupy PLUS rzeczownik odmieniony — ale przy jedności
// dokładnie „1" (czyli grupa = 1) rzeczownik idzie w liczbie pojedynczej BEZ słowa „jeden"
// z `slowaGrupy` z osobna dla „tysiąc": mówimy „jeden tysiąc", nie samo „tysiąc" — inaczej niż
// przy złotych, gdzie „1" i tak zawsze poprzedza słowo („jeden złoty"). Innymi słowy: dla
// tysięcy/milionów zawsze wypisujemy liczbę słowami, rzeczownik dokładamy odmieniony.
function grupaZRzeczownikiem(n, rzeczownik) {
  const forma = odmiana(n, [rzeczownik[1], rzeczownik[2]], rzeczownik[0]);
  return `${slowaGrupy(n)} ${forma}`;
}

// Rozbicie liczby 0..999_999_999 na (miliony, tysiące, reszta) — góra trzycyfrowych grup,
// każda mieści się w `slowaGrupy`. Wyżej niż miliony panel nie potrzebuje: proforma nie
// wystawi faktury na miliard złotych, a sufit chroni przed cichym obcięciem grupy.
function rozbijNaGrupy(zlotych) {
  if (zlotych > 999_999_999) {
    throw new RangeError(
      `kwotaSlownie: ${zlotych} zł przekracza obsługiwany zakres (do 999 999 999 zł) — `
      + 'dokument na taką kwotę wymaga ręcznej weryfikacji, nie cichego przycięcia liczby.',
    );
  }
  const miliony = Math.floor(zlotych / 1_000_000);
  const tysiace = Math.floor((zlotych % 1_000_000) / 1000);
  const reszta = zlotych % 1000;
  return { miliony, tysiace, reszta };
}

/**
 * Kwota słownie po polsku, do podsumowania dokumentu („Słownie: …").
 *
 * Wejście: `groszy` — liczba CAŁKOWITA groszy (nigdy floata, nigdy `parseFloat` na kwocie
 * z dokumentu). `65400` groszy to 654,00 zł.
 *
 * Wyjście: część złotowa zawsze odmieniona poprawnie („złoty"/„złote"/„złotych"), część
 * groszowa jako ułamek `NN/100` DOPISANA tylko wtedy, gdy grosze są niezerowe — dokument
 * Apilo, będący tu wzorcem, przy pełnych złotych nie pisze „0/100" w ogóle.
 */
export function kwotaSlownie(groszy) {
  if (!Number.isInteger(groszy) || groszy < 0) {
    throw new RangeError(`kwotaSlownie: „${groszy}" nie jest nieujemną liczbą całkowitą groszy.`);
  }

  const zlotych = Math.floor(groszy / 100);
  const grosze = groszy % 100;

  const czesciZlotowe = [];
  const { miliony, tysiace, reszta } = rozbijNaGrupy(zlotych);
  if (miliony > 0) czesciZlotowe.push(grupaZRzeczownikiem(miliony, MILION));
  if (tysiace > 0) czesciZlotowe.push(grupaZRzeczownikiem(tysiace, TYSIAC));
  // Zero pełnych złotych przy niezerowych milionach/tysiącach ("1 000 000 zł") ma nie dopisywać
  // pustego napisu z `slowaGrupy(0)` — stąd `reszta > 0`. Ale zero złotych W OGÓLE (nic wcześniej
  // nie trafiło do `czesciZlotowe`) to inny przypadek: "0 zł" ma słowo "zero", którego
  // `slowaGrupy(0)` NIE zwraca (JEDNOSCI[0] to pusty napis, bo w środku liczby zero się pomija,
  // np. "sto pięć" a nie "sto zero pięć") — stąd osobna gałąź, nie to samo wywołanie.
  if (reszta > 0) czesciZlotowe.push(slowaGrupy(reszta));
  else if (czesciZlotowe.length === 0) czesciZlotowe.push('zero');

  const slowoZlotych = odmiana(zlotych, [ZLOTY[1], ZLOTY[2]], ZLOTY[0]);
  const czescGroszowa = grosze > 0 ? ` ${String(grosze).padStart(2, '0')}/100` : '';

  return `${czesciZlotowe.join(' ')} ${slowoZlotych}${czescGroszowa}`;
}
