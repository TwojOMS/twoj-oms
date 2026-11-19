import { it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { wykonajMigracje } from '../../../src/core/baza.ts';

const bez18 = () =>
  openOmsDb(':memory:', { moduly: [{ ...modulRdzen, migracje: modulRdzen.migracje.filter((m) => m.numer !== 18) }] });
const tabela = (db, nazwa) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(nazwa)?.name ?? null;
const karta = (db, sku) =>
  Number(
    db
      .prepare(
        `INSERT INTO karty_produktow (sku, nazwa, utworzony_at, zmieniony_at)
         VALUES (?, ?, '2026-11-13T10:00:00Z', '2026-11-13T10:00:00Z')`,
      )
      .run(sku, `Lampa Kopuła ${sku}`).lastInsertRowid,
  );
const wpis = (db, kartaId, nad = {}) => {
  const w = { cena: 1230, od: '2026-11-05', zrodlo: 'karta', ...nad };
  return db
    .prepare(
      `INSERT INTO ceny_zakupu_kart (karta_id, cena_netto_gr, obowiazuje_od, wpisano_at, kto, zrodlo)
       VALUES (?, ?, ?, '2026-11-05T09:00:00Z', 'magazynier', ?)`,
    )
    .run(kartaId, w.cena, w.od, w.zrodlo);
};

it('dokłada tabelę cen zakupu raz; powtórka niczego nie psuje', () => {
  const db = bez18();
  try {
    expect(tabela(db, 'ceny_zakupu_kart')).toBe(null);
    expect(modulRdzen.migracje.find((m) => m.numer === 18)?.nazwa).toBeTruthy();
    expect(wykonajMigracje(db, [modulRdzen]).map((m) => m.numer)).toEqual([18]);

    expect(tabela(db, 'ceny_zakupu_kart')).toBe('ceny_zakupu_kart');
    const kolumny = db
      .prepare('PRAGMA table_info(ceny_zakupu_kart)')
      .all()
      .map((k) => k.name);
    expect(kolumny).toEqual(['id', 'karta_id', 'cena_netto_gr', 'obowiazuje_od', 'wpisano_at', 'kto', 'zrodlo']);
    // Indeks (karta_id, obowiazuje_od) — z UNIQUE; wyszukanie ceny na dzień ma iść po nim, nie po całej tabeli.
    const indeksy = db
      .prepare('PRAGMA index_list(ceny_zakupu_kart)')
      .all()
      .filter((i) => i.unique === 1)
      .map((i) =>
        db
          .prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`)
          .all()
          .map((k) => k.name),
      );
    expect(indeksy).toContainEqual(['karta_id', 'obowiazuje_od']);
    const fk = db.prepare('PRAGMA foreign_key_list(ceny_zakupu_kart)').all();
    expect(fk.map((f) => [f.table, f.from, f.to, f.on_delete])).toEqual([
      ['karty_produktow', 'karta_id', 'id', 'CASCADE'],
    ]);

    modulRdzen.migracje.find((m) => m.numer === 18).wykonaj(db);
    expect(wykonajMigracje(db, [modulRdzen])).toEqual([]);
  } finally {
    db.close();
  }
});

it('baza odmawia kwoty ujemnej, ułamkowej i tekstowej, złej daty i nieznanego źródła', () => {
  const db = openOmsDb(':memory:');
  try {
    const id = karta(db, 'PP-1');
    expect(() => wpis(db, id, { cena: -1 })).toThrow(/CHECK/);
    expect(() => wpis(db, id, { cena: 12.5 })).toThrow(/CHECK/);
    expect(() => wpis(db, id, { cena: '12,30' })).toThrow(/CHECK/);
    expect(() => wpis(db, id, { cena: '12.30' })).toThrow(/CHECK/);
    expect(() => wpis(db, id, { cena: null })).toThrow(/NOT NULL/);
    expect(() => wpis(db, id, { od: '5.11.2026' })).toThrow(/CHECK/);
    expect(() => wpis(db, id, { od: '2026-11-05T00:00:00Z' })).toThrow(/CHECK/);
    expect(() => wpis(db, id, { zrodlo: 'import' })).toThrow(/CHECK/);
    expect(() => wpis(db, 999999)).toThrow(/FOREIGN KEY/);
    expect(db.prepare('SELECT COUNT(*) AS ile FROM ceny_zakupu_kart').get().ile).toBe(0);

    wpis(db, id, { cena: 0 });
    expect(() => wpis(db, id, { cena: 1310 })).toThrow(/UNIQUE/);
    wpis(db, id, { cena: 1310, od: '2026-12-01', zrodlo: 'hurt' });
    expect(db.prepare('SELECT COUNT(*) AS ile FROM ceny_zakupu_kart').get().ile).toBe(2);
  } finally {
    db.close();
  }
});

it('napis z samych cyfr kolumna INTEGER zamienia na liczbę — w bazie nie zostaje tekst', () => {
  const db = openOmsDb(':memory:');
  try {
    wpis(db, karta(db, 'PP-2'), { cena: '1230' });
    expect(db.prepare('SELECT typeof(cena_netto_gr) AS t, cena_netto_gr AS c FROM ceny_zakupu_kart').get()).toEqual({
      t: 'integer',
      c: 1230,
    });
  } finally {
    db.close();
  }
});

it('skasowana karta zabiera swoją historię cen, cudzej nie rusza', () => {
  const db = openOmsDb(':memory:');
  try {
    const a = karta(db, 'PP-3');
    const b = karta(db, 'PP-4');
    wpis(db, a);
    wpis(db, a, { od: '2026-12-01' });
    wpis(db, b);
    db.prepare('DELETE FROM karty_produktow WHERE id = ?').run(a);
    expect(db.prepare('SELECT karta_id FROM ceny_zakupu_kart').all()).toEqual([{ karta_id: b }]);
  } finally {
    db.close();
  }
});
