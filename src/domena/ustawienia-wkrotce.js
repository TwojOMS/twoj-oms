// PRZ-101.01: strony-atrapy Ustawień („wkrótce”). Jedna tablica — trasa i widok są wspólne
// (moduly/ustawienia/trasy/wkrotce.js). Każde „Dziś” sprawdzone w kodzie 18.10.2026; bez dat i obietnic.
export const STRONY_WKROTCE = Object.freeze([
  {
    // PRZ-126: drukowanie faktur już działa (sekcja niżej) — bez ramki „nie działa” i plakietki w menu.
    klucz: 'druk', href: '/ustawienia/druk', tytul: 'Etykiety i druk', dziala: true,
    opis: 'Jedno miejsce na ustawienia wydruków, niezależnie od kuriera.',
    punkty: [
      'domyślny format etykiety: 10×15 cm albo kartka A4',
      'drukarka, na którą agent druku wysyła etykiety i faktury',
      'wydruki zbiorcze: etykiety i faktury kilku zamówień naraz',
    ],
    dzis: 'Format etykiety DPD wybierasz w ustawieniach kuriera, a drukowanie w biurze robi agent druku.',
    odnosnik: { href: '/ustawienia/integracje/dpd', etykieta: 'Kurier DPD' },
    instrukcjaFaktur: [
      'Przygotuj komputer z Windows podłączony do drukarki i sprawdź, czy drukarka działa.',
      'Pobierz agenta druku i skopiuj katalog deploy/drukarka na ten komputer.',
      'Skopiuj config-faktury.przyklad.json jako config-faktury.json i wpisz adres Twojego panelu, login i hasło konta serwisowego (opis w paczce) oraz nazwę drukarki dokładnie tak, jak pokazuje ją Windows.',
      'W konfiguracji wskaż program do otwierania PDF i sprawdź jego ustawienia.',
      'Uruchom próbny wydruk dowolnego pliku PDF według opisu w paczce instalacyjnej.',
      'Uruchom czuwacz faktur i sprawdź na tej stronie, czy panel widzi komputer. Pełny opis znajdziesz w paczce instalacyjnej, w katalogu deploy/drukarka.',
    ],
  },
  {
    klucz: 'import-eksport', href: '/ustawienia/import-eksport', tytul: 'Import i eksport',
    opis: 'Dane panelu w plikach CSV, do arkusza i z arkusza.',
    punkty: [
      'eksport zamówień, klientów i kart produktów do CSV',
      'import kart produktów z arkusza',
    ],
    dzis: 'Sprzedaż z wybranego okresu pobierzesz jako CSV w Raportach („Pobierz CSV”).',
    odnosnik: { href: '/raporty', etykieta: 'Raporty' },
  },
  {
    klucz: 'api', href: '/ustawienia/api', tytul: 'API i webhooki',
    opis: 'Dostęp do danych panelu dla zewnętrznych narzędzi.',
    punkty: [
      'klucze API dla zewnętrznych narzędzi',
      'powiadomienia HTTP (webhooki) o nowych zamówieniach',
    ],
  },
]);
