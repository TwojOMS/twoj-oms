// CZY WOLNO ZMIENIC PRZYNALEZNOSC ZAMOWIENIA DO OKRESU ROZLICZENIOWEGO.
//
// ⚠️⚠️ TA SAMA REGULA RZADZI EKRANEM I TRASA — dokladnie jak `domain/kanal-stan.js`
// (przewodnik 4.37). Rozjazd miedzy „czy pokazac przycisk" a „czy pozwolic na zadanie"
// znaczy albo przycisk prowadzacy prosto w odmowe, albo wyjscie, o ktorym nikt nie wie.
// Widok WOLA te funkcje, nigdy nie powtarza warunku.
//
// POWSTALA, BO PRZYNALEZNOSC DO OKRESU BYLA JEDYNYM STANEM BEZ WYJSCIA (niezmiennik 4.9).
// Do 17.08.2026 `zamowienia.okres_rozliczeniowy_id` bylo zapisywane WYLACZNIE w `INSERT`
// przy zakladaniu zamowienia — literowka w NIP-ie znaczyla, ze zamowienie po cichu wypada
// i z faktury miesiecznej, i z raportu, a jedynym ratunkiem byl SQL na produkcji.
import { stanFakturyOkresu } from './okres-rozliczeniowy.js';
import { idsDolaczonych } from './scalanie.js';

/**
 * Czy wolno odpiac zamowienie od okresu. Rozstrzyga WYLACZNIE stan faktury okresu.
 *
 * ⚠️ NIE PYTAMY O `stan` OKRESU, i to jest decyzja. Zamkniecie odcina okres od NOWYCH
 * zamowien i nie mowi nic o dokumencie — a odpiecie jest bezpieczne dopoki faktury nie ma.
 * Wlasnie w zamknietym miesiacu bywa najbardziej potrzebne: zamykasz go i dopiero wtedy
 * widzisz, ze wpadlo tam cudze zamowienie.
 *
 * ⚠️ STANY POSREDNIE BLOKUJA TAK SAMO JAK WYSTAWIONA FAKTURA. 'w_toku' znaczy, ze inFakt
 * wlasnie dostaje liste zamowien; 'zawieszona' i 'do_wyjasnienia' znacza, ze NIE WIADOMO,
 * czy dokument powstal. Zmiana listy w kazdym z tych stanow to zmiana podstawy dokumentu,
 * o ktorym panel nie ma pewnosci — czyli najgorszy rodzaj bledu o pieniadze.
 */
export function wolnoOdpiac({ okres, teraz = Date.now() } = {}) {
  if (!okres) {
    return { wolno: false, powod: 'Nie ma takiego okresu rozliczeniowego.' };
  }
  const faktura = stanFakturyOkresu(okres, teraz);
  if (faktura !== 'brak') {
    return {
      wolno: false,
      powod: 'Za ten okres jest już faktura — dokument opiewa na tę listę zamówień, '
        + 'więc odpięcie zmieniłoby jego podstawę. To sprawa dla korekty w inFakcie, nie dla panelu.',
    };
  }
  return { wolno: true, powod: null };
}

/**
 * Czy wolno dopisac zamowienie do okresu jego miesiaca.
 *
 * ⚠️ SAMA FUNKCJA NIE LICZY, DO KTOREGO OKRESU — od tego jest `przypiszDoOkresu`
 * (services/okres.js), ta sama, ktorej uzywa zakladanie zamowienia. Tutaj sa wylacznie
 * bariery, ktore musi znac TAKZE widok, zeby nie pokazac przycisku prowadzacego w odmowe.
 * Odmowa zamknietego miesiaca przychodzi juz z tamtej funkcji, tym samym zdaniem, ktore
 * operator zna z ekranu zakladania — i celowo NIE jest tu powtarzana.
 */
export function wolnoPrzypisac({ zamowienie, faktura, klient } = {}) {
  if (!zamowienie) {
    return { wolno: false, powod: 'Nie ma takiego zamówienia.' };
  }
  // ⚠️ DRUGI DOKUMENT ZA TE SAMA SPRZEDAZ. Zamowienie z wlasna faktura, dopisane do miesiaca,
  // pojechaloby jeszcze raz na fakturze zbiorczej — a tego nie cofa nic poza korekta.
  if (faktura) {
    return {
      wolno: false,
      powod: `To zamówienie ma już fakturę ${faktura.numer ?? ''}`.trim()
        + '. Dopisanie go do miesiąca oznaczałoby drugi dokument za tę samą sprzedaż.',
    };
  }
  // ⚠️ PRZ-101.04: ZAMÓWIENIE SCALONE NIE WCHODZI DO OKRESU (recenzja, W1). Faktura okresu czyta
  // `pobierzZamowienie` — same pozycje głównego; faktura grupy odmawia, bo główne „należy do okresu”,
  // a dołączone własnej mieć nie może: pozycje dołączonego nie trafiłyby na ŻADEN dokument. Dołączone
  // dopisane wprost — jego pozycje na fakturze okresu i drugi raz na fakturze grupy. Odwrotna
  // bariera (zamówienia z okresu nie scalamy) stoi w `powodyOdmowyScalenia`.
  if (zamowienie.scalone_do) {
    return {
      wolno: false,
      powod: `To zamówienie jest scalone z zamówieniem ${zamowienie.scalone_do_numer ?? `#${zamowienie.scalone_do}`} — `
        + 'okres rozliczeniowy nie obejmie go osobno. Najpierw rozdziel zamówienia (karta głównego → „Rozdziel”).',
    };
  }
  if (idsDolaczonych(zamowienie).length) {
    return {
      wolno: false,
      powod: 'To zamówienie ma dołączone zamówienia — faktura okresu objęłaby tylko jego własne pozycje. '
        + 'Jeśli ma wejść do okresu, najpierw je rozdziel (karta → „Rozdziel”).',
    };
  }
  if (zamowienie.okres_rozliczeniowy_id) {
    return {
      wolno: false,
      powod: 'To zamówienie jest już przypisane do okresu — najpierw odepnij je na ekranie okresu.',
    };
  }
  // Hurt do siedziby klienta dostaje fakture od razu, z terminem, i okres omija go
  // z zalozenia (services/okres.js). Przycisk przy nim bylby zaproszeniem do pomylki.
  if (zamowienie.do_siedziby_klienta) {
    return {
      wolno: false,
      powod: 'Zamówienie jest oznaczone jako hurt do siedziby klienta — takie rozlicza się '
        + 'osobno, fakturą z terminem, i nie wchodzi na fakturę zbiorczą.',
    };
  }
  // Bez klienta zbiorczego nie ma DOKAD przypisac — panel nie pokazuje przycisku, ktorego
  // klikniecie skonczyloby sie odmowa (ta sama zasada, co przy wiazaniu zdrowego kanalu).
  if (!klient) {
    return {
      wolno: false,
      powod: 'NIP z tego zamówienia nie należy do żadnego klienta rozliczanego zbiorczo.',
    };
  }
  return { wolno: true, powod: null };
}
