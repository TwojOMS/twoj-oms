import { bladOperatora } from './bledy.js';

// ⚠️ TEN MODUŁ NIE MA ŻADNEGO IMPORTU POZA `bledy.js` I TAK MA ZOSTAĆ. To jest liść drzewa
// zależności domeny i właśnie dlatego powstał.
//
// `grosze` i `zl` mieszkały w `suma-pozycji.js` i czytali je stamtąd WSZYSCY — także
// `pozycje-reczne.js`. Kiedy `suma-pozycji.js` musiał zacząć pytać o EFEKTYWNĄ kwotę
// wysyłki (domena/wysylka-kwota.js), a tamten moduł o znormalizowaną postać pól
// (domena/pozycje-reczne.js), powstałby cykl:
//
//     suma-pozycji → wysylka-kwota → pozycje-reczne → suma-pozycji
//
// Cykl w ESM nie wybucha — po prostu jedna ze stron widzi przez chwilę `undefined` zamiast
// funkcji. Przy arytmetyce pieniędzy to jest najgorszy możliwy rodzaj awarii: cichy,
// zależny od kolejności ładowania modułów i niepowtarzalny w testach jednostkowych.
// Wyjęcie dwóch funkcji do liścia rozcina go u źródła.
//
// `suma-pozycji.js` re-eksportuje obie, więc kilkanaście plików czytających je stamtąd
// nie musiało się zmienić — i to jest świadomy kompromis, a nie przeoczenie: przeniesienie
// wszystkich importów naraz byłoby zmianą w kilkunastu plikach przy okazji zupełnie innej
// poprawki.

// Kwoty inFaktu są CAŁKOWITE, w groszach. Liczymy na liczbach całkowitych do samego końca:
// porównanie sumy pozycji z kwotą zamówienia na floatach (61.50 * 2 === 123.00) potrafi
// chybić o 1e-13 i albo przepuścić błąd, albo zablokować poprawną fakturę. TA SAMA funkcja
// steruje BARIERĄ ARYTMETYCZNĄ faktury (domena/pozycje-faktury.js) i ostrzeżeniem pod tabelą
// „Pozycje” na karcie zamówienia (domena/tabela-pozycji.js) — jedno miejsce, żeby oba
// widoki nigdy się nie rozjechały.
//
// Pusta/nieliczbowa kwota ma RZUCIĆ, a nie zamienić się w NaN. NaN w JSON-ie staje się
// `null`, więc bez tej osłony do inFaktu poleciałaby pozycja bez ceny.
export function grosze(kwota, opis) {
  if (kwota === null || kwota === undefined || String(kwota).trim() === '') {
    throw bladOperatora(`Brak kwoty: ${opis}. Faktury nie da się wystawić bez ceny.`);
  }
  const n = Number(kwota);
  if (!Number.isFinite(n)) throw bladOperatora(`Kwota nie jest liczbą: ${opis} = "${kwota}".`);
  return Math.round(n * 100);
}

/** Grosze z powrotem na złotówki, do wyświetlenia w komunikatach/na karcie. */
export const zl = (gr) => (gr / 100).toFixed(2);

/** Liczba do prezentacji; wartości formularzy i obliczeń pozostają liczbami. */
export const liczbaPolska = (wartosc, opcje = {}) => new Intl.NumberFormat('pl-PL', {
  maximumFractionDigits: 3, ...opcje,
}).format(Number(wartosc));

/** Cena na karcie magazynu: „12 345,67 zł”. `zlotowki` niżej zostaje dla maili (bez odstępu tysięcy). */
export const cenaPolska = (napis) => `${liczbaPolska(napis, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;

/**
 * Kwota po polsku: przecinek dziesiętny, spacja przed „zł" — do maili i komunikatów
 * operatora (napis z kropką, jak oddaje go `zl` wyżej, na napis, jaki czyta klient).
 *
 * ⚠️ PUSTA WARTOŚĆ ODDAJE „—", NIE „ zł" — i to jest strażnik, nie ozdobnik (przeniesione
 * tu z domena/potwierdzenie-zamowienia.js). Wcześniej istniały
 * DWIE prywatne kopie tej samej funkcji: ta w potwierdzeniu miała strażnik pustki, a kopia
 * w domena/blok-platnosci.js — nie. Jedna funkcja w liściu drzewa zależności (obok `grosze`
 * i `zl` wyżej) jest jedynym sposobem, żeby nie dało się już napisać trzeciej kopii bez
 * tego strażnika.
 */
export function zlotowki(napis) {
  const tekst = String(napis ?? '').trim();
  if (tekst === '') return '—';
  // Kwota z przecinkiem („12,50”) też przychodzi na wejściu i przechodzi bez zmian — odpada tylko nie-liczba.
  if (!Number.isFinite(Number(tekst.replace(',', '.')))) return '';
  return `${tekst.replace('.', ',')} zł`;
}
