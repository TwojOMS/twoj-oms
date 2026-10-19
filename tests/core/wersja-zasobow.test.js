// PRZ-100: wersja w adresach /public/*.css|js. Bez niej przeglądarka za Cloudflare (demo: max-age=14400) trzymała
// po wydaniu stary oms-design.css do 4 h — menu Ustawień na demo było białe mimo poprawki 2d7555a.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wersjaZasobow, adresZasobu } from '../../src/core/web/wersja-zasobow.js';
import { nowyPanel, jako, get } from '../pomoc/konta-prz068.js';
import { zalozKonto } from '../../src/core/bezpieczenstwo/konta.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = path.join(ROOT, 'src/public');

function katalog(pliki) {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'prz100-'));
  for (const [nazwa, tresc] of Object.entries(pliki)) fs.writeFileSync(path.join(k, nazwa), tresc);
  return k;
}

describe('PRZ-100 wersjaZasobow', () => {
  it('ta sama treść → ta sama wersja (10 znaków hex); zmiana jednego bajtu CSS albo JS → inna', () => {
    const a = wersjaZasobow(katalog({ 'a.css': 'body{}', 'b.js': 'x()' }));
    expect(a).toMatch(/^[0-9a-f]{10}$/);
    expect(wersjaZasobow(katalog({ 'a.css': 'body{}', 'b.js': 'x()' }))).toBe(a);
    expect(wersjaZasobow(katalog({ 'a.css': 'body{ }', 'b.js': 'x()' }))).not.toBe(a);
    expect(wersjaZasobow(katalog({ 'a.css': 'body{}', 'b.js': 'y()' }))).not.toBe(a);
  });
  it('zmiana nazwy pliku zmienia wersję (ta sama treść pod inną nazwą to inny zasób)', () => {
    expect(wersjaZasobow(katalog({ 'a.css': 'body{}' }))).not.toBe(wersjaZasobow(katalog({ 'c.css': 'body{}' })));
  });
});

describe('PRZ-100 adresZasobu', () => {
  it('istniejący plik → /public/<nazwa>?v=<wersja>; nieznana nazwa → błąd (literówka wychodzi w testach widoków)', () => {
    const k = katalog({ 'oms-design.css': 'body{}' });
    const zasob = adresZasobu(k);
    expect(zasob('oms-design.css')).toBe(`/public/oms-design.css?v=${wersjaZasobow(k)}`);
    expect(() => zasob('nie-ma.css')).toThrow(/nie-ma\.css/);
    expect(() => zasob('../sekret.js')).toThrow();
  });
});

describe('PRZ-100 widoki i serwer', () => {
  it('żaden widok nie ma gołego adresu /public/*.css|js — tylko zasob(…)', () => {
    const gole = [];
    const przejdz = (k) => {
      for (const w of fs.readdirSync(k, { withFileTypes: true })) {
        const p = path.join(k, w.name);
        if (w.isDirectory()) przejdz(p);
        else if (w.name.endsWith('.ejs')) {
          fs.readFileSync(p, 'utf8').split('\n').forEach((linia, i) => {
            if (/(href|src)="\/public\/[^"]+\.(css|js)"/.test(linia)) gole.push(`${path.relative(ROOT, p)}:${i + 1}`);
          });
        }
      }
    };
    przejdz(path.join(ROOT, 'src'));
    expect(gole).toEqual([]);
  });

  it('strona panelu linkuje CSS i skrypty z wersją bieżących plików, a serwer podaje plik pod adresem z ?v=', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    const r = await get(app, '/ustawienia/magazyn', jako(db, 'adam'));
    expect(r.statusCode, r.body).toBe(200);
    const v = wersjaZasobow(PUBLIC);
    expect(r.body).toContain(`<link rel="stylesheet" href="/public/oms-design.css?v=${v}">`);
    expect(r.body).toContain(`src="/public/oms-nawigacja.js?v=${v}"`);
    const css = await app.inject({ method: 'GET', url: `/public/oms-design.css?v=${v}` });
    expect(css.statusCode).toBe(200);
    expect(css.body).toContain('.oms-settings-navigation');
  });
});
