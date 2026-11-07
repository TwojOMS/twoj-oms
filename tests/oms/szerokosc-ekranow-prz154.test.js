import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { nowyPanel, get, BASIC } from '../pomoc/konta-prz068.js';
import { zapiszZamowienie } from '../../src/oms/db/zamowienia.js';

describe('PRZ-154 — szerokość deklarowana przez ekran', () => {
  let app, db, id;
  beforeAll(() => {
    ({ app, db } = nowyPanel());
    id = zapiszZamowienie(db, 'reczne', {
      zrodlo_id: 'szerokosc-1', numer: 'TEST-1', klient: {}, dostawa: {},
      metoda_wysylki: 'odbior_osobisty', kwota_pobrania: null, chce_fakture: 0,
      nip: null, status_woo: 'processing', oplacone_at: null, kwota_brutto: '100.00',
      koszt_dostawy_brutto: '0.00', pozycje: [], anulowane: 0,
      utworzone_at: '2026-11-01T10:00:00Z',
    }, {});
  });
  afterAll(async () => { await app.close(); db.close(); });

  it.each([
    ['/', 'tabela'], ['/przesylki', 'tabela'], ['/faktury', 'tabela'],
    ['/magazyn', 'tabela'], ['/magazyn/pominiete', 'tabela'],
    ['/koszty', 'tabela'], ['/klienci', 'tabela'], ['/okresy', 'tabela'],
    ['/wiadomosci', 'tabela'], ['/przesylki/podjazdy/historia', 'tabela'],
    ['/zamowienia/nowe', 'formularz'], ['/cele/nowy', 'formularz'],
    ['/konto', 'formularz'], ['/konto/powiadomienia', 'formularz'],
    ['/ustawienia/firma', 'formularz'], ['/ustawienia/statusy', 'karta'],
    ['/ustawienia/zamowienia-i-wysylka', 'karta'],
    ['/ustawienia/firma/rejestrowe', 'formularz'], ['/ustawienia/firma/rachunek', 'formularz'],
    ['/ustawienia/powiadomienia', 'formularz'], ['/ustawienia/integracje/gus', 'formularz'],
    ['/ustawienia/integracje/dpd', 'formularz'], ['/ustawienia/integracje/inpost', 'formularz'],
    ['/ustawienia/integracje/infakt', 'formularz'], ['/ustawienia/integracje/ksef', 'formularz'],
    ['/ustawienia/integracje/poczta', 'formularz'],
    ['/ustawienia/wiadomosci-i-automatyzacje', 'formularz'],
    ['/ustawienia/automatyzacje/nowa', 'formularz'],
    ['/ustawienia/magazyn', 'karta'], ['/ustawienia/szablony-wiadomosci', 'karta'],
    ['/ustawienia/konta', 'karta'], ['/ustawienia/role', 'karta'],
    ['/ustawienia/integracje', 'karta'], ['/ustawienia/integracje/katalog', 'karta'],
    ['/kampania', 'karta'], ['/kampania?kampania=przykladowa', 'karta'],
  ])('%s → %s', async (url, szerokosc) => {
    const r = await get(app, url, BASIC);
    expect(r.statusCode).toBe(200);
    expect(r.body.match(/<main\b[^>]*>/)?.[0]).toBe(`<main class="kolumna-glowna szer-${szerokosc}">`);
  });

  it('karta zamówienia korzysta z domyślnej szerokości karta', async () => {
    const r = await get(app, `/zamowienia/${id}`, BASIC);
    expect(r.statusCode).toBe(200);
    expect(r.body.match(/<main\b[^>]*>/)?.[0]).toBe('<main class="kolumna-glowna szer-karta">');
  });

  it('limity wynikają z klasy main, a Reklamy zachowują szerokość i lewą krawędź', () => {
    const layout = readFileSync('src/public/oms-uklad.css', 'utf8');
    expect(layout).toMatch(/\.szer-tabela\s*>\s*:not\(style\)\s*\{\s*max-width:\s*none;/);
    expect(layout).toMatch(/\.szer-karta\s*>\s*:not\(\.strona-kampania\):not\(style\)\s*\{\s*max-width:\s*1222px;/);
    expect(layout).toMatch(/\.szer-formularz\s*>\s*:not\(style\)\s*\{\s*max-width:\s*760px;/);
    expect(layout).not.toContain(':not(.tresc-lista)');
    const kampania = readFileSync('src/moduly/marketing/widoki/_kampania-glowa.ejs', 'utf8');
    expect(kampania).toMatch(/\.strona-kampania\s*\{\s*max-width:\s*1560px;\s*margin:\s*0;/);
    const reklamy = readFileSync('src/moduly/marketing/widoki/_reklamy-style.ejs', 'utf8');
    expect(reklamy).toMatch(/\.reklamy\s*\{\s*max-width:\s*1380px;\s*margin:\s*0;/);
  });
});
