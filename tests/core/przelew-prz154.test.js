import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nowyPanel, get, BASIC } from '../pomoc/konta-prz068.js';
import { przelaczStany } from '../../src/oms/db/stany-magazynowe.js';
import { zapiszZamowienie } from '../../src/oms/db/zamowienia.js';
import { readFileSync } from 'node:fs';

// Stos przodków pozwala sprawdzić każdą tabelę, również kilka tabel w jednym main.
function tabeleBezPrzewijaka(html) {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? '';
  const stos = [], tabele = [];
  const tresc = main.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi, '');
  for (const [tag, koniec, nazwa, atrybuty] of tresc.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/gi)) {
    if (koniec) {
      const i = stos.findLastIndex(e => e.nazwa === nazwa);
      if (i >= 0) stos.splice(i);
      continue;
    }
    if (nazwa === 'table') tabele.push({ tag, przewijak: stos.some(e => e.przewijak) });
    if (!/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(nazwa)) {
      stos.push({ nazwa, przewijak: /class="[^"]*\bprzewijak-tabeli\b/.test(atrybuty) });
    }
  }
  return tabele;
}

describe('PRZ-154 E3.1 — szerokie tabele przewijają się wewnątrz main', () => {
  let app, db;
  beforeAll(() => {
    ({ app, db } = nowyPanel());
    przelaczStany(db, { wlacz: true, konto: { id: 1, login: 'test' }, at: '2026-10-17T08:00:00Z' });
    zapiszZamowienie(db, 'allegro_a', {
      zrodlo_id: 'przelew-1', numer: 'TEST-1', klient: {}, dostawa: {},
      metoda_wysylki: 'allegro_dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
      kwota_brutto: '50.00', status_woo: null, oplacone_at: null, anulowane: 0,
      utworzone_at: '2026-10-17T09:00:00Z',
      pozycje: [{ nazwa: 'Produkt testowy bez karty', sku: null, ilosc: 1, cena_brutto: '50.00',
        vat: '23', zdjecie_url: null, zrodlo_id: 1, produkt_id: null, oferta_id: '1111111111' }],
    }, {});
  });
  afterAll(async () => { await app.close(); db.close(); });
  it.each([
    '/zamowienia/nowe', '/magazyn/stany/bez-karty', '/ustawienia/zamowienia-i-wysylka',
  ])('%s: każda tabela ma przodka .przewijak-tabeli', async url => {
    const r = await get(app, url, BASIC);
    expect(r.statusCode).toBe(200);
    const tabele = tabeleBezPrzewijaka(r.body);
    expect(tabele.length).toBeGreaterThan(0);
    expect(tabele.filter(t => !t.przewijak).map(t => t.tag)).toEqual([]);
  });
  it('formularz automatyzacji renderuje pole statusu w podliście', async () => {
    const r = await get(app, '/ustawienia/automatyzacje/nowa', BASIC);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="aut-zdarzenie-status"');
    expect(tabeleBezPrzewijaka(r.body)).toEqual([]);
  });
  it('zamyka pozycjonowane etykiety w przewijaku i pozwala polom zwęzić się na telefonie', () => {
    const css = readFileSync('src/public/oms-design.css', 'utf8');
    expect(css).toMatch(/\.przewijak-tabeli\s*\{\s*position:\s*relative;\s*\}/);
    expect(css).toMatch(/@media\s*\(max-width:\s*650px\)\s*\{\s*\.magazyn-pole\s*\{\s*min-width:\s*0;\s*\}\s*\.magazyn-pole input,\s*\.oms-shell \.aut-podlista select\s*\{\s*min-width:\s*0;\s*max-width:\s*100%;\s*\}/);
  });
});
