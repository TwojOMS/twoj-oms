import type { OpisKanalu } from '../core/kontrakty.ts';

export const MODUL_ALLEGRO = {
  typ: 'allegro', nazwa: 'Allegro', litera: 'a',
  komunikaty: { mianownik: 'Allegro', dopelniacz: 'Allegro', miejscownik: 'Allegro', narzednik: 'Allegro' },
  idKatalogu: 'allegro', wzorzecLinku: 'allegro',
  umiejetnosci: {
    zdarzenia: 'odpytywanie', wymagaAkceptacji: false, statusZwrotny: 'mapa', numerListu: 'przesylki',
    plikFaktury: true, wiadomosci: true, wysylkaPlatformy: true, terminWysylki: true, scalanie: false, stany: 'oferty',
  },
  kluczeEnv: { sekrety: ['CLIENT_ID', 'CLIENT_SECRET'], wymagane: ['CLIENT_ID', 'CLIENT_SECRET', 'USER_AGENT', 'OD'] },
  konfigurator: { sciezka: '/ustawienia/integracje/allegro', nowy: 'nowe', dodaj: 'Dodaj konto', kroki: [
    { id: 'aplikacja', numer: 0, tytul: 'Aplikacja Allegro', widok: 'allegro-aplikacja' },
    { id: 'nazwa', numer: 1, tytul: 'Nazwa i zakres zamówień', formularz: {
      akcja: 'szkice', przycisk: 'Dalej', pola: [
        { id: 'nazwa', etykieta: 'Nazwa w OMS', rodzaj: 'tekst', wymagane: true },
        { id: 'srodowisko', etykieta: 'Środowisko', rodzaj: 'wybor', wymagane: true, domyslna: 'produkcja', opcje: [
          { wartosc: 'produkcja', etykieta: 'Allegro — konto sprzedażowe' },
          { wartosc: 'sandbox', etykieta: 'Allegro Sandbox — konto testowe' },
        ] },
        { id: 'od', etykieta: 'Zamówienia od dnia', rodzaj: 'data', wymagane: true,
          pomoc: 'Dzień liczymy według czasu w Polsce. Maksymalnie ostatnie 12 miesięcy i 10 000 zamówień.' },
      ],
    } },
    { id: 'zgoda', numer: 2, tytul: 'Zgoda w Allegro', widok: 'allegro-zgoda' },
    { id: 'konto', numer: 3, tytul: 'Potwierdź konto', widok: 'allegro-konto' },
    { id: 'start', numer: 4, tytul: 'Data startu', formularz: {
      akcja: ':kanal/data-startu', przycisk: 'Zapisz datę startu', pola: [
        { id: 'od', etykieta: 'Zamówienia od dnia', rodzaj: 'data', wymagane: true },
      ],
    } },
    { id: 'stan', numer: 5, tytul: 'Stan', widok: 'allegro-stan' },
  ] },
} as const satisfies OpisKanalu;
