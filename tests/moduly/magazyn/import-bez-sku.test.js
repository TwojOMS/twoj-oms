import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { zapiszProduktSklepowy, ofertySkuKanalu } from '../../../src/oms/db/magazyn.js';

// Konto Allegro, którego oferty nie mają SKU, nie dostanie z importu żadnych powiązań (import wiąże po SKU)
// — ekran importu odsyła wtedy do ekranu Powiązania. Dane zmyślone („Pracownia Półcień”).

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
  'content-type': 'application/x-www-form-urlencoded',
};
const KONTO = 'allegro_swietlik';
const LINK = `/magazyn/powiazania?kanal=${KONTO}`;
const oferta = (id, nazwa, sku) => ({
  id,
  name: nazwa,
  ...(sku ? { external: { id: sku } } : {}),
  sellingMode: { price: { amount: '30.00', currency: 'PLN' } },
});

let db;
let oferty;

const lustro = (produktId, nazwa, sku, o = {}) =>
  zapiszProduktSklepowy(db, {
    kanal: KONTO,
    produkt_id: produktId,
    wariant_id: '',
    nazwa,
    sku_sklepu: sku,
    odczytane_at: '2026-11-01T08:00:00.000Z',
    ...o,
  });

const tresc = {
  start: vi.fn(() => ({ wystartowal: true })),
  stan: () => ({
    trwa: false,
    zaczety_at: null,
    skonczony_at: null,
    postep: null,
    razem: 0,
    pobrane: 0,
    bledy: [],
    blad: null,
  }),
  gotowy: () => true,
};
const serwer = () =>
  buildOmsServer({
    db,
    config: { ...config, sklepy: {} },
    klienciWiadomosci: { [KONTO]: { pobierzOferty: vi.fn(async () => oferty) } },
    nadpisania: { 'magazyn.trescAllegro': tresc },
  });
const wybor = (app, kanal = KONTO) =>
  app.inject({ method: 'GET', url: `/magazyn/import?kanal=${kanal}`, headers: auth });

async function podglad(app, typ) {
  const r = await app.inject({
    method: 'POST',
    url: '/magazyn/import/sprawdz',
    headers: auth,
    payload: `kanal=${KONTO}&typ=${typ}`,
  });
  for (let i = 0; i < 200; i += 1) {
    const g = await app.inject({ method: 'GET', url: r.headers.location, headers: auth });
    if (g.body.includes('data-krok="podglad"')) return g.body;
    await new Promise((ok) => {
      setTimeout(ok, 5);
    });
  }
  throw new Error('podgląd się nie pojawił');
}

beforeEach(() => {
  db = openOmsDb(':memory:');
  oferty = [oferta('7001', 'Kubek bez sygnatury', null), oferta('7002', 'Lampa bez sygnatury', null)];
});

describe('ofertySkuKanalu', () => {
  it('liczy żywe oferty kanału i te z niepustym SKU; puste i zniknięte się nie liczą', () => {
    lustro('1', 'A', 'PP-A');
    lustro('2', 'B', '   ');
    lustro('3', 'C', null);
    lustro('4', 'D', 'PP-D');
    db.prepare("UPDATE produkty_sklepowe SET zniknal_at = '2026-11-02T08:00:00.000Z' WHERE produkt_id = '4'").run();
    expect(ofertySkuKanalu(db, KONTO)).toEqual({ razem: 3, zSku: 1 });
    expect(ofertySkuKanalu(db, 'allegro_inne')).toEqual({ razem: 0, zSku: 0 });
  });
});

describe('krok wyboru', () => {
  it('konto z ofertami i bez SKU → zdanie i link do Powiązań dla tego konta', async () => {
    lustro('1', 'Kubek bez sygnatury', null);
    const html = (await wybor(serwer())).body;
    expect(html).toContain('Oferty tego konta nie mają sygnatur (SKU)');
    expect(html).toContain(`href="${LINK}"`);
  });

  it('konto z choć jednym SKU → bez zdania', async () => {
    lustro('1', 'Kubek bez sygnatury', null);
    lustro('2', 'Lampa Półcień', 'PP-LAMPA-01');
    const html = (await wybor(serwer())).body;
    expect(html).not.toContain('nie mają sygnatur');
    expect(html).not.toContain(`href="${LINK}"`);
  });

  it('konto bez żadnych ofert w lustrze → bez zdania (nie wiemy, że brakuje SKU)', async () => {
    const html = (await wybor(serwer())).body;
    expect(html).not.toContain('nie mają sygnatur');
  });
});

describe('krok podglądu', () => {
  it('typ tworzący karty, utworzy > 0, konto bez SKU → ostrzeżenie z liczbą i linkiem, przycisk „Importuj” zostaje', async () => {
    const html = await podglad(serwer(), 'nowe');
    expect(html).toMatch(/Utworzy 2 nowych kart/);
    expect(html).toContain('nie ma już w magazynie pod inną nazwą');
    expect(html).toContain(`href="${LINK}"`);
    expect(html).toContain('>Importuj</button>');
  });

  it('konto z SKU → bez ostrzeżenia', async () => {
    oferty = [oferta('7001', 'Kubek Półcień', 'PP-KUBEK-01'), oferta('7002', 'Lampa bez sygnatury', null)];
    const html = await podglad(serwer(), 'nowe');
    expect(html).not.toContain('nie ma już w magazynie pod inną nazwą');
  });

  it('typ bez tworzenia kart (utworzy = 0) → bez ostrzeżenia', async () => {
    const html = await podglad(serwer(), 'powiaz');
    expect(html).not.toContain('nie ma już w magazynie pod inną nazwą');
  });

  it('powód „nie ma karty z tym SKU” → link „Powiąż je ręcznie →” do Powiązań konta', async () => {
    const html = await podglad(serwer(), 'powiaz');
    expect(html).toContain('nie ma karty z tym SKU');
    expect(html).toMatch(new RegExp(`<a [^>]*href="${LINK.replace('?', '\\?')}"[^>]*>Powiąż je ręcznie →</a>`));
  });
});
