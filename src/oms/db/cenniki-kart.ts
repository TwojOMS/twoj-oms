import type { DatabaseSync } from 'node:sqlite';
import { maCennikiOms, paryCennikaKarty, ustawParyCennikaKarty, wCalosci, wyjatekKartyOms } from './cenniki-oms.ts';

// Wyjątek cennika dostaw na karcie, osobno dla każdego konta. Kolejność dla konta: cennik kanału wybrany na karcie
// dla tego konta (magazyn/0007) → cennik OMS karty, gdy ma powiązanie z tym kontem (magazyn/0006) → brak wyjątku
// (dobór po rozmiarze, a bez niego odmowa — robi to `dobierzCennik`). Bez magazyn/0006 — dawna tabela z
// magazyn/0003; bez niej wyjątków nie ma: odczyt daje null / [].
// Wybory zapisane na koncie, którego nie ma już w konfiguracji, zostają w bazie; dobór o nie nie pyta, bo wołający
// pytają tylko o bieżące konta, a listę karty zawęża `konta`.

type Klucz = { kartaId: number; konto: string };
type Opcje = { teraz?: string; aktor?: string | null };
export type WyjatekCennika = { konto: string; cennik: string; zmienionoAt: string; aktor: string | null };
export type ZrodloWyjatkuCennika = { rodzaj: 'konto' } | { rodzaj: 'oms'; nazwaOms: string };

const WYBORY = 'karty_cenniki_kanalow';
const DAWNA = 'karty_cenniki_kont';

// Pamiętamy tylko „jest” (tabela nie znika); brak sprawdzamy za każdym razem — migracja może ją założyć w trakcie pracy.
const znaneTabele = new WeakMap<DatabaseSync, Set<string>>();
const maTabele = (db: DatabaseSync, nazwa: string) => {
  const znane = znaneTabele.get(db) ?? new Set<string>();
  if (znane.has(nazwa)) return true;
  const jest = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(nazwa));
  if (jest) znaneTabele.set(db, znane.add(nazwa));
  return jest;
};

type Trafienie = { cennik: string; zrodlo: ZrodloWyjatkuCennika };

// Jedno zapytanie na konto: szczeble doboru jako UNION z numerem szczebla, wygrywa najniższy. Budżet zapytań treści
// oferty liczy każde `prepare`, więc wybór konta nie może dokładać osobnego odczytu.
function trafienie(db: DatabaseSync, { kartaId, konto }: Klucz): Trafienie | null {
  const czesci: string[] = [];
  const parametry: (string | number)[] = [];
  if (maTabele(db, WYBORY)) {
    czesci.push(`SELECT 1 AS szczebel, cennik_kanalu AS cennik, NULL AS nazwa_oms FROM karty_cenniki_kanalow
    WHERE karta_id = ? AND konto = ?`);
    parametry.push(kartaId, konto);
  }
  if (maCennikiOms(db)) {
    czesci.push(`SELECT 2 AS szczebel, p.cennik_kanalu AS cennik, c.nazwa AS nazwa_oms FROM karty_cennik_oms k
    JOIN cenniki_dostaw_oms c ON c.id = k.cennik_id
    JOIN cenniki_dostaw_powiazania p ON p.cennik_id = k.cennik_id AND p.konto = ?
    WHERE k.karta_id = ?`);
    parametry.push(konto, kartaId);
  } else if (maTabele(db, DAWNA)) {
    czesci.push(`SELECT 3 AS szczebel, cennik, NULL AS nazwa_oms FROM karty_cenniki_kont
    WHERE karta_id = ? AND konto = ?`);
    parametry.push(kartaId, konto);
  }
  if (!czesci.length) return null;
  const w = db.prepare(`${czesci.join('\n    UNION ALL ')}\n    ORDER BY szczebel LIMIT 1`).get(...parametry);
  if (!w) return null;
  const zrodlo: ZrodloWyjatkuCennika =
    w.nazwa_oms == null ? { rodzaj: 'konto' } : { rodzaj: 'oms', nazwaOms: String(w.nazwa_oms) };
  return { cennik: String(w.cennik), zrodlo };
}

/** Wyjątek cennika karty na koncie (kod cennika kanału) albo null — wtedy dobór po rozmiarze. */
export function wyjatekCennika(db: DatabaseSync, klucz: Klucz): string | null {
  return trafienie(db, klucz)?.cennik ?? null;
}

/**
 * Skąd pochodzi wyjątek z `wyjatekCennika`: wybór na karcie dla tego konta albo cennik OMS karty (z nazwą do
 * powodu doboru). null = brak wyjątku.
 */
export function zrodloWyjatkuCennika(db: DatabaseSync, klucz: Klucz): ZrodloWyjatkuCennika | null {
  return trafienie(db, klucz)?.zrodlo ?? null;
}

type W = Record<string, unknown>;
const wpis = (w: W): WyjatekCennika => ({
  konto: String(w.konto),
  cennik: String(w.cennik),
  zmienionoAt: String(w.zmieniono_at),
  aktor: (w.aktor_login as string | null) ?? null,
});

/**
 * Wyjątki karty po kluczu konta, jeden na konto (wybór konta wygrywa z cennikiem OMS karty). `konta` — bieżące
 * konta z konfiguracji; wybory na pozostałych zostają w bazie, ale nie trafiają na listę.
 */
export function wyjatkiCennikowKarty(
  db: DatabaseSync,
  kartaId: number,
  { konta }: { konta?: readonly string[] } = {},
): WyjatekCennika[] {
  const poKoncie = new Map<string, WyjatekCennika>();
  const dodaj = (sql: string) => {
    for (const w of db.prepare(sql).all(kartaId) as W[]) poKoncie.set(String(w.konto), wpis(w));
  };
  if (maCennikiOms(db)) {
    dodaj(`SELECT p.konto, p.cennik_kanalu AS cennik, k.zmieniono_at, k.aktor_login FROM karty_cennik_oms k
    JOIN cenniki_dostaw_powiazania p ON p.cennik_id = k.cennik_id WHERE k.karta_id = ?`);
  } else if (maTabele(db, DAWNA)) {
    dodaj('SELECT konto, cennik, zmieniono_at, aktor_login FROM karty_cenniki_kont WHERE karta_id = ?');
  }
  if (maTabele(db, WYBORY)) {
    dodaj(`SELECT konto, cennik_kanalu AS cennik, zmieniono_at, aktor_login FROM karty_cenniki_kanalow
    WHERE karta_id = ?`);
  }
  const biezace = konta ? new Set(konta) : null;
  return [...poKoncie.values()]
    .filter((w) => !biezace || biezace.has(w.konto))
    .sort((x, y) => (x.konto < y.konto ? -1 : x.konto > y.konto ? 1 : 0));
}

/**
 * Zapisuje (albo podmienia) cennik kanału wybrany na karcie dla konta. Pusty cennik to błąd — wybór usuwa się
 * `usunWyjatekCennika`. Bez magazyn/0007 — dawny zapis (pary cennika OMS karty albo tabela z magazyn/0003).
 */
export function zapiszWyjatekCennika(
  db: DatabaseSync,
  { kartaId, konto, cennik }: Klucz & { cennik: string },
  opcje?: Opcje,
): void {
  const wartosc = typeof cennik === 'string' ? cennik.trim() : '';
  if (!wartosc) throw new Error('Wyjątek cennika: podaj nazwę albo ID cennika');
  if (typeof konto !== 'string' || !konto.trim()) throw new Error('Wyjątek cennika: brak konta');
  const teraz = opcje?.teraz ?? new Date().toISOString();
  const aktor = opcje?.aktor ?? null;
  if (maTabele(db, WYBORY)) {
    db.prepare(
      `INSERT INTO karty_cenniki_kanalow (karta_id, konto, cennik_kanalu, zmieniono_at, aktor_login)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (karta_id, konto) DO UPDATE SET cennik_kanalu = excluded.cennik_kanalu,
      zmieniono_at = excluded.zmieniono_at, aktor_login = excluded.aktor_login`,
    ).run(kartaId, konto, wartosc, teraz, aktor);
    return;
  }
  if (maCennikiOms(db)) {
    wCalosci(db, () => {
      const pary = paryCennikaKarty(db, kartaId);
      pary.set(konto, wartosc);
      ustawParyCennikaKarty(db, kartaId, pary, opcje);
    });
    return;
  }
  db.prepare(
    `INSERT INTO karty_cenniki_kont (karta_id, konto, cennik, zmieniono_at, aktor_login) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (karta_id, konto) DO UPDATE SET cennik = excluded.cennik, zmieniono_at = excluded.zmieniono_at,
      aktor_login = excluded.aktor_login`,
  ).run(kartaId, konto, wartosc, teraz, aktor);
}

/**
 * Usuwa wybór konta na karcie; zwraca liczbę usuniętych wpisów (0 albo 1). Cennik OMS karty zostaje — konto wraca
 * do niego (gdy ma powiązanie) albo do doboru po rozmiarze.
 */
export function usunWyjatekCennika(db: DatabaseSync, { kartaId, konto }: Klucz, opcje?: Opcje): number {
  if (maTabele(db, WYBORY)) {
    return Number(
      db.prepare('DELETE FROM karty_cenniki_kanalow WHERE karta_id = ? AND konto = ?').run(kartaId, konto).changes,
    );
  }
  if (maCennikiOms(db)) {
    return wCalosci(db, () => {
      const pary = paryCennikaKarty(db, kartaId);
      if (!pary.delete(konto)) return 0;
      ustawParyCennikaKarty(db, kartaId, pary, opcje);
      return 1;
    });
  }
  if (!maTabele(db, DAWNA)) return 0;
  return Number(
    db.prepare('DELETE FROM karty_cenniki_kont WHERE karta_id = ? AND konto = ?').run(kartaId, konto).changes,
  );
}
