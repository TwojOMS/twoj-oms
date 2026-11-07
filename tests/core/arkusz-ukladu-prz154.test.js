import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nowyPanel, get, BASIC } from '../pomoc/konta-prz068.js';

describe('PRZ-154 E3.3 — zewnętrzny arkusz układu', () => {
  it('zostawia w HTML tylko małe bloki stylów', () => {
    const layout = readFileSync('src/core/web/widoki/layout-oms.ejs', 'utf8');
    for (const styl of layout.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
      expect(Buffer.byteLength(styl[1], 'utf8')).toBeLessThanOrEqual(2048);
    }
  });

  it('ładuje układ przez zasob przed designem i ustawieniami', () => {
    const layout = readFileSync('src/core/web/widoki/layout-oms.ejs', 'utf8');
    const linki = [...layout.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="<%= zasob\('([^']+)'\) %>"[^>]*>/g)].map(m => m[1]);
    expect(linki).toContain('oms-uklad.css');
    expect(linki.indexOf('oms-uklad.css')).toBeLessThan(linki.indexOf('oms-design.css'));
    expect(linki.indexOf('oms-design.css')).toBeLessThan(linki.indexOf('oms-ustawienia.css'));
  });

  it('zawiera reguły tabel, przełączników i ramy bez składni EJS', () => {
    const css = readFileSync('src/public/oms-uklad.css', 'utf8');
    expect(css).not.toMatch(/<%/);
    expect(css).toMatch(/\.przewijak-tabeli\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/\.ust-pola \.pole-przelacznik\s*\{[^}]*display:\s*block/);
    expect(css).toMatch(/\.szer-tabela\s*>[^{}]*\{[^}]*max-width:\s*none/);
  });

  it.each(['/ustawienia/konta', '/ustawienia/zamowienia-i-wysylka'])('%s (Ustawienia) też ładuje arkusz układu', async url => {
    const { app, db } = nowyPanel();
    try {
      const r = await get(app, url, BASIC);
      expect(r.statusCode).toBe(200);
      expect(r.body).toMatch(/<link rel="stylesheet" href="\/public\/oms-uklad\.css\?v=[a-f0-9]+">/);
    } finally {
      await app.close();
      db.close();
    }
  });
});
