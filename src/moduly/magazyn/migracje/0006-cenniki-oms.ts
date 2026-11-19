import type { DatabaseSync } from 'node:sqlite';
import type { Migracja } from '../../../core/kontrakty.ts';

// Cenniki dostaw OMS: cennik zdefiniowany raz (nazwa, limity rozmiaru) i powiązany z kontami kanałów
// (konto → cennik kanału). Wyłącznie dokładanie — stare `cenniki_json`, `cennik_dostaw` i `karty_cenniki_kont` zostają
// nietknięte, żeby wycofanie wersji nie gubiło danych.
//
// Limity zapisujemy z wymiarami posortowanymi malejąco (a ≥ b ≥ c): dobór i tak obraca produkt, a jeden zapis tych
// samych limitów pozwala znaleźć istniejący cennik o identycznych limitach.
// Trzy rodzaje wynikają z kolumn: z rozmiarem (limity), domyślny (bez limitów, najwyżej jeden), tylko na karcie
// (bez limitów, nie domyślny — dobór rozmiarem go pomija).
//
// Przeniesienie danych odtwarza dzisiejszy dobór: reguły konta → cenniki OMS z rozmiarem i domyślny, wyjątki karty →
// cennik „tylko na karcie” z dokładnie tym zbiorem par (konto, cennik). Uruchamia się raz — gdy cenniki OMS już są,
// ponowienie niczego nie nadpisuje (sprzedawca mógł je zmienić).

const TABELE = [
  `CREATE TABLE IF NOT EXISTS cenniki_dostaw_oms (
    id INTEGER PRIMARY KEY,
    nazwa TEXT NOT NULL CHECK (length(trim(nazwa)) BETWEEN 1 AND 60),
    do_a_mm INTEGER,
    do_b_mm INTEGER,
    do_c_mm INTEGER,
    do_g INTEGER,
    domyslny INTEGER NOT NULL DEFAULT 0 CHECK (domyslny IN (0, 1)),
    utworzono_at TEXT NOT NULL,
    zmieniono_at TEXT NOT NULL,
    -- coalesce: NULL w porównaniu daje NULL, a CHECK z NULL przepuszcza — limity bez wagi by przeszły.
    CHECK ((do_a_mm IS NULL AND do_b_mm IS NULL AND do_c_mm IS NULL AND do_g IS NULL)
      OR (coalesce(do_a_mm, 0) > 0 AND coalesce(do_b_mm, 0) > 0 AND coalesce(do_c_mm, 0) > 0 AND coalesce(do_g, 0) > 0)),
    CHECK (domyslny = 0 OR do_a_mm IS NULL)
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS cenniki_dostaw_oms_nazwa ON cenniki_dostaw_oms (lower(trim(nazwa)))',
  'CREATE UNIQUE INDEX IF NOT EXISTS cenniki_dostaw_oms_domyslny ON cenniki_dostaw_oms (domyslny) WHERE domyslny = 1',
  `CREATE TABLE IF NOT EXISTS cenniki_dostaw_powiazania (
    cennik_id INTEGER NOT NULL REFERENCES cenniki_dostaw_oms(id) ON DELETE CASCADE,
    konto TEXT NOT NULL CHECK (length(trim(konto)) > 0),
    cennik_kanalu TEXT NOT NULL CHECK (length(trim(cennik_kanalu)) BETWEEN 1 AND 200),
    zmieniono_at TEXT NOT NULL,
    aktor_login TEXT,
    PRIMARY KEY (cennik_id, konto)
  )`,
  `CREATE TABLE IF NOT EXISTS karty_cennik_oms (
    karta_id INTEGER PRIMARY KEY REFERENCES karty_produktow(id) ON DELETE CASCADE,
    cennik_id INTEGER NOT NULL REFERENCES cenniki_dostaw_oms(id) ON DELETE RESTRICT,
    zmieniono_at TEXT NOT NULL,
    aktor_login TEXT
  )`,
];

const TERAZ_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
const AKTOR = 'migracja';

type Regula = { doMm?: unknown; doG?: unknown; cennik?: unknown };

const napis = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const dodatnia = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
const limityPoprawne = (r: Regula) =>
  Array.isArray(r.doMm) && r.doMm.length === 3 && r.doMm.every(dodatnia) && dodatnia(r.doG);
const cennikPoprawny = (c: string) => c.length >= 1 && c.length <= 200;
const ulamek = (v: number) => String(v).replace('.', ',');

const maTabele = (db: DatabaseSync, t: string) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
const maKolumne = (db: DatabaseSync, t: string, k: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((w) => w.name === k);

// Reguły konta tak, jak czyta je dobór sprzed cenników OMS: `cenniki_json`, a gdy pusta — `cennik_dostaw` jako jedna
// reguła „wszystko”. Lista, którą dobór by odrzucił (pusty cennik, reguła bez limitów w środku), daje konto bez
// cennika — tak samo jak dziś. Cennik dłuższy od limitu tabeli też (nie wpisujemy uciętego).
function regulyKonta(w: { cenniki_json?: unknown; cennik_dostaw?: unknown }): Regula[] {
  let lista: unknown = null;
  if (typeof w.cenniki_json === 'string') {
    try {
      lista = JSON.parse(w.cenniki_json);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(lista)) {
    const stary = napis(w.cennik_dostaw);
    lista = stary ? [{ cennik: stary }] : [];
  }
  const reguly = lista as Regula[];
  const cale = reguly.every(
    (r, i) =>
      r &&
      typeof r === 'object' &&
      cennikPoprawny(napis(r.cennik)) &&
      (i === reguly.length - 1 || limityPoprawne(r)),
  );
  return cale ? reguly : [];
}

function przenies(db: DatabaseSync) {
  const nowyCennik = db.prepare(
    `INSERT INTO cenniki_dostaw_oms (nazwa, do_a_mm, do_b_mm, do_c_mm, do_g, domyslny, utworzono_at, zmieniono_at)
    VALUES (?, ?, ?, ?, ?, ?, ${TERAZ_SQL}, ${TERAZ_SQL})`,
  );
  // Dwie reguły konta o tych samych limitach: zostaje pierwsza — dziś też wygrywała pierwsza od góry.
  const powiaz = db.prepare(
    `INSERT OR IGNORE INTO cenniki_dostaw_powiazania (cennik_id, konto, cennik_kanalu, zmieniono_at, aktor_login)
    VALUES (?, ?, ?, ${TERAZ_SQL}, '${AKTOR}')`,
  );
  const zLimitami = db.prepare(
    'SELECT id FROM cenniki_dostaw_oms WHERE do_a_mm = ? AND do_b_mm = ? AND do_c_mm = ? AND do_g = ?',
  );
  const idDomyslnego = () => {
    const w = db.prepare('SELECT id FROM cenniki_dostaw_oms WHERE domyslny = 1').get() as { id: number } | undefined;
    if (w) return w.id;
    return Number(nowyCennik.run('Domyślny', null, null, null, null, 1).lastInsertRowid);
  };

  const zCenniki = maKolumne(db, 'oferty_ustawienia_kont', 'cenniki_json');
  const konta = db
    .prepare(
      `SELECT klucz, cennik_dostaw${zCenniki ? ', cenniki_json' : ''} FROM oferty_ustawienia_kont ORDER BY klucz`,
    )
    .all() as { klucz: string; cennik_dostaw?: unknown; cenniki_json?: unknown }[];
  for (const konto of konta) {
    const reguly = regulyKonta(konto);
    reguly.forEach((r, i) => {
      const cennik = napis(r.cennik);
      if (i === reguly.length - 1) {
        powiaz.run(idDomyslnego(), konto.klucz, cennik);
        return;
      }
      const [a, b, c] = [...(r.doMm as number[])].sort((x, y) => y - x);
      const g = r.doG as number;
      const jest = zLimitami.get(a, b, c, g) as { id: number } | undefined;
      const nazwa = `Do ${ulamek(a / 10)}×${ulamek(b / 10)}×${ulamek(c / 10)} cm, ${ulamek(g / 1000)} kg`;
      const id = jest ? jest.id : Number(nowyCennik.run(nazwa, a, b, c, g, 0).lastInsertRowid);
      powiaz.run(id, konto.klucz, cennik);
    });
  }

  if (!maTabele(db, 'karty_cenniki_kont')) return;
  const wyjatki = db
    .prepare('SELECT karta_id, konto, cennik FROM karty_cenniki_kont ORDER BY karta_id, konto')
    .all() as { karta_id: number; konto: string; cennik: string }[];
  const zbiory = new Map<number, Map<string, string>>();
  for (const w of wyjatki) {
    const cennik = napis(w.cennik);
    if (!cennikPoprawny(cennik)) continue;
    if (!zbiory.has(w.karta_id)) zbiory.set(w.karta_id, new Map());
    zbiory.get(w.karta_id)!.set(w.konto, cennik);
  }
  const odcisk = (pary: Map<string, string>) => JSON.stringify([...pary].sort(([x], [y]) => (x < y ? -1 : 1)));
  const tylkoNaKarcie = new Map<string, number>();
  const nazwy = new Set(
    (db.prepare('SELECT lower(trim(nazwa)) n FROM cenniki_dostaw_oms').all() as { n: string }[]).map((w) => w.n),
  );
  const wolnaNazwa = () => {
    for (let n = 1; ; n += 1) {
      const nazwa = `Wyjątek ${n}`;
      if (!nazwy.has(nazwa.toLowerCase())) {
        nazwy.add(nazwa.toLowerCase());
        return nazwa;
      }
    }
  };
  const doKarty = db.prepare(
    `INSERT INTO karty_cennik_oms (karta_id, cennik_id, zmieniono_at, aktor_login)
    VALUES (?, ?, ${TERAZ_SQL}, '${AKTOR}')`,
  );
  for (const [kartaId, pary] of zbiory) {
    if (!pary.size) continue;
    const klucz = odcisk(pary);
    let id = tylkoNaKarcie.get(klucz);
    if (id === undefined) {
      id = Number(nowyCennik.run(wolnaNazwa(), null, null, null, null, 0).lastInsertRowid);
      for (const [konto, cennik] of pary) powiaz.run(id, konto, cennik);
      tylkoNaKarcie.set(klucz, id);
    }
    doKarty.run(kartaId, id);
  }
}

export const migracjaCennikowOms: Migracja = {
  numer: 6,
  nazwa: 'cenniki dostaw OMS',
  wykonaj(db: DatabaseSync) {
    for (const sql of TABELE) db.exec(sql);
    if (db.prepare('SELECT 1 FROM cenniki_dostaw_oms LIMIT 1').get()) return;
    if (!maTabele(db, 'oferty_ustawienia_kont')) return;
    przenies(db);
  },
};
