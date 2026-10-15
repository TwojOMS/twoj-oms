import { bladOperatora } from './bledy.js';

// Podsumowanie VAT na PROFORMĘ — jeden wiersz na stawkę plus wiersz sumy.
//
// ⚠️ ŚWIADOME ODSTĘPSTWO OD ZASADY REPO. Przewodnik OMS (4.5) mówi wprost: „netto bierzemy
// wprost z WooCommerce, nigdy przez dzielenie brutta przez 1,23". To NIE jest przeoczenie
// ani miejsce do „posprzątania" — powód tamtego zakazu po prostu tu nie zachodzi.
//
// Tamten zakaz chronił przed WYMYŚLANIEM DANYCH, które się już ma: pozycja ze sklepu i koszt
// dostawy mają w Woo WŁASNĄ kolumnę netto, więc liczenie netta dzieleniem brutta było
// zastępowaniem wartości źródłowej przybliżeniem — a dzielenie i mnożenie z powrotem
// produkowało rozjazd o grosze, o który panel rozbijał się na barierze arytmetycznej faktury.
//
// Tutaj kierunek jest ODWROTNY i innej drogi NIE MA. Proforma powstaje w całości w panelu
// (patrz plan 2026-08-04-oms-faktura-proforma), a panel ma dla tego dokumentu WYŁĄCZNIE
// brutto — bo brutto jest tym, co wpisał operator i co klient ma przelać. Netto nie istnieje
// tu nigdzie indziej, więc nie ma czego zgubić ani z czym się rozjechać. Ta sama granica, co
// w domain/vat.js: odstępstwo obowiązuje w TYM JEDNYM module i nie wolno go rozciągać na
// pozycje ze sklepu ani na fakturę VAT — tam podatek liczy dalej inFakt.
//
// Kwoty w groszach, na liczbach całkowitych. Zero floatów poza jednym dzieleniem niżej.

/**
 * VAT z brutta — ta arytmetyka i żadna inna.
 *
 *   nettoGr = round(bruttoGr * 100 / (100 + stawka))
 *   vatGr   = bruttoGr - nettoGr          ← ODEJMOWANIE, nigdy drugie dzielenie
 *
 * ⚠️ POWÓD, DLA KTÓREGO VAT LICZYMY ODEJMOWANIEM — z uczciwym przypisem, ile ten powód waży.
 * Kuszące `round(brutto * stawka / (100 + stawka))` daje DRUGIE, NIEZALEŻNE zaokrąglenie, a dwa
 * niezależne zaokrąglenia potrafią minąć się o grosz i wtedy kolumny na dokumencie NIE SUMUJĄ
 * SIĘ do brutta. Klient ogląda na proformie trzy kolumny obok siebie i musi móc je dodać
 * w pamięci — odejmowanie czyni niezgodność NIEMOŻLIWĄ, a nie „rzadką".
 *
 * PRZYPIS, żeby następna osoba nie szukała po omacku: przy stawkach 0/5/8/23% obie formuły
 * dają DOKŁADNIE te same liczby (sprawdzone mutacją na całym zakresie 1–200 000 gr,
 * 2026-08-04). Przy tych mianownikach iloraz nigdy nie trafia w równą połowę, więc nie ma
 * gdzie się rozjechać. Rozjazd pojawia się dopiero przy stawce, gdzie remis jest możliwy
 * (20%, 3 gr: netto 3 + VAT 1 = 4 zamiast 3), bo `Math.round` zaokrągla wtedy W GÓRĘ po obu
 * stronach naraz. Stawka jest tu DANĄ, nie stałą, więc reguła obowiązuje dla każdej — i tak
 * właśnie jest napisany test niezmiennika. To NIE jest powód, żeby wrócić do dzielenia
 * „skoro przy 23% wychodzi to samo": równoważność jest przypadkiem własności mianownika 123,
 * a nie własnością algorytmu.
 *
 * Jedno dzielenie zmiennoprzecinkowe jest tu bezpieczne: `100 * bruttoGr / (100 + stawka)`
 * nigdy nie trafia dokładnie w połowę (dla stawki 23 wymagałoby `200*brutto ≡ 123 (mod 246)`,
 * czyli parzystej lewej strony równej nieparzystej prawej), więc błąd rzędu 1e-10 nie ma jak
 * przewrócić decyzji o zaokrągleniu — najbliższy punkt graniczny leży o ~1/246 dalej.
 */
function wierszStawki(stawka, bruttoGr) {
  const nettoGr = Math.round((bruttoGr * 100) / (100 + stawka));
  return { stawka, suma: false, nettoGr, vatGr: bruttoGr - nettoGr, bruttoGr };
}

// Kwota MUSI być całkowitą liczbą groszy. Uszkodzona kwota ma zatrzymać dokument, a nie
// wydrukować się jako zero albo jako „NaN zł" — proforma mówi klientowi, ile ma przelać,
// więc cicha zła liczba jest tu gorsza niż odmowa wystawienia.
function groszeZPozycji(s, i) {
  const gr = s?.gross_price;
  if (!Number.isInteger(gr)) {
    throw bladOperatora(
      `Pozycja ${i + 1} nie ma kwoty brutto w całych groszach („${gr}") — `
      + 'proformy nie da się wystawić, dopóki kwota pozycji nie jest poprawna.',
    );
  }
  return gr;
}

// Stawka przychodzi z `services` jako `tax_symbol` — dziś zawsze napis „23" (STAWKA_VAT),
// ale liczbę też przyjmujemy, bo synonim nie jest powodem, żeby odmówić dokumentu.
//
// „zw", „np" i inne symbole NIE są tu obsługiwane celowo: panel takich pozycji nie wystawia,
// a zgadnięcie, że „zw" znaczy 0%, wydrukowałoby klientowi wymyśloną stawkę na dokumencie.
// Gdyby kiedyś były potrzebne, ma to być ŚWIADOMA zmiana z testem.
function stawkaZPozycji(s, i) {
  const surowa = typeof s?.tax_symbol === 'number' ? String(s.tax_symbol) : String(s?.tax_symbol ?? '').trim();
  if (!/^\d+$/.test(surowa)) {
    throw bladOperatora(
      `Pozycja ${i + 1} ma nierozpoznaną stawkę VAT („${s?.tax_symbol ?? ''}") — `
      + 'podsumowanie VAT na proformie przyjmuje wyłącznie stawkę liczbową (np. 23).',
    );
  }
  return Number(surowa);
}

/**
 * Tabela „Podsumowanie VAT" z proformy.
 *
 * Wejście: `services` z `domain/pozycje-faktury.js` — `{ gross_price, tax_symbol }`,
 * grosze i stawka. Pozostałe pola pozycji (nazwa, ilość) tego podsumowania nie dotyczą.
 *
 * Wyjście: TABELA GOTOWA DO WYDRUKU, w kolejności wierszy dokumentu — jeden wiersz na
 * stawkę, malejąco (23, 8, 5, 0 — tak jak na dokumentach księgowych), a na końcu wiersz
 * sumy. Wiersz sumy poznaje się po `suma: true` i ma `stawka: null` — generator PDF ma
 * wtedy wydrukować etykietę „Suma", a nie procent. Rozpoznawanie go po pozycji w tablicy
 * albo po napisie w polu `stawka` byłoby dwoma sposobami na jedną rzecz.
 *
 * ⚠️ Podatek liczy się od SUMY BRUTTO STAWKI, nie pozycja po pozycji z dodawaniem wyników.
 * Dwie pozycje po 50 gr dają per pozycja 41+41=82 netto, a poprawnie (i tak, jak liczy każdy
 * dokument księgowy) 81 netto i 19 VAT. Oba warianty sumują się do brutta, więc niezmiennik
 * kolumn tej pomyłki NIE złapie — łapie ją osobny test.
 *
 * Pusta lista daje pusty wynik i NIE rzuca: „nie ma czego podsumować" to nie jest błąd tego
 * modułu. Zamówienie bez pozycji odrzuca wcześniej `sprawdzSumeDokumentu`, i tam jest na to
 * właściwe miejsce — komunikat o pustym zamówieniu ma paść raz, nie w dwóch modułach.
 */
export function podsumowanieVat(services = []) {
  const bruttoWgStawki = new Map();
  services.forEach((s, i) => {
    const stawka = stawkaZPozycji(s, i);
    bruttoWgStawki.set(stawka, (bruttoWgStawki.get(stawka) ?? 0) + groszeZPozycji(s, i));
  });
  if (bruttoWgStawki.size === 0) return [];

  const wiersze = [...bruttoWgStawki.entries()]
    .sort(([a], [b]) => b - a)
    .map(([stawka, bruttoGr]) => wierszStawki(stawka, bruttoGr));

  // Suma jest sumą WIERSZY, nie drugim liczeniem podatku od sumy wszystkich pozycji.
  // Przy dwóch stawkach te dwie drogi dają różne liczby, a kolumna sumy na dokumencie ma
  // zgadzać się z tym, co klient widzi nad nią.
  const suma = wiersze.reduce(
    (a, w) => ({ ...a, nettoGr: a.nettoGr + w.nettoGr, vatGr: a.vatGr + w.vatGr, bruttoGr: a.bruttoGr + w.bruttoGr }),
    { stawka: null, suma: true, nettoGr: 0, vatGr: 0, bruttoGr: 0 },
  );
  return [...wiersze, suma];
}
