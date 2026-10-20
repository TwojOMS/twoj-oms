// PRZ-101.01: strony-atrapy Ustawień („wkrótce”). Jedna tablica — trasa i widok są wspólne
// (moduly/ustawienia/trasy/wkrotce.js). Każde „Dziś” sprawdzone w kodzie 18.10.2026; bez dat i obietnic.
export const STRONY_WKROTCE = Object.freeze([
  {
    klucz: 'druk', href: '/ustawienia/druk', tytul: 'Druk i etykiety',
    opis: 'Jedno miejsce na ustawienia wydruków, niezależnie od kuriera.',
    punkty: [
      'domyślny format etykiety: 10×15 cm albo kartka A4',
      'drukarka, na którą agent druku wysyła etykiety i faktury',
      'wydruki zbiorcze: etykiety i faktury kilku zamówień naraz',
    ],
    dzis: 'Format etykiety DPD wybierasz w ustawieniach kuriera, a drukowanie w biurze robi agent druku (opis w deploy/drukarka/README.md).',
    odnosnik: { href: '/ustawienia/integracje/dpd', etykieta: 'Kurier DPD' },
  },
  {
    klucz: 'kopie', href: '/ustawienia/kopie', tytul: 'Kopie zapasowe',
    opis: 'Podgląd i obsługa kopii bazy z poziomu panelu.',
    punkty: [
      'harmonogram kopii',
      'miejsce kopii: ten sam dysk albo nośnik zewnętrzny',
      'przywracanie wybranej kopii z panelu',
    ],
    dzis: 'W instalacji z Dockera kopię bazy robi raz dziennie kontener oms-kopia — opis w docs/instalacja-docker.md, sekcje „Codzienna obsługa” i „Kopia poza dyskiem”.',
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
