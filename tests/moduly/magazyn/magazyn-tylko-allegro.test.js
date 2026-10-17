// PRZ-090 — instancja bez sklepu WooCommerce: karty produktów powstają z ofert Allegro (decyzja właściciela 17.10).
// Z co najmniej jednym sklepem nic się nie zmienia: karta powstaje ze sklepu, ofertę Allegro wiąże się ręcznie.
import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';
import { createPomocnikiMagazynu } from '../../../src/moduly/magazyn/pomocniki.js';
import { kanalyZrodloweKart } from '../../../src/domena/karta-z-produktu.js';

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

const zapisz = (p) => zapiszProduktSklepowy(db, { wariant_id: '', odczytane_at: '2026-10-17T06:00:00.000Z', ...p });
const karty = () => db.prepare('SELECT nazwa FROM karty_produktow ORDER BY nazwa').all().map((k) => k.nazwa);
const pomoc = (kanalySklepow, kanalyAllegro) => createPomocnikiMagazynu({ kanalySklepow, kanalyAllegro, definicje: [] });

describe('kanalyZrodloweKart', () => {
  it('ze sklepami źródłem są sklepy, bez sklepów — konta Allegro', () => {
    expect(kanalyZrodloweKart(['sklep'], ['allegro_a'])).toEqual(['sklep']);
    expect(kanalyZrodloweKart([], ['allegro_a', 'allegro_b'])).toEqual(['allegro_a', 'allegro_b']);
    expect(kanalyZrodloweKart([], [])).toEqual([]);
  });
});

describe('Utwórz karty z niepowiązanych — tylko Allegro', () => {
  it('bez sklepu Woo karta powstaje z oferty Allegro i jest z nią powiązana', () => {
    const id = zapisz({ kanal: 'allegro_a', produkt_id: '9000000001', nazwa: 'Lampa stołowa Grzybek 30x45cm' });
    const wynik = pomoc([], ['allegro_a']).utworzKartyZNiepowiazanych(db);
    expect(wynik.utworzone).toBe(1);
    expect(karty()).toEqual(['Lampa stołowa Grzybek']);
    const { karta_id: kartaId } = db.prepare('SELECT karta_id FROM produkty_sklepowe WHERE id = ?').get(id);
    expect(kartaId).toBeGreaterThan(0);
  });

  it('ze sklepem Woo oferta Allegro nadal nie zakłada karty (zachowanie dotychczasowe)', () => {
    zapisz({ kanal: 'allegro_a', produkt_id: '9000000001', nazwa: 'Lampa stołowa Grzybek 30x45cm' });
    zapisz({ kanal: 'sklep', produkt_id: '10', nazwa: 'Kinkiet Ramię' });
    const wynik = pomoc(['sklep'], ['allegro_a']).utworzKartyZNiepowiazanych(db);
    expect(wynik.utworzone).toBe(1);
    expect(karty()).toEqual(['Kinkiet Ramię']);
    expect(wynik.pominiete).toHaveLength(1);
  });

  it('ekran „pominięte” bez sklepu nie odsyła ofert Allegro do ręcznego wiązania', () => {
    zapisz({ kanal: 'allegro_a', produkt_id: '1', nazwa: 'Kinkiet Ramię' });
    expect(pomoc([], ['allegro_a']).produktyPominiete(db)).toEqual([]);
    expect(pomoc(['sklep'], ['allegro_a']).produktyPominiete(db)).toHaveLength(1);
  });
});
