import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzKarte, kartyZKanalami } from '../../../src/oms/db/magazyn.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { createPomocnikiMagazynu } from '../../../src/moduly/magazyn/pomocniki.js';

const headers = { authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}` };
let db, app;
const get = async (query) => {
  const r = await app.inject({ method: 'GET', url: `/magazyn?${query}`, headers });
  expect(r.statusCode).toBe(200);
  return r.body;
};
const tabela = (body) => /<thead>[\s\S]*?<\/tbody>/.exec(body)[0];
const nazwy = (body) => [...tabela(body).matchAll(/<div><a href="[^"]*">([^<]*)<\/a><\/div>/g)].map((m) => m[1]);
const pomoc = () => createPomocnikiMagazynu({ kanalySklepow: [], kanalyAllegro: [], definicje: [] });

beforeEach(() => {
  db = openOmsDb(':memory:');
  // Nazwy i kategorie celowo w innej kolejności niż marki.
  utworzKarte(db, { nazwa: 'A produkt', marka: 'Półcień', kategoria_glowna: 'A' });
  utworzKarte(db, { nazwa: 'Z produkt', marka: 'Lumen Atrapa', kategoria_glowna: 'Z' });
  utworzKarte(db, { nazwa: 'B pusty', marka: '' });
  utworzKarte(db, { nazwa: 'C null' });
  utworzKarte(db, { nazwa: 'D produkt', marka: 'Półcień', kategoria_glowna: 'B' });
  utworzKarte(db, { nazwa: 'E inna marka', marka: 'Półcień Plus' });
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'atrapa' } },
    magazyn: { start: () => ({ wystartowal: true }), stan: () => ({ trwa: false, kanaly: [] }) },
  });
});
afterEach(async () => {
  await app.close();
  db.close();
});

describe('marka na liście magazynu', () => {
  it.each(['porzadki', 'katalog'])('sortuje w obu kierunkach, puste na końcu (%s)', async (widok) => {
    const asc = await get(`widok=${widok}&sort=marka&kier=asc`);
    expect(nazwy(asc)).toEqual(['Z produkt', 'A produkt', 'D produkt', 'E inna marka', 'B pusty', 'C null']);
    const desc = await get(`widok=${widok}&sort=marka&kier=desc`);
    expect(nazwy(desc)).toEqual(['E inna marka', 'A produkt', 'D produkt', 'Z produkt', 'B pusty', 'C null']);
    for (const [body, aria, kier] of [
      [asc, 'ascending', 'desc'],
      [desc, 'descending', 'asc'],
    ]) {
      const th = [...tabela(body).matchAll(/<th\b[^>]*>[\s\S]*?<\/th>/g)].map((m) => m[0]);
      const i = 3;
      expect(th[i]).toContain('>Marka ');
      expect(th[i]).toContain(`aria-sort="${aria}"`);
      expect(th[i]).toContain(`sort=marka&amp;kier=${kier}`);
      expect(th.filter((h) => h.includes('aria-sort='))).toHaveLength(1);
      const rows = [...tabela(body).matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
      for (const name of ['B pusty', 'C null']) {
        const row = rows.find((r) => r.includes(`>${name}</a>`));
        const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
        expect(cells[i].trim()).toBe('<span class="magazyn-brak">—</span>');
      }
      const cells = [...rows.find((r) => r.includes('>A produkt</a>')).matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(
        (m) => m[1],
      );
      expect(cells[i].trim()).toBe('Półcień');
    }
  });

  it.each(['porzadki', 'katalog'])(
    'filtruje dokładnie i przenosi wybór w formularzach, linkach i hurcie (%s)',
    async (widok) => {
      db.prepare("INSERT INTO marki (nazwa, utworzona_at) VALUES ('Tylko słownik', '2026-11-13')").run();
      const body = await get(`widok=${widok}&marka=${encodeURIComponent('Półcień')}`);
      expect(nazwy(body)).toEqual(['A produkt', 'D produkt']);
      const select = /<select name="marka"[^>]*>([\s\S]*?)<\/select>/.exec(body);
      expect(select).not.toBeNull();
      expect(select[1]).toContain('<option value="Półcień" selected>Półcień</option>');
      expect([...select[1].matchAll(/<option value="([^"]*)"/g)].map((m) => m[1])).toEqual([
        '',
        'Lumen Atrapa',
        'Półcień',
        'Półcień Plus',
      ]);
      expect(body).toContain('name="marka" value="Półcień"');
      expect(body).toContain(`marka=${encodeURIComponent('Półcień')}&amp;sort=marka`);
      const zawezenie = /name="zawezenie" value="([^"]*)"/.exec(body)[1];
      expect(new URLSearchParams(zawezenie.replaceAll('&amp;', '&')).get('marka')).toBe('Półcień');
      const filtry = pomoc().filtryZawezenia(zawezenie.replaceAll('&amp;', '&'));
      expect(kartyZKanalami(db, { filtry }).map((w) => w.nazwa)).toEqual(['A produkt', 'D produkt']);
      const form = /<form[^>]*>[\s\S]*?<select name="marka"[\s\S]*?<\/form>/.exec(body)[0];
      expect(form).not.toContain('type="hidden" name="marka"');
    },
  );

  it('odróżnia pusty wynik filtra od pustego magazynu, pusty parametr nie zawęża', async () => {
    const body = await get('marka=Nieistniejąca');
    expect(nazwy(body)).toEqual([]);
    expect(body).not.toContain('Nie ma tu jeszcze ani jednej karty produktu.');
    expect(nazwy(await get('marka='))).toHaveLength(6);
    expect(nazwy(await get('marka=Półcień&marka=Lumen'))).toHaveLength(6);
  });

  it('zachowuje markę wraz z kategorią i frazą w pomocnikach', () => {
    const p = pomoc();
    const f = p.filtryZZapytania({ marka: ' Półcień ', kategoria: 'A', fraza: 'produkt' });
    expect(f.marka).toBe('Półcień');
    expect(p.saJakiesFiltry(p.filtryZZapytania({ marka: 'Półcień' }))).toBe(true);
    expect(p.parametryUkryte(f)).toContainEqual({ name: 'marka', value: 'Półcień' });
    expect(p.parametryUkryte(f, { pomin: p.POLA_FORMULARZA_FILTROW }).some((w) => w.name === 'marka')).toBe(false);
    expect(p.wartosciPol(f).marka).toBe('Półcień');
    expect(p.adresMagazynu(f)).toContain(`marka=${encodeURIComponent('Półcień')}`);
    expect(kartyZKanalami(db, { fraza: f.fraza, filtry: f }).map((w) => w.nazwa)).toEqual(['A produkt']);
  });
});
