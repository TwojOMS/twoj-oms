// Klasyfikacja zamówienia dla listy (PRZ-051) — to, co panel boczny i filtry muszą wiedzieć
// o KAŻDYM zamówieniu, żeby policzyć zakładki i wybrać stronę bez czytania całej bazy.
//
// ⚠️ ŻADNEJ WŁASNEJ REGUŁY. Status liczy `wyliczStatus`, listę roboczą `doZrobienia`, termin
// `wiekZamowienia`, filtry `kluczeFiltrow`, frazę `polaPorownywalne` — te same funkcje, które
// liczą wiersz na ekranie. Ten plik tylko zapisuje ich odpowiedź w postaci, o którą da się
// zapytać SQL-em. Druga kopia reguły w WHERE rozjechałaby się z ekranem przy pierwszej zmianie.
//
// ⚠️ CZAS JAKO CHWILA PRZEJŚCIA, NIE JAKO WYNIK. „Do zrobienia" i „Po terminie" zmieniają się
// SAME z upływem czasu (faktura „w toku" po 5 minutach staje się sprawą, paczka bez ruchu po
// kilku dniach roboczych, zegar wysyłki po terminie) — bez żadnego zapisu w bazie. Zapisanie
// samego wyniku „teraz" znaczyłoby listę kłamiącą do następnej zmiany zamówienia. Zapisujemy
// więc PIERWSZĄ CHWILĘ, od której reguła mówi „tak"; zapytanie porównuje ją z bieżącą chwilą.
//
// To jest poprawne WYŁĄCZNIE dlatego, że obie reguły są monotoniczne w czasie: przy tych
// samych faktach raz „tak" znaczy „tak" już zawsze (progi „po N minutach/dniach", nigdy
// „przez N minut"). Pilnuje tego test własności (tests/prz051/klasyfikacja.test.js) na każdym
// rodzaju zamówienia z zestawu. Reguła, która kiedyś zacznie wygasać z czasem, rozbije ten
// test — i wtedy trzeba tu przechowywać przedziały, a nie jedną chwilę.
import { wyliczStatus, doZrobienia } from './status.js';
import { wiekZamowienia } from './wiek-zamowienia.js';
import { kluczeFiltrow } from './filtry-listy.js';
import { polaPorownywalne } from './szukanie.js';

// Jak daleko w przód szukamy chwili przejścia. Najdłuższy próg reguł to dni robocze (termin
// indywidualnego: 7, paczka bez ruchu) — 90 dni kalendarzowych mieści je z kilkukrotnym
// zapasem. Wiersz, który w horyzoncie nie zmienia zdania, jest liczony ponownie po jego końcu
// (`wazne_do`) — to bezpiecznik, nie mechanizm: zwykle wcześniej zmieni go zapis w bazie.
export const HORYZONT_KLASYFIKACJI_MS = 90 * 24 * 3600 * 1000;

/**
 * Pierwsza milisekunda z [od, do], w której monotoniczny predykat mówi „tak", albo `null`.
 * Bisekcja: ~33 wywołania na 90 dni, i tylko dla zamówień, które w horyzoncie zmieniają zdanie.
 */
export function pierwszaChwila(pred, od, doChwili) {
  if (pred(od)) return od;
  if (!pred(doChwili)) return null;
  let nie = od; let tak = doChwili;
  while (tak - nie > 1) {
    const srodek = nie + Math.floor((tak - nie) / 2);
    if (pred(srodek)) tak = srodek; else nie = srodek;
  }
  return tak;
}

/**
 * Wiersz indeksu listy dla zamówienia odczytanego tak samo jak wiersz listy
 * (`zamowieniaPoId`). `teraz` w milisekundach — chwila, od której liczymy przejścia.
 */
export function klasyfikacjaListy(z, teraz) {
  const doChwili = teraz + HORYZONT_KLASYFIKACJI_MS;
  return {
    status: wyliczStatus(z),
    robocze_od: pierwszaChwila((t) => doZrobienia(z, t), teraz, doChwili),
    po_terminie_od: pierwszaChwila((t) => wiekZamowienia(z, new Date(t))?.poTerminie === true, teraz, doChwili),
    wazne_do: doChwili,
    filtr: kluczeFiltrow(z),
    szukaj: polaPorownywalne(z),
  };
}
