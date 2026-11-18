// Filtr kategorii bez duplikatów po encjach HTML.
// Karta niesie kategorię już zdekodowaną („DIY & Craft”), a lustro sklepu potrafi trzymać
// ją z encjami zagnieżdżonymi („DIY &amp;amp; Craft”). Pole wyboru ma mieć JEDNĄ pozycję,
// a wybranie jej ma trafić w obie karty — lista pozycji = dokładnie zbiór osiągalny przez filtr.
import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  utworzKarte,
  zapiszProduktSklepowy,
  powiazProdukt,
  kartyZKanalami,
  kategorieDoFiltra,
} from '../../../src/oms/db/magazyn.js';

let db;
let nr = 0;
function produktZKategoriami(kartaId, kategorie) {
  nr += 1;
  const p = zapiszProduktSklepowy(db, {
    kanal: 'pro',
    produkt_id: String(500 + nr),
    wariant_id: '',
    cena_gr: 1990,
    nazwa: `Produkt ${nr}`,
    kategorie_json: JSON.stringify(kategorie),
    odczytane_at: '2026-11-13T06:00:00.000Z',
  });
  powiazProdukt(db, p, kartaId);
}

describe('filtr kategorii — encje HTML', () => {
  beforeEach(() => {
    db = openOmsDb(':memory:');
    utworzKarte(db, { nazwa: 'Szablon półcień A', kategoria_glowna: 'DIY & Craft' });
    const b = utworzKarte(db, { nazwa: 'Szablon półcień B' });
    produktZKategoriami(b, ['DIY &amp;amp; Craft', 'Boho']);
    const c = utworzKarte(db, { nazwa: 'Szablon półcień C', kategoria_glowna: 'Aplikacje' });
    produktZKategoriami(c, ['Ogród &amp; dom']);
  });

  it('jedna pozycja „DIY & Craft” zamiast dwóch, wartości zdekodowane, kolejność NOCASE', () => {
    expect(kategorieDoFiltra(db)).toEqual(['Aplikacje', 'Boho', 'DIY & Craft', 'Ogród & dom']);
  });

  it('filtr „DIY & Craft” zwraca kartę z kategorią i kartę z encjami w lustrze, bez innych', () => {
    const nazwy = kartyZKanalami(db, { filtry: { kategoria: 'DIY & Craft' } })
      .map((w) => w.nazwa)
      .sort();
    expect(nazwy).toEqual(['Szablon półcień A', 'Szablon półcień B']);
  });

  it('każda pozycja listy trafia w co najmniej jedną kartę', () => {
    for (const k of kategorieDoFiltra(db)) {
      expect(kartyZKanalami(db, { filtry: { kategoria: k } }).length, k).toBeGreaterThan(0);
    }
  });

  it('kategoria karty zapisana z encją (stare dane) też jest dekodowana', () => {
    utworzKarte(db, { nazwa: 'Szablon półcień D', kategoria_glowna: 'Ogród &amp;amp; dom' });
    expect(kategorieDoFiltra(db)).toEqual(['Aplikacje', 'Boho', 'DIY & Craft', 'Ogród & dom']);
    const nazwy = kartyZKanalami(db, { filtry: { kategoria: 'Ogród & dom' } })
      .map((w) => w.nazwa)
      .sort();
    expect(nazwy).toEqual(['Szablon półcień C', 'Szablon półcień D']);
  });
});
