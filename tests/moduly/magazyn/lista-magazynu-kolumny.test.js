import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte, zapiszProduktSklepowy, powiazProdukt, kartyZKanalami } from '../../../src/oms/db/magazyn.js';

// Lista Magazynu nie pokazuje opisów, a opisy (sekcje opisu karty, opis ze sklepu) to największe
// kolumny katalogu. Wariant „lista” zapytania ich nie wyciąga; pełne wiersze zostają dla eksportu,
// akcji hurtowych i karty, które z opisów korzystają.

const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};
const OPIS = 'Lampa wisząca z Pracowni Półcień — długi opis, którego lista nie pokazuje.';

let db;
beforeEach(() => {
  db = openOmsDb(':memory:');
  const karta = utworzKarte(db, { nazwa: 'Lampa Półcień', sku: 'PLC-1' });
  db.prepare('UPDATE karty_produktow SET opis = ?, opis_sekcje_json = ? WHERE id = ?').run(
    OPIS,
    JSON.stringify([{ tytul: 'Materiał', tresc: OPIS }]),
    karta,
  );
  const produkt = zapiszProduktSklepowy(db, {
    kanal: 'sklep_polcien',
    produkt_id: '101',
    wariant_id: '',
    nazwa: 'Lampa Półcień',
    sku_sklepu: 'PLC-1',
    cena_gr: 12900,
    adres: 'https://sklep.polcien.example.invalid/lampa',
    miniatura: 'https://sklep.polcien.example.invalid/lampa-m.jpg',
    opis_zrodlowy: OPIS,
    odczytane_at: '2026-11-13T06:00:00.000Z',
  });
  powiazProdukt(db, produkt, karta);
});
afterEach(() => db.close());

describe('zapytanie listy Magazynu bez opisów', () => {
  it('wariant „lista” pomija opisy karty i produktu, resztę wiersza zostawia', () => {
    const [pelny] = kartyZKanalami(db, {});
    const [lista] = kartyZKanalami(db, { kolumny: 'lista' });
    expect(pelny.opis).toBe(OPIS);
    expect(pelny.opis_sekcje_json).toContain('Materiał');
    expect(pelny.kanaly.sklep_polcien.opis_zrodlowy).toBe(OPIS);

    expect(lista).not.toHaveProperty('opis');
    expect(lista).not.toHaveProperty('opis_sekcje_json');
    expect(lista.kanaly.sklep_polcien).not.toHaveProperty('opis_zrodlowy');
    const bezOpisow = (w) => {
      const { opis, opis_sekcje_json, kanaly, ...reszta } = w;
      const { opis_zrodlowy, ...kanal } = kanaly.sklep_polcien;
      return { ...reszta, kanal };
    };
    expect(bezOpisow(lista)).toEqual(bezOpisow(pelny));
  });

  it('trasa listy używa wariantu bez opisów', async () => {
    const zapytania = [];
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => (zapytania.push(sql), prepare(sql));
    const app = buildOmsServer({
      db,
      config: { auth: { user: 'adam', pass: 'x' } },
      magazyn: { start: () => ({ wystartowal: true }), stan: () => ({ trwa: false, kanaly: [] }) },
    });
    try {
      await app.ready();
      zapytania.length = 0;
      const r = await app.inject({ url: '/magazyn', headers: auth });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('Lampa Półcień');
      expect(r.body).not.toContain('długi opis');
      const listy = zapytania.filter((sql) => /AS liczba_brakow FROM karty_produktow w/.test(sql));
      expect(listy).toHaveLength(1);
      expect(listy[0]).not.toMatch(/\bw\.\*/);
      const produktow = zapytania.filter((sql) => /FROM produkty_sklepowe p\b/.test(sql));
      expect(produktow.length).toBeGreaterThan(0);
      for (const sql of produktow) expect(sql).not.toMatch(/\bp\.\*/);
    } finally {
      await app.close();
    }
  });
});
