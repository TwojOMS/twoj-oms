import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { przelaczStany } from '../../../src/oms/db/stany-magazynowe.js';
import { dodajParametr, ustawWartoscKarty } from '../../../src/oms/db/parametry-kart.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

const config = { auth: { user: 'tester', pass: 'x' } };
const headers = { authorization: `Basic ${Buffer.from('tester:x').toString('base64')}` };
let db, app, paczkomat;
const get = (url = '/magazyn') => app.inject({ method: 'GET', url, headers });
const tabela = (html) => html.match(/<table class="tresc-lista magazyn-tabela">[\s\S]*?<\/table>/)[0];

beforeEach(() => {
  db = openOmsDb(':memory:');
  // Paczkomat jest wymaganym parametrem listy (tak po migracji z dawnej kolumny), wiec
  // stary adres `?paczkomat=` ma sie czym przetlumaczyc.
  paczkomat = dodajParametr(db, { nazwa: 'Paczkomat', typ: 'lista', wartosci: ['tak', 'nie'], wymagany: true }).id;
  const zeta = utworzKarte(db, {
    nazwa: 'Zeta',
    sku: 'Z',
    szerokosc_mm: 1,
    wysokosc_mm: 1,
    kategoria_glowna: 'K',
  });
  ustawWartoscKarty(db, zeta, paczkomat, 'tak');
  const alfa = utworzKarte(db, { nazwa: 'Alfa' });
  ustawWartoscKarty(db, alfa, paczkomat, 'nie');
  db.prepare('UPDATE karty_produktow SET opis_sekcje_json = ? WHERE id = ?').run(
    JSON.stringify({ sekcje: [{ elementy: [{ typ: 'tekst', html: '<p>Opis</p>' }] }] }),
    alfa,
  );
  utworzKarte(db, { nazwa: 'Beta' });
  app = buildOmsServer({
    db,
    config,
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: {
      'kanaly.klienciKanalow': { 'erli-test': {} },
      'kanaly.repozytoriumKanalow': {
        listaTypu: (typ) => (typ === 'erli' ? [{ klucz: 'erli-test', nazwa: 'Test' }] : []),
        zapisyZablokowane: () => false,
      },
    },
  });
});
afterEach(async () => {
  await app.close();
  db.close();
});

describe('lista Magazynu', () => {
  it('usuwa nagłówki i komórki Paczkomat i Stan w obu trybach', async () => {
    for (const widok of ['porzadki', 'katalog']) {
      const r = await get(`/magazyn?widok=${widok}`);
      expect(r.statusCode).toBe(200);
      const html = tabela(r.body);
      expect(html).not.toMatch(/>\s*(Paczkomat|Stan)\s/);
      expect(html).not.toMatch(/sort=(paczkomat|braki)/);
      expect(html).not.toContain('stan-braki');
      expect(html).not.toContain('>nieoznaczone<');
      const naglowki = html.match(/<th[\s>]/g).length;
      const wiersze = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].slice(1);
      expect(wiersze).toHaveLength(3);
      for (const w of wiersze) expect(w[1].match(/<td[\s>]/g)).toHaveLength(naglowki);
      expect(naglowki).toBe(widok === 'porzadki' ? 7 : 6 + (html.match(/<th class="magazyn-kanal"/g)?.length ?? 0));
    }
  });

  it.each(['paczkomat', 'braki'])('stary sort=%s wraca do domyślnej kolejności', async (sort) => {
    const domyslna = await get();
    const r = await get(`/magazyn?sort=${sort}`);
    expect(r.statusCode).toBe(200);
    // Nazwy w wierszach, niezależnie od układu filtrów i akcji.
    const kolejnosc = (html) => [...tabela(html).matchAll(/<div><a[^>]*>(Alfa|Beta|Zeta)<\/a>/g)].map((m) => m[1]);
    expect(kolejnosc(domyslna.body)).toEqual(['Alfa', 'Beta', 'Zeta']);
    expect(kolejnosc(r.body)).toEqual(kolejnosc(domyslna.body));
    expect(r.body).toContain('name="sort" value="nazwa"');
  });

  it('stary adres paczkomatu staje się filtrem parametru i łączy się z brakami opisu', async () => {
    const r = await get('/magazyn?paczkomat=tak&brak=opis');
    expect(r.statusCode).toBe(200);
    expect(tabela(r.body)).toContain('>Zeta</a>');
    expect(tabela(r.body)).not.toContain('>Alfa</a>');
    expect(tabela(r.body)).not.toContain('>Beta</a>');
    expect(r.body).toMatch(/<option value="tak" selected>/);
  });

  it('zastępuje kafle selectem, zachowuje wybór i przenosi brak w formularzach i sortowaniu', async () => {
    const r = await get('/magazyn?brak=opis');
    expect(r.statusCode).toBe(200);
    expect(tabela(r.body)).not.toContain('>Alfa</a>');
    expect(tabela(r.body)).toContain('>Beta</a>');
    expect(tabela(r.body)).toContain('>Zeta</a>');
    expect(r.body).not.toContain('class="kafle"');
    expect(r.body).toMatch(/<label[^>]*>[\s\S]*?Braki danych[\s\S]*?<select[^>]*name="brak"/);
    const select = r.body.match(/<select[^>]*name="brak"[^>]*>([\s\S]*?)<\/select>/)?.[1];
    expect(select).toBeDefined();
    expect(select).toMatch(/<option value="">wszystkie<\/option>/);
    expect(select).toContain('<option value="opis" selected>bez opisu</option>');
    expect([...select.matchAll(/value="([^"]*)"/g)].map((m) => m[1])).toEqual([
      '',
      'sku',
      'wymiary',
      'kategoria',
      'zdjecie',
      'opis',
      `parametr-${paczkomat}`,
      'cena_zakupu',
      'komplet',
    ]);
    // Bez liczników w opcjach; cyfra wolno tylko w wartości (id parametru).
    expect(select.replace(/value="[^"]*"/g, '')).not.toMatch(/\d/);
    expect(select).toContain(`<option value="parametr-${paczkomat}">bez: Paczkomat</option>`);
    const formularz = r.body.match(/<form[^>]*class="filtry[^\"]*"[\s\S]*?<\/form>/)?.[0];
    expect(formularz).toBeDefined();
    expect(formularz).not.toMatch(/<input[^>]*name="brak"/);
    expect(r.body).toContain('name="brak" value="opis"');
    const linki = [...tabela(r.body).matchAll(/href="([^\"]*sort=[^\"]*)"/g)];
    expect(linki.length).toBeGreaterThan(0);
    for (const [, adres] of linki) expect(adres).toContain('brak=opis');
  });

  it('podaje jednostkę stanu i zostawia liczbę sztuk', async () => {
    przelaczStany(db, { wlacz: true, konto: { id: 1, login: 'tester' }, at: '2026-11-13T10:00:00Z' });
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(tabela(r.body)).toContain('<th class="liczba">Na stanie (szt.)</th>');
    expect(tabela(r.body)).toContain('<td class="liczba kol-na-stanie">0</td>');
  });

  it('przycisk podglądu używa stylu drugiej akcji', async () => {
    const r = await get();
    const przyciski = [...r.body.matchAll(/<button\b([^>]*)>Pokaż podgląd — [\s\S]*?<\/button>/g)];
    expect(przyciski).toHaveLength(1);
    for (const [, attrs] of przyciski) expect(attrs).toContain('class="btn btn--drugi"');
  });
});
