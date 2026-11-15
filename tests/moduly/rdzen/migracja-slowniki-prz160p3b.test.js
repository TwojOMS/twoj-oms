import { it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { wykonajMigracje } from '../../../src/core/baza.ts';
import { dekodujEncje } from '../../../src/domena/slowniki-kart.js';

const bez16 = () => openOmsDb(':memory:', { moduly: [{ ...modulRdzen, migracje: modulRdzen.migracje.filter(m => m.numer !== 16) }] });
const kolumny = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map(k => k.name);
const karta = (db, sku, kategoria) => db.prepare(`INSERT INTO karty_produktow (sku, nazwa, kategoria_glowna, utworzony_at, zmieniony_at)
  VALUES (?, ?, ?, '2026-11-13T10:00:00Z', '2026-11-13T10:00:00Z')`).run(sku, `Karta ${sku}`, kategoria);

it('dekodujEncje zdejmuje encje aż do stałej wartości', () => {
  expect(dekodujEncje('Papier &amp;amp; Tektura')).toBe('Papier & Tektura');
  expect(dekodujEncje('Papier &amp;amp;amp; Tektura')).toBe('Papier & Tektura');
  expect(dekodujEncje('&quot;Lato&quot; &#39;26 &lt;b&gt; &#x41; &#66;')).toBe('"Lato" \'26 <b> A B');
  expect(dekodujEncje('Bez encji')).toBe('Bez encji');
  expect(dekodujEncje('&nieznana; zostaje')).toBe('&nieznana; zostaje');
  expect(dekodujEncje(null)).toBe(null);
});

it('0016 dokłada słowniki i markę, dekoduje encje kategorii i sieje słownik kategorii z kart', () => {
  const db = bez16();
  try {
    karta(db, 'A1', 'Papier &amp;amp; Tektura');
    karta(db, 'A2', 'Papier &amp; Tektura');
    karta(db, 'A3', 'Papier & Tektura');
    karta(db, 'A4', '&quot;Szablony&quot;');
    karta(db, 'A5', null);
    karta(db, 'A6', '   ');
    karta(db, 'A7', '  Lampy  ');
    karta(db, 'A8', '  &amp;  ');
    expect(kolumny(db, 'karty_produktow')).not.toContain('marka');
    expect(modulRdzen.migracje.find(m => m.numer === 16)).toBeDefined();
    expect(wykonajMigracje(db, [modulRdzen]).map(m => m.numer)).toEqual([16]);

    expect(kolumny(db, 'karty_produktow')).toContain('marka');
    expect(kolumny(db, 'kategorie_kart')).toEqual(['nazwa', 'utworzona_at']);
    expect(kolumny(db, 'marki')).toEqual(['nazwa', 'utworzona_at']);
    expect(kolumny(db, 'kategorie_kart_kanaly')).toEqual(['nazwa', 'kanal', 'id_zewnetrzne', 'rodzic_id']);

    const kategorie = db.prepare('SELECT sku, kategoria_glowna FROM karty_produktow ORDER BY sku').all();
    expect(kategorie.map(k => k.kategoria_glowna)).toEqual(['Papier & Tektura', 'Papier & Tektura', 'Papier & Tektura', '"Szablony"', null, '   ', 'Lampy', '&']);
    expect(db.prepare('SELECT nazwa FROM kategorie_kart ORDER BY nazwa').all().map(r => r.nazwa)).toEqual(['"Szablony"', '&', 'Lampy', 'Papier & Tektura']);
    expect(db.prepare('SELECT COUNT(*) AS ile FROM marki').get().ile).toBe(0);

    // Powtórzenie wykonaj nic nie psuje ani nie dubluje.
    modulRdzen.migracje.find(m => m.numer === 16).wykonaj(db);
    expect(db.prepare('SELECT COUNT(*) AS ile FROM kategorie_kart').get().ile).toBe(4);
    expect(wykonajMigracje(db, [modulRdzen])).toEqual([]);
  } finally { db.close(); }
});

it('kategorie_kart_kanaly: klucz (kanal, id_zewnetrzne)', () => {
  const db = openOmsDb(':memory:', { moduly: [modulRdzen] });
  try {
    const wstaw = db.prepare('INSERT INTO kategorie_kart_kanaly (nazwa, kanal, id_zewnetrzne, rodzic_id) VALUES (?, ?, ?, ?)');
    wstaw.run('Ramki', 'woo_a', '7', null);
    wstaw.run('Ramki', 'woo_b', '7', null);
    expect(() => wstaw.run('Ramki', 'woo_a', '7', null)).toThrow();
  } finally { db.close(); }
});

it('karta z produktu sklepu dostaje kategorię bez encji (jak po migracji 0016)', async () => {
  const { kartaZProduktu } = await import('../../../src/domena/karta-z-produktu.js');
  const zrodlowa = { id: 1, nazwa: 'Plakat Półcień', kategorie_json: JSON.stringify(['Papier &amp; Tektura', 'Szablony']), kategoria_glowna_zrodla: 'Papier &amp; Tektura' };
  expect(kartaZProduktu(zrodlowa).kategoria_glowna).toBe('Papier & Tektura');
  const jedyna = { id: 2, nazwa: 'Plakat Półcień', kategorie_json: JSON.stringify(['&quot;Szablony&quot;']) };
  expect(kartaZProduktu(jedyna).kategoria_glowna).toBe('"Szablony"');
  const zeSpacja = { id: 3, nazwa: 'Plakat Półcień', kategorie_json: JSON.stringify(['Lampy&nbsp;']) };
  expect(kartaZProduktu(zeSpacja).kategoria_glowna).toBe('Lampy');
});
