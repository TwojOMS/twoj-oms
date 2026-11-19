import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { zapiszProduktSklepowy, powiazProdukt, utworzKarte } from '../../../src/oms/db/magazyn.js';
import { odswiezMagazyn } from '../../../src/moduly/magazyn/services/magazyn-sync.js';
import { typImportu, wykonajImport } from '../../../src/moduly/magazyn/services/import-kanalu.js';
import { uzupelnijSkuZImportu } from '../../../src/moduly/magazyn/services/sku-z-importu.js';
import { createPomocnikiMagazynu } from '../../../src/moduly/magazyn/pomocniki.js';

// Import z kanału uzupełnia PUSTE SKU kart numerem, który ich produkt ma już w sklepie.
// SKU to tożsamość produktu: karta z numerem nie dostaje innego nigdy, kolizja pomija jedną kartę
// (z powodem), a reszta kanału idzie dalej. Dane zmyślone („Pracownia Półcień”).

const AT = '2026-11-19T09:00:00.000Z';
const ZRODLO = 'woo:pro';

let db;
const kartaSql = (id) => db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);
const zrodloSku = (id) =>
  db.prepare("SELECT zrodlo, reczne FROM karty_zrodla_pol WHERE karta_id = ? AND pole = 'sku'").get(id);
const lustro = (kanal, produktId, nazwa, sku) =>
  zapiszProduktSklepowy(db, {
    kanal,
    produkt_id: produktId,
    wariant_id: '',
    nazwa,
    sku_sklepu: sku,
    odczytane_at: '2026-11-18T08:00:00.000Z',
  });
// Karta powiązana z jednym produktem w lustrze danego kanału.
const kartaZProduktem = (nazwa, { sku = null, kanal = 'pro', produktId, skuSklepu }) => {
  const id = utworzKarte(db, { nazwa, sku });
  powiazProdukt(db, lustro(kanal, produktId, nazwa, skuSklepu), id);
  return id;
};
const zrodloPola = (id, zrodlo, reczne) =>
  db
    .prepare(
      "INSERT INTO karty_zrodla_pol (karta_id, pole, zrodlo, reczne, zmieniono_at) VALUES (?, 'sku', ?, ?, '2026-11-01T08:00:00.000Z')",
    )
    .run(id, zrodlo, reczne);
const uzupelnij = (idy) => uzupelnijSkuZImportu(db, idy, { zrodlo: ZRODLO, at: AT });

beforeEach(() => {
  db = openOmsDb(':memory:');
});

describe('usługa uzupełnienia SKU z importu', () => {
  it('pusta karta z produktem z SKU dostaje ten numer; źródło pola = kanał importu, nie ręczne', () => {
    const k = kartaZProduktem('Lampa Półcień 01', { produktId: '101', skuSklepu: ' PP-LAMPA-01 ' });
    const wynik = uzupelnij([k]);
    expect(wynik).toEqual({ uzupelniono: 1, pominiete: [] });
    expect(kartaSql(k).sku).toBe('PP-LAMPA-01');
    expect(kartaSql(k).zmieniony_at).toBe(AT);
    expect(zrodloSku(k)).toEqual({ zrodlo: ZRODLO, reczne: 0 });
  });

  it('SKU z samych spacji to brak numeru — karta dostaje numer ze sklepu', () => {
    const k = kartaZProduktem('Kinkiet Półcień 02', { sku: '   ', produktId: '102', skuSklepu: 'PP-KINKIET-02' });
    expect(uzupelnij([k]).uzupelniono).toBe(1);
    expect(kartaSql(k).sku).toBe('PP-KINKIET-02');
  });

  it('ręcznie wyczyszczone SKU (reczne = 1) zostaje puste — import go nie przywraca', () => {
    const k = kartaZProduktem('Abażur Półcień 03', { produktId: '103', skuSklepu: 'PP-ABAZUR-03' });
    zrodloPola(k, 'reczne', 1);
    const wynik = uzupelnij([k]);
    expect(wynik.uzupelniono).toBe(0);
    expect(kartaSql(k).sku).toBeNull();
    expect(zrodloSku(k)).toEqual({ zrodlo: 'reczne', reczne: 1 });
  });

  it('karta z SKU nie dostaje innego numeru — także gdy źródłem pola jest ten sam kanał', () => {
    const tenSam = kartaZProduktem('Plafon Półcień 04', {
      sku: 'PP-STARY-04',
      produktId: '104',
      skuSklepu: 'PP-NOWY-04',
    });
    zrodloPola(tenSam, ZRODLO, 0);
    const bezZrodla = kartaZProduktem('Plafon Półcień 05', {
      sku: 'PP-STARY-05',
      produktId: '105',
      skuSklepu: 'PP-NOWY-05',
    });
    const wynik = uzupelnij([tenSam, bezZrodla]);
    expect(wynik).toEqual({ uzupelniono: 0, pominiete: [] });
    expect(kartaSql(tenSam).sku).toBe('PP-STARY-04');
    expect(kartaSql(bezZrodla).sku).toBe('PP-STARY-05');
  });

  it('kolizja z SKU innej karty pomija TĘ kartę z powodem, a reszta kanału dostaje numery', () => {
    const wlasciciel = utworzKarte(db, { nazwa: 'Klosz Półcień 06b', sku: 'PP-KLOSZ-06' });
    const k = kartaZProduktem('Klosz Półcień 06', { produktId: '106', skuSklepu: 'pp-klosz-06' });
    const wolna = kartaZProduktem('Klosz Półcień 07', { produktId: '107', skuSklepu: 'PP-KLOSZ-07' });
    const wynik = uzupelnij([k, wolna]);
    expect(wynik.uzupelniono).toBe(1);
    expect(wynik.pominiete).toEqual([
      {
        id: k,
        nazwa: 'Klosz Półcień 06',
        sku: 'pp-klosz-06',
        powod: `Klosz Półcień 06: SKU pp-klosz-06 ma już karta „Klosz Półcień 06b" (#${wlasciciel})`,
      },
    ]);
    expect(kartaSql(k).sku).toBeNull();
    expect(kartaSql(wolna).sku).toBe('PP-KLOSZ-07');
  });

  it('kolizja z numerem produktu w innym sklepie pomija kartę — sklep miałby duplikat', () => {
    lustro('swietlik', '501', 'Kubek Świetlik', 'PP-KUBEK-08');
    const k = kartaZProduktem('Kubek Półcień 08', { produktId: '108', skuSklepu: 'PP-KUBEK-08' });
    const wynik = uzupelnij([k]);
    expect(wynik.uzupelniono).toBe(0);
    expect(wynik.pominiete.map((p) => p.powod)).toEqual([
      'Kubek Półcień 08: SKU PP-KUBEK-08 ma już produkt swietlik — „Kubek Świetlik"',
    ]);
    expect(kartaSql(k).sku).toBeNull();
  });

  it('dwie karty po ten sam numer — obie pominięte, żadna nie wygrywa alfabetem', () => {
    const a = kartaZProduktem('Świecznik Półcień A', { produktId: '109', skuSklepu: 'PP-SWIECZNIK-09' });
    const b = kartaZProduktem('Świecznik Półcień B', {
      kanal: 'swietlik',
      produktId: '509',
      skuSklepu: 'PP-SWIECZNIK-09',
    });
    const wynik = uzupelnij([a, b]);
    expect(wynik.uzupelniono).toBe(0);
    expect(wynik.pominiete.map((p) => p.powod)).toEqual([
      'Świecznik Półcień A: SKU PP-SWIECZNIK-09 chce też karta „Świecznik Półcień B"',
      'Świecznik Półcień B: SKU PP-SWIECZNIK-09 chce też karta „Świecznik Półcień A"',
    ]);
    expect(kartaSql(a).sku).toBeNull();
    expect(kartaSql(b).sku).toBeNull();
  });

  it('dwa produkty karty z różnymi SKU — karta pominięta z oboma numerami w powodzie', () => {
    const k = kartaZProduktem('Lampka Półcień 10', { produktId: '110', skuSklepu: 'PP-LAMPKA-10' });
    powiazProdukt(db, lustro('swietlik', '510', 'Lampka na Świetliku', 'PP-LAMPKA-10X'), k);
    const wynik = uzupelnij([k]);
    expect(wynik.uzupelniono).toBe(0);
    expect(wynik.pominiete).toEqual([
      {
        id: k,
        nazwa: 'Lampka Półcień 10',
        sku: 'PP-LAMPKA-10, PP-LAMPKA-10X',
        powod: 'Lampka Półcień 10: produkty mają różne SKU (PP-LAMPKA-10, PP-LAMPKA-10X) — wpisz właściwe na karcie',
      },
    ]);
    expect(kartaSql(k).sku).toBeNull();
  });

  it('karta bez produktu z SKU nie jest ani uzupełniona, ani pominięta', () => {
    const k = kartaZProduktem('Wazon Półcień 11', { produktId: '111', skuSklepu: null });
    expect(uzupelnij([k, k])).toEqual({ uzupelniono: 0, pominiete: [] });
  });
});

describe('„Importuj" uzupełnia puste SKU', () => {
  const tresc = (id) => ({
    id,
    kanal: 'pro',
    produkt_id: '0',
    wariant_id: '',
    tresc_woo: { pola: {}, zdjecia: [], kategoria: null },
  });
  const opcje = (typ, idy, kanal = 'pro') => ({
    kanal,
    typ: typImportu(typ),
    kanalyZrodlowe: ['pro'],
    allegro: kanal.startsWith('allegro'),
    tresc: idy.map(tresc),
    teraz: () => AT,
  });

  it('typ aktualizujący: powiązana pusta karta dostaje SKU, kolizja wraca w wyniku', () => {
    const k = utworzKarte(db, { nazwa: 'Lampa Półcień 12' });
    const w12 = lustro('pro', '112', 'Lampa Półcień 12', 'PP-LAMPA-12');
    powiazProdukt(db, w12, k);
    utworzKarte(db, { nazwa: 'Lampa Półcień 13b', sku: 'PP-LAMPA-13' });
    const kolizja = utworzKarte(db, { nazwa: 'Lampa Półcień 13' });
    const w13 = lustro('pro', '113', 'Lampa Półcień 13', 'PP-LAMPA-13');
    powiazProdukt(db, w13, kolizja);
    const wynik = wykonajImport(db, opcje('aktualizuj', [w12, w13]));
    expect(kartaSql(k).sku).toBe('PP-LAMPA-12');
    expect(kartaSql(kolizja).sku).toBeNull();
    expect(wynik.sku.uzupelniono).toBe(1);
    expect(wynik.sku.pominiete.map((p) => p.id)).toEqual([kolizja]);
  });

  it('Allegro nie uzupełnia SKU (tylko sklep Woo)', () => {
    const k = utworzKarte(db, { nazwa: 'Kinkiet Półcień 14' });
    const w = lustro('allegro_swietlik', '7014', 'Kinkiet na Allegro', 'PP-KINKIET-14');
    powiazProdukt(db, w, k);
    const wynik = wykonajImport(db, opcje('aktualizuj', [w], 'allegro_swietlik'));
    expect(kartaSql(k).sku).toBeNull();
    expect(wynik.sku).toEqual({ uzupelniono: 0, pominiete: [] });
  });

  it('ekran wyniku pokazuje licznik i powód pominięcia', async () => {
    const k = utworzKarte(db, { nazwa: 'Plafon Półcień 15' });
    powiazProdukt(db, lustro('pro', '115', 'Plafon Półcień 15', 'PP-PLAFON-15'), k);
    const wlasciciel = utworzKarte(db, { nazwa: 'Plafon Półcień 16b', sku: 'PP-PLAFON-16' });
    const kolizja = utworzKarte(db, { nazwa: 'Plafon Półcień 16' });
    powiazProdukt(db, lustro('pro', '116', 'Plafon Półcień 16', 'PP-PLAFON-16'), kolizja);
    const produkt = (id, sku, name) => ({ id, sku, name, type: 'simple', images: [], categories: [], attributes: [] });
    const app = buildOmsServer({
      db,
      config: { auth: { user: 'adam', pass: 'x' } },
      sklepy: {
        pro: {
          pobierzWszystkieProdukty: vi.fn(async () => [
            produkt(115, 'PP-PLAFON-15', 'Plafon Półcień 15'),
            produkt(116, 'PP-PLAFON-16', 'Plafon Półcień 16'),
          ]),
          pobierzWarianty: vi.fn(async () => []),
        },
      },
    });
    const naglowki = {
      authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
      origin: 'http://localhost',
      'content-type': 'application/x-www-form-urlencoded',
    };
    const r = await app.inject({
      method: 'POST',
      url: '/magazyn/import/sprawdz',
      headers: naglowki,
      payload: 'kanal=pro&typ=aktualizuj',
    });
    expect(r.statusCode).toBe(303);
    for (let i = 0; i < 200; i += 1) {
      const g = await app.inject({ method: 'GET', url: r.headers.location, headers: naglowki });
      if (g.body.includes('data-krok="podglad"')) break;
      await new Promise((ok) => {
        setTimeout(ok, 5);
      });
    }
    // „Sprawdź" tylko czyta — SKU jeszcze nie ma.
    expect(kartaSql(k).sku).toBeNull();
    const wynik = await app.inject({
      method: 'POST',
      url: '/magazyn/import/importuj',
      headers: naglowki,
      payload: 'kanal=pro&typ=aktualizuj',
    });
    expect(wynik.statusCode).toBe(200);
    expect(kartaSql(k).sku).toBe('PP-PLAFON-15');
    expect(kartaSql(kolizja).sku).toBeNull();
    expect(wynik.body).toContain('Uzupełniono SKU: 1 kart, pominięto: 1');
    expect(wynik.body).toContain(
      `Plafon Półcień 16: SKU PP-PLAFON-16 ma już karta „Plafon Półcień 16b" (#${wlasciciel})`.replaceAll('"', '&#34;'),
    );
  });
});

describe('odczyt katalogów (Odśwież) uzupełnia puste SKU', () => {
  const produkt = (id, sku, name) => ({ id, sku, name, type: 'simple', images: [], categories: [], attributes: [] });
  const odczyt = (produkty) =>
    odswiezMagazyn({
      db,
      sklepy: {
        pro: { pobierzWszystkieProdukty: vi.fn(async () => produkty), pobierzWarianty: vi.fn(async () => []) },
      },
      kanalySklepow: ['pro'],
      kanalyAllegro: [],
      teraz: () => AT,
      log: vi.fn(),
    });

  it('pusta karta powiązana z produktem dostaje SKU; wynik kanału niesie licznik i pominięcia', async () => {
    const k = kartaZProduktem('Lampa Półcień 17', { produktId: '117', skuSklepu: 'PP-LAMPA-17' });
    utworzKarte(db, { nazwa: 'Lampa Półcień 18b', sku: 'PP-LAMPA-18' });
    const kolizja = kartaZProduktem('Lampa Półcień 18', { produktId: '118', skuSklepu: 'PP-LAMPA-18' });
    const zSku = kartaZProduktem('Lampa Półcień 19', {
      sku: 'PP-WLASNY-19',
      produktId: '119',
      skuSklepu: 'PP-LAMPA-19',
    });
    zrodloPola(zSku, ZRODLO, 0);
    const wynik = await odczyt([
      produkt(117, 'PP-LAMPA-17', 'Lampa Półcień 17'),
      produkt(118, 'PP-LAMPA-18', 'Lampa Półcień 18'),
      produkt(119, 'PP-LAMPA-19', 'Lampa Półcień 19'),
    ]);
    expect(wynik.kanaly[0].blad).toBeNull();
    expect(kartaSql(k).sku).toBe('PP-LAMPA-17');
    expect(kartaSql(kolizja).sku).toBeNull();
    expect(kartaSql(zSku).sku).toBe('PP-WLASNY-19');
    expect(wynik.kanaly[0].sku.uzupelniono).toBe(1);
    expect(wynik.kanaly[0].sku.pominiete.map((p) => p.id)).toEqual([kolizja]);
  });

  it('odczyt „Sprawdź" (bez treści do kart) niczego nie uzupełnia', async () => {
    const k = kartaZProduktem('Lampa Półcień 20', { produktId: '120', skuSklepu: 'PP-LAMPA-20' });
    await odswiezMagazyn({
      db,
      sklepy: {
        pro: {
          pobierzWszystkieProdukty: vi.fn(async () => [produkt(120, 'PP-LAMPA-20', 'Lampa Półcień 20')]),
          pobierzWarianty: vi.fn(async () => []),
        },
      },
      kanalySklepow: ['pro'],
      kanalyAllegro: [],
      trescKart: false,
      teraz: () => AT,
      log: vi.fn(),
    });
    expect(kartaSql(k).sku).toBeNull();
  });

  it('streszczenie przebiegu na liście mówi, ile SKU uzupełniono i ile pominięto', () => {
    const { opisPrzebiegu } = createPomocnikiMagazynu({ kanalySklepow: ['pro'], kanalyAllegro: [], definicje: [] });
    const opis = opisPrzebiegu({
      trwa: false,
      blad: null,
      skonczony_at: AT,
      kanaly: [
        { kanal: 'pro', zapisane: 3, znikniete: 0, blad: null, sku: { uzupelniono: 2, pominiete: [{ id: 1 }] } },
        { kanal: 'swietlik', zapisane: 1, znikniete: 0, blad: 'odmowa', sku: undefined },
      ],
    });
    expect(opis.streszczenie).toMatch(/^ostatni przebieg .+ · uzupełniono SKU: 2 kart, pominięto: 1$/);
  });
});
