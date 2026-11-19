import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  utworzKarte,
  zapiszProduktSklepowy,
  powiazProdukt,
  zajeteSku,
  produktyKart,
} from '../../../src/oms/db/magazyn.js';

let db;
beforeEach(() => {
  db = openOmsDb(':memory:');
});
afterEach(() => db.close());

const kartaO = (nazwa, reszta = {}) => utworzKarte(db, { nazwa, ...reszta });

/** Produkt w lustrze, powiazany z kartą. Oddaje id wiersza lustra. */
function produktO(kartaId, { kanal = 'pro', produkt_id = null, sku = null, nazwa = 'Produkt' } = {}) {
  const id = zapiszProduktSklepowy(db, {
    kanal,
    produkt_id: produkt_id ?? `p${Math.random().toString(36).slice(2, 9)}`,
    wariant_id: '',
    nazwa,
    sku_sklepu: sku,
    odczytane_at: '2026-08-12T10:00:00.000Z',
  });
  if (kartaId) powiazProdukt(db, id, kartaId);
  return id;
}

describe('zajeteSku z pominięciem produktów wskazanych kart', () => {
  // ⚠️⚠️ BEZ TEGO POMINIECIA PRZEJECIE NIE DZIALALOBY NIGDY: numer, ktory chcemy przejac,
  // ZYJE w lustrze, wiec `zajeteSku` widzi go jako zajety — przez produkt TEJ SAMEJ karty.
  it('numer własnego produktu karty nie wraca jako zajęty', () => {
    const id = kartaO('Bursztyn');
    produktO(id, { sku: 'PD10' });
    expect([...zajeteSku(db, { pomijajProduktyKart: [id] }).keys()]).toEqual([]);
  });

  // MILCZENIE tego samego straznika: bez pominiecia numer JEST zajety — i tak ma byc,
  // bo generator SKU liczy na to, ze o numerach ze sklepow dowie sie stad.
  it('bez pominięcia ten sam numer wraca jako zajęty', () => {
    const id = kartaO('Bursztyn');
    produktO(id, { sku: 'PD10' });
    expect(zajeteSku(db).has('PD10')).toBe(true);
  });

  it('numer produktu INNEJ karty wraca jako zajęty mimo pominięcia', () => {
    const a = kartaO('Bursztyn');
    const b = kartaO('Dąbek');
    produktO(b, { sku: 'PD11' });
    expect(zajeteSku(db, { pomijajProduktyKart: [a] }).has('PD11')).toBe(true);
  });

  it('numer produktu NIEPOWIĄZANEGO z żadnym kartą wraca jako zajęty', () => {
    const a = kartaO('Bursztyn');
    produktO(null, { sku: 'PD12' });
    expect(zajeteSku(db, { pomijajProduktyKart: [a] }).has('PD12')).toBe(true);
  });

  it('nasze numery z rejestru wracają jako zajęte mimo pominięcia produktów', () => {
    const a = kartaO('Bursztyn');
    kartaO('Dąbek', { sku: 'PLC-001' });
    expect(zajeteSku(db, { pomijajProduktyKart: [a] }).has('PLC-001')).toBe(true);
  });

  it('śmieć zamiast numeru karty nie trafia do SQL-a i nie psuje odczytu', () => {
    const a = kartaO('Bursztyn');
    produktO(a, { sku: 'PD10' });
    expect(zajeteSku(db, { pomijajProduktyKart: ['1); DROP TABLE karty_produktow; --'] }).has('PD10')).toBe(true);
  });
});

describe('produktyKart', () => {
  it('oddaje produkty WIELU kart naraz, z numerem karty przy każdym', () => {
    const a = kartaO('Bursztyn');
    const b = kartaO('Dąbek');
    produktO(a, { sku: 'PD10' });
    produktO(b, { sku: 'PD11' });
    const wynik = produktyKart(db, [a, b]);
    expect(wynik.map((p) => [p.karta_id, p.sku_sklepu]).sort()).toEqual(
      [
        [a, 'PD10'],
        [b, 'PD11'],
      ].sort(),
    );
  });

  it('produkt CUDZEGO karty nie wchodzi do wyniku', () => {
    const a = kartaO('Bursztyn');
    const b = kartaO('Dąbek');
    produktO(b, { sku: 'PD11' });
    expect(produktyKart(db, [a])).toEqual([]);
  });

  // ⚠️ PRODUKT ZNIKNIETY ZE SKLEPU NADAL TRZYMA SWOJ NUMER — inaczej karta z jednym produktem
  // wycofanym i jednym zywym o INNYM numerze wygladalby na jednoznaczny, a nie jest.
  it('produkt zniknięty ze sklepu też wraca — jego numer nadal istnieje', () => {
    const a = kartaO('Bursztyn');
    const p = produktO(a, { sku: 'PD10' });
    db.prepare('UPDATE produkty_sklepowe SET zniknal_at = ? WHERE id = ?').run('2026-08-01', p);
    expect(produktyKart(db, [a])).toHaveLength(1);
  });

  it('pusta lista kart oddaje pusto, bez zapytania o wszystko', () => {
    const a = kartaO('Bursztyn');
    produktO(a, { sku: 'PD10' });
    expect(produktyKart(db, [])).toEqual([]);
  });
});
