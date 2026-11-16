import { wartoscPozycjiGrosze } from './suma-pozycji.js';

// Obsługa doklejana do zamówienia stałego klienta. Kurierska zostaje dla historii.
//
// ⚠️ TO JEST ZWYKLA POZYCJA RECZNA, nie nowy byt. Dzieki temu widac ja na karcie,
// jedzie na fakture bez ani jednej linii kodu w moduly/faktury/services/faktura.js, poller jej nie
// kasuje (rusza tylko `zrodlo = 'sklep'`), a POPRAWIENIE jej przez operatora to
// zwykla edycja wiersza — czyli „automat z furtka": sprzedawca moze go poprawic.
export const NAZWA_OBSLUGI = 'Obsługa zamówienia';
export const NAZWA_KURIERA = 'Usługa kurierska';

/**
 * Wartosc TOWARU zamowienia w groszach — czyli to, od czego liczy sie prog darmowej dostawy.
 *
 * ⚠️ WLASNE OPLATY WYPADAJA Z SUMY i to jest cala tresc tej funkcji. Opłata siedzi w tabeli
 * `pozycje` jak kazdy inny wiersz, wiec zwykla suma liczylaby ja razem z towarem — a wtedy
 * zamowienie tuz pod progiem przeskakiwaloby nad prog samo z siebie przy kolejnym przeliczeniu
 * i wynik zalezalby od tego, ile razy ktos ta trase wywolal.
 *
 * ⚠️ NIE `sumaPozycjiZWysylkaGrosze`: tamta dolicza koszt dostawy, a prog ma sie liczyc od
 * samego towaru. Towar za 490 zl z dostawa za 23 zl to zamowienie PONIZEJ progu.
 */
export function wartoscTowaruGrosze(pozycje) {
  return (pozycje ?? [])
    .filter((p) => p?.nazwa !== NAZWA_OBSLUGI && p?.nazwa !== NAZWA_KURIERA)
    .reduce((suma, p) => suma + wartoscPozycjiGrosze(p), 0);
}

/** Obsługa własnej etykiety; odbiór osobisty ma pierwszeństwo. */
export function oplataDlaZamowienia({ etykietaKlienta, bezWysylki, klient }) {
  if (!klient) return null;
  if (bezWysylki) return null;
  if (etykietaKlienta && klient.obslugaGr !== null) {
    return { nazwa: NAZWA_OBSLUGI, kwotaGr: klient.obslugaGr };
  }
  return null;
}

/** Reguły 1–3 zerują koszt formularza; wyłączony próg nigdy nie zwalnia z dostawy. */
export function darmowaDostawa({ bezWysylki, etykietaKlienta, wartoscTowaruGr, klient }) {
  if (!klient) return false;
  if (bezWysylki) return true;
  if (etykietaKlienta) return true;
  return klient.progGr !== null && wartoscTowaruGr >= klient.progGr;
}
