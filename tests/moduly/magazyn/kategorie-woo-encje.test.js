// Kategorie Woo przychodzą z API z encjami HTML („DIY &amp; Craft”). Lustro ma je trzymać
// zdekodowane, a widok sam koduje je raz przy wypisaniu — inaczej na karcie wychodzi „&amp;amp;”.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { odswiezMagazyn } from '../../../src/moduly/magazyn/services/magazyn-sync.js';
import { utworzKarte, powiazProdukt } from '../../../src/oms/db/magazyn.js';

const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};
const STAN_PUSTY = { trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null };

let db;
async function odczyt(kategorie, meta = []) {
  const produkt = {
    id: 700,
    type: 'simple',
    name: 'Szablon półcień',
    sku: 'SZB-1',
    price: '19.90',
    categories: kategorie,
    meta_data: meta,
  };
  await odswiezMagazyn({
    kanalySklepow: ['pro'],
    kanalyAllegro: [],
    db,
    sklepy: { pro: { pobierzWszystkieProdukty: vi.fn(async () => [produkt]), pobierzWarianty: vi.fn(async () => []) } },
    allegro: null,
    teraz: () => '2026-11-18T10:00:00Z',
  });
  return db.prepare('SELECT * FROM produkty_sklepowe').get();
}

async function htmlKarty(wiersz) {
  const kartaId = utworzKarte(db, { nazwa: 'Szablon półcień' });
  powiazProdukt(db, wiersz.id, kartaId);
  const app = buildOmsServer({
    db,
    config: { auth: { user: 'adam', pass: 'x' } },
    magazyn: { start: vi.fn(), stan: () => STAN_PUSTY },
  });
  const odp = await app.inject({ method: 'GET', url: `/magazyn/${kartaId}`, headers: auth });
  return odp.body;
}

beforeEach(() => {
  db = openOmsDb(':memory:');
});

describe('kategorie Woo — encje HTML przy zapisie lustra', () => {
  it('„DIY &amp; Craft” z API ląduje w bazie jako „DIY & Craft”, a w HTML karty jest raz zakodowane', async () => {
    const w = await odczyt([{ id: 5, name: 'DIY &amp; Craft' }]);
    expect(JSON.parse(w.kategorie_json)).toEqual(['DIY & Craft']);
    const html = await htmlKarty(w);
    expect(html).toContain('<div class="sku">DIY &amp; Craft</div>');
    expect(html).not.toContain('&amp;amp;');
  });

  it('kategoria główna z Yoasta też trafia zdekodowana', async () => {
    const w = await odczyt(
      [{ id: 5, name: 'DIY &amp; Craft' }],
      [{ key: '_yoast_wpseo_primary_product_cat', value: '5' }],
    );
    expect(w.kategoria_glowna_zrodla).toBe('DIY & Craft');
  });

  it('„&lt;script&gt;” nie staje się działającym tagiem w HTML karty', async () => {
    const w = await odczyt([{ id: 6, name: '&lt;script&gt;alert(1)&lt;/script&gt;' }]);
    const html = await htmlKarty(w);
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)');
  });
});
