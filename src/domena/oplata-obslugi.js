import { wartoscPozycjiGrosze } from './suma-pozycji.js';

// Oplata doklejana do zamowienia klienta rozliczanego zbiorczo.
//
// ⚠️ TO JEST ZWYKLA POZYCJA RECZNA, nie nowy byt. Dzieki temu widac ja na karcie,
// jedzie na fakture bez ani jednej linii kodu w services/faktura.js, poller jej nie
// kasuje (rusza tylko `zrodlo = 'sklep'`), a POPRAWIENIE jej przez operatora to
// zwykla edycja wiersza — czyli „automat z furtka", ktorego chcial wlasciciel.
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

/**
 * Opłata odpowiada na JEDNO pytanie: KTO NADAJE PACZKĘ. Odpowiedzi są trzy, nie dwie —
 * klient na swojej etykiecie (obsługa), my na swojej umowie (kurier), albo NIKT.
 *
 * @param {object} opcje
 * @param {boolean} opcje.etykietaKlienta czy paczke nadaje klient na SWOJEJ etykiecie
 * @param {boolean} opcje.bezWysylki czy zamowienie w ogole nie jedzie (odbior osobisty)
 * @param {number} opcje.wartoscTowaruGr wartosc TOWARU po rabacie, BEZ oplat
 * @param {object|null} opcje.klient klient zbiorczy z konfiguracji albo null
 * @returns {{nazwa: string, kwotaGr: number}|null}
 */
export function oplataDlaZamowienia({ etykietaKlienta, bezWysylki, wartoscTowaruGr, klient }) {
  if (!klient) return null;

  // ⚠️ BRAK WYSYLKI WYGRYWA ZE WSZYSTKIM — takze z etykieta klienta, dlatego stoi PRZED nia.
  // Oplata jest cena za NADANIE PACZKI: obsluga to cena za to, ze paczke przygotowalismy
  // pod cudza etykiete, kurierska — za to, ze kupilismy transport. Przy odbiorze osobistym
  // nie ma ani jednego, ani drugiego, wiec nie ma za co pobierac.
  //
  // To nie jest kosmetyka wydruku, tylko pieniadze w dwie strony: wiersz „Usługa kurierska"
  // przy odbiorze na miejscu to pozycja na fakturze za usluge, ktorej nie wykonalismy
  // (klient ma prawo ja zakwestionowac), a przy gotowce albo pobraniu to REALNA KWOTA,
  // ktora odbierajacy ma zainkasowac od klienta.
  if (bezWysylki) return null;

  // Etykieta klienta: placi za OBSLUGE, nie za transport — my transportu nie kupujemy,
  // wiec prog darmowej dostawy nie ma tu czego zwalniac.
  if (etykietaKlienta) {
    return { nazwa: NAZWA_OBSLUGI, kwotaGr: klient.oplataObslugiGr };
  }

  // ⚠️ Prog liczymy od wartosci TOWARU, nie od sumy zamowienia. Gdyby wchodzila w to
  // oplata kurierska, podnosilaby sume, od ktorej zalezy jej wlasne naliczenie —
  // zamowienie tuz pod progiem raz dostawaloby oplate, raz nie, zaleznie od kolejnosci
  // liczenia. Porownanie „>=", bo „powyzej 500 zl darmowa dostawa" w rozmowie handlowej
  // znaczy „od 500 zl", a klient ma dostac wersje dla siebie korzystniejsza.
  if (wartoscTowaruGr >= klient.progDarmowejDostawyGr) return null;

  return { nazwa: NAZWA_KURIERA, kwotaGr: klient.oplataKurierskaGr };
}
