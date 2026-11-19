import type { DatabaseSync } from 'node:sqlite';
import { maCennikiOms, paryCennikaKarty, ustawParyCennikaKarty, wCalosci, wyjatekKartyOms } from './cenniki-oms.ts';

// Wyjątek cennika dostaw na karcie, osobno dla każdego konta. Z cennikami OMS (magazyn/0006) wyjątek to cennik OMS
// wybrany na karcie: dla konta liczy się jego powiązanie z tym kontem, konta bez powiązania dobierają po rozmiarze.
// Bez magazyn/0006 — dawna tabela z magazyn/0003; bez niej wyjątków nie ma: odczyt daje null / [].

type Klucz = { kartaId: number; konto: string };
type Opcje = { teraz?: string; aktor?: string | null };
export type WyjatekCennika = { konto: string; cennik: string; zmienionoAt: string; aktor: string | null };

// Pamiętamy tylko „jest” (tabela nie znika); brak sprawdzamy za każdym razem — migracja może ją założyć w trakcie pracy.
const znaneTabele = new WeakSet<DatabaseSync>();
const maTabele = (db: DatabaseSync) => {
  if (znaneTabele.has(db)) return true;
  const jest = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'karty_cenniki_kont'").get(),
  );
  if (jest) znaneTabele.add(db);
  return jest;
};

/** Wyjątek cennika karty na koncie albo null. */
export function wyjatekCennika(db: DatabaseSync, { kartaId, konto }: Klucz): string | null {
  if (maCennikiOms(db)) return wyjatekKartyOms(db, { kartaId, konto })?.cennik ?? null;
  if (!maTabele(db)) return null;
  const w = db.prepare('SELECT cennik FROM karty_cenniki_kont WHERE karta_id = ? AND konto = ?').get(kartaId, konto);
  return w ? String(w.cennik) : null;
}

/** Wszystkie wyjątki karty, po kluczu konta. */
export function wyjatkiCennikowKarty(db: DatabaseSync, kartaId: number): WyjatekCennika[] {
  const sql = maCennikiOms(db)
    ? `SELECT p.konto, p.cennik_kanalu AS cennik, k.zmieniono_at, k.aktor_login FROM karty_cennik_oms k
    JOIN cenniki_dostaw_powiazania p ON p.cennik_id = k.cennik_id WHERE k.karta_id = ? ORDER BY p.konto`
    : maTabele(db)
      ? `SELECT konto, cennik, zmieniono_at, aktor_login FROM karty_cenniki_kont
    WHERE karta_id = ? ORDER BY konto`
      : null;
  if (!sql) return [];
  return db
    .prepare(sql)
    .all(kartaId)
    .map((w) => ({
      konto: String(w.konto),
      cennik: String(w.cennik),
      zmienionoAt: String(w.zmieniono_at),
      aktor: (w.aktor_login as string | null) ?? null,
    }));
}

/** Zapisuje (albo podmienia) wyjątek. Pusty cennik to błąd — wyjątek usuwa się `usunWyjatekCennika`. */
export function zapiszWyjatekCennika(
  db: DatabaseSync,
  { kartaId, konto, cennik }: Klucz & { cennik: string },
  opcje?: Opcje,
): void {
  const wartosc = typeof cennik === 'string' ? cennik.trim() : '';
  if (!wartosc) throw new Error('Wyjątek cennika: podaj nazwę albo ID cennika');
  if (typeof konto !== 'string' || !konto.trim()) throw new Error('Wyjątek cennika: brak konta');
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
  ).run(kartaId, konto, wartosc, opcje?.teraz ?? new Date().toISOString(), opcje?.aktor ?? null);
}

/** Usuwa wyjątek; zwraca liczbę usuniętych wpisów (0 albo 1). */
export function usunWyjatekCennika(db: DatabaseSync, { kartaId, konto }: Klucz, opcje?: Opcje): number {
  if (maCennikiOms(db)) {
    return wCalosci(db, () => {
      const pary = paryCennikaKarty(db, kartaId);
      if (!pary.delete(konto)) return 0;
      ustawParyCennikaKarty(db, kartaId, pary, opcje);
      return 1;
    });
  }
  if (!maTabele(db)) return 0;
  return Number(
    db.prepare('DELETE FROM karty_cenniki_kont WHERE karta_id = ? AND konto = ?').run(kartaId, konto).changes,
  );
}
