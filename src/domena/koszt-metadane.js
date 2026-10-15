import { bladOperatora } from './bledy.js';
import { znormalizujNip } from './gus.js';

// JEDYNE miejsce, w ktorym ksztalt odpowiedzi KSeF zamienia sie w ksztalt panelu. Druga kopia
// tego mapowania rozjedzie sie z pierwsza przy pierwszej zmianie schematu FA — a schema FA
// zmienia sie decyzja Ministerstwa, nie nasza.
//
// ⚠️⚠️ KWOTY WYCHODZA STAD JAKO NAPISY, nie jako liczby — i tu jest jedyne miejsce, w ktorym
// wolno je zamienic. KSeF oddaje `netAmount`/`vatAmount`/`grossAmount` jako liczby JSON-a
// (1067.0, 245.41), a kolumny `netto/vat/brutto` sa TEXT-em, bo pieniadze w tym repo liczy
// sie na liczbach CALKOWITYCH przez `grosze()` (niezmiennik 4.5) — nigdy na floatach.
//
// `toFixed(2)`, a NIE `String(v)`:
//   • `String(1067.0)` daje '1067' — przez `grosze()` przejdzie poprawnie, ale w bazie
//     lezalaby kwota zapisana inaczej niz wszystkie pozostale, a porownanie dwoch napisow
//     tej samej kwoty przestaloby cokolwiek znaczyc.
//   • `toString()` liczby po JAKIEJKOLWIEK arytmetyce zmiennoprzecinkowej potrafi oddac
//     '0.30000000000000004', czyli napis, ktory juz nie jest kwota. Wartosci z KSeF przychodza
//     wprost z parsera JSON i maja najwyzej dwa miejsca po przecinku, wiec zaokraglenie do
//     dwoch miejsc jest tu WIERNE, a nie „prawie wierne".
// Zero i kwota ujemna (korekta) ida ta sama droga: '0.00' i '-36.90'.
//
// ⚠️⚠️ BRAK KWOTY RZUCA — TUTAJ, U ZRODLA, A NIE DOPIERO PRZY ZAPISIE (recenzja, K1).
//
// `Number(null)` i `Number('')` daja ZERO, wiec samo `Number(n).toFixed(2)` zamienialo brak
// kwoty w napis '0.00': faktura, ktorej KSeF kwoty nie podal, lezala w bazie jako koszt
// zerowy, wygladala poprawnie i wchodzila do sumy miesiaca. A poniewaz zapis idzie przez
// `INSERT OR IGNORE`, taki wiersz NIGDY BY SIE SAM NIE POPRAWIL — kazdy nastepny przebieg
// czuwacza widzi, ze dokument o tym numerze KSeF juz jest, i przechodzi obok.
// Przed zmiana kwot na TEXT chronilo przed tym `grosze(null)` („Brak kwoty"); ta oslona
// zostala wylaczona u zrodla i wraca w to samo miejsce, w tym samym ksztalcie.
//
// DLACZEGO RZUCENIE, A NIE `NOT NULL` W BAZIE. Odmowa bazy przy `INSERT OR IGNORE` jest
// CICHA (to jest usterka W1 obok) — i nawet po jej naprawie mowilaby wylacznie „wiersza
// nie ma", bez wskazania, ktorej kwoty zabraklo. Poza tym `NOT NULL` w ogole by tu nie
// zadzialal: do bazy szedl napis '0.00', czyli wartosc jak najbardziej NIE-NULL. Straznik
// musi wiec stac PRZED mapowaniem na wiersz, w jedynym miejscu styku ksztaltu KSeF
// z ksztaltem panelu.
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
    // ⚠️ NIP ZNORMALIZOWANY, bo to po nim (i nigdy po nazwie) dobiera sie kategoria kosztu.
    // KSeF potrafi oddac ten sam NIP jako '525-267-47-98' i '5252674798', a `kategorie_kosztow`
    // trzyma go w KLUCZU GLOWNYM — dwa zapisy to dwa wiersze dla jednego podatnika, i chybiony
    // odczyt wygladajacy na „ten NIP nie ma jeszcze kategorii". TA SAMA funkcja, co przy GUS-ie.
    // Pusty wynik to NULL, nie pusty napis: pusty napis bylby KLUCZEM i skleilby ze soba
    // wszystkich sprzedawcow bez NIP-u.
    //
    // ⚠️ U4 (druga runda recenzji): `znormalizujNip` (domain/gus.js) to goly
    // `replace(/\D+/g,'')` bez kontroli dlugosci — sprzedawca zagraniczny z NIP-em
    // 'DE123456789' dostaje tu klucz '123456789', czyli napis WYGLADAJACY jak polski NIP
    // (10 cyfr), ktorym NIE JEST. Ten klucz sluzy WYLACZNIE grupowaniu kosztow po sprzedawcy
    // (kategorie_kosztow.nip) — nie jest walidowanym polskim NIP-em i nie wolno go tak czytac
    // na ekranie operatora (np. wklejac wprost do wyszukiwarki GUS/Bialej Listy).
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
