import { bladOperatora } from './bledy.js';

// ⚠️ TEN MODUŁ NIE MA ŻADNEGO IMPORTU POZA `bledy.js` I TAK MA ZOSTAĆ. To jest liść drzewa
// zależności domeny i właśnie dlatego powstał (07.08.2026, przy edytowalnej wysyłce).
//
// `grosze` i `zl` mieszkały w `suma-pozycji.js` i czytali je stamtąd WSZYSCY — także
// `pozycje-reczne.js`. Kiedy `suma-pozycji.js` musiał zacząć pytać o EFEKTYWNĄ kwotę
// wysyłki (domain/wysylka-kwota.js), a tamten moduł o znormalizowaną postać pól
// (domain/pozycje-reczne.js), powstałby cykl:
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

// Kwoty inFaktu sa CALKOWITE, w groszach. Liczymy na liczbach calkowitych do samego konca:
// porownanie sumy pozycji z kwota zamowienia na floatach (61.50 * 2 === 123.00) potrafi
// chybic o 1e-13 i albo przepuscic blad, albo zablokowac poprawna fakture. TA SAMA funkcja
// steruje BARIERA ARYTMETYCZNA faktury (services/faktura.js) i ostrzezeniem pod tabela
// „Pozycje" na karcie zamowienia (domain/tabela-pozycji.js) — jedno miejsce, zeby oba
// widoki nigdy sie nie rozjechaly.
//
// Pusta/nieliczbowa kwota ma RZUCIC, a nie zamienic sie w NaN. NaN w JSON-ie staje sie
// `null`, wiec bez tej oslony do inFaktu poleciałaby pozycja bez ceny.
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

/**
 * Kwota po polsku: przecinek dziesiętny, spacja przed „zł" — do maili i komunikatów
 * operatora (napis z kropką, jak oddaje go `zl` wyżej, na napis, jaki czyta klient).
 *
 * ⚠️ PUSTA WARTOŚĆ ODDAJE „—", NIE „ zł" — i to jest strażnik, nie ozdobnik (przeniesione
 * tu z domain/potwierdzenie-zamowienia.js 22.08.2026, przy recenzji). Do tego dnia istniały
 * DWIE prywatne kopie tej samej funkcji: ta w potwierdzeniu miała strażnik pustki, a kopia
 * w domain/blok-platnosci.js — nie. Jedna funkcja w liściu drzewa zależności (obok `grosze`
 * i `zl` wyżej) jest jedynym sposobem, żeby nie dało się już napisać trzeciej kopii bez
 * tego strażnika.
 */
export function zlotowki(napis) {
  const tekst = String(napis ?? '').trim();
  if (tekst === '') return '—';
  return `${tekst.replace('.', ',')} zł`;
}
