import type { DatabaseSync } from 'node:sqlite';
import { kluczNazwy } from '../../domena/parametry-kart.js';
import { ustawPowiazanieCennika, wCalosci, type RodzajCennikaOms } from './cenniki-oms.ts';

// Zapis cenników OMS z ekranu Magazyn → Cenniki: dodanie, zmiana i usunięcie razem z powiązaniami kont.
// Każda odmowa wraca jako tekst dla formularza (400), nie jako wyjątek — ograniczenia bazy (CHECK, indeksy unikalne)
// są tylko ostatnią zaporą. Nazwy porównujemy przez `kluczNazwy`, bo `lower()` w SQLite składa tylko litery ASCII
// („Żółta” i „ŻÓŁTA” byłyby dla bazy różne).

export const MAKS_NAZWY_OMS = 60;
export const MAKS_CENNIKA_KANALU = 200;

export type DaneCennikaOms = {
  id?: number | null;
  nazwa: string;
  rodzaj: RodzajCennikaOms;
  doMm?: number[] | null;
  doG?: number | null;
  /** Powiązania tylko z bieżącymi kontami; powiązania innych kont (np. usuniętych) zostają nietknięte. */
  powiazania?: { konto: string; cennikKanalu: string }[];
};
export type WynikZapisu = { ok: true; id: number } | { ok: false; blad: string };
type Opcje = { teraz?: string; aktor?: string | null };
type W = Record<string, unknown>;

const znaki = (s: string) => [...s].length;
const dodatnia = (v: unknown) => Number.isInteger(v) && (v as number) > 0;

/** Sprawdza dane formularza względem pozostałych cenników; `null` = można zapisać. */
export function bladCennikaOms(db: DatabaseSync, c: DaneCennikaOms): string | null {
  const nazwa = typeof c.nazwa === 'string' ? c.nazwa.trim() : '';
  if (!nazwa || znaki(nazwa) > MAKS_NAZWY_OMS) return `Nazwa ma od 1 do ${MAKS_NAZWY_OMS} znaków.`;
  const inne = (
    db.prepare('SELECT id, nazwa, do_a_mm, do_b_mm, do_c_mm, do_g, domyslny FROM cenniki_dostaw_oms').all() as W[]
  ).filter((w) => Number(w.id) !== Number(c.id ?? 0));
  const klucz = kluczNazwy(nazwa);
  const zajeta = inne.find((w) => kluczNazwy(w.nazwa) === klucz);
  if (zajeta) return `Cennik o takiej nazwie już jest („${String(zajeta.nazwa)}”) — wpisz inną nazwę.`;
  if (c.rodzaj === 'domyslny') {
    const domyslny = inne.find((w) => w.domyslny === 1);
    if (domyslny) return `Domyślny jest już cennik „${String(domyslny.nazwa)}” — zmień go albo usuń.`;
  }
  if (c.rodzaj === 'rozmiar') {
    if (!(Array.isArray(c.doMm) && c.doMm.length === 3 && c.doMm.every(dodatnia) && dodatnia(c.doG)))
      return 'Podaj trzy wymiary i wagę paczki (liczby większe od zera).';
    const mm = [...c.doMm].sort((x, y) => y - x);
    const taki = inne.find(
      (w) =>
        w.do_a_mm != null &&
        [w.do_a_mm, w.do_b_mm, w.do_c_mm].every((v, i) => Number(v) === mm[i]) &&
        Number(w.do_g) === c.doG,
    );
    if (taki)
      return `Te same wymiary i waga są już w cenniku „${String(taki.nazwa)}” — zmień limity albo użyj tamtego.`;
  } else if (c.rodzaj !== 'domyslny' && c.rodzaj !== 'karta') return 'Wybierz, kiedy OMS bierze ten cennik.';
  for (const p of c.powiazania ?? []) {
    const wartosc = typeof p.cennikKanalu === 'string' ? p.cennikKanalu.trim() : '';
    if (znaki(wartosc) > MAKS_CENNIKA_KANALU) return `Nazwa cennika kanału ma do ${MAKS_CENNIKA_KANALU} znaków.`;
  }
  return null;
}

/** Dodaje (bez `id`) albo zmienia cennik razem z powiązaniami — w jednej transakcji. */
export function zapiszCennikOms(db: DatabaseSync, c: DaneCennikaOms, opcje: Opcje = {}): WynikZapisu {
  const blad = bladCennikaOms(db, c);
  if (blad) return { ok: false, blad };
  const t = opcje.teraz ?? new Date().toISOString();
  const nazwa = c.nazwa.trim();
  const rozmiar = c.rodzaj === 'rozmiar';
  const mm = rozmiar ? [...(c.doMm as number[])].sort((x, y) => y - x) : [null, null, null];
  const pola = [nazwa, mm[0], mm[1], mm[2], rozmiar ? (c.doG as number) : null, c.rodzaj === 'domyslny' ? 1 : 0];
  return wCalosci(db, () => {
    let id = Number(c.id ?? 0);
    if (id) {
      db.prepare(
        `UPDATE cenniki_dostaw_oms SET nazwa = ?, do_a_mm = ?, do_b_mm = ?, do_c_mm = ?, do_g = ?, domyslny = ?,
          zmieniono_at = ? WHERE id = ?`,
      ).run(...pola, t, id);
    } else {
      id = Number(
        db
          .prepare(
            `INSERT INTO cenniki_dostaw_oms (nazwa, do_a_mm, do_b_mm, do_c_mm, do_g, domyslny, utworzono_at,
              zmieniono_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(...pola, t, t).lastInsertRowid,
      );
    }
    // Niezmienione powiązanie zostaje z dawną datą i autorem — zapis formularza nie udaje, że ktoś je zmienił.
    const dawne = new Map(
      (db.prepare('SELECT konto, cennik_kanalu FROM cenniki_dostaw_powiazania WHERE cennik_id = ?').all(id) as W[]).map(
        (w) => [String(w.konto), String(w.cennik_kanalu)],
      ),
    );
    for (const p of c.powiazania ?? []) {
      const wartosc = typeof p.cennikKanalu === 'string' ? p.cennikKanalu.trim() : '';
      if ((dawne.get(p.konto) ?? '') === wartosc) continue;
      ustawPowiazanieCennika(
        db,
        { cennikId: id, konto: p.konto, cennikKanalu: wartosc },
        { teraz: t, aktor: opcje.aktor },
      );
    }
    return { ok: true as const, id };
  });
}

/** Karty, na których wybrano ten cennik (nazwy do odmowy usunięcia). */
export function kartyCennikaOms(db: DatabaseSync, id: number): { id: number; nazwa: string }[] {
  return (
    db
      .prepare(
        `SELECT k.id, k.nazwa FROM karty_cennik_oms c JOIN karty_produktow k ON k.id = c.karta_id
        WHERE c.cennik_id = ? ORDER BY k.nazwa COLLATE NOCASE, k.id`,
      )
      .all(id) as W[]
  ).map((w) => ({ id: Number(w.id), nazwa: String(w.nazwa ?? '') }));
}

/** Usuwa cennik z powiązaniami; cennik wybrany na kartach zostaje (karta musi najpierw dostać inny). */
export function usunCennikOms(db: DatabaseSync, id: number): { ok: true } | { ok: false; karty: number } {
  return wCalosci(db, () => {
    const karty = Number((db.prepare('SELECT count(*) AS n FROM karty_cennik_oms WHERE cennik_id = ?').get(id) as W).n);
    if (karty > 0) return { ok: false as const, karty };
    db.prepare('DELETE FROM cenniki_dostaw_powiazania WHERE cennik_id = ?').run(id);
    db.prepare('DELETE FROM cenniki_dostaw_oms WHERE id = ?').run(id);
    return { ok: true as const };
  });
}
