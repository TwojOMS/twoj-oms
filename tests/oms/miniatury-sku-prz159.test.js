// PRZ-159 — miniatury pozycji ERLI. ERLI nie przysyła zdjęcia w zamówieniu (`erli-mapowanie.js`: `zdjecie_url: null`,
// `produkt_id: null`), więc lista, karta i ekran nadania nie miały czego pokazać (właściciel 12.11: „Zamówienia z Erli nie mają
// miniaturek produktu”). Pozycja BEZ żadnego zdjęcia bierze miniaturę z lustra magazynu po SKU — tę samą, którą pokazuje
// magazyn; zdjęcie, które pozycja ma (sklep, Allegro), wygrywa jak dotąd.
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { miniaturaPozycji } from '../../src/domena/miniatura-pozycji.js';
import { miniaturySku, skuPozycji } from '../../src/oms/db/miniatury-lustra.js';
import { miniaturyEkranu } from '../../src/moduly/zamowienia/wspolne.js';

function baza() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE produkty_sklepowe (id INTEGER PRIMARY KEY AUTOINCREMENT, kanal TEXT NOT NULL, produkt_id TEXT NOT NULL,
    sku_sklepu TEXT, miniatura TEXT, zniknal_at TEXT)`);
  const dodaj = db.prepare('INSERT INTO produkty_sklepowe (kanal, produkt_id, sku_sklepu, miniatura, zniknal_at) VALUES (?,?,?,?,?)');
  dodaj.run('sklep_a', '1', 'LMP-1', 'https://sklep.example/lmp1-stary-247x296.jpg', '2026-10-01');
  dodaj.run('sklep_a', '2', 'LMP-1', 'https://sklep.example/lmp1-247x296.jpg', null);
  dodaj.run('sklep_b', '3', 'LMP-1', 'https://inny.example/lmp1-150x150.jpg', null);
  dodaj.run('sklep_a', '4', 'LMP-2', null, null);
  dodaj.run('sklep_a', '5', 'LMP-3', 'data:image/png;base64,AAAA', null);
  dodaj.run('sklep_a', '6', 'ZASLEPKA', 'https://sklep.example/zaslepka.jpg', null);
  return db;
}

describe('PRZ-159 — miniatura pozycji po SKU', () => {
  it('lustro po SKU: produkt obecny przed zniknietym, potem najstarszy wiersz; bez miniatury i nie-http nie wchodzi', () => {
    const mapa = miniaturySku(baza(), ['LMP-1', 'LMP-2', 'LMP-3', 'BRAK']);
    expect(mapa.get('LMP-1')).toBe('https://sklep.example/lmp1-247x296.jpg');
    expect(mapa.has('LMP-2')).toBe(false);
    expect(mapa.has('LMP-3')).toBe(false);
    expect(mapa.has('BRAK')).toBe(false);
  });

  it('bez SKU do sprawdzenia nie dotyka bazy', () => {
    expect(miniaturySku({ prepare() { throw new Error('nie wolno pytać bazy'); } }, []).size).toBe(0);
  });

  it('SKU zbierane tylko z pozycji bez zdjęcia i bez produktu sklepu; zaślepka panelu indywidualnego odpada', () => {
    const zamowienia = [{ sklep: 'erli_polcien', pozycje: [
      { sku: 'LMP-1', produkt_id: null, zdjecie_url: null },
      { sku: ' LMP-2 ', produkt_id: null, zdjecie_url: null },
      { sku: 'LMP-3', produkt_id: null, zdjecie_url: 'https://allegro.example/original/abc' },
      { sku: 'LMP-4', produkt_id: 44, zdjecie_url: null },
      { sku: 'TECHNICZNY-WTYCZKI-INDYWIDUALNE', produkt_id: null, zdjecie_url: null },
      { sku: '', produkt_id: null, zdjecie_url: null },
    ] }];
    expect(skuPozycji(zamowienia, (sku) => sku.startsWith('TECHNICZNY'))).toEqual(['LMP-1', 'LMP-2']);
  });

  it('reguła: zdjęcie pozycji wygrywa z SKU; SKU tylko, gdy pozycja nie ma żadnego zdjęcia', () => {
    const poSku = new Map([['LMP-1', 'https://sklep.example/lmp1-247x296.jpg']]);
    // ERLI: brak produktu i zdjęcia → miniatura z magazynu, BEZ doklejania rozmiaru (to już jest miniatura).
    expect(miniaturaPozycji(new Map(), 'erli_polcien', null, null, 'LMP-1', poSku)).toBe('https://sklep.example/lmp1-247x296.jpg');
    // Pozycja ze zdjęciem (Allegro, sklep) — jak dotąd, SKU nie zmienia niczego.
    expect(miniaturaPozycji(new Map(), 'allegro_a', null, 'https://a.allegroimg.com/original/abc', 'LMP-1', poSku))
      .toBe('https://a.allegroimg.com/s150/abc');
    // Brak SKU w lustrze albo brak mapy → pusto, jak dotąd.
    expect(miniaturaPozycji(new Map(), 'erli_polcien', null, null, 'LMP-9', poSku)).toBeNull();
    expect(miniaturaPozycji(new Map(), 'erli_polcien', null, null, 'LMP-1')).toBeNull();
  });

  it('ekran (lista, karta, nadanie): pozycja ERLI dostaje miniaturę z lustra po SKU', () => {
    const db = baza();
    const miniatura = miniaturyEkranu(db, [{ sklep: 'erli_polcien', pozycje: [{ sku: 'LMP-1', produkt_id: null, zdjecie_url: null }] }]);
    expect(miniatura('erli_polcien', null, null, 'LMP-1')).toBe('https://sklep.example/lmp1-247x296.jpg');
    // Wywołanie bez SKU (stary widok) działa jak przed zmianą.
    expect(miniatura('erli_polcien', null, null)).toBeNull();
  });
});
