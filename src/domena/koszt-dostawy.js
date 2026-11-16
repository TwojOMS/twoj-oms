import { grosze, zl } from './suma-pozycji.js';
import { bladOperatora } from './bledy.js';

// Koszt dostawy WPISANY RĘCZNIE na ekranie „Nowe zamówienie”. Zamówienie ręczne nie ma
// sklepu, który narzuciłby kwotę wysyłki — operator wpisuje ją wprost przy zakładaniu, bo
// przy zamówieniu telefonicznym wysyłka prawie zawsze kosztuje.
//
// ⚠️ PUSTE POLE ZNACZY ZERO, A NIE BLAD. Formularz nie wymusza wypelnienia tego pola (np.
// sprzedaz na miejscu z odbiorem osobistym nie ma kosztu dostawy w ogole) — wiec brak wartosci
// to prawidlowy, najczestszy przypadek, a nie odmowa.
//
// Przecinek dziesietny przyjmujemy z tego samego powodu, co przy wadze paczki
// (domena/paczka.js) i przy kwocie pobrania (domena/wysylka.js): to polska klawiatura,
// nie blad wpisu. Wartosc nieliczbowa albo ujemna to ZAWSZE czytelna odmowa — ciche
// podstawienie zera zgubiloby literowke operatora, a ujemny koszt pomniejszylby sume
// pozycji ponizej tego, co naprawde nalezy sie od klienta.
export function parsujKosztDostawy(surowa) {
  const znormalizowana = String(surowa ?? '').trim().replace(',', '.');
  if (!znormalizowana) return '0.00';

  const liczba = Number(znormalizowana);
  if (!Number.isFinite(liczba)) {
    throw bladOperatora(
      `Nie umiem odczytać kosztu dostawy: „${surowa}” (użyj kropki albo przecinka jako separatora dziesiętnego).`,
    );
  }
  if (liczba < 0) {
    throw bladOperatora('Koszt dostawy nie może być ujemny.');
  }
  // grosze()/zl() TA SAMA para funkcji, ktora liczy sume pozycji i bariere arytmetyczna
  // (domena/suma-pozycji.js) — zaokraglenie do grosza musi byc identyczne wszedzie, inaczej
  // koszt dostawy zapisany tutaj rozjechalby sie z tym, co widzi bariera o grosz.
  return zl(grosze(znormalizowana, 'koszt dostawy'));
}
