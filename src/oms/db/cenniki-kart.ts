import type { DatabaseSync } from 'node:sqlite';

// Wyjątek cennika dostaw na karcie, osobno dla każdego konta (tabela z magazyn/0003).
// Baza bez tej migracji (moduł w starszej wersji) nie ma wyjątków: odczyt daje null / [].

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
  if (!maTabele(db)) return null;
  const w = db.prepare('SELECT cennik FROM karty_cenniki_kont WHERE karta_id = ? AND konto = ?').get(kartaId, konto);
  return w ? String(w.cennik) : null;
}

/** Wszystkie wyjątki karty, po kluczu konta. */
export function wyjatkiCennikowKarty(db: DatabaseSync, kartaId: number): WyjatekCennika[] {
  if (!maTabele(db)) return [];
  return db
    .prepare(
      `SELECT konto, cennik, zmieniono_at, aktor_login FROM karty_cenniki_kont
    WHERE karta_id = ? ORDER BY konto`,
    )
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
  db.prepare(
    `INSERT INTO karty_cenniki_kont (karta_id, konto, cennik, zmieniono_at, aktor_login) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (karta_id, konto) DO UPDATE SET cennik = excluded.cennik, zmieniono_at = excluded.zmieniono_at,
      aktor_login = excluded.aktor_login`,
  ).run(kartaId, konto, wartosc, opcje?.teraz ?? new Date().toISOString(), opcje?.aktor ?? null);
}

/** Usuwa wyjątek; zwraca liczbę usuniętych wierszy (0 albo 1). */
export function usunWyjatekCennika(db: DatabaseSync, { kartaId, konto }: Klucz): number {
  if (!maTabele(db)) return 0;
  return Number(
    db.prepare('DELETE FROM karty_cenniki_kont WHERE karta_id = ? AND konto = ?').run(kartaId, konto).changes,
  );
}
