import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';

export type Srodowisko = Readonly<Record<string, string | undefined>>;

export type Migracja = {
  readonly numer: number;
  readonly nazwa: string;
  readonly wykonaj: (db: DatabaseSync) => void;
};

/** Klucz uprawnienia = dzisiejsza kolumna `uprawnienia.ekran`. `role` — kto z ISTNIEJĄCYCH kont dostaje ptaszek, gdy klucz pojawia się pierwszy raz (lekcja CELE, 13.09). */
export type Uprawnienie = {
  readonly klucz: string;
  readonly etykieta: string;
  readonly role: readonly string[];
};

export type PozycjaMenu = {
  readonly dzial: string;
  readonly grupa?: string;
  readonly etykieta: string;
  readonly adres: string;
  readonly uprawnienie: string;
  readonly kolejnosc: number;
};

export type Zegar = {
  readonly nazwa: string;
  readonly odstepMs: number;
  readonly przebieg: () => Promise<void>;
};

export type StanZdrowia = { readonly alarmy: readonly string[]; readonly uwagi: readonly string[] };

export type KontekstModulu<K> = {
  readonly db: DatabaseSync;
  readonly konfiguracja: K;
  readonly teraz: () => Date;
  readonly log: (...tekst: string[]) => void;
  /** Usługa zbudowana przez moduł wcześniejszy w kolejności `wymaga`, albo nadpisanie z testu/demo pod kluczem `modul.nazwa`. */
  readonly usluga: <T>(modul: string, nazwa: string) => T;
};

export type ZbudowanyModul = {
  readonly trasy?: (app: FastifyInstance) => void;
  readonly zegary?: readonly Zegar[];
  readonly zdrowie?: () => StanZdrowia;
  readonly uslugi?: Readonly<Record<string, unknown>>;
};

export type ModulOms<K = unknown> = {
  readonly nazwa: string;
  readonly wersja: string;
  readonly wymaga: readonly string[];
  /** Nazwy zmiennych z kluczami integracji, blokowane podczas próby. */
  readonly kluczeIntegracji?: readonly string[];
  /** Rzuca przy złej lub brakującej konfiguracji — błąd startu zamiast cichej wartości domyślnej. */
  readonly konfiguracja: (env: Srodowisko) => K;
  readonly migracje: readonly Migracja[];
  readonly uprawnienia: readonly Uprawnienie[];
  readonly menu: readonly PozycjaMenu[];
  readonly zbuduj: (ctx: KontekstModulu<K>) => ZbudowanyModul;
};

// Kanał sprzedaży — kształt zmierzony 29.09 w woo/adapter.js i allegro/adapter.js oraz w services/poller.js.
export type StronaZamowien = { readonly zamowienia: readonly unknown[]; readonly stron: number };

export type KanalSprzedazy<Z = unknown> = {
  readonly pobierzStrone: (p: { od: string | null; kursor: string | null; strona: number }) => Promise<StronaZamowien>;
  readonly kursorZ: (surowe: unknown) => string | null;
  readonly zlozoneZ: (surowe: unknown) => string | null;
  readonly mapuj: (surowe: unknown) => Z;
};

// Kurier — kształt zmierzony 29.09 w kurierzy/dpd.js, inpost.js, allegro-wza.js i services/nadanie.js.
// PRZ-022: modele danych faktycznie przekazywanych przez nadanie.js do klientów.
export type WynikNadania = {
  readonly numerListu: string | null;
  readonly shipmentId?: string | number | null;
  readonly wTrakcieTworzenia?: boolean;
  readonly numerPrzewoznika?: string | null;
  readonly zplBladOpis?: string | null;
  readonly etykietaPdf?: Buffer | null;
  readonly etykietaZpl?: Buffer | string | null;
  readonly surowa?: string | null;
};

/** Blok billing/shipping odczytany z JSON kanału przez db/zamowienia.js. */
export type AdresKanalu = Readonly<{
  first_name?: string | null; last_name?: string | null; company?: string | null;
  address_1?: string | null; address_2?: string | null; postcode?: string | null;
  city?: string | null; country?: string | null; phone?: string | null; email?: string | null;
}>;

/** Projekcja pobierzZamowienie używana przez nadanie, adresOdbiorcy i wybór taryfy.
 * Kwoty SQLite są tekstem dziesiętnym, flagi mają 0/1; id Allegro jest tekstowe.
 * Pozostałe kolumny/pozycje zamówienia nie są wejściem kontraktu kurierskiego. */
export type ZamowienieDoWysylki = Readonly<{
  id: number; sklep: string; zrodlo_id: string | number; numer: string;
  metoda_wysylki: string; kwota_pobrania: string | null; pobranie: 0 | 1;
  anulowane: 0 | 1; punkt_odbioru: string | null; surowe_json: string | null;
  klient: AdresKanalu | null; dostawa: AdresKanalu | null;
  dostawa_reczna_json: string | null;
}>;

/** Wyjście parsujPaczke (DPD), parsujPaczkeInpost lub parsujGabarytAllegro. */
export type PaczkaKuriera = Readonly<{ waga: number }> & (
  | Readonly<{ dlugosc: number; szerokosc: number; wysokosc: number;
      gabaryt?: never; oczekiwanyDeliveryMethodId?: never }>
  | Readonly<{ gabaryt: 'A' | 'B' | 'C'; dlugosc?: never; szerokosc?: never;
      wysokosc?: never; oczekiwanyDeliveryMethodId?: never }>
  | Readonly<{ gabaryt: 'S' | 'M' | 'L'; dlugosc: number; szerokosc: number;
      wysokosc: number; oczekiwanyDeliveryMethodId: string }>
);

/** Wynik adresOdbiorcy/parsujAdresOdbiorcy z poprawkami operatora. */
export type AdresOdbiorcyKuriera = Readonly<{
  nazwa: string | null; company?: string | null; ulica: string | null; kod: string | null;
  miasto: string | null; kraj: string; phone: string | null; email: string | null;
  punkt_odbioru?: string;
}>;

export type ZlecenieKuriera = Readonly<{
  zamowienie: ZamowienieDoWysylki;
  paczka: PaczkaKuriera;
  kolejnosc?: number;
  adres?: AdresOdbiorcyKuriera;
  punktOdbioru?: string | null;
  kwotaPobrania?: string | null;
  pobranieNaTejPaczce?: boolean;
  drukowac?: boolean;
}>;

export type Kurier<Z = ZlecenieKuriera> = {
  readonly nadaj: (zlecenie: Z) => Promise<WynikNadania>;
  readonly sprawdzPrzesylke?: (idPrzesylkiKuriera: string) => Promise<unknown>;
  readonly statusPrzesylki?: (numerListu: string) => Promise<unknown>;
};
