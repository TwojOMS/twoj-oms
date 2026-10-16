// PRZ-087 — miniatury produktów w demo. Do PRZ-087 katalog demo dawał zaślepki `data:image/svg+xml`, a ekrany
// (domena/miniatura-pozycji.js, domena/miniatury.js) przepuszczają wyłącznie adresy http(s) — gość nie widział
// ani jednej miniatury: ani na liście zamówień, ani na karcie, ani w Magazynie.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PRODUKTY, KANALY } from '../../scripts/demo-dane-firma.mjs';
import { ADRES_ZDJEC_DEMO, zdjecieProduktu, katalogWoo, ofertyAllegro } from '../../scripts/demo-dane-katalog.mjs';
import { utworzBazeDemo, ENV_DEMO } from '../../scripts/demo-dane.mjs';
import { miniaturaZLustra } from '../../src/domena/miniatura-pozycji.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const KATALOG_ZDJEC = path.resolve(import.meta.dirname, '../../src/public/demo-produkty');
/** Adres demo → plik w src/public; adres spoza puli zdjęć demo = null. */
function plikZAdresu(adres) {
  if (typeof adres !== 'string' || !adres.startsWith(`${ADRES_ZDJEC_DEMO}/`)) return null;
  return path.join(KATALOG_ZDJEC, adres.slice(ADRES_ZDJEC_DEMO.length + 1));
}
function zdjecieIstnieje(adres) {
  const plik = plikZAdresu(adres);
  return plik !== null && fs.existsSync(plik) && fs.statSync(plik).size > 1000;
}

describe('zdjęcia katalogu demo', () => {
  it('pula zdjęć leży pod /public/ (otwarte bez logowania) w src/public/demo-produkty', () => {
    expect(ADRES_ZDJEC_DEMO).toMatch(/^https:\/\/[^/]+\/public\/demo-produkty$/);
  });

  it('każdy produkt ma zdjęcie, które istnieje i przechodzi regułę ekranu', () => {
    for (const p of PRODUKTY) {
      const adres = zdjecieProduktu(p.sku);
      expect(zdjecieIstnieje(adres), `${p.sku} → ${adres}`).toBe(true);
      expect(miniaturaZLustra(adres, null)).toBe(adres);
      // Pozycja bez lustra idzie gałęzią zapasową: adresMiniatury dokleja `-150x150` (konwencja WordPressa).
      expect(zdjecieIstnieje(miniaturaZLustra(null, adres)), `${p.sku} → ${miniaturaZLustra(null, adres)}`).toBe(true);
    }
  });

  it('różne kategorie nie dostają tego samego zdjęcia, a w kategorii zdjęcia się przeplatają', () => {
    const kategoriaZdjecia = new Map();
    for (const p of PRODUKTY) {
      const adres = zdjecieProduktu(p.sku);
      expect(kategoriaZdjecia.get(adres) ?? p.kategoria, adres).toBe(p.kategoria);
      kategoriaZdjecia.set(adres, p.kategoria);
    }
    const stolowe = new Set(PRODUKTY.filter((p) => p.kategoria === 'Lampy stołowe').map((p) => zdjecieProduktu(p.sku)));
    expect(stolowe.size).toBeGreaterThan(1);
  });

  it('nieznane SKU → null (pozycja pokaże samą nazwę, jak dotąd)', () => {
    expect(zdjecieProduktu('NIE-MA-TAKIEGO')).toBeNull();
  });

  it('lustro Woo: miniatury i images[0].src to zdjęcia demo', () => {
    for (const kanal of KANALY.filter((k) => k.typ === 'woo').map((k) => k.klucz)) {
      const k = katalogWoo(kanal);
      expect(k.miniatury.size).toBe(k.produkty.length);
      for (const p of k.produkty) {
        const m = k.miniatury.get(String(p.id));
        expect(zdjecieIstnieje(m), `${p.name} → ${m}`).toBe(true);
        expect(p.images[0]?.src).toBe(m);
      }
    }
  });

  it('oferty Allegro: primaryImage.url to zdjęcie demo', () => {
    for (const kanal of KANALY.filter((k) => k.typ === 'allegro').map((k) => k.klucz)) {
      for (const o of ofertyAllegro(kanal)) expect(zdjecieIstnieje(o.primaryImage?.url), o.name).toBe(true);
    }
  });
});

describe('baza demo: pozycje zamówień niosą zdjęcie', () => {
  let katalog, db;
  beforeAll(async () => {
    katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-demo-miniatury-'));
    const env = { ...ENV_DEMO, OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog };
    await utworzBazeDemo({ baza: path.join(katalog, 'oms.sqlite'), dzis: '2026-10-14', env });
    db = new DatabaseSync(path.join(katalog, 'oms.sqlite'));
  }, 180_000);
  afterAll(() => { db?.close(); fs.rmSync(katalog, { recursive: true, force: true }); });

  it('każda pozycja z kanału ma zdjęcie demo, także w rozmiarze, który pokazuje lista', () => {
    const pozycje = db.prepare("SELECT nazwa, zdjecie_url FROM pozycje WHERE zrodlo = 'sklep'").all();
    expect(pozycje.length).toBeGreaterThan(100);
    const bez = pozycje.filter((p) => !zdjecieIstnieje(p.zdjecie_url) || !zdjecieIstnieje(miniaturaZLustra(null, p.zdjecie_url)));
    expect(bez.slice(0, 3)).toEqual([]);
  });

  it('lustro magazynu ma miniatury demo', () => {
    const wiersze = db.prepare('SELECT miniatura FROM produkty_sklepowe').all();
    expect(wiersze.length).toBeGreaterThan(30);
    expect(wiersze.filter((w) => !zdjecieIstnieje(w.miniatura)).length).toBe(0);
  });
});
