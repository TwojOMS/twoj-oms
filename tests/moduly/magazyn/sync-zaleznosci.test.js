import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszProduktSklepowy, niepowiazaneOfertyAllegro } from '../../../src/oms/db/magazyn.js';
import { odswiezMagazyn } from '../../../src/moduly/magazyn/services/magazyn-sync.js';
import { ofertaNaProdukt } from '../../../src/domena/allegro-oferta.js';

const stare = '2026-09-01T10:00:00.000Z';
const teraz = () => '2026-10-01T12:00:00.000Z';
const kanalySklepow = ['polnoc', 'poludnie'];
const kanalyAllegro = ['wschod', 'zachod'];
const sklep = (produkty) => ({ pobierzWszystkieProdukty: vi.fn(async () => produkty) });
const produkt = (id, name = 'Produkt testowy') => ({ id, name, type: 'simple', price: '12.34' });
const oferta = (id) => ({ id, name: 'Oferta testowa', sellingMode: { price: { amount: '25.00', currency: 'PLN' } } });
const dane = (db) => db.prepare('SELECT * FROM produkty_sklepowe ORDER BY id').all().map(p => ({ ...p }));
function zasiej(db, kanal, produkt_id) {
  db.exec("INSERT OR IGNORE INTO karty_produktow(id,nazwa,sku,utworzony_at,zmieniony_at) VALUES(7,'Karta ręczny','RECZNE-7','x','x')");
  const id = zapiszProduktSklepowy(db, { kanal, produkt_id, wariant_id: '', nazwa: 'Zachowaj', odczytane_at: stare,
    sku_sklepu: 'SKU-TEST', miniatura: 'https://przyklad.invalid/mini.jpg', cena_gr: 999,
    zdjecia_json: '["https://przyklad.invalid/original.jpg"]', kategorie_json: '["Testowa"]' });
  db.prepare('UPDATE produkty_sklepowe SET karta_id=7 WHERE id=?').run(id);
  return id;
}
const odczyt = (db, sklepy, dodatkowe = {}) => odswiezMagazyn({ db, sklepy, allegro: {}, teraz,
  kanalySklepow, kanalyAllegro, log: () => {}, ...dodatkowe });

describe('PRZ-026 — ochrona lustra i neutralne kanały', () => {
  it('pusty odczyt zachowuje każdy zapisany fakt i ręczne powiązanie', async () => {
    const db = openOmsDb();
    try {
      zasiej(db, 'polnoc', '1'); const przed = dane(db); const log = vi.fn();
      const r = await odczyt(db, { polnoc: sklep([]) }, { log });
      expect(dane(db)).toEqual(przed);
      expect(r.kanaly).toEqual([{ kanal: 'polnoc', zapisane: 0, znikniete: 0, blad: expect.stringContaining('0 pozycji') }]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('polnoc'), expect.stringContaining('0 pozycji'));
    } finally { db.close(); }
  });
  it('błąd wariantu po udanym odczycie części katalogu nie zapisuje części i pozwala skończyć drugi kanał', async () => {
    const db = openOmsDb();
    try {
      zasiej(db, 'polnoc', '1'); zasiej(db, 'poludnie', '2');
      const przed = dane(db).filter(p => p.kanal === 'polnoc'); const log = vi.fn();
      const uszkodzony = { pobierzWszystkieProdukty: async () => [produkt(1, 'Nie zapisuj'), { id: 3, name: 'Wariantowy', type: 'variable' }],
        pobierzWarianty: async () => { throw Error('awaria wariantów 503'); } };
      const r = await odczyt(db, { polnoc: uszkodzony, poludnie: sklep([produkt(4, 'Nowy zdrowy')]) }, { log });
      expect(dane(db).filter(p => p.kanal === 'polnoc')).toEqual(przed);
      expect(r.kanaly).toEqual([{ kanal: 'polnoc', zapisane: 0, znikniete: 0, blad: 'awaria wariantów 503' },
        { kanal: 'poludnie', zapisane: 1, znikniete: 1, blad: null }]);
      expect(dane(db).find(p => p.kanal === 'poludnie' && p.produkt_id === '4')).toMatchObject({ nazwa: 'Nowy zdrowy', cena_gr: 1234, zniknal_at: null });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('polnoc'), 'awaria wariantów 503');
    } finally { db.close(); }
  });
  it('błąd zapisu drugiej pozycji cofa aktualizację pierwszej i zniknięcia w tej samej transakcji', async () => {
    const db = openOmsDb();
    try {
      zasiej(db, 'polnoc', '1'); zasiej(db, 'polnoc', '9'); const przed = dane(db);
      db.exec("CREATE TEMP TRIGGER odmowa_test BEFORE INSERT ON produkty_sklepowe WHEN NEW.produkt_id='2' BEGIN SELECT RAISE(ABORT,'odmowa zapisu test'); END");
      const r = await odczyt(db, { polnoc: sklep([produkt(1, 'Nie utrwalaj'), produkt(2)]) });
      expect(dane(db)).toEqual(przed);
      expect(r.kanaly[0]).toMatchObject({ zapisane: 0, znikniete: 0, blad: expect.stringContaining('odmowa zapisu test') });
    } finally { db.close(); }
  });
  it('zdrowy odczyt zachowuje powiązanie, oznacza tylko nieobecne i dopuszcza nowy pusty kanał', async () => {
    const db = openOmsDb();
    try {
      zasiej(db, 'polnoc', '1'); zasiej(db, 'polnoc', '2');
      const r = await odczyt(db, { polnoc: sklep([produkt(1, 'Odświeżony')]), poludnie: sklep([]) });
      expect(r.kanaly).toEqual([{ kanal: 'polnoc', zapisane: 1, znikniete: 1, blad: null }, { kanal: 'poludnie', zapisane: 0, znikniete: 0, blad: null }]);
      expect(dane(db)[0]).toMatchObject({ nazwa: 'Odświeżony', karta_id: 7, zniknal_at: null, odczytane_at: teraz() });
      expect(dane(db)[1]).toMatchObject({ karta_id: 7, zniknal_at: teraz() });
    } finally { db.close(); }
  });
  it('dwa neutralne konta Allegro zapisują własne kanały, a nieznany kanał jest odrzucony przed odczytem', async () => {
    const db = openOmsDb();
    try {
      const obcy = { pobierzOferty: vi.fn(async () => [oferta('3')]) };
      const r = await odczyt(db, {}, { allegro: { wschod: { pobierzOferty: async () => [oferta('1')] },
        zachod: { pobierzOferty: async () => [oferta('2')] }, obcy } });
      expect(dane(db).map(p => [p.kanal, p.produkt_id, p.cena_gr])).toEqual([['wschod', '1', 2500], ['zachod', '2', 2500]]);
      expect(r.kanaly[2]).toMatchObject({ kanal: 'obcy', zapisane: 0, znikniete: 0, blad: expect.stringContaining('nie jest') });
      expect(obcy.pobierzOferty).not.toHaveBeenCalled();
      expect(ofertaNaProdukt(oferta('4'), 'wschod', kanalyAllegro).kanal).toBe('wschod');
      expect(() => ofertaNaProdukt(oferta('4'), 'obcy', kanalyAllegro)).toThrow(/nie jest/);
      expect(() => ofertaNaProdukt(oferta('4'), 'wschod', [])).toThrow(/nie jest/);
    } finally { db.close(); }
  });
  it('zapytanie kandydatów dostaje jawne kanały, odrzuca pozostałe i pustą listę', () => {
    const db = openOmsDb();
    try {
      for (const kanal of ['wschod', 'zachod', 'obcy', 'polnoc']) zapiszProduktSklepowy(db, {
        kanal, produkt_id: '1', wariant_id: '', nazwa: kanal, odczytane_at: stare });
      expect(niepowiazaneOfertyAllegro(db, ['wschod', 'zachod']).map(p => p.kanal)).toEqual(['wschod', 'zachod']);
      expect(niepowiazaneOfertyAllegro(db, [])).toEqual([]);
      expect(niepowiazaneOfertyAllegro(db, ["wschod') OR 1=1 --"])).toEqual([]);
    } finally { db.close(); }
  });
});
