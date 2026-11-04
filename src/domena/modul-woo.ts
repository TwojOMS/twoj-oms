import type { OpisKanalu } from '../core/kontrakty.ts';

export const MODUL_WOO = {
  typ: 'woo', nazwa: 'WooCommerce', litera: 'W',
  komunikaty: { mianownik: 'sklep', dopelniacz: 'sklepu', miejscownik: 'sklepie', narzednik: 'sklepem' },
  idKatalogu: 'woocommerce', wzorzecLinku: 'sklep',
  umiejetnosci: {
    zdarzenia: 'odpytywanie', wymagaAkceptacji: false, statusZwrotny: 'wyslane', numerListu: 'notatka',
    plikFaktury: false, wiadomosci: false, wysylkaPlatformy: false, terminWysylki: false, scalanie: true, stany: 'produkty',
  },
  kluczeEnv: { sekrety: ['CK', 'CS'], wymagane: ['URL', 'CK', 'CS', 'MAPOWANIE'] },
  konfigurator: { sciezka: '/ustawienia/integracje/woocommerce', nowy: 'nowy', dodaj: 'Dodaj sklep', kroki: [
    { id: 'nazwa', numer: 1, tytul: 'Nazwa i adres', formularz: {
      akcja: 'szkice', przycisk: 'Dalej', pola: [
        { id: 'nazwa', etykieta: 'Nazwa w OMS', rodzaj: 'tekst', wymagane: true },
        { id: 'adres', etykieta: 'Adres sklepu', rodzaj: 'adres', wymagane: true, przyklad: 'sklep.pl' },
      ],
    } },
    { id: 'klucze', numer: 2, tytul: 'Klucze REST', instrukcja: [
      'W WordPress przejdź do WooCommerce → Ustawienia → Zaawansowane → REST API i wybierz „Dodaj klucz”.',
      'W polu „Opis” wpisz „Twój OMS”. W polu „Użytkownik” zostaw swoje konto administratora.',
      'W polu „Uprawnienia” wybierz „Zapis/odczyt”. Kliknij „Wygeneruj klucz API”.',
      'Tajny konsumenta WooCommerce pokazuje tylko raz — skopiuj oba klucze, zanim opuścisz stronę.',
    ],
    // PRZ-149.04 (C8): „Odczyt” — OMS tylko pobiera zamówienia (statusu, notatki ani SKU/wymiarów nie zapisuje).
    wybor: {
      pole: { id: 'uprawnienia', etykieta: 'Jakie uprawnienia ma klucz?', rodzaj: 'wybor', wymagane: true, domyslna: 'zapis', opcje: [
        { wartosc: 'odczyt', etykieta: 'Odczyt (OMS tylko pobiera zamówienia)' },
        { wartosc: 'zapis', etykieta: 'Zapis/odczyt (OMS też zmienia status, dopisuje numer przesyłki i zapisuje SKU/wymiary)' },
      ] },
      punkt: 2,
      warianty: {
        odczyt: 'W polu „Uprawnienia” zostaw „Odczyt”. Kliknij „Wygeneruj klucz API”.',
        zapis: 'W polu „Uprawnienia” wybierz „Zapis/odczyt”. Kliknij „Wygeneruj klucz API”.',
      },
    },
    formularz: {
      akcja: ':kanal/klucze', przycisk: 'Sprawdź połączenie', pola: [
        { id: 'ck', etykieta: 'Klucz konsumenta (ck_…)', rodzaj: 'sekret', wymagane: true },
        { id: 'cs', etykieta: 'Tajny konsumenta (cs_…)', rodzaj: 'sekret', wymagane: true },
      ],
    } },
    { id: 'mapowanie', numer: 3, tytul: 'Metody wysyłki', widok: 'woo-mapowanie' },
    { id: 'start', numer: 4, tytul: 'Data startu i „Aktywuj”', formularz: {
      akcja: ':kanal/data-startu', przycisk: 'Zapisz datę startu', pola: [
        { id: 'od', etykieta: 'Zamówienia od dnia', rodzaj: 'data', wymagane: true,
          pomoc: 'Zamówień sprzed tej daty OMS nie pobierze, także później.' },
      ],
    } },
    { id: 'stan', numer: 5, tytul: 'Stan', widok: 'woo-stan' },
  ] },
} as const satisfies OpisKanalu;
