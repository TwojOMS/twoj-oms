import type {TypKanaluZnany} from '../../domena/moduly-kanalow.ts';
export type Autoryzacja = 'brak' | 'oczekuje_potwierdzenia' | 'polaczone' | 'wymaga_autoryzacji' | 'odlaczone';
export type Pobieranie = 'wylaczone' | 'wlaczone' | 'zatrzymywanie';
export type SrodowiskoAllegro = 'produkcja' | 'sandbox';
export type Aktor = { id: number; login: string };
export type PolaczenieAllegro = {
  klucz: string; nazwa: string; srodowisko: SrodowiskoAllegro; zrodlo: 'env' | 'panel';
  kontoId: string | null; login: string | null; autoryzacja: Autoryzacja; pobieranie: Pobieranie;
  odUtc: string; raport: string; wersja: number; generacja: number; generacjaImportu: number;
};
/** Aplikacja Allegro, przez którą połączono kanał; NULL = wiersz sprzed PRZ-132 (DCR dla panelu, env dla env). */
export type AplikacjaKanalu = 'device' | 'dcr' | null;
/** PRZ-132.02: kanał dowolnego typu z jednej tabeli `kanaly_sprzedazy`; `PolaczenieAllegro` zostaje aliasem bazy. */
export type PolaczenieKanalu = PolaczenieAllegro & { typ: TypKanaluZnany; aplikacja: AplikacjaKanalu };
export type Wynik<T> = { ok: true; dane: T } | {
  ok: false; kod: 'walidacja' | 'konflikt' | 'brak_dostepu' | 'odlaczone' | 'ponow_autoryzacje' | 'tymczasowy' | 'niejednoznaczny'; komunikat: string;
};
export const bladAllegro = (kod: Extract<Wynik<never>, {ok:false}>['kod'], komunikat: string): Wynik<never> => ({ok:false,kod,komunikat});
