import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';

describe('schemat magazynu', () => {
  it('zakłada obie tabele na świeżej bazie', () => {
    const db = openOmsDb(':memory:');
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    expect(t).toContain('karty_produktow');
    expect(t).toContain('produkty_sklepowe');
  });

  it('ma indeks na karta_id — bez niego lista magazynu skanuje całą tabelę', () => {
    const db = openOmsDb(':memory:');
    const i = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
    expect(i).toContain('idx_produkty_sklepowe_karta');
  });

  // ⚠️ To jest test na wariant_id NOT NULL DEFAULT ''. Przy nullowalnej kolumnie
  // SQLite uzna dwa NULL-e za różne i ten sam produkt prosty wpadłby dwa razy.
  it('ten sam produkt prosty nie wchodzi dwa razy', () => {
    const db = openOmsDb(':memory:');
    const wstaw = () => db.prepare(
      `INSERT INTO produkty_sklepowe (kanal, produkt_id, nazwa, odczytane_at)
       VALUES ('pro', '944', 'Plafon', '2026-08-06T10:00:00Z')`,
    ).run();
    wstaw();
    expect(() => wstaw()).toThrow(/UNIQUE/i);
  });

  it('wariant tego samego produktu wchodzi obok produktu prostego', () => {
    const db = openOmsDb(':memory:');
    db.prepare(`INSERT INTO produkty_sklepowe (kanal, produkt_id, wariant_id, nazwa, odczytane_at)
                VALUES ('pro','944','1090','Plafon 45x65','2026-08-06T10:00:00Z')`).run();
    db.prepare(`INSERT INTO produkty_sklepowe (kanal, produkt_id, wariant_id, nazwa, odczytane_at)
                VALUES ('pro','944','1091','Plafon 70x100','2026-08-06T10:00:00Z')`).run();
    expect(db.prepare('SELECT COUNT(*) c FROM produkty_sklepowe').get().c).toBe(2);
  });

  // ⚠️ 1010 kart bez SKU musi współistnieć. W SQLite wiele NULL-i przechodzi przez UNIQUE.
  it('wiele kart bez SKU współistnieje, ale duplikat prawdziwego SKU odbija się', () => {
    const db = openOmsDb(':memory:');
    const w = (sku, nazwa) => db.prepare(
      `INSERT INTO karty_produktow (sku, nazwa, utworzony_at, zmieniony_at)
       VALUES (?, ?, '2026-08-06T10:00:00Z', '2026-08-06T10:00:00Z')`,
    ).run(sku, nazwa);
    w(null, 'A'); w(null, 'B');
    w('LMP-PLA-118', 'C');
    expect(() => w('LMP-PLA-118', 'D')).toThrow(/UNIQUE/i);
  });

});
