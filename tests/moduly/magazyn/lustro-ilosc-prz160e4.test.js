import { afterEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { powiazProdukt, utworzKarte } from '../../../src/oms/db/magazyn.js';
import { dodajRuch, przelaczStany, stanyKart } from '../../../src/oms/db/stany-magazynowe.js';
import { odswiezMagazyn } from '../../../src/moduly/magazyn/services/magazyn-sync.js';

const data = '2026-11-14T10:00:00.000Z';
let db;
afterEach(() => db?.close());

async function odczytaj({ produkty = [], warianty = [], oferty = [] }) {
  db = openOmsDb(':memory:');
  const wynik = await odswiezMagazyn({ db, kanalySklepow: ['sklep'], kanalyAllegro: ['allegro'],
    sklepy: { sklep: { pobierzWszystkieProdukty: async () => produkty, pobierzWarianty: async () => warianty } },
    allegro: { allegro: { pobierzOferty: async () => oferty } }, teraz: () => data, log: () => {} });
  expect(wynik.kanaly.map(k => k.blad).filter(Boolean)).toEqual([]);
}

const lustro = (kanal, wariant = '') => db.prepare(`SELECT id, ilosc_kanalu, stan_prowadzony, ilosc_odczytana_at
  FROM produkty_sklepowe WHERE kanal = ? AND wariant_id = ?`).get(kanal, wariant);

it('zapisuje ilość Allegro i datę odczytu', async () => {
  await odczytaj({ oferty: [{ id: '123', name: 'Lampa', stock: { available: 490 } }] });
  expect(lustro('allegro')).toMatchObject({ ilosc_kanalu: 490, stan_prowadzony: 'tak', ilosc_odczytana_at: data });
});

it('zapisuje prowadzenie stanu Woo dla produktu i wariantu', async () => {
  await odczytaj({ produkty: [
    { id: 1, name: 'Lampa', type: 'simple', manage_stock: false, stock_quantity: null },
    { id: 2, name: 'Kinkiet', type: 'variable' },
  ], warianty: [{ id: 21, manage_stock: 'parent', stock_quantity: -3 }] });
  expect(lustro('sklep')).toMatchObject({ ilosc_kanalu: null, stan_prowadzony: 'nie', ilosc_odczytana_at: data });
  expect(lustro('sklep', '21')).toMatchObject({ ilosc_kanalu: -3, stan_prowadzony: 'rodzic', ilosc_odczytana_at: data });
});

it('stan nie zależy od lustra', async () => {
  await odczytaj({ oferty: [{ id: '123', name: 'Lampa', stock: { available: 490 } }] });
  const karta = utworzKarte(db, { nazwa: 'Lampa', sku: 'LMP-1' });
  powiazProdukt(db, lustro('allegro').id, karta);
  przelaczStany(db, { wlacz: true, konto: { id: 1, login: 'operator' }, at: data });
  dodajRuch(db, { kartaId: karta, rodzaj: 'przyjecie', ilosc: 3, klucz: 'test-klucz-123456', at: data });
  expect(stanyKart(db).stany.get(karta).stan).toBe(3);
});
