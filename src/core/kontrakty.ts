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

// Program fakturowy (PRZ-118) — kontrakt, za którym stoi inFakt (src/integracje/programy/infakt.ts), a w PRZ-119
// Fakturownia. Nazwy metod = nazwy klienta inFaktu (src/oms/infakt/client.js); jedyna nowa to `przygotujNabywce`.
// Ładunek i wiersz listy mają kształt v3 inFaktu (grosze całkowite) — tłumaczy adapter programu, nie domena.
// Typy celowo luźne tam, gdzie dziś luźny jest kod (JS domeny buduje i czyta te pola bez typów): nazwane pola
// dokumentują kształt, sygnatura indeksu przepuszcza resztę.

export type OdmianaNazwy = Readonly<{ mianownik: string; dopelniacz: string; miejscownik: string; narzednik: string }>;

export type ZdolnoscProgramu = 'nieoplacone' | 'oznaczZaplacona' | 'wyslijDoKsef' | 'numeracjaWlasna';

export type OpisProgramu = Readonly<{
  /** Wartość kolumny `program`: 'infakt'. */
  id: string;
  /** Odmiana do komunikatów: „do inFaktu”, „w inFakcie”, „z inFaktem”. */
  nazwa: OdmianaNazwy;
  /** Jak program liczy VAT dokumentu wielopozycyjnego. W PRZ-118 strażnik przyjmuje tylko 'wierszami'. */
  regulaVat: 'wierszami' | 'odSumy';
  /** DOKŁADNIE zbiór metod opcjonalnych, które program ma (strażnik: src/integracje/program-fakturowy.ts). */
  zdolnosci: readonly ZdolnoscProgramu[];
  /** Literał: program, który wysyła do KSeF przy wystawieniu, nie wchodzi (wystawienie ≠ wysyłka). */
  wystawienieWysylaDoKsef: false;
  /** Budżety czasu czuwaczy liczone z limitów programu; `zadanieMs` < PROG_ZAWIESZONEJ_FAKTURY_MS. */
  limity: Readonly<{ zadanieMs: number; najdluzszaListaMs: number; stronaListy: number; sufitStron: number; rownolegleStron: number }>;
  /** Cel diagnostyki łączności, bez sekretów. */
  adres: string;
  /** Ekran Ustawień programu: '/ustawienia/integracje/infakt'. */
  ekran: string;
}>;

/** Pozycja dokumentu: `gross_price` = SUMA LINII brutto w groszach (domena/pozycje-faktury.js), VAT liczy program. */
export type PozycjaDokumentu = Readonly<{
  name: string; quantity: number; gross_price: number; tax_symbol: string;
  [pole: string]: unknown;
}>;

/** Ładunek `wystaw` (services/faktura.js, faktura-okresu.js). Bez `send_to_ksef` — wysyłka to osobna metoda. */
export type LadunekFaktury = Readonly<{
  client_id?: unknown;
  services: readonly PozycjaDokumentu[];
  invoice_date?: string; sale_date?: string; payment_date?: string; payment_method?: string;
  paid_price?: number; paid_date?: string; number?: string;
  sale_type?: string; sales_kind?: string; notes?: string;
  [pole: string]: unknown;
}>;

/** Ładunek `wystawKorekte` (zwroty/services/korekta.js): pozycje przed i po korekcie, wskazanie faktury korygowanej. */
export type LadunekKorekty = Readonly<{
  corrected_invoice_number?: string; corrected_invoice_date?: string; corrected_invoice_uuid?: string;
  correction_reason?: string; correction_reason_symbol?: string;
  services?: readonly Readonly<Record<string, unknown>>[];
  [pole: string]: unknown;
}>;

/** Wiersz listy albo wynik `pobierzFakture` w kształcie v3 inFaktu (domena/lista-faktur.js, archiwum, paczka).
 * ⚠️ `left_to_pay` bywa nieobecne albo tekstem — patrz `stanZaplaty` w domena/lista-faktur.js; adapter innego programu
 * tłumaczy też tę pułapkę. */
export type WierszDokumentu = Readonly<{
  uuid?: string; number?: string; rodzaj?: string; status?: string; invoice_date?: string; sale_date?: string;
  payment_date?: string | null; payment_method?: string; paid_date?: string | null; ksef_number?: string | null;
  paid_price?: number | string | null; left_to_pay?: number | string | null; gross_price?: number | string | null;
  client_company_name?: string | null; client_nip?: string | null;
  [pole: string]: unknown;
}>;

/** Nabywca do `przygotujNabywce` = wynik `daneFaktury(z)` (domena/dane-faktury.js); faktura okresu podaje sam `nip`. */
export type NabywcaDokumentu = Readonly<{
  firma?: string | null; nip?: string | null; ulica?: string | null; kod?: string | null;
  miasto?: string | null; kraj?: string | null; email?: string | null;
}>;

type Operacja<A extends unknown[], W> = (...a: A) => Promise<W>;

export type ProgramFakturowy = {
  readonly opis: OpisProgramu;
  readonly sprawdzPolaczenie: Operacja<[], unknown>;
  /** Pola do rozsypania w ładunku (`{ client_id }` dla inFaktu) albo `null`, gdy nabywcy nie ma i nie wolno go założyć.
   * KAŻDY błąd znaczy „dokumentu na pewno nie ma” (faza przygotowania zwalnia rezerwację). */
  readonly przygotujNabywce: (nabywca: NabywcaDokumentu, o?: Readonly<{ zalozGdyBrak?: boolean }>) => Promise<Readonly<Record<string, unknown>> | null>;
  readonly wystaw: Operacja<[ladunek: LadunekFaktury, ...reszta: unknown[]], unknown>;
  readonly wystawKorekte: Operacja<[ladunek: LadunekKorekty, ...reszta: unknown[]], unknown>;
  readonly pobierzPdf: Operacja<[id: string, ...reszta: unknown[]], Buffer>;
  readonly pobierzPdfKorekty: Operacja<[id: string, ...reszta: unknown[]], Buffer>;
  readonly pobierzFakture: Operacja<[id: string, ...reszta: unknown[]], WierszDokumentu | null>;
  readonly listaFaktur: Operacja<unknown[], readonly WierszDokumentu[]>;
  readonly listaKorekt: Operacja<unknown[], readonly WierszDokumentu[]>;
  /** Zdolność 'nieoplacone'. */
  readonly listaNieoplaconych?: Operacja<unknown[], readonly WierszDokumentu[]>;
  /** Zdolność 'oznaczZaplacona'. */
  readonly oznaczZaplacona?: Operacja<[id: string, ...reszta: unknown[]], unknown>;
  /** Zdolność 'wyslijDoKsef' — jedyny wołający: moduly/faktury/services/wysylka-ksef.js. */
  readonly wyslijDokumentDoKsef?: Operacja<[id: string, ...reszta: unknown[]], unknown>;
  /** Zdolność 'numeracjaWlasna' — strażnik duplikatu własnej serii WDT. */
  readonly iluMaNumer?: Operacja<[numer: string, ...reszta: unknown[]], number>;
};
