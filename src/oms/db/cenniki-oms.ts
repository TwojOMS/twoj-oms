import type { DatabaseSync } from 'node:sqlite';

// Cenniki dostaw OMS (tabele z magazyn/0006): cennik zdefiniowany raz, powiązany z kontami kanałów
// (konto → cennik kanału), oraz cennik wybrany na karcie. Dobór (`src/domena/cennik-dostaw.js`) dostaje stąd reguły
// konta w dawnym kształcie, więc algorytm doboru się nie zmienia.
// Baza bez tej migracji (moduł w starszej wersji) nie ma tych tabel — wołający sprawdzają `maCennikiOms`.

type Opcje = { teraz?: string; aktor?: string | null };
export type RodzajCennikaOms = 'rozmiar' | 'domyslny' | 'karta';
export type PowiazanieCennika = { konto: string; cennikKanalu: string; zmienionoAt: string; aktor: string | null };
export type CennikOms = {
  id: number;
  nazwa: string;
  rodzaj: RodzajCennikaOms;
  doMm: number[] | null;
  doG: number | null;
  powiazania: PowiazanieCennika[];
  kart: number;
  zmienionoAt: string;
};
export type RegulaOms = { doMm?: number[]; doG?: number; cennik: string; nazwaOms: string };
type W = Record<string, unknown>;

const teraz = (o?: Opcje) => o?.teraz ?? new Date().toISOString();
const ulamek = (v: number) => String(v).replace('.', ',');
const dodatnia = (v: unknown) => Number.isInteger(v) && (v as number) > 0;

// Pamiętamy tylko „jest” (tabela nie znika); brak sprawdzamy za każdym razem — migracja może ją założyć w trakcie pracy.
const znane = new WeakSet<DatabaseSync>();
export function maCennikiOms(db: DatabaseSync): boolean {
  if (znane.has(db)) return true;
  const jest = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cenniki_dostaw_oms'").get(),
  );
  if (jest) znane.add(db);
  return jest;
}

// Kolejność doboru wspólna dla wszystkich kont: najmniejszy cennik rozmiaru pierwszy (objętość limitów, waga, id),
// domyślny na końcu, „tylko na karcie” poza doborem.
const KOLEJNOSC = `CASE WHEN c.do_a_mm IS NOT NULL THEN 0 WHEN c.domyslny = 1 THEN 1 ELSE 2 END,
  c.do_a_mm * c.do_b_mm * c.do_c_mm, c.do_g, c.id`;

/** Reguły doboru konta: cenniki z rozmiarem powiązane z kontem (od najmniejszego), na końcu domyślny — gdy powiązany. */
export function regulyCennikowKonta(db: DatabaseSync, konto: string): RegulaOms[] {
  return (
    db
      .prepare(
        `SELECT c.nazwa, c.do_a_mm, c.do_b_mm, c.do_c_mm, c.do_g, p.cennik_kanalu
      FROM cenniki_dostaw_oms c JOIN cenniki_dostaw_powiazania p ON p.cennik_id = c.id AND p.konto = ?
      WHERE c.do_a_mm IS NOT NULL OR c.domyslny = 1
      ORDER BY ${KOLEJNOSC}`,
      )
      .all(konto) as W[]
  ).map((w) =>
    w.do_a_mm == null
      ? { cennik: String(w.cennik_kanalu), nazwaOms: String(w.nazwa) }
      : {
          doMm: [Number(w.do_a_mm), Number(w.do_b_mm), Number(w.do_c_mm)],
          doG: Number(w.do_g),
          cennik: String(w.cennik_kanalu),
          nazwaOms: String(w.nazwa),
        },
  );
}

const powiazaniaCennika = (db: DatabaseSync, id: number): PowiazanieCennika[] =>
  (
    db
      .prepare(
        `SELECT konto, cennik_kanalu, zmieniono_at, aktor_login FROM cenniki_dostaw_powiazania
      WHERE cennik_id = ? ORDER BY konto`,
      )
      .all(id) as W[]
  ).map((w) => ({
    konto: String(w.konto),
    cennikKanalu: String(w.cennik_kanalu),
    zmienionoAt: String(w.zmieniono_at),
    aktor: (w.aktor_login as string | null) ?? null,
  }));

/** Wszystkie cenniki OMS w kolejności doboru, z powiązaniami i liczbą kart, które go wybrały. */
export function cennikiOms(db: DatabaseSync): CennikOms[] {
  return (
    db
      .prepare(
        `SELECT c.*, (SELECT count(*) FROM karty_cennik_oms k WHERE k.cennik_id = c.id) AS kart
      FROM cenniki_dostaw_oms c ORDER BY ${KOLEJNOSC}`,
      )
      .all() as W[]
  ).map((w) => ({
    id: Number(w.id),
    nazwa: String(w.nazwa),
    rodzaj: w.do_a_mm != null ? 'rozmiar' : w.domyslny === 1 ? 'domyslny' : 'karta',
    doMm: w.do_a_mm == null ? null : [Number(w.do_a_mm), Number(w.do_b_mm), Number(w.do_c_mm)],
    doG: w.do_g == null ? null : Number(w.do_g),
    powiazania: powiazaniaCennika(db, Number(w.id)),
    kart: Number(w.kart),
    zmienionoAt: String(w.zmieniono_at),
  }));
}

/** Cennik OMS wybrany na karcie albo null. */
export function cennikOmsKarty(
  db: DatabaseSync,
  kartaId: number,
): { cennikId: number; nazwa: string; zmienionoAt: string; aktor: string | null } | null {
  const w = db
    .prepare(
      `SELECT k.cennik_id, c.nazwa, k.zmieniono_at, k.aktor_login FROM karty_cennik_oms k
    JOIN cenniki_dostaw_oms c ON c.id = k.cennik_id WHERE k.karta_id = ?`,
    )
    .get(kartaId) as W | undefined;
  if (!w) return null;
  return {
    cennikId: Number(w.cennik_id),
    nazwa: String(w.nazwa),
    zmienionoAt: String(w.zmieniono_at),
    aktor: (w.aktor_login as string | null) ?? null,
  };
}

/** Cennik kanału z cennika OMS karty dla konta (i nazwa cennika OMS do powodu doboru); null = dobór po rozmiarze. */
export function wyjatekKartyOms(
  db: DatabaseSync,
  { kartaId, konto }: { kartaId: number; konto: string },
): { cennik: string; nazwaOms: string } | null {
  const w = db
    .prepare(
      `SELECT p.cennik_kanalu, c.nazwa FROM karty_cennik_oms k
    JOIN cenniki_dostaw_oms c ON c.id = k.cennik_id
    JOIN cenniki_dostaw_powiazania p ON p.cennik_id = k.cennik_id AND p.konto = ?
    WHERE k.karta_id = ?`,
    )
    .get(konto, kartaId) as W | undefined;
  return w ? { cennik: String(w.cennik_kanalu), nazwaOms: String(w.nazwa) } : null;
}

const nazwaLimitow = (mm: number[], g: number) =>
  `Do ${mm.map((v) => ulamek(v / 10)).join('×')} cm, ${ulamek(g / 1000)} kg`;

// Nazwa wolna w bazie (porównanie jak w indeksie unikalnym: bez wielkości liter i spacji na brzegach).
function wolnaNazwa(db: DatabaseSync, propozycje: Iterable<string>): string {
  const zajeta = db.prepare('SELECT 1 FROM cenniki_dostaw_oms WHERE lower(trim(nazwa)) = lower(trim(?))');
  for (const n of propozycje) if (!zajeta.get(n)) return n;
  throw new Error('Cennik OMS: brak wolnej nazwy');
}
function* zPrzyrostkiem(baza: string) {
  yield baza;
  for (let i = 2; i < 1000; i += 1) yield `${baza} (${i})`;
}

/** Nowy cennik OMS. Limity: trzy wymiary w mm i waga w g (zapisane z wymiarami malejąco) albo żadnych. Zwraca id. */
export function dodajCennikOms(
  db: DatabaseSync,
  c: { nazwa: string; doMm?: number[] | null; doG?: number | null; domyslny?: boolean },
  opcje?: Opcje,
): number {
  const nazwa = typeof c.nazwa === 'string' ? c.nazwa.trim() : '';
  if (!nazwa || nazwa.length > 60) throw new Error('Cennik OMS: nazwa od 1 do 60 znaków');
  const zLimitami = c.doMm != null || c.doG != null;
  if (zLimitami && !(Array.isArray(c.doMm) && c.doMm.length === 3 && c.doMm.every(dodatnia) && dodatnia(c.doG)))
    throw new Error('Cennik OMS: podaj trzy wymiary i wagę (liczby całkowite większe od zera) albo żadnych');
  if (zLimitami && c.domyslny) throw new Error('Cennik OMS: domyślny nie ma limitów rozmiaru');
  const mm = zLimitami ? [...(c.doMm as number[])].sort((x, y) => y - x) : [null, null, null];
  const t = teraz(opcje);
  return Number(
    db
      .prepare(
        `INSERT INTO cenniki_dostaw_oms (nazwa, do_a_mm, do_b_mm, do_c_mm, do_g, domyslny, utworzono_at, zmieniono_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(nazwa, mm[0], mm[1], mm[2], zLimitami ? (c.doG as number) : null, c.domyslny ? 1 : 0, t, t).lastInsertRowid,
  );
}

/** Powiązanie cennika OMS z kontem (cennik kanału po stronie konta). Pusty cennik kanału usuwa powiązanie. */
export function ustawPowiazanieCennika(
  db: DatabaseSync,
  p: { cennikId: number; konto: string; cennikKanalu: string | null },
  opcje?: Opcje,
): void {
  const konto = typeof p.konto === 'string' ? p.konto.trim() : '';
  if (!konto) throw new Error('Powiązanie cennika: brak konta');
  const wartosc = typeof p.cennikKanalu === 'string' ? p.cennikKanalu.trim() : '';
  if (!wartosc) {
    db.prepare('DELETE FROM cenniki_dostaw_powiazania WHERE cennik_id = ? AND konto = ?').run(p.cennikId, konto);
    return;
  }
  db.prepare(
    `INSERT INTO cenniki_dostaw_powiazania (cennik_id, konto, cennik_kanalu, zmieniono_at, aktor_login)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (cennik_id, konto) DO UPDATE SET cennik_kanalu = excluded.cennik_kanalu,
      zmieniono_at = excluded.zmieniono_at, aktor_login = excluded.aktor_login`,
  ).run(p.cennikId, konto, wartosc, teraz(opcje), opcje?.aktor ?? null);
}

/** Cennik OMS na karcie; `null` usuwa wybór (karta wraca do doboru po rozmiarze). */
export function ustawCennikKarty(
  db: DatabaseSync,
  { kartaId, cennikId }: { kartaId: number; cennikId: number | null },
  opcje?: Opcje,
): void {
  if (cennikId == null) {
    db.prepare('DELETE FROM karty_cennik_oms WHERE karta_id = ?').run(kartaId);
    return;
  }
  db.prepare(
    `INSERT INTO karty_cennik_oms (karta_id, cennik_id, zmieniono_at, aktor_login) VALUES (?, ?, ?, ?)
    ON CONFLICT (karta_id) DO UPDATE SET cennik_id = excluded.cennik_id, zmieniono_at = excluded.zmieniono_at,
      aktor_login = excluded.aktor_login`,
  ).run(kartaId, cennikId, teraz(opcje), opcje?.aktor ?? null);
}

/** Kilka zapisów cenników jako całość; SAVEPOINT działa też wewnątrz transakcji trasy API. */
export function wCalosci<T>(db: DatabaseSync, f: () => T): T {
  db.exec('SAVEPOINT cenniki_oms');
  try {
    const wynik = f();
    db.exec('RELEASE cenniki_oms');
    return wynik;
  } catch (e) {
    db.exec('ROLLBACK TO cenniki_oms');
    db.exec('RELEASE cenniki_oms');
    throw e;
  }
}

// --- Zgodność z dawnym zapisem (reguły na koncie, wyjątek per konto na karcie) ---
// Ekran ustawień konta i karta zapisują jeszcze w dawnym kształcie; te dwie funkcje przekładają taki zapis na cenniki
// OMS, żeby dobór (który czyta już cenniki OMS) widział zmianę. Istniejących cenników nie zmieniają — tylko
// powiązania tego konta albo wybór na tej karcie.

/** Reguły konta `[{doMm,doG,cennik},…,{cennik}]` → powiązania tego konta z cennikami rozmiaru i domyślnym. */
export function zapiszRegulyKonta(
  db: DatabaseSync,
  konto: string,
  reguly: readonly { doMm?: number[]; doG?: number; cennik: string }[],
  opcje?: Opcje,
): void {
  db.prepare(
    `DELETE FROM cenniki_dostaw_powiazania WHERE konto = ? AND cennik_id IN
    (SELECT id FROM cenniki_dostaw_oms WHERE do_a_mm IS NOT NULL OR domyslny = 1)`,
  ).run(konto);
  const t = teraz(opcje);
  // Pierwsza z dwóch reguł o tych samych limitach wygrywa — jak w dawnym doborze od góry.
  const powiaz = db.prepare(
    `INSERT OR IGNORE INTO cenniki_dostaw_powiazania (cennik_id, konto, cennik_kanalu, zmieniono_at, aktor_login)
    VALUES (?, ?, ?, ?, ?)`,
  );
  reguly.forEach((r, i) => {
    const cennik = r.cennik.trim();
    let id: number;
    if (i === reguly.length - 1 && r.doMm == null) {
      const w = db.prepare('SELECT id FROM cenniki_dostaw_oms WHERE domyslny = 1').get() as W | undefined;
      id = w
        ? Number(w.id)
        : dodajCennikOms(db, { nazwa: wolnaNazwa(db, zPrzyrostkiem('Domyślny')), domyslny: true }, opcje);
    } else {
      const mm = [...(r.doMm as number[])].sort((x, y) => y - x);
      const g = r.doG as number;
      const w = db
        .prepare('SELECT id FROM cenniki_dostaw_oms WHERE do_a_mm = ? AND do_b_mm = ? AND do_c_mm = ? AND do_g = ?')
        .get(mm[0], mm[1], mm[2], g) as W | undefined;
      id = w
        ? Number(w.id)
        : dodajCennikOms(db, { nazwa: wolnaNazwa(db, zPrzyrostkiem(nazwaLimitow(mm, g))), doMm: mm, doG: g }, opcje);
    }
    powiaz.run(id, konto, cennik, t, opcje?.aktor ?? null);
  });
}

/** Pary (konto → cennik kanału) cennika OMS karty. */
export function paryCennikaKarty(db: DatabaseSync, kartaId: number): Map<string, string> {
  const wiersze = db
    .prepare(
      `SELECT p.konto, p.cennik_kanalu FROM karty_cennik_oms k
    JOIN cenniki_dostaw_powiazania p ON p.cennik_id = k.cennik_id WHERE k.karta_id = ? ORDER BY p.konto`,
    )
    .all(kartaId) as W[];
  return new Map(wiersze.map((w) => [String(w.konto), String(w.cennik_kanalu)]));
}

const odcisk = (pary: Map<string, string>) => JSON.stringify([...pary].sort(([x], [y]) => (x < y ? -1 : 1)));

/** Karta dostaje cennik „tylko na karcie” o dokładnie tych parach (istniejący albo nowy `Wyjątek N`); pusto = bez. */
export function ustawParyCennikaKarty(
  db: DatabaseSync,
  kartaId: number,
  pary: Map<string, string>,
  opcje?: Opcje,
): void {
  if (!pary.size) {
    ustawCennikKarty(db, { kartaId, cennikId: null }, opcje);
    return;
  }
  const szukany = odcisk(pary);
  const kandydaci = db
    .prepare('SELECT id FROM cenniki_dostaw_oms WHERE do_a_mm IS NULL AND domyslny = 0 ORDER BY id')
    .all() as W[];
  let id = kandydaci
    .map((w) => Number(w.id))
    .find((k) => odcisk(new Map(powiazaniaCennika(db, k).map((p) => [p.konto, p.cennikKanalu]))) === szukany);
  if (id === undefined) {
    const nazwy = (function* () {
      for (let n = 1; n < 100000; n += 1) yield `Wyjątek ${n}`;
    })();
    id = dodajCennikOms(db, { nazwa: wolnaNazwa(db, nazwy) }, opcje);
    for (const [konto, cennikKanalu] of pary) ustawPowiazanieCennika(db, { cennikId: id, konto, cennikKanalu }, opcje);
  }
  ustawCennikKarty(db, { kartaId, cennikId: id }, opcje);
}
