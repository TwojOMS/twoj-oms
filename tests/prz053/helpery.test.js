import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { ofertaNaProdukt } from '../../src/domena/allegro-oferta.js';
import { powodPominiecia, czyPominietyCelowo } from '../../src/domena/karta-z-produktu.js';
import { ocenZapis, zmianyDoWyslania } from '../../src/domena/zapis-do-sklepu.js';
import { filtryZZapytania } from '../../src/domena/magazyn-filtry.js';
import { grupujPominiete } from '../../src/domena/magazyn-pominiete.js';
import * as magazyn from '../../src/oms/db/magazyn.js';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { odswiezMagazyn } from '../../src/moduly/magazyn/services/magazyn-sync.js';
import { zbudujOms } from '../../src/oms/bootstrap.ts';

const oferta = { id: '0099', name: 'Oferta próbna', sellingMode: { price: { amount: '12.34', currency: 'PLN' } } };
const publiczne = [
  ['ofertaNaProdukt', lista => ofertaNaProdukt(oferta, 'wschod', lista)],
  ['powodPominiecia', lista => powodPominiecia(null, lista)],
  ['czyPominietyCelowo', lista => czyPominietyCelowo(null, lista)],
  ['ocenZapis', lista => ocenZapis(null, [], {}, lista)],
  ['zmianyDoWyslania', lista => zmianyDoWyslania(null, [], {}, lista)],
  ['filtryZZapytania', lista => filtryZZapytania({}, lista)],
  ['grupujPominiete', lista => grupujPominiete([], lista)],
  ['zliczeniaNiepowiazanych', lista => magazyn.zliczeniaNiepowiazanych(null, lista)],
  ['utworzKartyZNiepowiazanych', lista => magazyn.utworzKartyZNiepowiazanych(null, { kanalySklepow: lista })],
  ['niepowiazaneOfertyAllegro', lista => magazyn.niepowiazaneOfertyAllegro(null, lista)],
  ['powiazaneOfertyAllegro', lista => magazyn.powiazaneOfertyAllegro(null, lista)],
  ['powiazOfertyHurtem', lista => magazyn.powiazOfertyHurtem(null, [], lista)],
  ['odepnijOferte', lista => magazyn.odepnijOferte(null, 1, lista)],
  ['produktyPominiete', lista => magazyn.produktyPominiete(null, lista)],
];
describe('PRZ-053 — jawne listy helperów', () => {
  it.each(publiczne)('%s odmawia braku listy i nie-tablicy także przy pustych danych', (_nazwa, fn) => {
    for (const brak of [undefined, null, 'wschod', {}]) {
      expect(() => fn(brak)).toThrow(TypeError);
      expect(() => fn(brak)).toThrow(/lista kanałów/i);
    }
  });
  it('sync wymaga osobno obu list przed dotknięciem klientów', async () => {
    const klient = { pobierzWszystkieProdukty: vi.fn(async () => []) };
    for (const pole of ['kanalySklepow', 'kanalyAllegro']) for (const brak of [undefined, null, 'x', {}]) {
      await expect(odswiezMagazyn({ db: null, sklepy: { polnoc: klient }, kanalySklepow: [], kanalyAllegro: [], [pole]: brak })).rejects.toThrow(/lista kanałów/i);
    }
    expect(klient.pobierzWszystkieProdukty).not.toHaveBeenCalled();
  });
  it('puste listy oznaczają pusty zakres bez przywrócenia dawnych kanałów', async () => {
    const db = openOmsDb();
    try {
      expect(magazyn.zliczeniaNiepowiazanych(db, [])).toEqual({ pominiete: 0, ofertyAllegro: 0 });
      expect(magazyn.niepowiazaneOfertyAllegro(db, [])).toEqual([]);
      expect(magazyn.powiazaneOfertyAllegro(db, [])).toEqual([]);
      expect(magazyn.powiazOfertyHurtem(db, [], [])).toEqual({ powiazane: [], nieaktualne: [] });
      expect(magazyn.odepnijOferte(db, 1, [])).toBe(false);
      expect(magazyn.utworzKartyZNiepowiazanych(db, { kanalySklepow: [] })).toEqual({ utworzone: 0, pominiete: [] });
      expect(magazyn.produktyPominiete(db, [])).toEqual([]);
      expect(grupujPominiete([], [])).toEqual([]);
      expect(filtryZZapytania({ kanal: 'pro' }, []).kanal).toBeNull();
      expect(ocenZapis(null, [], {}, [])).toEqual({ zmiany: [], wstrzymane: [] });
      expect(zmianyDoWyslania(null, [], {}, [])).toEqual([]);
      expect(() => ofertaNaProdukt(oferta, 'allegro_szkicownia', [])).toThrow(/nie jest/);
      expect(await odswiezMagazyn({ db, sklepy: {}, allegro: {}, kanalySklepow: [], kanalyAllegro: [] })).toEqual({ kanaly: [] });
    } finally { db.close(); }
  });
  it('zmianyDoWyslania propaguje listę klienta i zachowuje własność SKU oraz jednostki', () => {
    const karta = { id: 1, sku: 'NOWY-1', szerokosc_mm: 100, wysokosc_mm: 200 };
    const p = kanal => ({ kanal, produkt_id: '42', wariant_id: '', sku_sklepu: '' });
    for (const kanal of ['polnoc', 'poludnie']) {
      const zmiany = zmianyDoWyslania(karta, [p(kanal), p('pro')], { [kanal]: 'cm' }, [kanal]);
      expect(zmiany).toHaveLength(1);
      expect(zmiany[0]).toMatchObject({ kanal, sciezka: 'products/42', pola: { sku: 'NOWY-1', dimensions: { length: '20', width: '10' } } });
    }
  });
  it('jawna lista ofert nie zgaduje typu z prefiksu i chroni wiązanie oraz odpinanie', () => {
    const db = openOmsDb();
    try {
      const w = magazyn.utworzKarte(db, { nazwa: 'Karta testowa' });
      const ids = Object.fromEntries(['wschod', 'zachod', 'allegro_obce', 'pro'].map(kanal => [kanal,
        magazyn.zapiszProduktSklepowy(db, { kanal, produkt_id: '9', nazwa: kanal, odczytane_at: 'x' })]));
      for (const kanal of ['wschod', 'zachod']) {
        expect(magazyn.niepowiazaneOfertyAllegro(db, [kanal]).map(p => p.kanal)).toEqual([kanal]);
        expect(magazyn.powiazOfertyHurtem(db, [{ produktId: ids[kanal], kartaId: w }, { produktId: ids.allegro_obce, kartaId: w }], [kanal]))
          .toEqual({ powiazane: [ids[kanal]], nieaktualne: [ids.allegro_obce] });
        expect(magazyn.powiazaneOfertyAllegro(db, [kanal]).map(p => p.kanal)).toEqual([kanal]);
        expect(magazyn.odepnijOferte(db, ids[kanal], [])).toBe(false);
        expect(magazyn.odepnijOferte(db, ids[kanal], [kanal])).toBe(true);
      }
      expect(magazyn.niepowiazaneOfertyAllegro(db, [])).toEqual([]);
    } finally { db.close(); }
  });
  it('rzeczywisty moduł przekazuje obie listy do odczytu w dwóch osobnych konfiguracjach', async () => {
    const env = { OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_USER: 'operator', OMS_PASS: 'test',
      OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
    for (const [sklep, konto] of [['polnoc', 'wschod'], ['poludnie', 'zachod']]) {
      const a = await zbudujOms({ env, nadpisania: {
        'kanaly.config': { sklepy: { [sklep]: {} }, kanaly: { [konto]: {} }, definicje: [
          { klucz: sklep, typ: 'woo', prefiks: 'SKLEP_TEST' },
          { klucz: konto, typ: 'allegro', prefiks: 'ALLEGRO_TEST' },
        ] },
        'kanaly.klienciSklepow': { [sklep]: { pobierzWszystkieProdukty: async () => [{ id: 1, name: 'Produkt klienta', type: 'simple', price: '5.00' }] } },
        'kanaly.klienciKanalow': { [konto]: { pobierzOferty: async () => [oferta] } },
      } });
      try {
        const przebieg = a.usluga('magazyn', 'magazyn');
        expect(przebieg.start()).toEqual({ wystartowal: true });
        for (let i = 0; i < 40 && przebieg.stan().trwa; i++) await new Promise(resolve => setImmediate(resolve));
        expect(przebieg.stan()).toMatchObject({ trwa: false, blad: null, kanaly: [{ kanal: sklep, zapisane: 1, blad: null }, { kanal: konto, zapisane: 1, blad: null }] });
        expect(a.db.prepare('SELECT kanal,cena_gr FROM produkty_sklepowe ORDER BY id').all()).toEqual([{ kanal: sklep, cena_gr: 500 }, { kanal: konto, cena_gr: 1234 }]);
      } finally { await a.app.close(); a.db.close(); }
    }
  });
});
