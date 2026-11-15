import type { Migracja } from '../../../core/kontrakty.ts';
import { dekodujEncje } from '../../../domena/slowniki-kart.js';

// PRZ-160.P3b.01 — słowniki kart: kategorie i marki. Wyłącznie dokładanie: kolumna `marka` (NULL),
// trzy nowe tabele. Kategorie główne z encjami HTML (`Papier &amp;amp; Tektura` z WooCommerce) są
// dekodowane aż do stałej wartości, a słownik kategorii dostaje DISTINCT niepustych nazw z kart.
// Słownik marek startuje pusty. Powtórne wykonanie niczego nie zmienia (dekodowanie jest stałe,
// wpisy słownika INSERT OR IGNORE), więc znacznik w migracje_jednorazowe nie jest potrzebny.

const TABELE = `
CREATE TABLE IF NOT EXISTS kategorie_kart (
  nazwa        TEXT PRIMARY KEY CHECK (length(trim(nazwa)) > 0),
  utworzona_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS marki (
  nazwa        TEXT PRIMARY KEY CHECK (length(trim(nazwa)) > 0),
  utworzona_at TEXT NOT NULL
);

-- Skąd wpis słownika przyszedł: kategoria sklepu (id i rodzic w danym połączeniu).
CREATE TABLE IF NOT EXISTS kategorie_kart_kanaly (
  nazwa         TEXT NOT NULL,
  kanal         TEXT NOT NULL,
  id_zewnetrzne TEXT NOT NULL,
  rodzic_id     TEXT,
  PRIMARY KEY (kanal, id_zewnetrzne)
);
`;

export const migracjaSlownikowKart: Migracja = {
  numer: 16,
  nazwa: 'słowniki kart: kategorie i marki',
  wykonaj(db) {
    const sa = new Set(db.prepare('PRAGMA table_info(karty_produktow)').all().map((k) => (k as { name: string }).name));
    if (!sa.has('marka')) db.exec('ALTER TABLE karty_produktow ADD COLUMN marka TEXT');
    db.exec(TABELE);

    const zmien = db.prepare('UPDATE karty_produktow SET kategoria_glowna = ? WHERE kategoria_glowna = ?');
    const zEncjami = db.prepare("SELECT DISTINCT kategoria_glowna AS k FROM karty_produktow WHERE kategoria_glowna LIKE '%&%'").all() as { k: string }[];
    for (const { k } of zEncjami) {
      const czysta = dekodujEncje(k).trim();
      if (czysta && czysta !== k) zmien.run(czysta, k);
    }
    // Słownik zmienia nazwę i usuwa po obciętej nazwie — karty i słownik muszą mieć ją bez spacji na brzegach.
    db.exec("UPDATE karty_produktow SET kategoria_glowna = trim(kategoria_glowna) WHERE trim(kategoria_glowna) <> '' AND kategoria_glowna <> trim(kategoria_glowna)");
    db.prepare(`INSERT OR IGNORE INTO kategorie_kart (nazwa, utworzona_at)
      SELECT DISTINCT kategoria_glowna, ? FROM karty_produktow
      WHERE kategoria_glowna IS NOT NULL AND trim(kategoria_glowna) <> ''`).run(new Date().toISOString());
  },
};
