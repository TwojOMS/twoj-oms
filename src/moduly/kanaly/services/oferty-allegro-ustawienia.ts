import type { DatabaseSync } from 'node:sqlite';
import {
  ustawieniaOfertKonta,
  zapiszUstawieniaOfertKonta,
  BEZPIECZENSTWO_MAKS_ZNAKOW,
  type RegulaCennika,
} from '../../../oms/db/oferty-kanalow.ts';
import { brakiUstawienOfert } from '../../../domena/erli-oferty-ustawienia.js';
import { stanyKiedysWlaczone } from '../stany-kont.ts';
import { regulyZFormularza } from '../../../domena/cennik-dostaw.js';

// Krok 6 „Oferty” konfiguratora Allegro — dane konta, których karta nie zna.
// Listy konta (cenniki, warunki, producenci, osoby) przychodzą wyłącznie z „Pobierz z Allegro”; formularz
// przyjmuje tylko identyfikatory z zapisanej listy. Producent marki w `allegro_marki_gpsr`.

const root = '/ustawienia/integracje/allegro';
/** Konto bez zgody na zapis ofert. */
export const BRAK_ZGODY_OFERT = 'To konto nie ma zgody na zapis ofert — połącz je ponownie';

type Pozycja = { id: string; nazwa: string };
export type SlownikiAllegro = {
  pobranoAt: string;
  cenniki: Pozycja[];
  zwroty: Pozycja[];
  reklamacje: Pozycja[];
  gwarancje: Pozycja[];
  producenci: Pozycja[];
  osoby: Pozycja[];
};
type Lista = Exclude<keyof SlownikiAllegro, 'pobranoAt'>;

/** Pole ustawień → lista konta, metoda klienta Allegro i etykieta na ekranie. Cennik dostaw nie jest
 * już jednym polem — wybiera się go w tabeli reguł (`_cenniki-reguly.ejs`, `regulyZKroku`); listę cenników
 * pobiera nadal „Pobierz z Allegro” (`LISTY_KONTA`). */
export const POLA_LIST: readonly { pole: string; lista: Lista; metoda: string; etykieta: string; wymagane: boolean }[] =
  [
    { pole: 'zwrotyId', lista: 'zwroty', metoda: 'pobierzZwroty', etykieta: 'Warunki zwrotów', wymagane: true },
    {
      pole: 'reklamacjeId',
      lista: 'reklamacje',
      metoda: 'pobierzReklamacje',
      etykieta: 'Warunki reklamacji',
      wymagane: true,
    },
    {
      pole: 'gwarancjaId',
      lista: 'gwarancje',
      metoda: 'pobierzGwarancje',
      etykieta: 'Gwarancja (opcjonalna)',
      wymagane: false,
    },
    {
      pole: 'producentId',
      lista: 'producenci',
      metoda: 'pobierzProducentow',
      etykieta: 'Producent konta',
      wymagane: false,
    },
    {
      pole: 'osobaOdpowiedzialnaId',
      lista: 'osoby',
      metoda: 'pobierzOsobyOdpowiedzialne',
      etykieta: 'Osoba odpowiedzialna (opcjonalna)',
      wymagane: false,
    },
  ];
/** Wszystkie listy „Pobierz z Allegro”: cenniki (tabela reguł) i listy pól wyboru. */
const LISTY_KONTA: readonly { lista: Lista; metoda: string }[] = [
  { lista: 'cenniki', metoda: 'pobierzCenniki' },
  ...POLA_LIST,
];

/** Pola tabeli reguł w formularzu kroku „Oferty” (Allegro i ERLI) — po jednej wartości na wiersz. */
export const POLA_TABELI_CENNIKOW = ['regulaA', 'regulaB', 'regulaC', 'regulaWaga', 'regulaCennik'] as const;
export type RegulyZKroku = {
  reguly: RegulaCennika[];
  wiersze: { a: string; b: string; c: string; waga: string; cennik: string }[];
  wieksze: string;
  bledyPol: Record<string, string>;
};

/**
 * Tabela reguł z formularza kroku „Oferty”: wiersze (cm, kg, cennik) od góry plus cennik „dla większych”.
 * `null` — w ciele nie ma tabeli (stary formularz, inny zapis): reguły konta zostają bez zmian.
 * Pola `cennikDostaw` z formularza nie czytamy: ten alias jednej reguły „wszystko” zamieniłby całą listę reguł na jeden cennik.
 * Błędy przy polach: `regula-<indeks wiersza>` i `cennikWiekszych`.
 */
export function regulyZKroku(b: Record<string, unknown>): RegulyZKroku | null {
  if (!('cennikWiekszych' in b)) return null;
  const [pa, pb, pc, pw, pk] = POLA_TABELI_CENNIKOW.map((p) => lista(b[p]));
  const n = Math.max(pa.length, pb.length, pc.length, pw.length, pk.length);
  const wiersze = Array.from({ length: n }, (_, i) => ({
    a: pa[i] ?? '',
    b: pb[i] ?? '',
    c: pc[i] ?? '',
    waga: pw[i] ?? '',
    cennik: pk[i] ?? '',
  }));
  const wieksze = tekst(b.cennikWiekszych);
  const { reguly, bledy } = regulyZFormularza(wiersze, wieksze) as unknown as {
    reguly: RegulaCennika[];
    bledy: { wiersz: number | null; tekst: string }[];
  };
  const bledyPol: Record<string, string> = {};
  for (const x of bledy) {
    const klucz = x.wiersz === null ? 'cennikWiekszych' : 'regula-' + x.wiersz;
    if (!bledyPol[klucz]) bledyPol[klucz] = x.tekst;
  }
  // Puste „dla większych” zawsze odmowa — pusta tabela nie kasuje po cichu reguł konta.
  if (!wieksze.trim() && !bledyPol.cennikWiekszych) bledyPol.cennikWiekszych = 'Ustaw cennik dla większych';
  return { reguly: Object.keys(bledyPol).length ? [] : reguly, wiersze, wieksze, bledyPol };
}

/** Formularz bez tabeli reguł przy koncie z regułami to strona otwarta przed zmianą — 409, nic nie zapisane. */
export const FORMULARZ_NIEAKTUALNY = 'Strona była otwarta przed zmianą — odśwież';
export const formularzNieaktualny = (b: Record<string, unknown>, cenniki: readonly unknown[]) =>
  !('cennikWiekszych' in b) && cenniki.length > 0;

/** Cenniki wpisane w tabeli, których nie ma na liście konta (Allegro przyjmuje tylko identyfikator ze swojej listy). */
function cennikiSpozaListy(t: RegulyZKroku, znane: ReadonlySet<string>): Record<string, string> {
  const komunikat = 'Wybierz z listy pobranej z Allegro (cennik dostaw)';
  const bledy: Record<string, string> = {};
  t.wiersze.forEach((w, i) => {
    const id = w.cennik.trim();
    if (id && !znane.has(id)) bledy['regula-' + i] = komunikat;
  });
  if (t.wieksze.trim() && !znane.has(t.wieksze.trim())) bledy.cennikWiekszych = komunikat;
  return bledy;
}

export type WynikKroku =
  { ok: true } | { ok: false; status: number; komunikat: string; bledyPol?: Record<string, string> };
export type MarkaKonta = { marka: string; wybor: '' | 'konto' | string };

const tekst = (v: unknown) => (typeof v === 'string' ? v : '');
const lista = (v: unknown): string[] => (Array.isArray(v) ? v.map(tekst) : v === undefined ? [] : [tekst(v)]);
const liczba = (v: string) => (/^-?\d+([.,]\d+)?$/.test(v) ? Number(v.replace(',', '.')) : NaN);

/** Gotowość konta do wystawiania: braki odsyłają do kroku „Oferty” tego konta. */
export function gotowoscOfertAllegro(db: DatabaseSync, klucz: string) {
  const braki: string[] = brakiUstawienOfert(ustawieniaOfertKonta(db, klucz), 'allegro');
  return { gotowe: braki.length === 0, braki, krok: root + '/' + encodeURIComponent(klucz) + '/oferty' };
}

/** Marki ze słownika `marki` z wyborem producenta na tym koncie ('' = nieprzypisana). */
export function markiKonta(db: DatabaseSync, klucz: string): MarkaKonta[] {
  return (
    db
      .prepare(
        `SELECT m.nazwa AS marka, g.zrodlo, g.producent_id FROM marki m
   LEFT JOIN allegro_marki_gpsr g ON g.marka = m.nazwa AND g.konto = ? ORDER BY m.nazwa COLLATE NOCASE`,
      )
      .all(klucz) as any[]
  ).map((w) => ({
    marka: String(w.marka),
    wybor: w.zrodlo === 'konto' ? 'konto' : w.zrodlo === 'wybrany' ? String(w.producent_id ?? '') : '',
  }));
}

function pozycje(dane: unknown): Pozycja[] {
  if (!Array.isArray(dane)) throw new Error('lista');
  return dane
    .filter(
      (x) =>
        x && typeof x === 'object' && (typeof x.id === 'string' || typeof x.id === 'number') && String(x.id).trim(),
    )
    .map((x: any) => ({
      id: String(x.id),
      nazwa: typeof x.name === 'string' && x.name.trim() ? x.name : String(x.id),
    }));
}

export function createOfertyAllegroUstawienia(o: {
  db: DatabaseSync;
  klient: (klucz: string) => any;
  zgoda: (klucz: string) => boolean | null;
  teraz: () => Date;
}) {
  const { db } = o;
  function transakcja<T>(fn: () => T): T {
    db.exec('SAVEPOINT oferty_allegro_krok');
    try {
      const w = fn();
      db.exec('RELEASE oferty_allegro_krok');
      return w;
    } catch (e) {
      db.exec('ROLLBACK TO oferty_allegro_krok');
      db.exec('RELEASE oferty_allegro_krok');
      throw e;
    }
  }

  /** „Pobierz z Allegro”: sześć list naraz; zapis tylko, gdy wszystkie przyszły. */
  async function pobierzSlowniki(klucz: string, aktor: { login: string }): Promise<WynikKroku> {
    if (o.zgoda(klucz) !== true) return { ok: false, status: 409, komunikat: BRAK_ZGODY_OFERT };
    const klient = o.klient(klucz);
    if (!klient)
      return { ok: false, status: 409, komunikat: 'Konto nie jest połączone z Allegro. Połącz je i spróbuj ponownie.' };
    let listy: Pozycja[][];
    try {
      listy = await Promise.all(LISTY_KONTA.map(async (p) => pozycje(await klient[p.metoda]())));
    } catch (e) {
      const status = Number((e as { status?: unknown })?.status);
      return {
        ok: false,
        status: 502,
        komunikat:
          (status === 401 || status === 403
            ? 'Allegro odmówiło pobrania list konta.'
            : 'Nie udało się pobrać list konta z Allegro.') + ' Zapisane ustawienia zostały bez zmian.',
      };
    }
    const slowniki: Record<string, unknown> = { pobranoAt: o.teraz().toISOString() };
    LISTY_KONTA.forEach((p, i) => {
      slowniki[p.lista] = listy[i];
    });
    zapiszUstawieniaOfertKonta(db, klucz, { slowniki }, { aktor: aktor.login, teraz: o.teraz().toISOString() });
    return { ok: true };
  }

  /** Zapis formularza kroku: wszystko albo nic. Błąd → 400 z błędem przy polu. */
  function zapisz(klucz: string, b: Record<string, unknown>, aktor: { login: string }): WynikKroku {
    const u = ustawieniaOfertKonta(db, klucz);
    if (formularzNieaktualny(b, u.cenniki)) return { ok: false, status: 409, komunikat: FORMULARZ_NIEAKTUALNY };
    const slowniki = (u.slowniki ?? null) as Partial<SlownikiAllegro> | null;
    const bledy: Record<string, string> = {};
    const ilosc = tekst(b.stalaIlosc).trim();
    if (!ilosc) bledy.stalaIlosc = 'Podaj stałą liczbę sztuk';
    const czas = tekst(b.czasWysylkiDni).trim();
    const bezp = tekst(b.bezpieczenstwoDomyslne);
    if (bezp.length > BEZPIECZENSTWO_MAKS_ZNAKOW)
      bledy.bezpieczenstwoDomyslne = `Informacja o bezpieczeństwie może mieć najwyżej ${BEZPIECZENSTWO_MAKS_ZNAKOW} znaków`;
    const zmiany: Record<string, unknown> = {
      czynne: b.czynne === 'czynne',
      narzutProcent: liczba(tekst(b.narzutProcent).trim()),
      progPotwierdzeniaProcent: liczba(tekst(b.progPotwierdzeniaProcent).trim()),
      stalaIlosc: liczba(ilosc),
      czasWysylkiDni: czas ? liczba(czas) : null,
      stawkaVat: tekst(b.stawkaVat) || null,
      aktywujPoSprawdzeniu: b.aktywujPoSprawdzeniu === 'tak',
      bezpieczenstwoDomyslne: bezp.trim() ? bezp : null,
    };
    // Bufor i próg skoku tylko, gdy stany kiedykolwiek włączono; inaczej pola nie istnieją.
    if (stanyKiedysWlaczone(db))
      for (const p of ['buforSzt', 'progSkokuSzt']) if (b[p] !== undefined) zmiany[p] = liczba(tekst(b[p]).trim());
    for (const p of POLA_LIST) {
      const id = tekst(b[p.pole]).trim();
      if (id && !(slowniki?.[p.lista] ?? []).some((x) => x.id === id))
        bledy[p.pole] =
          `Wybierz z listy pobranej z Allegro (${p.etykieta.replace(/ \(opcjonalna\)$/, '').toLowerCase()})`;
      zmiany[p.pole] = id || null;
    }
    // Reguły cenników z tabeli; cennik w każdym wierszu i „dla większych” tylko z listy konta.
    const tabela = regulyZKroku(b);
    if (tabela) {
      const obce = cennikiSpozaListy(tabela, new Set((slowniki?.cenniki ?? []).map((x) => x.id)));
      for (const [pole, komunikat] of Object.entries({ ...obce, ...tabela.bledyPol })) bledy[pole] = komunikat;
      zmiany.cenniki = tabela.reguly;
    }
    // Producent marki — '' zostawia markę nieprzypisaną (nie dostaje producenta konta).
    const marki = lista(b.marka),
      wybory = lista(b.producentMarki);
    const znane = new Set(markiKonta(db, klucz).map((m) => m.marka));
    const producenci = new Set((slowniki?.producenci ?? []).map((x) => x.id));
    if (
      marki.length !== wybory.length ||
      marki.some((m) => !znane.has(m)) ||
      wybory.some((w) => w && w !== 'konto' && !producenci.has(w))
    )
      bledy.marki = 'Wybierz producenta marki z listy pobranej z Allegro albo „Producent konta (marka własna)”';
    const pierwszy = Object.keys(bledy)[0];
    if (pierwszy) return { ok: false, status: 400, komunikat: bledy[pierwszy], bledyPol: bledy };
    let pole = '';
    try {
      return transakcja(() => {
        const t = o.teraz().toISOString();
        for (const [nazwa, wartosc] of Object.entries(zmiany)) {
          pole = nazwa;
          zapiszUstawieniaOfertKonta(db, klucz, { [nazwa]: wartosc }, { aktor: aktor.login, teraz: t });
        }
        pole = 'marki';
        marki.forEach((marka, i) => {
          const wybor = wybory[i];
          const zrodlo = wybor === 'konto' ? 'konto' : wybor ? 'wybrany' : null;
          if (!zrodlo) {
            db.prepare('DELETE FROM allegro_marki_gpsr WHERE marka = ? AND konto = ?').run(marka, klucz);
            return;
          }
          db.prepare(
            `INSERT INTO allegro_marki_gpsr (marka, konto, zrodlo, producent_id, zmieniono_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (marka, konto) DO UPDATE SET zrodlo = excluded.zrodlo, producent_id = excluded.producent_id, zmieniono_at = excluded.zmieniono_at`,
          ).run(marka, klucz, zrodlo, zrodlo === 'wybrany' ? wybor : null, t);
        });
        return { ok: true } as const;
      });
    } catch (e) {
      const komunikat = e instanceof Error ? e.message : 'Niepoprawne ustawienie ofert.';
      return { ok: false, status: 400, komunikat, bledyPol: { [pole]: komunikat } };
    }
  }

  function widok(klucz: string) {
    const ustawienia = ustawieniaOfertKonta(db, klucz);
    return {
      ustawienia,
      slowniki: (ustawienia.slowniki ?? null) as SlownikiAllegro | null,
      marki: markiKonta(db, klucz),
      braki: brakiUstawienOfert(ustawienia, 'allegro') as string[],
      zgoda: o.zgoda(klucz) === true,
      polaList: POLA_LIST,
      stanyKiedys: stanyKiedysWlaczone(db),
    };
  }
  return { widok, zapisz, pobierzSlowniki };
}
