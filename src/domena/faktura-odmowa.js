import { chceFakture } from './dane-faktury.js';
import { sumaWplatGrosze } from './platnosci.js';
import { kwotaOczekiwanaGrosze, zl } from './suma-pozycji.js';

// Kto NIE dostanie faktury i dlaczego — JEDNA regula dla obu drog: wystawienia z karty
// (services/faktura.js) i wystawienia hurtem (services/faktura-hurtem.js).
//
// ⚠️ ISTNIEJE PO TO, ZEBY NIE BYLO DRUGIEJ KOPII. Modul ma te lekcje wpisana przy akcjach
// masowych (domain/masowe.js): druga kopia reguly rozjezdza sie przy pierwszej zmianie
// i tryb masowy zaczyna przepuszczac to, czego karta odmawia. Ekran podgladu przed hurtem
// pokazuje DOKLADNIE ten podzial, ktory potem wykona trasa, bo pyta o to ta sama funkcje.
//
// ⚠️ TA FUNKCJA NIE ZASTEPUJE REZERWACJI W BAZIE. „Zamowienie ma juz fakture" rozstrzyga
// `rozpocznijFakture` (db/faktury.js) i tak ma zostac: karta w przegladarce pokazuje stan
// sprzed sekund, a dwie zakladki potrafia kliknac naraz. Podzial na ekranie podgladu czyta
// stan faktury osobno (domain/faktura-stan.js) — dla WYGODY oka, nie jako zabezpieczenie.

/** Kolejnosc odmow jest czescia reguly — patrz komentarze przy poszczegolnych warunkach. */
export function powodOdmowyFaktury(z, { okresyWlaczone = true } = {}) {
  if (!z) return 'Nie ma takiego zamówienia.';

  // PRZ-101.04: JEDNA FAKTURA NA ZAMÓWIENIE SCALONE (decyzja właściciela 18.10). Dołączone jest częścią
  // głównego — jego pozycje fakturuje faktura głównego (oms/db/scalenia.js). Własna faktura
  // dołączonego = te same pozycje na dwóch dokumentach. Tej samej funkcji pyta wystawianie hurtem.
  if (z.scalone_do) {
    return `Zamówienie ${z.numer} jest scalone z zamówieniem ${z.scalone_do_numer ?? `#${z.scalone_do}`} — `
      + 'faktura w zamówieniu głównym.';
  }

  // ⚠️ ZAMOWIENIE ROZLICZANE ZBIORCZO NIE MA WLASNEJ FAKTURY — I TO JEST BLOKADA
  // O PIENIADZE, a nie o porzadek. Bez niej to samo zamowienie jedzie na dokument DWIEMA
  // drogami: pojedynczo z wlasnej karty, a potem drugi raz, zbiorczo, z ekranu okresu
  // (zmierzone przed ta poprawka: `infakt.wystaw` wywolany dwa razy, ta sama pozycja
  // „STOP 70x100" na obu dokumentach). Klient dostaje ten sam towar na dwoch fakturach,
  // a po wieczornej wysylce do KSeF obie sa juz tylko do korekty.
  //
  // Blokady zbudowane w Zadaniach 7 i 9 (rezerwacja okresu, `stanFakturyOkresu`) bronily
  // WYLACZNIE osi „drugi dokument za ten sam MIESIAC" — osi „to samo ZAMOWIENIE dwiema
  // drogami" nie pilnowalo NIC, bo zadne pojedyncze zadanie planu jej nie widzialo.
  //
  // Druga strona tej samej bariery (odmowa fakturze ZBIORCZEJ, gdy ktores zamowienie ma
  // juz wlasny wiersz w `faktury`) siedzi w services/faktura-okresu.js. Kazda z nich
  // z osobna zostawia dziure — dlatego sa obie.
  //
  // ⚠️ PIERWSZA, bo to fakt STRUKTURALNY: takiego zamowienia nie fakturuje sie pojedynczo
  // w ZADNYM stanie, a komunikat niesie adres ekranu, na ktory czlowiek ma kliknac —
  // inaczej operator wie tylko, ze nie wolno, i nie wie, gdzie ma isc.
  if (z.okres_rozliczeniowy_id) {
    return `Zamówienie ${z.numer} należy do miesięcznego okresu rozliczeniowego i rozlicza się `
      + 'JEDNĄ fakturą zbiorczą za cały miesiąc — pojedynczej faktury panel do niego nie '
      + 'wystawi. ' + (okresyWlaczone
        ? `Fakturę za ten miesiąc wystawisz na ekranie okresu: /okresy/${z.okres_rozliczeniowy_id}.`
        : 'Włącz Rozliczenia w Ustawienia → Moduły, żeby wystawić fakturę za okres.');
  }

  // TWARDA odmowa, nie samo ukrycie sekcji w widoku: karta w przegladarce pokazuje stan
  // sprzed sekund, a klient moze anulowac dokladnie wtedy, gdy operator ma ja otwarta.
  // Faktura do anulowanego zamowienia to dokument, ktorego nikt nie powinien byl
  // wystawic — trzeba go recznie skasowac w inFakcie, zanim wieczorem sam pojedzie do
  // KSeF razem z reszta. Zlapane po tej wysylce to juz nie skasowanie, a KOREKTA
  // i wizyta w ksiegowosci.
  //
  // CELOWO blokujemy WYLACZNIE anulowanie. Brak oplaty NIE blokuje wystawienia: to sklep
  // B2B, faktura z terminem platnosci jest tam norma, a nie wyjatkiem.
  if (z.anulowane) return 'Zamówienie jest anulowane — nie wolno wystawiać do niego faktury.';

  // `chceFakture(z)`, a NIE `z.chce_fakture`: na sklepie B nie ma pola
  // „chce fakture" i panel wnioskuje je z NIP-u (mapowanie.js), wiec czlowiek musi miec
  // prawo to rozstrzygnac — klient regularnie dzwoni po fakture juz po zlozeniu
  // zamowienia. Przelacznik dziala w OBIE strony i wygrywa z domyslem ze sklepu.
  if (!chceFakture(z)) return 'Klient nie prosił o fakturę.';
  return null;
}

/**
 * Odmowa wariantowi „zaplacone" — dokument mowiacy „zaplacono" przy pustej kasie.
 *
 * ⚠️ DRUGA BARIERA, O PIENIADZE. `datyFaktury` (domain/termin-platnosci.js) sprawdza
 * wylacznie KSZTALT kwoty (calkowita, dodatnia) i nie ma jak sprawdzic FAKTU zaplaty —
 * nie widzi zamowienia. Bez tej odmowy zamowienie z ZEREM wplat i wyborem „zaplacone"
 * szlo do inFaktu z `paid_price` rownym calej kwocie, czyli dokument mowil klientowi
 * „Zaplacono: 123,00 / Pozostalo: 0,00", gdy nikt nie zaplacil. Panel te wiedze MIAL
 * (trasa liczy `podstawa` przez proponowanaDataSprzedazy), ale uzywal jej tylko do
 * podpowiedzi domyslnej opcji w formularzu.
 *
 * To bariera o pieniadze, nie o porzadek: dokumentu ksiegowego mowiacego „zaplacono",
 * gdy nikt nie zaplacil, NIE DA SIE poprawic — tylko skorygowac, czyli drugim dokumentem
 * i wizyta w ksiegowosci (a po wieczornej wysylce do KSeF tym bardziej).
 *
 * ⚠️ Miara to `kwotaOczekiwanaGrosze` (kwota ze sklepu PLUS pozycje dopisane recznie), TA SAMA,
 * ktora sprawdza bariera arytmetyczna, ktora liczy saldo wplat na karcie i ktora leci na
 * dokument jako `paid_price`. Nadplata TEZ jest pokryciem (`>=`): nadwyzka to sprawa salda
 * zamowienia, nie tej faktury.
 */
export function powodOdmowyZaplaconej(z) {
  if (!z) return 'Nie ma takiego zamówienia.';

  const wplatyGr = sumaWplatGrosze(z?.platnosci);
  const naleznoscGr = kwotaOczekiwanaGrosze(z);
  if (wplatyGr >= naleznoscGr) return null;
  return `Faktura ma być oznaczona jako zapłacona, a panel widzi przy zamówieniu ${z?.numer} `
    + `wpłaty na ${zl(wplatyGr)} zł przy należności ${zl(naleznoscGr)} zł. Nie wystawiono `
    + 'niczego. Najpierw dopisz wpłatę na karcie zamówienia (sekcja „Płatności"), a potem '
    + 'wystaw fakturę — albo wybierz termin płatności zamiast „zapłacone". Dokumentu '
    + 'mówiącego „zapłacono", gdy pieniędzy nie ma, nie da się poprawić — tylko skorygować.';
}
