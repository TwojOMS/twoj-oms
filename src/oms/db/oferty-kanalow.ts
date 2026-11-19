import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { STAWKI_Z_ZW } from '../../domena/vat.js';
import { regulyKonta, sprawdzReguly } from '../../domena/cennik-dostaw.js';
import { maCennikiOms, regulyCennikowKonta, wCalosci, zapiszRegulyKonta } from './cenniki-oms.ts';

// Dostęp do rejestru ofert kanałów (`oferty_kanalow`) i ustawień ofert konta kanału
// (`oferty_ustawienia_kont`), tabele z migracji magazyn/0001. Bez logiki pętli synchronizacji i bez wyliczenia ceny.
// Kwoty w groszach (liczby całkowite). Narzut i próg potwierdzenia w procentach (np. 12.5) na wejściu i wyjściu,
// w bazie w punktach bazowych (1250) — wyjście podaje też `narzutBp`, żeby cenę liczyć bez ułamków.

export const STANY_OFERTY = Object.freeze([
  'szkic',
  'do_wyslania',
  'wyslana',
  'sprawdzana',
  'aktywna',
  'nieaktywna',
  'problem',
  'blad',
] as const);
export const POCHODZENIA_OFERTY = Object.freeze(['oms', 'przejeta'] as const);
export const TRYBY_OFERTY = Object.freeze(['obserwowana', 'zarzadzana'] as const);

export type StanOferty = (typeof STANY_OFERTY)[number];
export type PochodzenieOferty = (typeof POCHODZENIA_OFERTY)[number];
export type TrybOferty = (typeof TRYBY_OFERTY)[number];

export type OfertaKanalu = {
  id: number;
  kartaId: number;
  kanal: string;
  idZewnetrzne: string;
  pochodzenie: PochodzenieOferty;
  tryb: TrybOferty;
  stan: StanOferty;
  problemy: unknown[];
  problemyOd: string | null;
  wyslanePola: unknown;
  wyslanySkrot: string | null;
  wyslanaIlosc: number | null;
  wyslanaCenaGr: number | null;
  wyslanoAt: string | null;
  odczytIlosc: number | null;
  odczytCenaGr: number | null;
  odczytStatus: string | null;
  odczytZamrozone: unknown;
  odczytZarchiwizowana: boolean | null;
  odczytanoAt: string | null;
  cenaDoPotwierdzeniaGr: number | null;
  liczbaProb: number;
  nastepnaProbaAt: string | null;
  blad: string | null;
  // Kolumny z magazyn/0004: ilość z OMS, ślad ostatniej wysyłki ilości, ilość w toku `{cel, at}`,
  // problem ilości `{kod, wstrzymuje, od, cel, odczyt, zakres?, tekst}`, surowy odczyt kanału (może być < 0).
  iloscZOms: boolean;
  iloscWyslanaAt: string | null;
  stanKartyWyslany: number | null;
  iloscWToku: unknown;
  iloscProblem: unknown;
  odczytIloscKanalu: number | null;
  // Kolumny z magazyn/0005: cenę albo status oferty prowadzi OMS (także na ofercie obserwowanej).
  cenaZOms: boolean;
  statusZOms: boolean;
  utworzonoAt: string;
  zmienionoAt: string;
};

export type NowaOferta = {
  kartaId: number;
  kanal: string;
  idZewnetrzne: string;
  pochodzenie?: PochodzenieOferty;
  tryb?: TrybOferty;
  stan?: StanOferty;
};

export type UstawieniaOfertKonta = {
  klucz: string;
  zapisane: boolean;
  czynne: boolean;
  narzutProcent: number;
  narzutBp: number;
  progPotwierdzeniaProcent: number;
  progPotwierdzeniaBp: number;
  stalaIlosc: number | null;
  czasWysylkiDni: number | null;
  cennikDostaw: string | null;
  stawkaVat: string | null;
  producentId: string | null;
  osobaOdpowiedzialnaId: string | null;
  zwrotyId: string | null;
  reklamacjeId: string | null;
  gwarancjaId: string | null;
  lokalizacja: unknown;
  aktywujPoSprawdzeniu: boolean;
  bezpieczenstwoDomyslne: string | null;
  slowniki: unknown;
  buforSzt: number;
  progSkokuSzt: number;
  /** Reguły cenników od góry; ostatni wpis bez limitów = „dla większych”, jeden wpis = „wszystko”. */
  cenniki: readonly RegulaCennika[];
  zmienionoAt: string | null;
  aktorLogin: string | null;
};

/** Reguła cennika konta — wymiary w mm i waga w g (liczby całkowite); bez limitów = „dla większych”. */
export type RegulaCennika = { doMm?: number[]; doG?: number; cennik: string; nazwaOms?: string };

/** Zatwierdzenie stanów przed pierwszą wysyłką ilości — związane z przełączeniem magazynu, nie z datą. */
export type ZatwierdzenieStanow = {
  id: number;
  przelaczenieId: number;
  zatwierdzil: string | null;
  zatwierdzonoAt: string;
  ofert: number;
  skrot: string;
};

/** Ślad przepięcia powiązania produktu kanału z jednej karty na drugą. */
export type PrzepiecieStanu = {
  id: number;
  kanal: string;
  produktId: string;
  wariantId: string | null;
  zKarty: number | null;
  naKarte: number | null;
  iloscWstecz: number;
  kontoLogin: string | null;
  utworzonoAt: string;
};

/** Zdjęcie wgrane na konto Allegro — adres z odpowiedzi i znacznik AI z chwili wgrania. */
export type WgraneZdjecieAllegro = {
  zdjecieId: number;
  konto: string;
  adres: string;
  ai: 0 | 1;
  wygasaAt: string | null;
  wgranoAt: string;
};

/** Najdłuższa informacja o bezpieczeństwie produktu przyjmowana przez Allegro (`safetyInformation`). */
export const BEZPIECZENSTWO_MAKS_ZNAKOW = 5000;

type Opcje = { teraz?: string };
type Wiersz = Record<string, SQLInputValue>;

// Zera nie zapisujemy jako stałej ilości — oferta schodzi przyciskiem „Zdejmij” (albo cel 0 z OMS-u → END).
export const STALA_ILOSC_ZERO =
  '0 sztuk = zdejmij ofertę przyciskiem „Zdejmij” na karcie w Magazynie; stała ilość to liczba od 1 do 1000000';

/** Oferty wstrzymane, stała ilość nieustawiona, próg 20%. Konto bez wiersza dostaje te wartości. */
export const DOMYSLNE_USTAWIENIA_OFERT = Object.freeze({
  czynne: false,
  narzutBp: 0,
  progPotwierdzeniaBp: 2000,
  stalaIlosc: null,
  czasWysylkiDni: null,
  cennikDostaw: null,
  stawkaVat: null,
  producentId: null,
  osobaOdpowiedzialnaId: null,
  // Warunki i lokalizacja nieustawione, „Aktywuj po sprawdzeniu” domyślnie nie.
  zwrotyId: null,
  reklamacjeId: null,
  gwarancjaId: null,
  lokalizacja: null,
  aktywujPoSprawdzeniu: false,
  bezpieczenstwoDomyslne: null,
  slowniki: null,
  // Bez bufora, próg skoku stanu karty 5 szt.
  buforSzt: 0,
  progSkokuSzt: 5,
  // Konto bez reguł cenników.
  cenniki: Object.freeze([]) as readonly RegulaCennika[],
});

const teraz = (o?: Opcje) => o?.teraz ?? new Date().toISOString();
const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : null);

function tekst(nazwa: string, v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Pole ${nazwa} musi być niepustym tekstem`);
  return v;
}
function tekstLubNull(nazwa: string, v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw new Error(`Pole ${nazwa} musi być tekstem albo null`);
  return v;
}
function calkowita(nazwa: string, v: unknown, od: number, opis = 'liczbą całkowitą'): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < od)
    throw new Error(`Pole ${nazwa} musi być ${opis} ≥ ${od}`);
  return v;
}
const grosze = (nazwa: string) => (v: unknown) =>
  v === null ? null : calkowita(nazwa, v, 0, 'liczbą całkowitą groszy');
const ilosc = (nazwa: string) => (v: unknown) => (v === null ? null : calkowita(nazwa, v, 0));
const tekstowe = (nazwa: string) => (v: unknown) => tekstLubNull(nazwa, v);
/** Liczba całkowita dowolnego znaku albo null — surowy odczyt kanału i stan karty mogą być ujemne. */
const calkowitaLubNull = (nazwa: string) => (v: unknown) => {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v))
    throw new Error(`Pole ${nazwa} musi być liczbą całkowitą albo null`);
  return v;
};
/** Flaga 0/1 w bazie, na wejściu wyłącznie true/false — 1 albo 'tak' to pomyłka wołającego, nie „prawda”. */
const flaga = (nazwa: string) => (v: unknown) => {
  if (typeof v !== 'boolean') throw new Error(`Pole ${nazwa} musi być true albo false`);
  return v ? 1 : 0;
};
function wZakresie(opis: string, v: unknown, od: number, do_: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < od || v > do_)
    throw new Error(`${opis} musi być liczbą całkowitą od ${od} do ${do_}`);
  return v;
}
const jsonLubNull = (nazwa: string) => (v: unknown) => {
  if (v === null) return null;
  if (typeof v !== 'object') throw new Error(`Pole ${nazwa} musi być obiektem, tablicą albo null`);
  return JSON.stringify(v);
};
const obiektLubNull = (nazwa: string) => (v: unknown) => {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`Pole ${nazwa} musi być obiektem albo null`);
  return JSON.stringify(v);
};
function zListy<T extends string>(nazwa: string, lista: readonly T[], v: unknown): T {
  if (typeof v !== 'string' || !(lista as readonly string[]).includes(v))
    throw new Error(`Nieznany ${nazwa}: ${String(v)}`);
  return v as T;
}

/** Pola oferty, które wolno zmieniać: camelCase → [kolumna, zamiana na wartość bazy]. Karta, konto, id i pochodzenie są stałe. */
const POLA_OFERTY: Record<string, readonly [string, (v: unknown) => SQLInputValue]> = {
  stan: ['stan', (v) => zListy('stan oferty', STANY_OFERTY, v)],
  tryb: ['tryb', (v) => zListy('tryb oferty', TRYBY_OFERTY, v)],
  problemy: [
    'problemy_json',
    (v) => {
      if (v === null) return null;
      if (!Array.isArray(v)) throw new Error('Pole problemy musi być tablicą albo null');
      return JSON.stringify(v);
    },
  ],
  wyslanePola: ['wyslane_pola_json', jsonLubNull('wyslanePola')],
  wyslanySkrot: ['wyslany_skrot', tekstowe('wyslanySkrot')],
  wyslanaIlosc: ['wyslana_ilosc', ilosc('wyslanaIlosc')],
  wyslanaCenaGr: ['wyslana_cena_gr', grosze('wyslanaCenaGr')],
  wyslanoAt: ['wyslano_at', tekstowe('wyslanoAt')],
  odczytIlosc: ['odczyt_ilosc', ilosc('odczytIlosc')],
  odczytCenaGr: ['odczyt_cena_gr', grosze('odczytCenaGr')],
  odczytStatus: ['odczyt_status', tekstowe('odczytStatus')],
  odczytZamrozone: ['odczyt_zamrozone_json', jsonLubNull('odczytZamrozone')],
  odczytZarchiwizowana: [
    'odczyt_zarchiwizowana',
    (v) => {
      if (v === null) return null;
      if (typeof v !== 'boolean') throw new Error('Pole odczytZarchiwizowana musi być true, false albo null');
      return v ? 1 : 0;
    },
  ],
  odczytanoAt: ['odczytano_at', tekstowe('odczytanoAt')],
  cenaDoPotwierdzeniaGr: ['cena_do_potwierdzenia_gr', grosze('cenaDoPotwierdzeniaGr')],
  liczbaProb: ['liczba_prob', (v) => calkowita('liczbaProb', v, 0)],
  nastepnaProbaAt: ['nastepna_proba_at', tekstowe('nastepnaProbaAt')],
  blad: ['blad', tekstowe('blad')],
  // Kolumny z magazyn/0004 bez CHECK w bazie, więc pilnuje ich ten słownik.
  iloscZOms: [
    'ilosc_z_oms',
    (v) => {
      if (typeof v !== 'boolean') throw new Error('Pole iloscZOms musi być true albo false');
      return v ? 1 : 0;
    },
  ],
  iloscWyslanaAt: ['ilosc_wyslana_at', tekstowe('iloscWyslanaAt')],
  stanKartyWyslany: ['stan_karty_wyslany', calkowitaLubNull('stanKartyWyslany')],
  iloscWToku: ['ilosc_w_toku_json', obiektLubNull('iloscWToku')],
  iloscProblem: ['ilosc_problem_json', obiektLubNull('iloscProblem')],
  odczytIloscKanalu: ['odczyt_ilosc_kanalu', calkowitaLubNull('odczytIloscKanalu')],
  // Kolumny z magazyn/0005, tak samo bez CHECK w bazie.
  cenaZOms: ['cena_z_oms', flaga('cenaZOms')],
  statusZOms: ['status_z_oms', flaga('statusZOms')],
};

function oferta(w: Wiersz | undefined): OfertaKanalu | null {
  if (!w) return null;
  const zapisane = (json(w.problemy_json) as unknown[] | null) ?? [];
  const daty = zapisane
    .flatMap((p) => {
      if (!p || typeof p !== 'object' || !('od' in p) || typeof p.od !== 'string') return [];
      return [p.od];
    })
    .sort();
  const problemy = zapisane.map((p) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return p;
    const { od: _od, ...reszta } = p as Record<string, unknown>;
    return reszta;
  });
  return {
    id: Number(w.id),
    kartaId: Number(w.karta_id),
    kanal: String(w.kanal),
    idZewnetrzne: String(w.id_zewnetrzne),
    pochodzenie: w.pochodzenie as PochodzenieOferty,
    tryb: w.tryb as TrybOferty,
    stan: w.stan as StanOferty,
    problemy,
    problemyOd: daty[0] ?? (w.stan === 'blad' && !problemy.length ? String(w.zmieniono_at) : null),
    wyslanePola: json(w.wyslane_pola_json),
    wyslanySkrot: w.wyslany_skrot as string | null,
    wyslanaIlosc: w.wyslana_ilosc as number | null,
    wyslanaCenaGr: w.wyslana_cena_gr as number | null,
    wyslanoAt: w.wyslano_at as string | null,
    odczytIlosc: w.odczyt_ilosc as number | null,
    odczytCenaGr: w.odczyt_cena_gr as number | null,
    odczytStatus: w.odczyt_status as string | null,
    odczytZamrozone: json(w.odczyt_zamrozone_json),
    odczytZarchiwizowana: w.odczyt_zarchiwizowana === null ? null : w.odczyt_zarchiwizowana === 1,
    odczytanoAt: w.odczytano_at as string | null,
    cenaDoPotwierdzeniaGr: w.cena_do_potwierdzenia_gr as number | null,
    liczbaProb: Number(w.liczba_prob),
    nastepnaProbaAt: w.nastepna_proba_at as string | null,
    blad: w.blad as string | null,
    // Kolumny z magazyn/0004 — baza bez tej migracji daje zachowanie bez ilości z OMS.
    iloscZOms: w.ilosc_z_oms === 1,
    iloscWyslanaAt: (w.ilosc_wyslana_at as string | null | undefined) ?? null,
    stanKartyWyslany: (w.stan_karty_wyslany as number | null | undefined) ?? null,
    iloscWToku: json(w.ilosc_w_toku_json),
    iloscProblem: json(w.ilosc_problem_json),
    odczytIloscKanalu: (w.odczyt_ilosc_kanalu as number | null | undefined) ?? null,
    // Kolumny z magazyn/0005 — baza bez tej migracji daje zachowanie bez ceny i statusu z OMS.
    cenaZOms: w.cena_z_oms === 1,
    statusZOms: w.status_z_oms === 1,
    utworzonoAt: String(w.utworzono_at),
    zmienionoAt: String(w.zmieniono_at),
  };
}

export function ofertaPoId(db: DatabaseSync, id: number): OfertaKanalu | null {
  return oferta(db.prepare('SELECT * FROM oferty_kanalow WHERE id = ?').get(id) as Wiersz | undefined);
}

export function ofertaPoIdZewnetrznym(db: DatabaseSync, kanal: string, idZewnetrzne: string): OfertaKanalu | null {
  return oferta(
    db.prepare('SELECT * FROM oferty_kanalow WHERE kanal = ? AND id_zewnetrzne = ?').get(kanal, idZewnetrzne) as
      Wiersz | undefined,
  );
}

export function ofertyKarty(db: DatabaseSync, kartaId: number): OfertaKanalu[] {
  return (
    db.prepare('SELECT * FROM oferty_kanalow WHERE karta_id = ? ORDER BY kanal, id').all(kartaId) as Wiersz[]
  ).map((w) => oferta(w) as OfertaKanalu);
}

// Alarm ilości czeka na decyzję, gdy wstrzymuje wysyłkę; `brak-stanu` — bo prowadzi do stanu otwarcia.
const PROBLEM_ILOSCI =
  "(json_extract(o.ilosc_problem_json, '$.wstrzymuje') = 1 OR json_extract(o.ilosc_problem_json, '$.kod') = 'brak-stanu')";
const DO_DECYZJI = `o.stan IN ('problem', 'blad') OR o.cena_do_potwierdzenia_gr IS NOT NULL OR ${PROBLEM_ILOSCI}`;
const filtrDecyzji = (ilosc: boolean) => (ilosc ? PROBLEM_ILOSCI : `(${DO_DECYZJI})`);

/** Najstarsze problemy najpierw; limit dopiero po odczytaniu czasu ukrytego w JSON. `ilosc` — tylko alarmy ilości. */
export function ofertyDoDecyzji(
  db: DatabaseSync,
  { limit = 200, ilosc = false }: { limit?: number; ilosc?: boolean } = {},
): (OfertaKanalu & { nazwa: string; sku: string | null })[] {
  calkowita('limit', limit, 0);
  return (
    db
      .prepare(
        `SELECT o.*, k.nazwa, k.sku FROM oferty_kanalow o
    JOIN karty_produktow k ON k.id = o.karta_id WHERE ${filtrDecyzji(ilosc)}`,
      )
      .all() as Wiersz[]
  )
    .map((w) => ({ ...(oferta(w) as OfertaKanalu), nazwa: String(w.nazwa), sku: w.sku as string | null }))
    .sort((a, b) => (a.problemyOd ?? a.zmienionoAt).localeCompare(b.problemyOd ?? b.zmienionoAt) || a.id - b.id)
    .slice(0, limit);
}

export function liczbaOfertDoDecyzji(db: DatabaseSync, { ilosc = false }: { ilosc?: boolean } = {}): number {
  const w = db
    .prepare(
      `SELECT COUNT(*) AS n FROM oferty_kanalow o
    JOIN karty_produktow k ON k.id = o.karta_id WHERE ${filtrDecyzji(ilosc)}`,
    )
    .get() as Wiersz;
  return Number(w.n);
}

/** Oferty konta z danym kodem alarmu ilości („Wyślij zera” — całe konto naraz). */
export function ofertyZProblememIlosci(db: DatabaseSync, kanal: string, kod: string): OfertaKanalu[] {
  return (
    db
      .prepare(
        `SELECT * FROM oferty_kanalow WHERE kanal = ? AND json_extract(ilosc_problem_json, '$.kod') = ? ORDER BY id`,
      )
      .all(kanal, kod) as Wiersz[]
  ).map((w) => oferta(w) as OfertaKanalu);
}

/** Kasuje wiersz rejestru (np. oferta usunięta w Allegro). Nic w kanale się nie zmienia; zwraca liczbę usuniętych. */
export function usunOferte(db: DatabaseSync, id: number): number {
  return Number(db.prepare('DELETE FROM oferty_kanalow WHERE id = ?').run(id).changes);
}

/** Nowy wiersz rejestru. Z OMS-u → tryb `zarzadzana`, przejęta → `obserwowana`. Druga oferta OMS tej samej
 * karty na tym samym koncie albo powtórzone (konto, id zewnętrzne) kończy się błędem bazy. */
export function wstawOferte(db: DatabaseSync, nowa: NowaOferta, opcje?: Opcje): OfertaKanalu {
  const kartaId = calkowita('kartaId', nowa.kartaId, 1);
  const kanal = tekst('kanal', nowa.kanal);
  const idZewnetrzne = tekst('idZewnetrzne', nowa.idZewnetrzne);
  const pochodzenie = zListy('rodzaj pochodzenia oferty', POCHODZENIA_OFERTY, nowa.pochodzenie ?? 'oms');
  const tryb = zListy('tryb oferty', TRYBY_OFERTY, nowa.tryb ?? (pochodzenie === 'oms' ? 'zarzadzana' : 'obserwowana'));
  const stan = zListy('stan oferty', STANY_OFERTY, nowa.stan ?? 'szkic');
  const t = teraz(opcje);
  const wynik = db
    .prepare(
      `INSERT INTO oferty_kanalow (karta_id, kanal, id_zewnetrzne, pochodzenie, tryb, stan, utworzono_at, zmieniono_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(kartaId, kanal, idZewnetrzne, pochodzenie, tryb, stan, t, t);
  return ofertaPoId(db, Number(wynik.lastInsertRowid)) as OfertaKanalu;
}

/** Zmienia wskazane pola oferty (stan, próby, termin, błąd, ostatnia wysyłka, ostatni odczyt, cena do potwierdzenia).
 * Najpierw sprawdza wszystkie pola, potem zapisuje jednym UPDATE. Brak oferty → null. */
export function zmienOferte(
  db: DatabaseSync,
  id: number,
  zmiany: Record<string, unknown>,
  opcje?: Opcje,
): OfertaKanalu | null {
  const kolumny: string[] = [];
  const wartosci: SQLInputValue[] = [];
  const t = teraz(opcje);
  for (const [pole, v] of Object.entries(zmiany)) {
    const opis = POLA_OFERTY[pole];
    if (!opis) throw new Error(`Nieznane albo stałe pole oferty: ${pole}`);
    kolumny.push(`${opis[0]} = ?`);
    let wartosc = opis[1](v);
    if (pole === 'problemy' && Array.isArray(v)) {
      const w = db.prepare('SELECT problemy_json FROM oferty_kanalow WHERE id = ?').get(id) as Wiersz | undefined;
      const poprzednie = ((json(w?.problemy_json) as unknown[] | null) ?? []).filter(
        (p): p is Record<string, unknown> => p !== null && typeof p === 'object' && !Array.isArray(p),
      );
      wartosc = JSON.stringify(
        v.map((p: unknown) => {
          if (!p || typeof p !== 'object' || Array.isArray(p)) return p;
          const problem = p as Record<string, unknown>;
          const stary = poprzednie.find(
            (x) => typeof problem.kod === 'string' && x.kod === problem.kod && typeof x.od === 'string',
          );
          return { ...problem, od: stary?.od ?? t };
        }),
      );
    }
    wartosci.push(wartosc);
  }
  if (!ofertaPoId(db, id)) return null;
  if (!kolumny.length) return ofertaPoId(db, id);
  db.prepare(`UPDATE oferty_kanalow SET ${kolumny.join(', ')}, zmieniono_at = ? WHERE id = ?`).run(...wartosci, t, id);
  return ofertaPoId(db, id);
}

/** Przedrostek tymczasowego id oferty przed POST: `ext:` + `external.id` wysłany do Allegro. */
export const PRZEDROSTEK_EXT = 'ext:';

/** Po przyjęciu oferty (201/202) zamienia tymczasowe `ext:…` na numer oferty — tylko z `ext:…` i tylko raz.
 * Wiersz z innym id (już przypisany, przejęty) → odmowa, nic nie zmienione. Numer zajęty na koncie → błąd bazy
 * (`UNIQUE (kanal, id_zewnetrzne)`). Brak oferty → null. */
export function przypiszIdZewnetrzne(db: DatabaseSync, id: number, nowe: string, opcje?: Opcje): OfertaKanalu | null {
  const numer = tekst('nowe id zewnętrzne', nowe);
  if (numer.startsWith(PRZEDROSTEK_EXT)) throw new Error('Numer oferty nie może zaczynać się od „ext:”');
  if (!ofertaPoId(db, id)) return null;
  const wynik = db
    .prepare(
      `UPDATE oferty_kanalow SET id_zewnetrzne = ?, zmieniono_at = ?
    WHERE id = ? AND substr(id_zewnetrzne, 1, 4) = 'ext:'`,
    )
    .run(numer, teraz(opcje), id);
  if (Number(wynik.changes) !== 1)
    throw new Error('Numer oferty przypisuje się tylko raz, do wiersza z tymczasowym „ext:…”');
  return ofertaPoId(db, id);
}

function procentNaBp(nazwa: string, v: unknown, od: number, doBp: number): number {
  const bp = typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : NaN;
  if (Number.isNaN(bp) || Math.abs(bp - (v as number) * 100) > 1e-6 || bp < od || bp > doBp) {
    throw new Error(`${nazwa} musi być liczbą od ${od / 100} do ${doBp / 100} z najwyżej dwoma miejscami po przecinku`);
  }
  return bp;
}

/** Ustawienia ofert, które wolno zapisać: camelCase → [kolumna, zamiana na wartość bazy]. */
const POLA_USTAWIEN: Record<string, readonly [string, (v: unknown) => SQLInputValue]> = {
  czynne: [
    'oferty_czynne',
    (v) => {
      if (typeof v !== 'boolean') throw new Error('Przełącznik „czynne” musi być true albo false');
      return v ? 1 : 0;
    },
  ],
  narzutProcent: ['narzut_bp', (v) => procentNaBp('Narzut (%)', v, 0, 100000)],
  progPotwierdzeniaProcent: ['prog_potwierdzenia_bp', (v) => procentNaBp('Próg potwierdzenia ceny (%)', v, 1, 100000)],
  stalaIlosc: [
    'stala_ilosc',
    (v) => {
      if (v === null) return null;
      if (v === 0) throw new Error(STALA_ILOSC_ZERO);
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 1000000)
        throw new Error('Stała ilość musi być liczbą całkowitą od 1 do 1000000 albo pusta');
      return v;
    },
  ],
  czasWysylkiDni: [
    'czas_wysylki_dni',
    (v) => {
      if (v === null) return null;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 365)
        throw new Error('Czas wysyłki musi być liczbą dni od 0 do 365 albo pusty');
      return v;
    },
  ],
  cennikDostaw: ['cennik_dostaw', tekstowe('cennikDostaw')],
  stawkaVat: [
    'stawka_vat',
    (v) => {
      if (v === null) return null;
      if (typeof v !== 'string' || !(STAWKI_Z_ZW as readonly string[]).includes(v))
        throw new Error(`Nieznana stawka VAT: ${String(v)}`);
      return v;
    },
  ],
  producentId: ['producent_id', tekstowe('producentId')],
  osobaOdpowiedzialnaId: ['osoba_odpowiedzialna_id', tekstowe('osobaOdpowiedzialnaId')],
  zwrotyId: ['zwroty_id', tekstowe('zwrotyId')],
  reklamacjeId: ['reklamacje_id', tekstowe('reklamacjeId')],
  gwarancjaId: ['gwarancja_id', tekstowe('gwarancjaId')],
  lokalizacja: ['lokalizacja_json', obiektLubNull('lokalizacja')],
  aktywujPoSprawdzeniu: [
    'aktywuj_po_sprawdzeniu',
    (v) => {
      if (typeof v !== 'boolean') throw new Error('Przełącznik „Aktywuj po sprawdzeniu” musi być true albo false');
      return v ? 1 : 0;
    },
  ],
  bezpieczenstwoDomyslne: [
    'bezpieczenstwo_domyslne',
    (v) => {
      if (v === null) return null;
      if (typeof v !== 'string' || !v.trim() || v.length > BEZPIECZENSTWO_MAKS_ZNAKOW) {
        throw new Error(
          `Informacja o bezpieczeństwie musi mieć od 1 do ${BEZPIECZENSTWO_MAKS_ZNAKOW} znaków albo być pusta`,
        );
      }
      return v;
    },
  ],
  slowniki: ['slowniki_json', obiektLubNull('slowniki')],
  // Kolumny z magazyn/0004 bez CHECK w bazie.
  buforSzt: ['bufor_szt', (v) => wZakresie('Bufor (szt.)', v, 0, 1000000)],
  progSkokuSzt: ['prog_skoku_szt', (v) => wZakresie('Próg skoku stanu (szt.)', v, 1, 1000000)],
  // Cała lista reguł naraz; `null` = konto bez reguł.
  cenniki: [
    'cenniki_json',
    (v) => {
      const { reguly, bledy } = sprawdzReguly(v ?? []);
      if (bledy.length) throw new Error(`Reguły cenników: ${bledy.join(' ')}`);
      return JSON.stringify(
        reguly.map((r: RegulaCennika, i: number) =>
          i === reguly.length - 1 ? { cennik: r.cennik.trim() } : { doMm: r.doMm, doG: r.doG, cennik: r.cennik.trim() },
        ),
      );
    },
  ],
};

/** Reguły konta z cenników OMS (magazyn/0006); baza bez nich — z wiersza: `cenniki_json`, a gdy pusta albo kolumny
 * brak (baza bez magazyn/0003) — dawne pole. */
function cennikiKonta(db: DatabaseSync, klucz: string, w: Wiersz | undefined): readonly RegulaCennika[] {
  if (maCennikiOms(db)) return regulyCennikowKonta(db, klucz);
  if (!w) return DOMYSLNE_USTAWIENIA_OFERT.cenniki;
  const lista = json(w.cenniki_json);
  return Array.isArray(lista) ? lista : regulyKonta({ cennikDostaw: w.cennik_dostaw });
}

const maKolumneCennikow = (db: DatabaseSync) =>
  (db.prepare('PRAGMA table_info(oferty_ustawienia_kont)').all() as { name: string }[]).some(
    (k) => k.name === 'cenniki_json',
  );

/** Ustawienia ofert konta kanału. Konto bez zapisanego wiersza (także każde nowe) → wartości domyślne, `zapisane: false`. */
export function ustawieniaOfertKonta(db: DatabaseSync, klucz: string): UstawieniaOfertKonta {
  const w = db.prepare('SELECT * FROM oferty_ustawienia_kont WHERE klucz = ?').get(klucz) as Wiersz | undefined;
  const d = DOMYSLNE_USTAWIENIA_OFERT;
  const narzutBp = w ? Number(w.narzut_bp) : d.narzutBp;
  const progBp = w ? Number(w.prog_potwierdzenia_bp) : d.progPotwierdzeniaBp;
  return {
    klucz,
    zapisane: Boolean(w),
    czynne: w ? w.oferty_czynne === 1 : d.czynne,
    narzutProcent: narzutBp / 100,
    narzutBp,
    progPotwierdzeniaProcent: progBp / 100,
    progPotwierdzeniaBp: progBp,
    stalaIlosc: w ? (w.stala_ilosc as number | null) : d.stalaIlosc,
    czasWysylkiDni: w ? (w.czas_wysylki_dni as number | null) : d.czasWysylkiDni,
    cennikDostaw: w ? (w.cennik_dostaw as string | null) : d.cennikDostaw,
    stawkaVat: w ? (w.stawka_vat as string | null) : d.stawkaVat,
    producentId: w ? (w.producent_id as string | null) : d.producentId,
    osobaOdpowiedzialnaId: w ? (w.osoba_odpowiedzialna_id as string | null) : d.osobaOdpowiedzialnaId,
    // Kolumny z magazyn/0002 — baza bez tej migracji (moduł w starszej wersji) daje wartości domyślne.
    zwrotyId: (w?.zwroty_id as string | null | undefined) ?? d.zwrotyId,
    reklamacjeId: (w?.reklamacje_id as string | null | undefined) ?? d.reklamacjeId,
    gwarancjaId: (w?.gwarancja_id as string | null | undefined) ?? d.gwarancjaId,
    lokalizacja: json(w?.lokalizacja_json) ?? d.lokalizacja,
    aktywujPoSprawdzeniu:
      w?.aktywuj_po_sprawdzeniu === undefined ? d.aktywujPoSprawdzeniu : w.aktywuj_po_sprawdzeniu === 1,
    bezpieczenstwoDomyslne: (w?.bezpieczenstwo_domyslne as string | null | undefined) ?? d.bezpieczenstwoDomyslne,
    slowniki: json(w?.slowniki_json) ?? d.slowniki,
    // Kolumny z magazyn/0004 — baza bez tej migracji daje wartości domyślne.
    buforSzt: (w?.bufor_szt as number | undefined) ?? d.buforSzt,
    progSkokuSzt: (w?.prog_skoku_szt as number | undefined) ?? d.progSkokuSzt,
    cenniki: cennikiKonta(db, klucz, w),
    zmienionoAt: w ? String(w.zmieniono_at) : null,
    aktorLogin: w ? (w.aktor_login as string | null) : null,
  };
}

/** Zapis częściowy: zmienia tylko podane pola, reszta zostaje (przy pierwszym zapisie — domyślne z bazy).
 * Najpierw sprawdza wszystkie pola; błąd = nic nie zapisane. */
export function zapiszUstawieniaOfertKonta(
  db: DatabaseSync,
  klucz: string,
  zmiany: Record<string, unknown>,
  opcje?: Opcje & { aktor?: string | null },
): UstawieniaOfertKonta {
  tekst('klucz', klucz);
  const kolumny: string[] = [];
  const wartosci: SQLInputValue[] = [];
  for (const [pole, v] of Object.entries(zmiany)) {
    const opis = POLA_USTAWIEN[pole];
    if (!opis) throw new Error(`Nieznane ustawienie ofert: ${pole}`);
    kolumny.push(opis[0]);
    wartosci.push(opis[1](v));
  }
  // `cennikDostaw` to alias jednej reguły „wszystko”; obu pól naraz nie wolno.
  if ('cenniki' in zmiany || 'cennikDostaw' in zmiany) {
    if ('cenniki' in zmiany && 'cennikDostaw' in zmiany)
      throw new Error('Podaj albo cenniki, albo cennikDostaw — nie oba naraz');
    const kolumna = maKolumneCennikow(db);
    if ('cenniki' in zmiany && !kolumna)
      throw new Error('Baza bez migracji magazyn/0003 — reguł cenników nie da się zapisać');
    if ('cennikDostaw' in zmiany && kolumna) {
      const stary = (zmiany.cennikDostaw as string | null)?.trim();
      kolumny.push('cenniki_json');
      wartosci.push(stary ? JSON.stringify([{ cennik: stary }]) : null);
    }
  }
  const wszystkie = [...kolumny, 'zmieniono_at', 'aktor_login'];
  const zapisz = () =>
    db
      .prepare(
        `INSERT INTO oferty_ustawienia_kont (klucz, ${wszystkie.join(', ')}) VALUES (?, ${wszystkie.map(() => '?').join(', ')})
    ON CONFLICT (klucz) DO UPDATE SET ${wszystkie.map((k) => `${k} = excluded.${k}`).join(', ')}`,
      )
      .run(klucz, ...wartosci, teraz(opcje), opcje?.aktor ?? null);
  // Dobór czyta już cenniki OMS: dawny zapis reguł konta przekładamy na powiązania tego konta, żeby nie przepadł.
  if (('cenniki' in zmiany || 'cennikDostaw' in zmiany) && maCennikiOms(db)) {
    const stary = 'cennikDostaw' in zmiany ? (zmiany.cennikDostaw as string | null)?.trim() : null;
    const reguly =
      'cenniki' in zmiany ? ((zmiany.cenniki as RegulaCennika[] | null) ?? []) : stary ? [{ cennik: stary }] : [];
    wCalosci(db, () => {
      zapisz();
      zapiszRegulyKonta(db, klucz, reguly, { teraz: teraz(opcje), aktor: opcje?.aktor ?? null });
    });
  } else zapisz();
  return ustawieniaOfertKonta(db, klucz);
}

/** Zapisuje adres zdjęcia wgranego na konto Allegro i — w tej samej transakcji — oznacza zdjęcie karty jako
 * wysłane (`zdjecia_kart.wyslane_at`, tylko gdy puste). Od tej chwili znacznika AI nie da się zmienić na karcie.
 * Ponowne wgranie (adres wygasł) zmienia adres i daty w mapie; pierwsza data wysłania zostaje. */
export function zapiszWgraneZdjecie(
  db: DatabaseSync,
  z: { zdjecieId: number; konto: string; adres: string; ai: number; wygasaAt?: string | null },
  opcje?: Opcje,
): WgraneZdjecieAllegro {
  const zdjecieId = calkowita('zdjecieId', z.zdjecieId, 1);
  const konto = tekst('konto', z.konto);
  const adres = tekst('adres', z.adres);
  if (z.ai !== 0 && z.ai !== 1) throw new Error('Znacznik AI wgranego zdjęcia musi być 0 albo 1');
  const wygasaAt = tekstLubNull('wygasaAt', z.wygasaAt ?? null);
  const t = teraz(opcje);
  db.exec('SAVEPOINT wgrane_zdjecie_allegro');
  try {
    const zdj = db.prepare('SELECT ai FROM zdjecia_kart WHERE id = ?').get(zdjecieId) as
      { ai: number | null } | undefined;
    if (!zdj) throw new Error(`Zdjęcie ${zdjecieId} nie istnieje`);
    // Znacznik na karcie mógł się zmienić, gdy zdjęcie szło do Allegro — nie zamrażamy sprzeczności.
    if (zdj.ai === null || zdj.ai !== z.ai) {
      throw new Error(
        `Znacznik AI zdjęcia ${zdjecieId} zmienił się w trakcie wgrywania (karta: ${zdj.ai ?? 'brak'}, wgrane: ${z.ai})`,
      );
    }
    db.prepare(
      `INSERT INTO zdjecia_kart_allegro (zdjecie_id, konto, adres, ai, wygasa_at, wgrano_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (zdjecie_id, konto) DO UPDATE SET adres = excluded.adres, ai = excluded.ai,
      wygasa_at = excluded.wygasa_at, wgrano_at = excluded.wgrano_at`,
    ).run(zdjecieId, konto, adres, z.ai, wygasaAt, t);
    db.prepare('UPDATE zdjecia_kart SET wyslane_at = ? WHERE id = ? AND wyslane_at IS NULL').run(t, zdjecieId);
    db.exec('RELEASE wgrane_zdjecie_allegro');
  } catch (e) {
    db.exec('ROLLBACK TO wgrane_zdjecie_allegro');
    db.exec('RELEASE wgrane_zdjecie_allegro');
    throw e;
  }
  return { zdjecieId, konto, adres, ai: z.ai, wygasaAt, wgranoAt: t };
}

/** Zdjęcia karty wgrane na wskazane konto Allegro, w kolejności galerii karty. */
export function wgraneZdjeciaAllegro(
  db: DatabaseSync,
  { kartaId, konto }: { kartaId: number; konto: string },
): WgraneZdjecieAllegro[] {
  return (
    db
      .prepare(
        `SELECT a.zdjecie_id, a.konto, a.adres, a.ai, a.wygasa_at, a.wgrano_at
    FROM zdjecia_kart_allegro a JOIN zdjecia_kart z ON z.id = a.zdjecie_id
    WHERE z.karta_id = ? AND a.konto = ? ORDER BY z.kolejnosc, z.id`,
      )
      .all(kartaId, konto) as Wiersz[]
  ).map((w) => ({
    zdjecieId: Number(w.zdjecie_id),
    konto: String(w.konto),
    adres: String(w.adres),
    ai: (w.ai === 1 ? 1 : 0) as 0 | 1,
    wygasaAt: w.wygasa_at as string | null,
    wgranoAt: String(w.wgrano_at),
  }));
}

function zatwierdzenie(w: Wiersz | undefined): ZatwierdzenieStanow | null {
  if (!w) return null;
  return {
    id: Number(w.id),
    przelaczenieId: Number(w.przelaczenie_id),
    zatwierdzil: w.zatwierdzil as string | null,
    zatwierdzonoAt: String(w.zatwierdzono_at),
    ofert: Number(w.ofert),
    skrot: String(w.skrot),
  };
}

/** Zapis zatwierdzenia stanów dla przełączenia magazynu (`magazyn_przelaczenia.id`). Kolejne zatwierdzenie
 * tego samego przełączenia dopisuje nowy wiersz — obowiązuje ostatnie. */
export function zapiszZatwierdzenieStanow(
  db: DatabaseSync,
  dane: { przelaczenieId: number; zatwierdzil: string | null; ofert: number; skrot: string },
  opcje?: Opcje,
): ZatwierdzenieStanow {
  const przelaczenieId = calkowita('przelaczenieId', dane.przelaczenieId, 1);
  const zatwierdzil = tekstLubNull('zatwierdzil', dane.zatwierdzil ?? null);
  const ofert = calkowita('ofert', dane.ofert, 0);
  const skrot = tekst('skrot', dane.skrot);
  const wynik = db
    .prepare(
      `INSERT INTO stany_zatwierdzenia (przelaczenie_id, zatwierdzil, zatwierdzono_at, ofert, skrot)
    VALUES (?, ?, ?, ?, ?)`,
    )
    .run(przelaczenieId, zatwierdzil, teraz(opcje), ofert, skrot);
  return zatwierdzenie(
    db.prepare('SELECT * FROM stany_zatwierdzenia WHERE id = ?').get(Number(wynik.lastInsertRowid)) as Wiersz,
  ) as ZatwierdzenieStanow;
}

/** Obowiązujące (ostatnie) zatwierdzenie stanów dla przełączenia; brak → null. */
export function zatwierdzenieStanow(db: DatabaseSync, przelaczenieId: number): ZatwierdzenieStanow | null {
  return zatwierdzenie(
    db
      .prepare('SELECT * FROM stany_zatwierdzenia WHERE przelaczenie_id = ? ORDER BY id DESC LIMIT 1')
      .get(przelaczenieId) as Wiersz | undefined,
  );
}

/** Ślad przepięcia powiązania produktu kanału z karty `zKarty` na kartę `naKarte` (null = brak karty po tej
 * stronie) z ilością cofniętą wstecz. Ta sama karta po obu stronach to nie przepięcie. */
export function zapiszPrzepiecie(
  db: DatabaseSync,
  dane: {
    kanal: string;
    produktId: string;
    wariantId?: string | null;
    zKarty: number | null;
    naKarte: number | null;
    iloscWstecz: number;
    kontoLogin?: string | null;
  },
  opcje?: Opcje,
): PrzepiecieStanu {
  const kanal = tekst('kanal', dane.kanal);
  const produktId = tekst('produktId', dane.produktId);
  const wariantId = tekstLubNull('wariantId', dane.wariantId ?? null);
  const zKarty = dane.zKarty === null ? null : calkowita('zKarty', dane.zKarty, 1);
  const naKarte = dane.naKarte === null ? null : calkowita('naKarte', dane.naKarte, 1);
  if (zKarty === naKarte) throw new Error('Przepięcie wymaga dwóch różnych kart');
  const iloscWstecz = calkowita('iloscWstecz', dane.iloscWstecz, 0);
  const kontoLogin = tekstLubNull('kontoLogin', dane.kontoLogin ?? null);
  const t = teraz(opcje);
  const wynik = db
    .prepare(
      `INSERT INTO stany_przepiecia (kanal, produkt_id, wariant_id, z_karty, na_karte, ilosc_wstecz, konto_login, utworzono_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(kanal, produktId, wariantId, zKarty, naKarte, iloscWstecz, kontoLogin, t);
  return {
    id: Number(wynik.lastInsertRowid),
    kanal,
    produktId,
    wariantId,
    zKarty,
    naKarte,
    iloscWstecz,
    kontoLogin,
    utworzonoAt: t,
  };
}
