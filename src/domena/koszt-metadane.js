import { bladOperatora } from './bledy.js';
import { znormalizujNip } from './gus.js';

// JEDYNE miejsce, w którym kształt odpowiedzi KSeF zamienia się w kształt panelu. Druga kopia
// tego mapowania rozjedzie się z pierwszą przy pierwszej zmianie schematu FA — a schemat FA
// zmienia się decyzją Ministerstwa, nie naszą.
//
// ⚠️⚠️ KWOTY WYCHODZĄ STĄD JAKO NAPISY, nie jako liczby — i tu jest jedyne miejsce, w którym
// wolno je zamienić. KSeF oddaje `netAmount`/`vatAmount`/`grossAmount` jako liczby JSON-a
// (1067.0, 245.41), a kolumny `netto/vat/brutto` są TEXT-em, bo pieniądze w tym repo liczy
// się na liczbach CAŁKOWITYCH przez `grosze()` — nigdy na floatach.
//
// `toFixed(2)`, a NIE `String(v)`:
//   • `String(1067.0)` daje '1067' — przez `grosze()` przejdzie poprawnie, ale w bazie
//     leżałaby kwota zapisana inaczej niż wszystkie pozostałe, a porównanie dwóch napisów
//     tej samej kwoty przestałoby cokolwiek znaczyć.
//   • `toString()` liczby po JAKIEJKOLWIEK arytmetyce zmiennoprzecinkowej potrafi oddać
//     '0.30000000000000004', czyli napis, który już nie jest kwotą. Wartości z KSeF przychodzą
//     wprost z parsera JSON i mają najwyżej dwa miejsca po przecinku, więc zaokrąglenie do
//     dwóch miejsc jest tu WIERNE, a nie „prawie wierne”.
// Zero i kwota ujemna (korekta) idą tą samą drogą: '0.00' i '-36.90'.
//
// ⚠️⚠️ BRAK KWOTY RZUCA — TUTAJ, U ŹRÓDŁA, A NIE DOPIERO PRZY ZAPISIE.
//
// `Number(null)` i `Number('')` dają ZERO, więc samo `Number(n).toFixed(2)` zamieniłoby brak
// kwoty w napis '0.00': faktura, której KSeF kwoty nie podał, leżałaby w bazie jako koszt
// zerowy, wyglądałaby poprawnie i wchodziłaby do sumy miesiąca. A ponieważ zapis idzie przez
// `INSERT OR IGNORE`, taki wiersz NIGDY BY SIĘ SAM NIE POPRAWIŁ — każdy następny przebieg
// czuwacza widzi, że dokument o tym numerze KSeF już jest, i przechodzi obok.
// Kwoty idą do bazy jako napisy, bez `grosze()` (który na brak odpowiada „Brak kwoty”),
// więc ta osłona musi stać tutaj.
//
// DLACZEGO RZUCENIE, A NIE `NOT NULL` W BAZIE. Odmowa bazy przy `INSERT OR IGNORE` jest
// CICHA — a nawet głośna mówiłaby wyłącznie „wiersza
// nie ma”, bez wskazania, której kwoty zabrakło. Poza tym `NOT NULL` w ogóle by tu nie
// zadziałał: do bazy szedłby napis '0.00', czyli wartość jak najbardziej NIE-NULL. Strażnik
// musi więc stać PRZED mapowaniem na wiersz, w jedynym miejscu styku kształtu KSeF
// z kształtem panelu.
//
// ZERO TO NIE BRAK: `0` przechodzi i daje '0.00'. Kwota ujemna (korekta) tak samo.
const kwota = (n, pole) => {
  const brak = n === null || n === undefined
    || (typeof n === 'string' && n.trim() === '');
  if (brak) {
    throw bladOperatora(
      `KSeF nie podał kwoty „${pole}" na tym dokumencie — panel nie zapisze faktury `
      + 'kosztowej bez kwoty, bo zero weszłoby do sumy miesiąca jako prawda.',
    );
  }
  // Tylko liczba albo napis: `true`, tablica czy obiekt przeszlyby przez `Number(...)`
  // z wynikiem, ktory wyglada jak kwota (`Number(true)` to 1), a kwota nie jest.
  const l = typeof n === 'number' || typeof n === 'string' ? Number(n) : NaN;
  if (!Number.isFinite(l)) {
    throw bladOperatora(`Kwota „${pole}" z KSeF nie jest liczbą: „${String(n)}".`);
  }
  return l.toFixed(2);
};

export function naWiersz(m) {
  return {
    ksefNumber: m.ksefNumber,
    numerDokumentu: m.invoiceNumber,
    // ⚠️ NIP ZNORMALIZOWANY, bo to po nim (i nigdy po nazwie) dobiera się kategoria kosztu.
    // KSeF potrafi oddać ten sam NIP jako '525-267-47-98' i '5252674798', a `kategorie_kosztow`
    // trzyma go w KLUCZU GŁÓWNYM — dwa zapisy to dwa wiersze dla jednego podatnika, i chybiony
    // odczyt wyglądający na „ten NIP nie ma jeszcze kategorii”. TA SAMA funkcja, co przy GUS-ie.
    // Pusty wynik to NULL, nie pusty napis: pusty napis byłby KLUCZEM i skleiłby ze sobą
    // wszystkich sprzedawców bez NIP-u.
    //
    // ⚠️ `znormalizujNip` (domena/gus.js) to zdjęcie przedrostka „PL” i goły
    // `replace(/\D+/g,'')` bez kontroli długości — sprzedawca zagraniczny z NIP-em
    // 'DE123456789' dostaje tu klucz '123456789', czyli same cyfry WYGLĄDAJĄCE jak polski NIP,
    // którym NIE SĄ. Ten klucz służy WYŁĄCZNIE grupowaniu kosztów po sprzedawcy
    // (kategorie_kosztow.nip) — nie jest walidowanym polskim NIP-em i nie wolno go tak czytać
    // na ekranie operatora (np. wklejać wprost do wyszukiwarki GUS/Białej Listy).
    sprzedawcaNip: znormalizujNip(m.seller?.nip) || null,
    sprzedawcaNazwa: m.seller?.name ?? null,
    dataWystawienia: m.issueDate,
    dataTrwalegoZapisu: m.permanentStorageDate,
    netto: kwota(m.netAmount, 'netto'),
    vat: kwota(m.vatAmount, 'vat'),
    brutto: kwota(m.grossAmount, 'brutto'),
    waluta: m.currency,
    rodzaj: m.invoiceType,
    maZalacznik: m.hasAttachment ? 1 : 0,
  };
}

// KSeF podaje `vatAmount` ZAWSZE w PLN, a netto/brutto w walucie dokumentu. Dokument w EUR
// nie ma wiec jednej wspolnej waluty i NIE WOLNO go dodac do sumy miesiaca. Kurs jest
// wartoscia, ktorej nie znamy — zmyslony kurs jest gorszy niz widoczna dziura.
export const czyPLN = (wiersz) => wiersz.waluta === 'PLN';
