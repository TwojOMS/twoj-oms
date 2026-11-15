import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO, wygenerujDaneDemo } from '../../../scripts/demo-dane.mjs';
import { klienciKataloguDemo } from '../../../scripts/demo-dane-katalog.mjs';
import { odswiezMagazyn } from '../../../src/moduly/magazyn/services/magazyn-sync.js';
import { utworzKartyZNiepowiazanych } from '../../../src/oms/db/magazyn.js';
import { polePuste, POLA_ZASTANE } from '../../../src/domena/zrodla-pol.js';

// PRZ-160 E1.01 — migracja rdzen/0012: model treści karty (źródła pól, zdjęcia, dane kanału, pamięć kategorii).
// Wyłącznie dokładanie. Istniejące niepuste pola treści dostają źródło `zastane` (reczne = 1).

const KORZEN = fileURLToPath(new URL('../../../', import.meta.url));
const NOWE_KOLUMNY = {
  karty_produktow: ['opis_sekcje_json', 'grupa_wariantow', 'ai_wspoltworzone', 'informacja_bezpieczenstwa'],
  produkty_sklepowe: ['tresc_pobrana_at', 'tresc_zmieniona_at'],
};
const NOWE_TABELE = ['karty_zrodla_pol', 'zdjecia_kart', 'karty_dane_kanalu', 'kanaly_kategorie'];
const katalogi = [];
afterEach(() => { for (const k of katalogi.splice(0)) rmSync(k, { recursive: true, force: true }); });

function nowyPlik() {
  const k = mkdtempSync(join(tmpdir(), 'oms-prz160-e101-'));
  katalogi.push(k);
  return join(k, 'oms.sqlite');
}

// 0014 zależy od 0012; 0015 przenosi pieniądze i ma własny test migracji.
const bez12 = (moduly) => moduly.map((m) => (m.nazwa === 'rdzen' ? { ...m, migracje: m.migracje.filter((x) => x.numer !== 12 && x.numer !== 14 && x.numer !== 15) } : m));
const bez15 = (moduly) => moduly.map((m) => (m.nazwa === 'rdzen' ? { ...m, migracje: m.migracje.filter((x) => x.numer !== 15) } : m));
const rdzenBez12 = bez12([modulRdzen]);
const TERAZ = () => new Date('2026-11-12T10:00:00.000Z');
const kolumny = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((k) => k.name);

// Odcisk: schemat i zawartość każdej istniejącej tabeli, bez kolumn dodanych przez 0012.
function odcisk(db, tabele) {
  const wynik = {};
  for (const t of tabele) {
    const pomin = NOWE_KOLUMNY[t] ?? [];
    const wiersze = db.prepare(`SELECT * FROM "${t}"`).all()
      .map((w) => JSON.stringify(Object.entries(w).filter(([k]) => !pomin.includes(k))))
      .sort();
    wynik[t] = { kolumny: kolumny(db, t).filter((k) => !pomin.includes(k)), wiersze };
  }
  return wynik;
}
const tabele = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((w) => w.name);
const schemat = (db, pomin) => db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
  .filter((w) => !pomin.includes(w.name));

const TRUDNE = [
  // sku, nazwa, opis, kategoria, vat, ean, cena, szer, wys, gleb, waga
  ['PP-1', 'Lampa Półcień', '  ', 'Lampy', '', null, 0, 0, null, -3, 0],
  [null, 'Kinkiet Półcień', 'Opis', null, '23', '5901234123457', 4990, 300, 400, 120, 1200],
  [null, '\n\t', '\r\n\t ', ' \t', '\n', '\t', null, null, null, null, null],
  ['PP-4', ' Abażur ', '\n0\n', 'Abażury', '8', ' ', 1, 1, 0, 0, 1],
];

function wstawTrudne(db) {
  const ins = db.prepare(`INSERT INTO karty_produktow (sku, nazwa, opis, kategoria_glowna, stawka_vat, ean, cena_gr,
    szerokosc_mm, wysokosc_mm, glebokosc_mm, waga_g, utworzony_at, zmieniony_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of TRUDNE) ins.run(...r, '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z');
}

describe('migracja rdzen/0012 — treść karty', () => {
  it('baza demo: istniejące tabele, ich schemat i dane po migracji są takie same jak przed', async () => {
    const plik = nowyPlik();
    const stare = bez12(modulyDla(ENV_DEMO));
    let db = openOmsDb(plik, { moduly: stare, teraz: TERAZ });
    wygenerujDaneDemo(db, { dzis: '2026-10-18', env: ENV_DEMO });
    // Magazyn demo tą samą drogą co scripts/demo-dane.mjs (wypelnijMagazyn): lustro katalogu, karty, SKU.
    const { sklepy, allegro, kanalySklepow, kanalyAllegro } = klienciKataloguDemo();
    const teraz = () => '2026-10-18T04:00:00.000Z';
    await odswiezMagazyn({ db, sklepy, allegro, teraz, kanalySklepow, kanalyAllegro, log: () => {} });
    utworzKartyZNiepowiazanych(db, { teraz, kanalySklepow });
    for (const p of db.prepare('SELECT karta_id, sku_sklepu FROM produkty_sklepowe WHERE karta_id IS NOT NULL AND sku_sklepu IS NOT NULL').all()) {
      // Baza sprzed 0012: SKU wprost w SQL, bo dzisiejszy `zapiszKarte` znaczy pola ręczne w tabeli z 0012.
      if (!db.prepare('SELECT sku FROM karty_produktow WHERE id = ?').get(p.karta_id).sku) db.prepare('UPDATE karty_produktow SET sku = ? WHERE id = ?').run(p.sku_sklepu, p.karta_id);
    }
    wstawTrudne(db);
    db.close();
    // Odcisk po ponownym otwarciu tą samą wersją — skutki samego otwarcia nie mieszają się z migracją.
    db = openOmsDb(plik, { moduly: stare, teraz: TERAZ });
    const stareTabele = tabele(db).filter((t) => t !== 'migracje');
    expect(stareTabele).not.toContain('karty_zrodla_pol');
    expect(db.prepare('SELECT count(*) n FROM karty_produktow').get().n).toBeGreaterThan(TRUDNE.length);
    const przed = odcisk(db, stareTabele);
    const schematPrzed = schemat(db, ['migracje', ...Object.keys(NOWE_KOLUMNY)]);
    db.close();

    db = openOmsDb(plik, { moduly: bez15(modulyDla(ENV_DEMO)), teraz: TERAZ });
    try {
      expect(odcisk(db, stareTabele)).toEqual(przed);
      const schematPo = schemat(db, ['migracje', ...Object.keys(NOWE_KOLUMNY)]);
      expect(schematPo.filter((w) => schematPrzed.some((p) => p.name === w.name))).toEqual(schematPrzed);
      for (const [t, nowe] of Object.entries(NOWE_KOLUMNY)) expect(kolumny(db, t)).toEqual(expect.arrayContaining(nowe));
      for (const t of NOWE_TABELE) expect(tabele(db)).toContain(t);
      expect(db.prepare("SELECT numer FROM migracje WHERE modul = 'rdzen' AND numer = 12").get()).toEqual({ numer: 12 });
      // Nowe kolumny starych wierszy są puste.
      expect(db.prepare(`SELECT count(*) n FROM karty_produktow WHERE opis_sekcje_json IS NOT NULL OR grupa_wariantow IS NOT NULL
        OR ai_wspoltworzone IS NOT NULL OR informacja_bezpieczenstwa IS NOT NULL`).get().n).toBe(0);
      expect(db.prepare('SELECT count(*) n FROM produkty_sklepowe WHERE tresc_pobrana_at IS NOT NULL OR tresc_zmieniona_at IS NOT NULL').get().n).toBe(0);
      // Każda karta demo z nazwą ma źródło `zastane`.
      expect(db.prepare(`SELECT count(*) n FROM karty_produktow k WHERE NOT EXISTS
        (SELECT 1 FROM karty_zrodla_pol z WHERE z.karta_id = k.id AND z.pole = 'nazwa' AND z.zrodlo = 'zastane' AND z.reczne = 1)
        AND trim(k.nazwa, ' '||char(9,10,13)) <> ''`).get().n).toBe(0);
    } finally { db.close(); }
  });

  it('zastane tylko dla pól niepustych: zero w wymiarach i wadze to brak, cena 0 zł to wartość, same \\n\\t to brak', () => {
    const plik = nowyPlik();
    let db = openOmsDb(plik, { moduly: rdzenBez12 });
    wstawTrudne(db);
    db.close();
    db = openOmsDb(plik);
    try {
      const pola = (id) => db.prepare("SELECT pole FROM karty_zrodla_pol WHERE karta_id = ? AND zrodlo = 'zastane' AND reczne = 1 ORDER BY pole")
        .all(id).map((w) => w.pole);
      expect(pola(1)).toEqual(['cena_gr', 'kategoria_glowna', 'nazwa', 'sku']);
      expect(pola(2)).toEqual(['cena_gr', 'ean', 'glebokosc_mm', 'nazwa', 'opis', 'stawka_vat', 'szerokosc_mm', 'waga_g', 'wysokosc_mm']);
      expect(pola(3)).toEqual([]);
      expect(pola(4)).toEqual(['cena_gr', 'kategoria_glowna', 'nazwa', 'opis', 'sku', 'stawka_vat', 'szerokosc_mm', 'waga_g']);
      expect(db.prepare("SELECT count(*) n FROM karty_zrodla_pol WHERE zrodlo <> 'zastane' OR reczne <> 1").get().n).toBe(0);
      // Ta sama definicja pustości w JS (polePuste) i w SQL migracji — pole po polu.
      for (const k of db.prepare('SELECT * FROM karty_produktow').all()) {
        const oczekiwane = POLA_ZASTANE.filter((p) => !polePuste(p, k[p])).sort();
        expect(pola(k.id), `karta ${k.id}`).toEqual(oczekiwane);
      }
    } finally { db.close(); }
  });

  it('ograniczenia nowych tabel: zastane/reczne/api wymagają reczne = 1, kasowanie karty czyści nowe tabele', () => {
    const db = openOmsDb();
    try {
      const at = '2026-11-12T10:00:00.000Z';
      db.prepare("INSERT INTO karty_produktow (nazwa, utworzony_at, zmieniony_at) VALUES ('Lampa', ?, ?)").run(at, at);
      const zrodlo = db.prepare('INSERT INTO karty_zrodla_pol (karta_id, pole, zrodlo, reczne, zmieniono_at) VALUES (1, ?, ?, ?, ?)');
      for (const z of ['reczne', 'zastane', 'api']) expect(() => zrodlo.run(`p_${z}`, z, 0, at), z).toThrow(/CHECK/);
      zrodlo.run('opis', 'allegro:allegro_glowne', 0, at);
      zrodlo.run('nazwa', 'api', 1, at);
      db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at)
        VALUES (1, 0, 'woo:woo_sklep', 'https://sklep.example/a.jpg', ?)`).run(at);
      db.prepare(`INSERT INTO karty_dane_kanalu (karta_id, typ_kanalu, polaczenie, oferta_id, pobrano_at)
        VALUES (1, 'allegro', 'allegro_glowne', '123', ?)`).run(at);
      expect(() => db.prepare("INSERT INTO kanaly_kategorie (polaczenie, kategoria_id, sciezka_json, pobrano_at) VALUES ('a', '1', 'nie json', ?)").run(at)).toThrow(/CHECK/);
      expect(() => db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at)
        VALUES (1, 1, 'woo:woo_sklep', 'https://sklep.example/a.jpg', ?)`).run(at)).toThrow(/UNIQUE/);
      const plik = db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, plik, sha256, typ, rozmiar, utworzono_at)
        VALUES (1, ?, 'reczne', ?, ?, 'image/png', 10, ?)`);
      plik.run(2, `${'a'.repeat(64)}.png`, 'a'.repeat(64), at);
      expect(() => plik.run(3, `${'a'.repeat(64)}.png`, 'a'.repeat(64), at)).toThrow(/UNIQUE/);
      expect(() => db.prepare(`INSERT INTO karty_dane_kanalu (karta_id, typ_kanalu, polaczenie, oferta_id, pobrano_at)
        VALUES (1, 'allegro', 'allegro_drugie', '456', ?)`).run(at)).toThrow(/UNIQUE/);
      db.prepare('DELETE FROM karty_produktow WHERE id = 1').run();
      for (const t of ['karty_zrodla_pol', 'zdjecia_kart', 'karty_dane_kanalu']) expect(db.prepare(`SELECT count(*) n FROM ${t}`).get().n, t).toBe(0);
    } finally { db.close(); }
  });

  it('ponowne wykonanie ciała migracji nic nie zmienia', () => {
    const plik = nowyPlik();
    let db = openOmsDb(plik, { moduly: rdzenBez12 });
    wstawTrudne(db);
    db.close();
    db = openOmsDb(plik);
    try {
      const mig = modulRdzen.migracje.find((m) => m.numer === 12);
      const przed = JSON.stringify([schemat(db, []), db.prepare('SELECT * FROM karty_zrodla_pol ORDER BY karta_id, pole').all()]);
      mig.wykonaj(db);
      mig.wykonaj(db);
      expect(JSON.stringify([schemat(db, []), db.prepare('SELECT * FROM karty_zrodla_pol ORDER BY karta_id, pole').all()])).toBe(przed);
    } finally { db.close(); }
  });

  it('strażnik migracji przepuszcza 0012', () => {
    expect(execFileSync(process.execPath, ['scripts/straznik-migracji.mjs'], { cwd: KORZEN, encoding: 'utf8' })).toBe('');
  });
});
