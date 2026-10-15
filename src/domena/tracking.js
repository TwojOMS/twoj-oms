// ⚠️ KAZDY WZORZEC MA BYC SPRAWDZONY NA ZYWEJ STRONIE, a nie przepisany z pamieci albo
// z dokumentacji. Przy DPD kosztowalo to jedna pomylke: `findParcel?q=` laduje sie i oddaje
// HTTP 200, ale numeru na stronie NIE MA — czyli link dzialajacy „wedlug kodu odpowiedzi"
// i bezuzyteczny dla czlowieka. Sprawdzian jest zawsze ten sam: czy strona pokazuje TEN numer.
const WZORCE = {
  // Potwierdzone na prawdziwym numerze (Zadanie 8, notatka 2026-07-29-dpd-api-rozpoznanie).
  dpd: (n) => `https://tracktrace.dpd.com.pl/parcelDetails?p1=${encodeURIComponent(n)}`,
  // Potwierdzone 2026-08-04 w przegladarce: dla numeru nieistniejacego strona odpowiada
  // „Nie znalezlismy paczki o podanym numerze" i wypisuje „Przesylka nr: <numer>", wiec
  // parametr naprawde napedza wyszukiwanie. ⚠️ Rozpoznanie ShipX (notatka z 2026-08-01)
  // opisuje wylacznie API `GET /tracking/{numer}` — adresu strony dla czlowieka nie zawiera,
  // wiec ten wzorzec pochodzi z osobnego sprawdzenia, nie z tamtej notatki.
  inpost: (n) => `https://inpost.pl/sledzenie-przesylek?number=${encodeURIComponent(n)}`,
  // ⚠️⚠️ `allegro` CELOWO NIE MA TU WPISU — i to nie jest przeoczenie (04.08.2026).
  //
  // Kandydat (z briefu Zadania 9, NIE z pomiaru):
  //   https://allegro.pl/moje-allegro/zakupy/sledzenie-przesylki/<numer>
  // Wpis o tej tresci istnial przez chwile w Zadaniu 9 i zostal ZDJETY w recenzji, bo nikt
  // go nie otworzyl w przegladarce. Wpisany kosztowal wiecej, niz dawal: `lista-ikony.js`
  // robi `href: sledzenie ?? '/zamowienia/<id>'`, wiec DOPOKI wzorca nie ma, ikona przesylki
  // przy paczce Allegro prowadzi do KARTY ZAMOWIENIA — link zawsze uzyteczny, w tej samej
  // zakladce. Wzorzec zamienia go na adres niesprawdzony, otwierany w NOWEJ zakladce.
  //
  // ZANIM ktokolwiek dopisze tu wpis, trzeba ZMIERZYC na prawdziwym numerze „AD…" dwie
  // rzeczy — obie osobno, obie w przegladarce:
  //   1. CZY STRONA POKAZUJE TEN NUMER. To ta sama pulapka, co przy DPD: `findParcel?q=`
  //      oddawalo HTTP 200 i numeru na stronie NIE BYLO, czyli link „dzialal wedlug kodu
  //      odpowiedzi" i byl bezuzyteczny dla czlowieka. Sam kod 200 niczego nie dowodzi.
  //   2. CZY ISTNIEJE ODPOWIEDNIK PO STRONIE SPRZEDAJACEGO. Sciezka `moje-allegro/zakupy/…`
  //      jest strona KUPUJACEGO, a panel jest po stronie SPRZEDAJACEGO — sciezka jest wiec
  //      PODEJRZANA: zalogowany sprzedawca zobaczy tam prawdopodobnie swoje ZAKUPY albo
  //      pustke, a nie przesylke tego zamowienia. Jesli odpowiednika sprzedawcy nie ma,
  //      poprawna odpowiedzia jest ZOSTAWIC TO MIEJSCE PUSTE, a nie kierowac numeru
  //      gdziekolwiek indziej.
  // Dopisanie wzorca wymaga swiadomej zmiany testu w tests/oms/tracking.test.js (dzis
  // asercja brzmi `toBeNull()`) — i tak ma byc: pomiar ma poprzedzac wpis, nie odwrotnie.
};

// Brak linku jest lepszy niz link otwierajacy pusta wyszukiwarke.
export function linkDoSledzenia(kurier, numerListu) {
  if (!numerListu) return null;
  const wzorzec = WZORCE[kurier];
  return wzorzec ? wzorzec(numerListu) : null;
}
