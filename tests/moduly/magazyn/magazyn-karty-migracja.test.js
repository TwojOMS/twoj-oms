// PRZ-090 — migracja rdzenia nr 4: karty produktów zamiast wzorów, migracja wyłącznie addytywna.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { otworzBaze, wykonajMigracje } from '../../../src/core/baza.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';

const AT = '2026-08-11T19:03:48.074Z';
const ZMIANA = '2026-08-12T09:00:00.000Z';

/** Baza w stanie sprzed PRZ-090: rdzeń z migracjami 1–3 i dane w `wzory`. */
function bazaSprzedMigracji(sciezka) {
  const db = otworzBaze(sciezka);
  wykonajMigracje(db, [{ ...modulRdzen, migracje: modulRdzen.migracje.filter((m) => m.numer <= 3) }]);
  const wzor = db.prepare(`INSERT INTO wzory (id, sku, nazwa, szerokosc_mm, wysokosc_mm, kategoria_glowna,
    paczkomat, opis, folder_nas, utworzony_at, zmieniony_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  wzor.run(3, 'LMP-STO-001', 'Lampa stołowa Grzyb', 300, 450, 'Lampy stołowe', 'tak', 'opis A', null, AT, ZMIANA);
  wzor.run(8, null, 'Kinkiet Ramię', null, null, null, null, null, 'x', AT, AT);
  const prod = db.prepare(`INSERT INTO produkty_sklepowe (kanal, produkt_id, wariant_id, wzor_id, nazwa, odczytane_at)
    VALUES (?,?,?,?,?,?)`);
  prod.run('sklep', '10', '', 3, 'Lampa stołowa Grzyb 30x45cm', AT);
  prod.run('sklep', '11', '', 8, 'Kinkiet Ramię', AT);
  prod.run('allegro', '900', '', null, 'Kinkiet Ramię mosiądz', AT);
  db.close();
}

describe('migracja kart produktów (PRZ-090)', () => {
  it('świeża baza ma karty_produktow, karta_id, wymiary 3D, wagę i indeks na karta_id', () => {
    const db = openOmsDb(':memory:');
    const kolumny = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((k) => k.name);
    expect(kolumny('karty_produktow')).toEqual(expect.arrayContaining([
      'id', 'sku', 'nazwa', 'szerokosc_mm', 'wysokosc_mm', 'glebokosc_mm', 'waga_g',
      'kategoria_glowna', 'paczkomat', 'opis', 'utworzony_at', 'zmieniony_at']));
    expect(kolumny('karty_produktow')).not.toContain('folder_nas');
    expect(kolumny('produkty_sklepowe')).toEqual(expect.arrayContaining(['karta_id', 'wymiary_json', 'waga_tekst']));
    const indeksy = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
    expect(indeksy).toContain('idx_produkty_sklepowe_karta');
  });

  it('przepisuje wzory do kart z tymi samymi id i polami, a powiązania do karta_id', () => {
    const kat = mkdtempSync(join(tmpdir(), 'prz090-'));
    try {
      const sciezka = join(kat, 'oms.sqlite');
      bazaSprzedMigracji(sciezka);
      const db = openOmsDb(sciezka);
      const karty = db.prepare('SELECT * FROM karty_produktow ORDER BY id').all();
      expect(karty).toEqual([
        { id: 3, sku: 'LMP-STO-001', nazwa: 'Lampa stołowa Grzyb', szerokosc_mm: 300, wysokosc_mm: 450,
          glebokosc_mm: null, waga_g: null, kategoria_glowna: 'Lampy stołowe', paczkomat: 'tak', opis: 'opis A',
          utworzony_at: AT, zmieniony_at: ZMIANA },
        { id: 8, sku: null, nazwa: 'Kinkiet Ramię', szerokosc_mm: null, wysokosc_mm: null,
          glebokosc_mm: null, waga_g: null, kategoria_glowna: null, paczkomat: null, opis: null,
          utworzony_at: AT, zmieniony_at: AT },
      ]);
      const pow = db.prepare('SELECT produkt_id, karta_id FROM produkty_sklepowe ORDER BY produkt_id').all();
      expect(pow).toEqual([
        { produkt_id: '10', karta_id: 3 }, { produkt_id: '11', karta_id: 8 }, { produkt_id: '900', karta_id: null },
      ]);
      // Nowa karta nie trafia w id przepisanej (AUTOINCREMENT liczy od największego).
      const nowa = db.prepare(`INSERT INTO karty_produktow (nazwa, utworzony_at, zmieniony_at) VALUES ('Nowa', ?, ?)`)
        .run(AT, AT);
      expect(Number(nowa.lastInsertRowid)).toBe(9);
      // Stara tabela zostaje nietknięta — droga powrotu do poprzedniego obrazu.
      expect(db.prepare('SELECT COUNT(*) AS n FROM wzory').get().n).toBe(2);
      db.close();

      // Drugie otwarcie nie kopiuje drugi raz.
      const db2 = openOmsDb(sciezka);
      expect(db2.prepare('SELECT COUNT(*) AS n FROM karty_produktow').get().n).toBe(3);
      db2.close();
    } finally { rmSync(kat, { recursive: true, force: true }); }
  });

  it('SKU karty jest unikalne, wiele kart bez SKU współistnieje', () => {
    const db = openOmsDb(':memory:');
    const k = (sku) => db.prepare(`INSERT INTO karty_produktow (sku, nazwa, utworzony_at, zmieniony_at)
      VALUES (?, 'x', ?, ?)`).run(sku, AT, AT);
    k(null); k(null); k('LMP-1');
    expect(() => k('LMP-1')).toThrow(/UNIQUE/i);
  });
});
