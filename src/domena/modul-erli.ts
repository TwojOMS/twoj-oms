import type { OpisKanalu } from '../core/kontrakty.ts';

export const MODUL_ERLI = {
  typ: 'erli', nazwa: 'ERLI', litera: 'e',
  komunikaty: { mianownik: 'konto ERLI', dopelniacz: 'konta ERLI', miejscownik: 'koncie ERLI', narzednik: 'kontem ERLI' },
  idKatalogu: 'erli', wzorzecLinku: 'erli',
  umiejetnosci: {
    zdarzenia: 'skrzynka', wymagaAkceptacji: false, statusZwrotny: 'mapa', numerListu: 'przesylki',
    plikFaktury: false, wiadomosci: false, wysylkaPlatformy: false, terminWysylki: true, scalanie: false, stany: 'brak',
  },
  kluczeEnv: { sekrety: ['KLUCZ_API'], wymagane: ['KLUCZ_API', 'ADRES_API', 'OD'] },
  // wysylkaPlatformy: false do zmian 07/08 (D4 mówi true), bo dziś ta umiejętność włącza ścieżki pisane pod Allegro
  // (odmowa DPD i paczkomatu InPost, taryfa inpost_locker_allegro, teksty o Allegro) — recenzja 01b.
  // Opis kroków; widoki i trasy powstaną w PRZ-157.11.
  konfigurator: { sciezka: '/ustawienia/integracje/erli', nowy: 'nowe', dodaj: 'Dodaj konto', kroki: [
    { id: 'dane', numer: 1, tytul: 'Nazwa, środowisko, klucz', instrukcja: ['Podaj dane sklepu i domyślny czas wysyłki.'], widok: 'erli-dane' },
    { id: 'polaczenie', numer: 2, tytul: 'Sprawdź połączenie', instrukcja: ['Sprawdź nazwę i id sklepu w ERLI.'], widok: 'erli-polaczenie' },
    { id: 'metody', numer: 3, tytul: 'Metody dostawy', instrukcja: ['Wskaż, jak nadajesz każdą metodę z cenników sklepu.'], widok: 'erli-metody' },
    { id: 'nadawanie', numer: 4, tytul: 'Nadawanie Przesyłek Erli', instrukcja: ['Wybierz punkt nadania i domyślne wymiary paczki.'], widok: 'erli-nadawanie' },
    { id: 'start', numer: 5, tytul: 'Start', instrukcja: ['Podaj datę, od której OMS ma pobierać zamówienia, i aktywuj sklep.'], widok: 'erli-start' },
  ] },
} as const satisfies OpisKanalu;
