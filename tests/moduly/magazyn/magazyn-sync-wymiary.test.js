// PRZ-090 — lustro zapisuje wymiary i wagę, które podaje sklep WooCommerce, razem z jednostką sklepu.
import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { odswiezMagazyn } from '../../../src/moduly/magazyn/services/magazyn-sync.js';

const teraz = () => '2026-10-17T10:00:00Z';
const USTAWIENIA = { woocommerce_dimension_unit: 'cm', woocommerce_weight_unit: 'kg' };

const sklep = (produkty, { warianty = {}, ustawienia = USTAWIENIA, bezUstawien = false, ustawieniaRzucaja = false } = {}) => ({
  pobierzWszystkieProdukty: vi.fn(async () => produkty),
  pobierzWarianty: vi.fn(async (id) => warianty[id] ?? []),
  ...(bezUstawien ? {} : {
    ustawienieSklepu: vi.fn(async (id) => {
      if (ustawieniaRzucaja) throw new Error('HTTP 503');
      return ustawienia[id] ?? '';
    }),
  }),
});

const lampa = (nad = {}) => ({
  id: 10, type: 'simple', name: 'Lampa stołowa Grzybek', sku: 'LMP-GRZ-30', price: '249.00',
  dimensions: { length: '45', width: '30', height: '30' }, weight: '1.8', ...nad,
});

const odswiez = (db, sklepy, log = () => {}) => odswiezMagazyn({
  kanalySklepow: ['sklep'], kanalyAllegro: [], db, sklepy, allegro: null, teraz, log,
});
const wiersz = (db, wariant = '') => db.prepare(
  'SELECT wymiary_json, waga_tekst FROM produkty_sklepowe WHERE wariant_id = ?').get(wariant);

describe('odswiezMagazyn — wymiary i waga ze sklepu', () => {
  it('produkt prosty: wymiary z jednostką i waga z jednostką', async () => {
    const db = openOmsDb(':memory:');
    await odswiez(db, { sklep: sklep([lampa()]) });
    expect(JSON.parse(wiersz(db).wymiary_json)).toEqual({ length: '45', width: '30', height: '30', unit: 'cm' });
    expect(wiersz(db).waga_tekst).toBe('1.8 kg');
  });

  it('wariant nie dziedziczy wymiarów ani wagi po rodzicu — tylko własne', async () => {
    const db = openOmsDb(':memory:');
    const rodzic = lampa({ id: 20, type: 'variable', dimensions: { length: '60', width: '40', height: '' }, weight: '2' });
    await odswiez(db, { sklep: sklep([rodzic], { warianty: { 20: [
      { id: 21, sku: 'A', price: '1', attributes: [{ name: 'Kolor', option: 'mosiądz' }], dimensions: { length: '', width: '', height: '' }, weight: '' },
      { id: 22, sku: 'B', price: '1', attributes: [{ name: 'Kolor', option: 'czarny' }], dimensions: { length: '70', width: '', height: '' }, weight: '2.5' },
    ] } }) });
    expect(wiersz(db, '21')).toEqual({ wymiary_json: null, waga_tekst: null });
    expect(JSON.parse(wiersz(db, '22').wymiary_json)).toEqual({ length: '70', width: null, height: null, unit: 'cm' });
    expect(wiersz(db, '22').waga_tekst).toBe('2.5 kg');
  });

  it('sklep bez wymiarów i wagi — kolumny puste (tak jak dziś u sklepu z rozmiarem w nazwie)', async () => {
    const db = openOmsDb(':memory:');
    await odswiez(db, { sklep: sklep([lampa({ dimensions: { length: '', width: '', height: '' }, weight: '' })]) });
    expect(wiersz(db)).toEqual({ wymiary_json: null, waga_tekst: null });
  });

  it('jednostki nie da się odczytać — odczyt katalogu przechodzi, wymiary i waga nie wchodzą, ślad w logu', async () => {
    const db = openOmsDb(':memory:');
    const log = vi.fn();
    const w = await odswiez(db, { sklep: sklep([lampa()], { ustawieniaRzucaja: true }) }, log);
    expect(w.kanaly[0].zapisane).toBe(1);
    expect(wiersz(db)).toEqual({ wymiary_json: null, waga_tekst: null });
    expect(log.mock.calls.flat().join(' ')).toContain('woocommerce_dimension_unit');
  });

  it('klient bez ustawienieSklepu — odczyt przechodzi bez wymiarów', async () => {
    const db = openOmsDb(':memory:');
    await odswiez(db, { sklep: sklep([lampa()], { bezUstawien: true }) });
    expect(wiersz(db)).toEqual({ wymiary_json: null, waga_tekst: null });
  });
});
