import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { schematBazy } from '../../../src/core/baza.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import { migracjaKanalowSprzedazy } from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import { migracjaDiagnostykiAllegro } from '../../../src/moduly/kanaly/migracje/0002-diagnostyka-allegro.ts';
import { migracjaTypuKanaluISklepow } from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import { migracjaOfertKanalow } from '../../../src/moduly/magazyn/migracje/0001-oferty-kanalow.ts';
import { ustawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';

// Migracja magazyn/0001: rejestr ofert `oferty_kanalow` (D8) i ustawienia ofert konta kanału
// `oferty_ustawienia_kont` (D13, D13a, D14, D15, D24, D28). Wyłącznie dokładanie: dwie nowe tabele, dane bez zmian.

const NOWE_TABELE = ['oferty_kanalow', 'oferty_ustawienia_kont'];
const katalogi = [];
afterEach(() => {
  for (const k of katalogi.splice(0)) rmSync(k, { recursive: true, force: true });
});

function nowyPlik() {
  const k = mkdtempSync(join(tmpdir(), 'oms-prz160-e201-'));
  katalogi.push(k);
  return join(k, 'oms.sqlite');
}

const kanaly = {
  nazwa: 'kanaly',
  migracje: [migracjaKanalowSprzedazy, migracjaDiagnostykiAllegro, migracjaTypuKanaluISklepow],
};
const magazynPrzed = { nazwa: 'magazyn', migracje: [] };
const magazynPo = { nazwa: 'magazyn', migracje: [migracjaOfertKanalow] };
const nowyObiekt = (wpis) => NOWE_TABELE.some((t) => wpis.startsWith(`${t} `) || wpis.startsWith(`${t}.`));
const dane = (db) =>
  Object.fromEntries(
    ['karty_produktow', 'kanaly_sprzedazy', 'produkty_sklepowe', 'zdjecia_kart'].map((t) => [
      t,
      db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),
    ]),
  );

function staraBaza() {
  const plik = nowyPlik();
  const db = openOmsDb(plik, { moduly: [modulRdzen, kanaly, magazynPrzed] });
  for (const t of NOWE_TABELE) expect(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(t)).toBeUndefined();
  db.prepare(
    `INSERT INTO karty_produktow (id, sku, nazwa, cena_gr, utworzony_at, zmieniony_at)
    VALUES (501, 'LMP-501', 'Lampa Półcień', 5900, '2026-11-01T10:00:00.000Z', '2026-11-01T10:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO kanaly_sprzedazy(klucz,nazwa,srodowisko,zrodlo,raport,autoryzacja,pobieranie,od_utc,wersja,generacja,
    generacja_importu,utworzono_at,zmieniono_at,aktor_id,aktor_login,typ)
    VALUES ('erli_polcien','Pracownia Półcień — ERLI','sandbox','panel','ERLI_POLCIEN','polaczone','wlaczone',
    '2026-11-01T00:00:00Z',2,1,1,'2026-11-01T10:00:00.000Z','2026-11-01T10:00:00.000Z',1,'administrator','erli')`,
  ).run();
  const przed = { schemat: schematBazy(db), dane: dane(db) };
  db.close();
  return { plik, przed };
}

describe('migracja magazyn/0001 — rejestr ofert i ustawienia ofert konta kanału', () => {
  it('moduł magazynu niesie migrację numer 1', () => {
    expect(modulMagazyn.migracje).toContain(migracjaOfertKanalow);
    expect(migracjaOfertKanalow.numer).toBe(1);
  });

  it('stara baza (rdzeń po 0013, kanały po 0003): dochodzą tylko nowe tabele, stary schemat i dane bez zmian', () => {
    const { plik, przed } = staraBaza();
    const db = openOmsDb(plik, { moduly: [modulRdzen, kanaly, magazynPo] });
    try {
      const po = schematBazy(db);
      expect(po.filter((w) => !nowyObiekt(w))).toEqual(przed.schemat);
      expect(przed.schemat.filter(nowyObiekt)).toEqual([]);
      for (const t of NOWE_TABELE) expect(po.some((w) => w.startsWith(`${t} tabela`))).toBe(true);
      expect(dane(db)).toEqual(przed.dane);
      expect(db.prepare("SELECT numer, nazwa FROM migracje WHERE modul = 'magazyn'").all()).toEqual([
        { numer: 1, nazwa: migracjaOfertKanalow.nazwa },
      ]);
      for (const t of NOWE_TABELE) expect(db.prepare(`SELECT count(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('istniejące konto kanału po migracji ma oferty wstrzymane i stałą ilość nieustawioną', () => {
    const { plik } = staraBaza();
    const db = openOmsDb(plik, { moduly: [modulRdzen, kanaly, magazynPo] });
    try {
      expect(ustawieniaOfertKonta(db, 'erli_polcien')).toMatchObject({
        klucz: 'erli_polcien',
        czynne: false,
        stalaIlosc: null,
      });
    } finally {
      db.close();
    }
  });

  it('kolumny ustawień: przełącznik wstrzymany, narzut 0, próg 20%, stała ilość bez wartości domyślnej', () => {
    const db = openOmsDb(':memory:', { moduly: [modulRdzen, kanaly, magazynPo] });
    try {
      const k = Object.fromEntries(
        db
          .prepare('PRAGMA table_info(oferty_ustawienia_kont)')
          .all()
          .map((x) => [x.name, x]),
      );
      expect(k.oferty_czynne).toMatchObject({ notnull: 1, dflt_value: '0' });
      expect(k.narzut_bp).toMatchObject({ notnull: 1, dflt_value: '0' });
      expect(k.prog_potwierdzenia_bp).toMatchObject({ notnull: 1, dflt_value: '2000' });
      expect(k.stala_ilosc).toMatchObject({ notnull: 0, dflt_value: null });
      db.prepare("INSERT INTO oferty_ustawienia_kont (klucz, zmieniono_at) VALUES ('erli_surowe', 'x')").run();
      expect(
        db
          .prepare(
            "SELECT oferty_czynne, narzut_bp, stala_ilosc FROM oferty_ustawienia_kont WHERE klucz = 'erli_surowe'",
          )
          .get(),
      ).toEqual({ oferty_czynne: 0, narzut_bp: 0, stala_ilosc: null });
    } finally {
      db.close();
    }
  });

  it('indeks pod zegar (stan + termin następnej próby) obsługuje zapytanie pętli', () => {
    const db = openOmsDb(':memory:', { moduly: [modulRdzen, kanaly, magazynPo] });
    try {
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT id FROM oferty_kanalow
        WHERE stan = 'do_wyslania' AND (nastepna_proba_at IS NULL OR nastepna_proba_at <= ?)`,
        )
        .all('2026-11-13T10:00:00.000Z');
      expect(plan.map((w) => w.detail).join(' | ')).toMatch(/oferty_kanalow_zegar/);
    } finally {
      db.close();
    }
  });

  it('ponowne wykonanie migracji niczego nie zmienia', () => {
    const { plik } = staraBaza();
    const db = openOmsDb(plik, { moduly: [modulRdzen, kanaly, magazynPo] });
    try {
      db.prepare(
        `INSERT INTO oferty_kanalow (karta_id, kanal, id_zewnetrzne, pochodzenie, tryb, stan, utworzono_at, zmieniono_at)
        VALUES (501, 'erli_polcien', 'ABC123-K501', 'oms', 'zarzadzana', 'szkic', 'x', 'x')`,
      ).run();
      db.prepare(
        "INSERT INTO oferty_ustawienia_kont (klucz, narzut_bp, zmieniono_at) VALUES ('erli_polcien', 1250, 'x')",
      ).run();
      const przed = [
        schematBazy(db),
        db.prepare('SELECT * FROM oferty_kanalow').all(),
        db.prepare('SELECT * FROM oferty_ustawienia_kont').all(),
      ];
      migracjaOfertKanalow.wykonaj(db);
      migracjaOfertKanalow.wykonaj(db);
      expect([
        schematBazy(db),
        db.prepare('SELECT * FROM oferty_kanalow').all(),
        db.prepare('SELECT * FROM oferty_ustawienia_kont').all(),
      ]).toEqual(przed);
    } finally {
      db.close();
    }
  });
});
