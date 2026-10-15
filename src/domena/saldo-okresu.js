import { sumaWplatGrosze } from './platnosci.js';

// Saldo miesiecznego okresu rozliczeniowego.
//
// ⚠️ ROZLICZENIE ZYJE NA OKRESIE, NIE NA ZAMOWIENIU. Klient placi RAZ, po fakturze,
// wiec kilkadziesiat zamowien miesiaca nigdy nie dostanie wlasnej wplaty. Gdyby bramka
// platnosci zostala przy zamowieniu, wszystkie wisialyby w nieskonczonosc jako
// nieoplacone i zatrulyby statusy liczone z faktow.
//
// ⚠️ WPLATY PRZYCHODZA JAKO WIERSZE (takie, jakie oddaje `wplatyOkresu` z db/platnosci.js),
// a nie jako gotowe grosze — i to nie jest wygoda, tylko wymog. `platnosci_okresu.kwota`
// jest napisem ('500.00'), wiec sygnatura na liczbach zrzucalaby konwersje TEXT→liczba na
// wolajacego, czyli tworzyla DRUGA kopie arytmetyki wplat. Naglowek domain/platnosci.js
// mowi, jak taka kopia klamie: 35.65 + 35.65 + 141.60 na floatach daje 212.89999999999998,
// czyli NIEDOPLATE na okresie oplaconym co do grosza. Sumujemy wiec `sumaWplatGrosze` —
// TA SAMA funkcja, ktora liczy saldo pojedynczego zamowienia i idzie przez `grosze()`.
//
// Grosz niedoplaty NIE jest „oplacony" — porownanie jest scisle, na liczbach calkowitych.
// Zaokraglanie „prawie zaplacone" do „zaplacone" jest dokladnie tym, przez co niedoplaty
// znikaja z ekranu i nikt sie po nie nie zglasza.
//
// ⚠️ TRZY STANY ROZLICZENIA, NIE DWA (ta sama regula, co `saldoWplat` na zamowieniu):
// „pokryte" znaczy DOKLADNIE zero roznicy, zeby nadplata nie schowala sie w tym samym
// worku co rowna zaplata. Nadplata to pieniadze klienta do zwrotu albo do rozliczenia,
// a panel jest jedynym miejscem, gdzie ktokolwiek to zobaczy.
//
// ⚠️ ...i czwarty stan PRZED nimi: NIEZAFAKTUROWANY. Samo `saldoGr >= 0` uznaje swiezy
// okres (kwota faktury 0, zero wplat) za oplacony, bo 0 >= 0 — panel pokazywalby
// „oplacony" dla miesiaca, za ktory nikt niczego nie wystawil ani nie zaplacil. To ten sam
// rodzaj cichego falszu, przez ktory okres bez faktury raportowal 'wystawiona'
// (stanFakturyOkresu w domain/okres-rozliczeniowy.js). Dopoki faktury nie ma, nie ma czego
// rozliczac — okres NIE JEST oplacony i nie jest tez „nadplacony".
//
// ⚠️ ...ale SALDO DALEJ POKAZUJE PIENIADZE. Do 2026-08-01 ta galaz oddawala `saldoGr: 0`
// i to chowalo zaliczke: klient przelewa 5000 zl za lipiec, faktury jeszcze nie ma, a jedyne
// miejsce, gdzie ktokolwiek te pieniadze zobaczy, mowi „0,00 zl". ZADEN stan nie ma prawa
// chowac pieniedzy klienta. Saldo jest wiec suma wplat (wobec kwoty faktury rownej zeru),
// a to, ze rozliczenia jeszcze nie ma, niesie `stan` — i to po `stan`, nie po zerze, widok
// ma poznac te sytuacje.
//
// `Number.isInteger`, nie `isFinite`: grosze sa CALKOWITE (regula z domain/suma-pozycji.js).
// `kwotaFakturyGr: 212.90` — czyli zlotowki podane jako grosze — przechodzilo przez isFinite
// i dawalo saldo -211.9: liczbe, ktora nie jest ani zlotowka, ani groszem, i ktora nigdy nie
// zejdzie do zera. To nie jest kwota faktury, tylko blad wolajacego.
export function saldoOkresuGrosze({ kwotaFakturyGr, wplaty }) {
  if (!Number.isInteger(kwotaFakturyGr) || kwotaFakturyGr <= 0) {
    return { saldoGr: sumaWplatGrosze(wplaty), oplacony: false, stan: 'niezafakturowany' };
  }
  const saldoGr = sumaWplatGrosze(wplaty) - kwotaFakturyGr;
  return {
    saldoGr,
    oplacony: saldoGr >= 0,
    stan: saldoGr === 0 ? 'pokryte' : (saldoGr < 0 ? 'niedoplata' : 'nadplata'),
  };
}
